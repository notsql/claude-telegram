import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createEngine } from '../scheduler/engine'
import { failureNotice, narrowPolicy, runJob, type JobRunDeps } from '../scheduler/run'
import { loadJobs, saveJobs, type Job } from '../scheduler/store'
import type { TurnOutcome } from '../agent/runner'
import type { StreamEvent } from '../agent/stream'

const dir = () => mkdtempSync(join(tmpdir(), 'tg-run-'))
const base = {
  tz: 'Asia/Singapore', prompt: 'Remind me to stretch', sessionKey: '-100:7', mode: 'fresh' as const, enabled: true,
  createdBy: '1', createdAt: 0, lastRun: null, lastStatus: null, nextRun: null, failures: 0,
}
const result = (over: object = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'Time to stretch!', session_id: 's', ...over }) as unknown as TurnOutcome['result']

function deps(d: string, outcome: TurnOutcome, events: StreamEvent[] = []) {
  const posts: [string, string][] = []
  const turns: { job: Job; prompt: string }[] = []
  const r: JobRunDeps = {
    stateDir: d,
    policy: () => ({ allowedTools: ['Read', 'Grep'] }),
    turn: async (job, prompt, _p, onEvent) => {
      turns.push({ job, prompt })
      events.forEach(onEvent)
      return outcome
    },
    post: async (key, text) => posts.push([key, text]),
    now: () => 1000,
  }
  return { r, posts, turns }
}

test('AC1: an at job fires, posts header and fallback text to its chat, and is removed', async () => {
  const d = dir()
  const at = new Date(Date.now() + 1000).toISOString()
  saveJobs(d, [{ ...base, id: 'j_1', kind: 'at', at, title: 'Stretch' }])
  const { r, posts, turns } = deps(d, { result: result(), exitCode: 0 })
  const done: Promise<unknown>[] = []
  const engine = createEngine({ stateDir: d, fire: id => done.push(runJob(id, r)) })
  engine.reload()
  await new Promise(res => setTimeout(res, 1600))
  await Promise.all(done)
  engine.stop()
  expect(posts).toEqual([['-100:7', '⏰ Stretch'], ['-100:7', 'Time to stretch!']])
  expect(turns[0]!.prompt).toStartWith('<channel source="telegram" origin="scheduler" chat_id="-100" job_id="j_1" job_title="Stretch"')
  expect(loadJobs(d)).toEqual([])
})

test('no fallback post when the agent replied; cron jobs keep status', async () => {
  const d = dir()
  saveJobs(d, [{ ...base, id: 'j_2', kind: 'cron', expr: '0 9 * * *', failures: 2 }])
  const replied = { kind: 'assistant', event: { message: { content: [{ type: 'tool_use', id: 't', name: 'mcp__tg__reply', input: {} }] } } } as unknown as StreamEvent
  const { r, posts } = deps(d, { result: result(), exitCode: 0 }, [replied])
  expect(await runJob('j_2', r)).toBe('ok')
  expect(posts).toEqual([['-100:7', '⏰ Remind me to stretch']])
  expect(loadJobs(d)[0]).toMatchObject({ lastRun: 1000, lastStatus: 'ok', failures: 0 })
})

test('errors and denied permissions are recorded', async () => {
  const d = dir()
  saveJobs(d, [{ ...base, id: 'j_3', kind: 'cron', expr: '0 9 * * *' }])
  expect(await runJob('j_3', deps(d, { result: result({ is_error: true }), exitCode: 1 }).r)).toBe('error')
  expect(loadJobs(d)[0]).toMatchObject({ lastStatus: 'error', failures: 1 })
  expect(await runJob('j_3', deps(d, { result: result({ permission_denials: [{ tool_name: 'Bash' }] }), exitCode: 0 }).r)).toBe('needs_approval')
  expect(loadJobs(d)[0]).toMatchObject({ lastStatus: 'needs_approval', failures: 1 })
})

test('AC5: a job that always fails is disabled after 3 runs and the owner is told each time', async () => {
  const d = dir()
  saveJobs(d, [{ ...base, id: 'j_5', kind: 'cron', expr: '0 9 * * *', title: 'Broken' }])
  const notices: { enabled: boolean; text: string; buttons: string[] }[] = []
  const { r } = deps(d, { result: result({ is_error: true, errors: ['boom'] }), exitCode: 1 })
  r.onFailure = (job, reason) => {
    const n = failureNotice(job, reason)
    notices.push({ enabled: job.enabled, text: n.text, buttons: n.keyboard.inline_keyboard[0]!.map(b => b.callback_data) })
  }
  for (let i = 0; i < 4; i++) await runJob('j_5', r)
  expect(notices.map(n => n.enabled)).toEqual([true, true, false])
  expect(notices[0]).toEqual({ enabled: true, text: '⚠️ Scheduled job j_5 "Broken" failed: boom', buttons: ['sch:retry:j_5', 'sch:off:j_5'] })
  expect(notices[2]!.text).toEndWith('Disabled after 3 failures in a row.')
  expect(notices[2]!.buttons).toEqual(['sch:retry:j_5'])
  expect(loadJobs(d)[0]).toMatchObject({ enabled: false, failures: 3, lastStatus: 'error' })
})

test('a usage-limit stop is deferred, not a failure', async () => {
  const d = dir()
  saveJobs(d, [{ ...base, id: 'j_6', kind: 'cron', expr: '0 9 * * *', failures: 2 }])
  const { r } = deps(d, { pausedUntil: 5000, result: result({ is_error: true }), exitCode: 1 })
  let failed = false
  r.onFailure = () => { failed = true }
  expect(await runJob('j_6', r)).toBe('deferred')
  expect(failed).toBe(false)
  expect(loadJobs(d)[0]).toMatchObject({ enabled: true, failures: 2, lastStatus: 'deferred' })
})

test('disabled or missing jobs do not run', async () => {
  const d = dir()
  saveJobs(d, [{ ...base, id: 'j_4', kind: 'cron', expr: '0 9 * * *', enabled: false }])
  const { r, turns } = deps(d, { exitCode: 0 })
  expect(await runJob('j_4', r)).toBeUndefined()
  expect(await runJob('nope', r)).toBeUndefined()
  expect(turns).toEqual([])
})

test('policyOverride only narrows', () => {
  const group = { allowedTools: ['Read', 'Grep'], permissionMode: 'default' as const, maxTurns: 10, schedulerAllowed: true }
  expect(narrowPolicy(group, { allowedTools: ['Read', 'Bash'], permissionMode: 'bypassPermissions', maxTurns: 50, schedulerAllowed: true, cwd: '/' }))
    .toEqual({ ...group, allowedTools: ['Read'] })
  expect(narrowPolicy(group, { permissionMode: 'plan', maxTurns: 3, disallowedTools: ['WebFetch'], schedulerAllowed: false }))
    .toEqual({ ...group, permissionMode: 'plan', maxTurns: 3, disallowedTools: ['WebFetch'], schedulerAllowed: false })
  expect(narrowPolicy({}, { allowedTools: ['Read'] })).toEqual({ allowedTools: ['Read'] })
})
