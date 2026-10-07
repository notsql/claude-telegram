/**
 * `schedule_*` tools on the daemon MCP server (007 FR6). All need
 * `schedulerAllowed` (AC6): hidden from `tools/list` and refused otherwise.
 * The agent turns natural-language times into a cron expression or ISO
 * timestamp; the daemon validates it and echoes it back in words with the
 * next runs. A chat only sees and changes its own jobs. `policyOverride` is
 * stored as given and only ever narrows the chat's policy at run time (FR3).
 */

import { randomBytes } from 'crypto'
import { Cron } from 'croner'
import type { ToolResult } from '../memory/tools.ts'
import { PolicySchema, type Policy } from '../policy/schema.ts'
import { visibleTools } from '../policy/tools.ts'
import { describeJob } from './describe.ts'
import { jobTitle } from './run.ts'
import { loadJobs, saveJobs, type Job } from './store.ts'

const WHEN = { type: 'string', description: 'A 5-field cron expression ("30 8 * * 1-5") for repeating jobs, or an ISO 8601 timestamp ("2026-10-08T15:00:00") for a one-off. Resolve relative times ("in 2 minutes", "tomorrow 3pm") from the inbound ts.' }
const TZ = { type: 'string', description: "IANA timezone, e.g. Asia/Singapore. Use the user's timezone from their user model if known; defaults to the host's." }
const MODE = { type: 'string', enum: ['fresh', 'session'], description: 'fresh (default): a new session each run. session: continue this chat\'s conversation.' }
const OVERRIDE = { type: 'object', description: 'Optional policy limits for the job, e.g. {"allowedTools": ["Read"]}. Can only narrow this chat\'s policy.' }

const TOOLS = [
  {
    name: 'schedule_create',
    description: 'Schedule a prompt to run later in this chat, once or repeatedly. Confirm the returned summary to the user so they can catch a misreading.',
    inputSchema: {
      type: 'object',
      properties: { when: WHEN, prompt: { type: 'string', description: 'What to do when it runs, written as an instruction to yourself' }, title: { type: 'string' }, mode: MODE, tz: TZ, policyOverride: OVERRIDE },
      required: ['when', 'prompt'],
    },
  },
  { name: 'schedule_list', description: "This chat's scheduled jobs.", inputSchema: { type: 'object', properties: {} } },
  {
    name: 'schedule_update',
    description: 'Change a scheduled job in this chat; pass only the fields to change. enabled: false pauses it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, when: WHEN, prompt: { type: 'string' }, title: { type: 'string' }, mode: MODE, tz: TZ, enabled: { type: 'boolean' }, policyOverride: OVERRIDE },
      required: ['id'],
    },
  },
  { name: 'schedule_delete', description: 'Delete a scheduled job in this chat.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'schedule_run_now', description: 'Run a scheduled job in this chat now, in addition to its schedule.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
].map(t => ({ ...t, requires: 'schedulerAllowed' as const }))

const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) })

/** Cron vs. one-off, validated by croner. Throws with a readable message. */
function parseWhen(when: string, tz: string, now: Date): Pick<Job & { kind: 'cron' }, 'kind' | 'expr'> | Pick<Job & { kind: 'at' }, 'kind' | 'at'> {
  const at = /^\d{4}-\d{2}-\d{2}T/.test(when)
  let next: Date | null
  try {
    next = new Cron(when, { timezone: tz, paused: true }).nextRun(now)
  } catch (err) {
    throw new Error(`Invalid when "${when}": ${(err as Error).message}`)
  }
  if (!next) throw new Error(`"${when}" never runs${at ? ' (it is in the past)' : ''}.`)
  return at ? { kind: 'at', at: when } : { kind: 'cron', expr: when }
}

function checkTz(tz: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
  } catch {
    throw new Error(`Unknown timezone "${tz}".`)
  }
  return tz
}

export type ScheduleToolDeps = {
  stateDir: string
  /** Reschedules after a change (engine.reload). */
  reload: () => void
  /** Queues a run of the job now. */
  runNow: (id: string) => void
  now?: () => Date
}

