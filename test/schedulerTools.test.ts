import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createScheduleTools } from '../scheduler/tools'
import { runJob } from '../scheduler/run'
import { loadJobs } from '../scheduler/store'
import { resolvePolicy } from '../policy/resolve'
import { policyArgs } from '../policy/args'
import type { Policy } from '../policy/schema'
import type { Access } from '../access'

const setup = () => {
  const d = mkdtempSync(join(tmpdir(), 'tg-sched-tools-'))
  const calls = { reload: 0, runNow: [] as string[] }
  const tools = createScheduleTools({
    stateDir: d,
    reload: () => calls.reload++,
    runNow: id => calls.runNow.push(id),
    now: () => new Date('2026-10-07T04:00:00Z'),
  })
  return { d, tools, calls }
}
const access = (chats: Access['chats'] = {}) => ({ allowFrom: ['1'], groups: {}, pending: {}, dmPolicy: 'allowlist', chats }) as unknown as Access
const out = (r: { content: { text: string }[] } | undefined) => r!.content[0]!.text

test('AC6: no scheduling tools where schedulerAllowed is false; calls are refused', () => {
  const { tools } = setup()
  const group = resolvePolicy(access(), '-100', 'group')
  expect(tools.list(group)).toEqual([])
  expect(tools.call('schedule_list', {}, '-100', group)!.isError).toBe(true)
  const dm = resolvePolicy(access(), '1', 'private')
  expect(tools.list(dm).map(t => t.name)).toEqual(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete', 'schedule_run_now'])
  expect(tools.list(dm)[0]).not.toHaveProperty('requires')
  expect(tools.call('memory_write', {}, '1', dm)).toBeUndefined()
})

test('create echoes the schedule in words; list, update, run now and delete stay in the chat', () => {
  const { d, tools, calls } = setup()
  const p: Policy = { schedulerAllowed: true }
  const created = out(tools.call('schedule_create', { when: '30 8 * * 1-5', prompt: 'Summarise notifications', title: 'Briefing', tz: 'Asia/Singapore' }, '1', p))
  expect(created).toContain('Every weekday at 08:30 (Asia/Singapore)\nNext runs:\n• Thu 8 Oct 2026, 08:30')
  const [job] = loadJobs(d)
  expect(job).toMatchObject({ kind: 'cron', expr: '30 8 * * 1-5', tz: 'Asia/Singapore', sessionKey: '1', mode: 'fresh', enabled: true })
  expect(calls.reload).toBe(1)
  expect(out(tools.call('schedule_list', {}, '-100', p))).toBe('No scheduled jobs in this chat.')
  expect(tools.call('schedule_delete', { id: job!.id }, '-100', p)!.isError).toBe(true)
  expect(out(tools.call('schedule_update', { id: job!.id, when: '0 9 * * *', enabled: false }, '1', p))).toContain('(paused): Every day at 09:00')
  expect(loadJobs(d)[0]).toMatchObject({ expr: '0 9 * * *', enabled: false, prompt: 'Summarise notifications' })
  tools.call('schedule_run_now', { id: job!.id }, '1', p)
  expect(calls.runNow).toEqual([job!.id])
  tools.call('schedule_delete', { id: job!.id }, '1', p)
  expect(loadJobs(d)).toEqual([])
})

test('one-offs, bad input', () => {
  const { d, tools } = setup()
  const p: Policy = { schedulerAllowed: true }
  expect(out(tools.call('schedule_create', { when: '2026-10-07T12:02:00', prompt: 'stretch', tz: 'Asia/Singapore' }, '1', p))).toContain('Once, Wed 7 Oct 2026, 12:02')
  expect(loadJobs(d)[0]).toMatchObject({ kind: 'at', at: '2026-10-07T12:02:00' })
  expect(out(tools.call('schedule_create', { when: '2020-01-01T00:00:00', prompt: 'x' }, '1', p))).toContain('in the past')
  expect(out(tools.call('schedule_create', { when: 'every weekday', prompt: 'x' }, '1', p))).toContain('Invalid when')
  expect(out(tools.call('schedule_create', { when: '0 9 * * *', prompt: 'x', tz: 'Mars/Base' }, '1', p))).toContain('Unknown timezone')
  expect(tools.call('schedule_create', { when: '0 9 * * *', prompt: 'x', policyOverride: { permissionMode: 'yolo' } }, '1', p)!.isError).toBe(true)
})

test('AC3: a job from a read-only group cannot widen to Bash', async () => {
  const { d, tools } = setup()
  const a = access({ '-100': { policy: { schedulerAllowed: true } } })
  const policyOf = (key: string) => resolvePolicy(a, key, 'group')
  tools.call('schedule_create', {
    when: '0 9 * * *', prompt: 'Run `rm -rf /tmp/x` with Bash',
    policyOverride: { allowedTools: ['Read', 'Bash'], permissionMode: 'bypassPermissions' },
  }, '-100', policyOf('-100'))
  let used: Policy | undefined
  await runJob(loadJobs(d)[0]!.id, {
    stateDir: d,
    policy: policyOf,
    turn: async (_j, _p, policy) => { used = policy; return { exitCode: 0 } },
    post: async () => {},
  })
  expect(used!.allowedTools).toEqual(['Read'])
  expect(used!.permissionMode).toBe('default')
  expect(policyArgs(used!)).not.toContain('Bash')
})
