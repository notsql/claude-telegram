import { expect, test } from 'bun:test'
import { CRON_CALLBACK, CRON_NEW_CALLBACK, cronView, newJobView, whenFor } from '../commands/cron'
import type { Job } from '../scheduler/store'

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id, kind: 'cron', expr: '30 8 * * 1-5', tz: 'Asia/Singapore', title: 'Briefing', prompt: 'p', sessionKey: '1',
  mode: 'fresh', enabled: true, createdBy: '1', createdAt: 0, lastRun: null, lastStatus: null, nextRun: null, failures: 0,
  ...over,
} as Job)

test('empty chat offers only New job', () => {
  expect(cronView([]).text).toContain('No scheduled jobs')
})

test('one row per job: pause or resume, delete, run now; data round-trips through the callback pattern', () => {
  const v = cronView([job('j_aa'), job('j_bb', { enabled: false, lastStatus: 'error' })], new Date('2026-10-07T04:00:00Z'))
  expect(v.text).toContain('j_aa "Briefing"\nEvery weekday at 08:30 (Asia/Singapore)')
  expect(v.text).toContain('⏸ j_bb "Briefing" (last: error)')
  const rows = v.keyboard!.inline_keyboard
  expect(rows.map(r => r.map(b => b.callback_data))).toEqual([
    ['crn:pause:j_aa', 'crn:del:j_aa', 'crn:run:j_aa'],
    ['crn:resume:j_bb', 'crn:del:j_bb', 'crn:run:j_bb'],
    ['crn:w:'],
  ])
  for (const b of rows.slice(0, -1).flat()) expect(CRON_CALLBACK.test(b.callback_data)).toBe(true)
  expect(CRON_CALLBACK.test('crn:del:../x')).toBe(false)
})

test('New job steps: how often, day for weekly, hour, then ready', () => {
  const data = (v: ReturnType<typeof newJobView>) => v === 'ready' ? 'ready' : v.keyboard.inline_keyboard.flat().map(b => b.callback_data)
  const first = data(newJobView(''))
  expect(first).toEqual(['crn:w:once', 'crn:w:daily', 'crn:w:wkdy', 'crn:w:weekly', 'crn:w:hourly', 'crn:list:'])
  expect(data(newJobView('hourly'))).toBe('ready')
  expect(data(newJobView('weekly'))).toContain('crn:w:weekly.1')
  expect(data(newJobView('weekly.1'))).toContain('crn:w:weekly.1@09')
  expect(data(newJobView('weekly.1@09'))).toBe('ready')
  for (const d of [...first, ...data(newJobView('weekly')), ...data(newJobView('daily'))] as string[]) {
    expect(CRON_NEW_CALLBACK.test(d)).toBe(true)
  }
  expect(cronView([]).keyboard.inline_keyboard[0]![0]!.callback_data).toBe('crn:w:')
})

test('whenFor turns a spec into a cron expression or the next local time', () => {
  expect(whenFor('wkdy@08')).toEqual({ when: '0 8 * * 1-5', label: 'every weekday at 08:00' })
  expect(whenFor('weekly.1@09').when).toBe('0 9 * * 1')
  expect(whenFor('hourly').when).toBe('0 * * * *')
  const now = new Date(2026, 9, 8, 10, 30)
  expect(whenFor('once@18', now)).toEqual({ when: '2026-10-08T18:00:00', label: 'once, today at 18:00' })
  expect(whenFor('once@09', now)).toEqual({ when: '2026-10-09T09:00:00', label: 'once, tomorrow at 09:00' })
})