export function createScheduleTools(deps: ScheduleToolDeps) {
  const now = () => deps.now?.() ?? new Date()
  const hostTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone

  function save(jobs: Job[]): void {
    saveJobs(deps.stateDir, jobs)
    deps.reload()
  }

  function own(id: unknown, key: string): { jobs: Job[]; job: Job } {
    const jobs = loadJobs(deps.stateDir)
    const job = jobs.find(j => j.id === id && j.sessionKey === key)
    if (!job) throw new Error(`No job ${id} in this chat. Use schedule_list.`)
    return { jobs, job }
  }

  return {
    list: (policy: Policy) => visibleTools(TOOLS, policy),

    /** Undefined when `name` is not a schedule tool. */
    call(name: string, args: Record<string, unknown>, key: string, policy: Policy): ToolResult | undefined {
      if (!TOOLS.some(t => t.name === name)) return
      if (policy.schedulerAllowed !== true) return text('Scheduling is not allowed in this chat.', true)
      try {
        switch (name) {
          case 'schedule_create': {
            const tz = checkTz(args.tz ? String(args.tz) : hostTz())
            const job = {
              id: `j_${randomBytes(3).toString('hex')}`,
              ...parseWhen(String(args.when ?? ''), tz, now()),
              tz,
              ...(args.title ? { title: String(args.title) } : {}),
              prompt: String(args.prompt ?? ''),
              sessionKey: key,
              mode: args.mode === 'session' ? 'session' : 'fresh',
              ...(args.policyOverride ? { policyOverride: PolicySchema.parse(args.policyOverride) } : {}),
              enabled: true,
              createdBy: key,
              createdAt: now().getTime(),
              lastRun: null, lastStatus: null, nextRun: null, failures: 0,
            } as Job
            if (!job.prompt) throw new Error('prompt is required.')
            save([...loadJobs(deps.stateDir), job])
            return text(`Scheduled ${job.id} "${jobTitle(job)}": ${describeJob(job, now())}`)
          }
          case 'schedule_list': {
            const mine = loadJobs(deps.stateDir).filter(j => j.sessionKey === key)
            if (!mine.length) return text('No scheduled jobs in this chat.')
            return text(mine.map(j => `${j.id} "${jobTitle(j)}"${j.enabled ? '' : ' (paused)'}${j.lastStatus ? ` last: ${j.lastStatus}` : ''}\n${describeJob(j, now())}`).join('\n\n'))
          }
          case 'schedule_update': {
            const { jobs, job } = own(args.id, key)
            const tz = args.tz ? checkTz(String(args.tz)) : job.tz
            const when = args.when ? String(args.when) : job.kind === 'cron' ? job.expr : job.at
            const { expr: _e, at: _a, ...rest } = job as Job & { expr?: string; at?: string }
            const updated = {
              ...rest,
              ...parseWhen(when, tz, now()),
              tz,
              ...(args.prompt ? { prompt: String(args.prompt) } : {}),
              ...(args.title ? { title: String(args.title) } : {}),
              ...(args.mode === 'fresh' || args.mode === 'session' ? { mode: args.mode } : {}),
              ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled, failures: 0 } : {}),
              ...(args.policyOverride ? { policyOverride: PolicySchema.parse(args.policyOverride) } : {}),
            } as Job
            save(jobs.map(j => (j === job ? updated : j)))
            return text(`Updated ${job.id}${updated.enabled ? '' : ' (paused)'}: ${describeJob(updated, now())}`)
          }
          case 'schedule_delete': {
            const { jobs, job } = own(args.id, key)
            save(jobs.filter(j => j !== job))
            return text(`Deleted ${job.id} "${jobTitle(job)}".`)
          }
          case 'schedule_run_now': {
            const { job } = own(args.id, key)
            deps.runNow(job.id)
            return text(`Running ${job.id} "${jobTitle(job)}" now.`)
          }
        }
      } catch (err) {
        return text((err as Error).message, true)
      }
    },
  }
}

export type ScheduleTools = ReturnType<typeof createScheduleTools>
