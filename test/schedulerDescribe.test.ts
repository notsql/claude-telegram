import { expect, test } from 'bun:test'
import { cronText, describeJob } from '../scheduler/describe'
import type { Job } from '../scheduler/store'

const base = {
  id: 'j', tz: 'Asia/Singapore', prompt: 'p', sessionKey: '1', mode: 'fresh' as const, enabled: true, createdBy: '1',
  createdAt: 0, lastRun: null, lastStatus: null, nextRun: null, failures: 0,
}
// Wed 7 Oct 2026, 12:00 in Singapore.
const from = new Date('2026-10-07T04:00:00Z')

test('AC2: every weekday at 8:30 reads back in words with tz and the next 3 runs', () => {
  const job: Job = { ...base, kind: 'cron', expr: '30 8 * * 1-5' }
  expect(describeJob(job, from)).toBe([
    'Every weekday at 08:30 (Asia/Singapore)',
    'Next runs:',
    '• Thu 8 Oct 2026, 08:30',
    '• Fri 9 Oct 2026, 08:30',
    '• Mon 12 Oct 2026, 08:30',
  ].join('\n'))
})

test('the next runs are in the job tz, not the host tz', () => {
  const job: Job = { ...base, kind: 'cron', expr: '30 8 * * 1-5', tz: 'America/New_York' }
  expect(describeJob(job, from)).toContain('• Wed 7 Oct 2026, 08:30')
})

test('common patterns in words, others raw', () => {
  expect(cronText('0 9 * * *')).toBe('Every day at 09:00')
  expect(cronText('15 * * * *')).toBe('Every hour at :15')
  expect(cronText('0 10 * * 0,6')).toBe('Every weekend day at 10:00')
  expect(cronText('0 18 * * 1,3')).toBe('Every Mon, Wed at 18:00')
  expect(cronText('0 7 1 * *')).toBe('On day 1 of every month at 07:00')
  expect(cronText('*/5 * * * *')).toBe('cron "*/5 * * * *"')
})

test('one-off jobs show their single time', () => {
  expect(describeJob({ ...base, kind: 'at', at: '2026-10-08T15:00:00+08:00' }, from)).toBe('Once, Thu 8 Oct 2026, 15:00 (Asia/Singapore)')
  expect(describeJob({ ...base, kind: 'at', at: '2020-01-01T00:00:00Z' }, from)).toContain('already past')
})
