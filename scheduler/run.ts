/**
 * One scheduled run (007 FR3–FR5): the job's prompt goes in an
 * `origin="scheduler"` wrapper, under the target session's policy narrowed by
 * `policyOverride`. The run is announced with a "⏰ <title>" header; if the
 * agent never calls `reply`, its final text is posted instead. Status lands
 * back in `jobs.json`; a one-off job that succeeded is removed (US2).
 */

import { renderInbound } from '../agent/inbound.ts'
import type { TurnOutcome } from '../agent/runner.ts'
import type { StreamEvent } from '../agent/stream.ts'
import type { Policy } from '../policy/schema.ts'
import { parseKey } from '../sessions/key.ts'
import { loadJobs, saveJobs, type Job } from './store.ts'

/** `deferred`: the usage limit was hit; not a failure (FR11). */
export type JobStatus = 'ok' | 'error' | 'needs_approval' | 'deferred'

/** FR8: consecutive failures before a job is disabled. */
export const MAX_FAILURES = 3

export type JobRunDeps = {
  stateDir: string
  /** The target session's resolved policy. */
  policy: (key: string) => Policy
  /** Runs the turn: fresh, or resuming the chat's session for `mode: session` (FR4). */
  turn: (job: Job, prompt: string, policy: Policy, onEvent: (ev: StreamEvent) => void) => Promise<TurnOutcome>
  post: (key: string, text: string) => Promise<unknown>
  /** FR8: after a failed run, with the job as stored (`enabled: false` once auto-disabled). */
  onFailure?: (job: Job, reason: string) => unknown
  now?: () => number
}

const MODE_RANK = { plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 } as const

/**
 * FR3: an override can only take permissions away. Allowed tools intersect,
 * disallowed tools add up, the stricter permission mode and lower max turns
 * win, and a flag is on only if both have it. Other override fields are ignored.
 */
export function narrowPolicy(base: Policy, override?: Policy): Policy {
  if (!override) return base
  const out: Policy = { ...base }
  if (override.allowedTools) {
    out.allowedTools = base.allowedTools ? base.allowedTools.filter(t => override.allowedTools!.includes(t)) : override.allowedTools
  }
  if (override.disallowedTools) out.disallowedTools = [...new Set([...base.disallowedTools ?? [], ...override.disallowedTools])]
  if (override.permissionMode && MODE_RANK[override.permissionMode] < MODE_RANK[base.permissionMode ?? 'default']) {
    out.permissionMode = override.permissionMode
  }
  if (override.maxTurns) out.maxTurns = Math.min(override.maxTurns, base.maxTurns ?? Infinity)
  for (const flag of ['schedulerAllowed', 'teamsAllowed'] as const) {
    if (override[flag] === false) out[flag] = false
  }
  if (override.memoryScope === 'none') out.memoryScope = 'none'
  return out
}

export const jobTitle = (job: Job) => job.title ?? job.prompt.slice(0, 60)

function statusOf(outcome: TurnOutcome): JobStatus {
  if (outcome.pausedUntil) return 'deferred'
  if (outcome.refused || !outcome.result || outcome.result.is_error) return 'error'
  if (outcome.result.permission_denials?.length) return 'needs_approval'
  return 'ok'
}

function failureReason(outcome: TurnOutcome): string {
  if (outcome.refused) return outcome.refused.join('; ')
  const r = outcome.result
  return r?.errors?.join('; ') || r?.result?.trim().slice(0, 300) || `exited with code ${outcome.exitCode} and no result`
}

/** Applies `change` to the stored job and returns what was stored (null if removed). */
function update(stateDir: string, id: string, change: (job: Job) => Job | null): Job | null {
  let stored: Job | null = null
  const jobs = loadJobs(stateDir).flatMap(j => {
    if (j.id !== id) return [j]
    stored = change(j)
    return stored ? [stored] : []
  })
  saveJobs(stateDir, jobs)
  return stored
}

/** FR8: the owner's failure notice, with Retry and Disable buttons. */
export function failureNotice(job: Job, reason: string) {
  const head = `⚠️ Scheduled job ${job.id} "${jobTitle(job)}" failed: ${reason}`
  const text = job.enabled ? head : `${head}\nDisabled after ${MAX_FAILURES} failures in a row.`
  const keyboard = { inline_keyboard: [[
    { text: '🔁 Retry', callback_data: `sch:retry:${job.id}` },
    ...(job.enabled ? [{ text: '⏸ Disable', callback_data: `sch:off:${job.id}` }] : []),
  ]] }
  return { text, keyboard }
}

/** Runs the job with this id, if it still exists and is enabled. */
export async function runJob(id: string, deps: JobRunDeps): Promise<JobStatus | undefined> {
  const job = loadJobs(deps.stateDir).find(j => j.id === id)
  if (!job?.enabled) return
  const now = deps.now?.() ?? Date.now()
  await deps.post(job.sessionKey, `⏰ ${jobTitle(job)}`)
  const prompt = renderInbound(job.prompt, {
    origin: 'scheduler',
    chat_id: parseKey(job.sessionKey).chatId,
    job_id: job.id,
    ...(job.title && { job_title: job.title }),
    ts: new Date(now).toISOString(),
  })
  let replied = false
  const outcome = await deps.turn(job, prompt, narrowPolicy(deps.policy(job.sessionKey), job.policyOverride), ev => {
    if (ev.kind === 'assistant' && ev.event.message.content.some(b => b.type === 'tool_use' && 'name' in b && String(b.name).endsWith('__reply'))) replied = true
  })
  const status = statusOf(outcome)
  const text = outcome.result?.result?.trim()
  if (!replied && status === 'ok' && text) await deps.post(job.sessionKey, text)
  const stored = update(deps.stateDir, id, j => {
    if (status === 'ok' && j.kind === 'at') return null
    const failures = status === 'error' ? j.failures + 1 : status === 'ok' ? 0 : j.failures
    return { ...j, lastRun: now, lastStatus: status, failures, enabled: j.enabled && failures < MAX_FAILURES }
  })
  if (status === 'error' && stored) await deps.onFailure?.(stored, failureReason(outcome))
  return status
}
