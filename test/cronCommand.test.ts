import { expect, test } from 'bun:test'
import { CRON_CALLBACK, cronView } from '../commands/cron'
import type { Job } from '../scheduler/store'

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id, kind: 'cron', expr: '30 8 * * 1-5', tz: 'Asia/Singapore', title: 'Briefing', prompt: 'p', sessionKey: '1',
  mode: 'fresh', enabled: true, createdBy: '1', createdAt: 0, lastRun: null, lastStatus: null, nextRun: null, failures: 0,
  ...over,
} as Job)

test('empty chat has no keyboard', () => {
  expect(cronView([])).toEqual({ text: expect.stringContaining('No scheduled jobs') })
})

test('one row per job: pause or resume, delete, run now; data round-trips through the callback pattern', () => {
  const v = cronView([job('j_aa'), job('j_bb', { enabled: false, lastStatus: 'error' })], new Date('2026-10-07T04:00:00Z'))
  expect(v.text).toContain('j_aa "Briefing"\nEvery weekday at 08:30 (Asia/Singapore)')
  expect(v.text).toContain('⏸ j_bb "Briefing" (last: error)')
  const rows = v.keyboard!.inline_keyboard
  expect(rows.map(r => r.map(b => b.callback_data))).toEqual([
    ['crn:pause:j_aa', 'crn:del:j_aa', 'crn:run:j_aa'],
    ['crn:resume:j_bb', 'crn:del:j_bb', 'crn:run:j_bb'],
  ])
  for (const b of rows.flat()) expect(CRON_CALLBACK.test(b.callback_data)).toBe(true)
  expect(CRON_CALLBACK.test('crn:del:../x')).toBe(false)
})
