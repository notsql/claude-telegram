import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startSystemJobs, SYSTEM_JOBS, WEEK_MS } from '../scheduler/system'

const file = () => join(mkdtempSync(join(tmpdir(), 'tg-system-')), 'system-jobs.json')

test('both weekly jobs are registered in the given tz; the first start runs nothing', () => {
  const f = file()
  const ran: string[] = []
  const sys = startSystemJobs({ stateFile: f, tz: 'Asia/Singapore', run: id => ran.push(id), now: () => 1_000 })
  expect(SYSTEM_JOBS.map(j => j.id)).toEqual(['memory-consolidation', 'skill-pruning'])
  const next = sys.nextRun('memory-consolidation')!
  expect(next.toLocaleString('en-GB', { timeZone: 'Asia/Singapore', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })).toBe('Sun 03:00')
  expect(sys.nextRun('skill-pruning')!.getTime() - next.getTime()).toBe(30 * 60 * 1000)
  sys.stop()
  expect(ran).toEqual([])
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ 'memory-consolidation': 1_000, 'skill-pruning': 1_000 })
})

test('a job missed for over a week runs once on start and is stamped', () => {
  const f = file()
  writeFileSync(f, JSON.stringify({ 'memory-consolidation': 0, 'skill-pruning': WEEK_MS }))
  const ran: string[] = []
  const sys = startSystemJobs({ stateFile: f, tz: 'UTC', run: id => ran.push(id), now: () => WEEK_MS + 5 })
  sys.stop()
  expect(ran).toEqual(['memory-consolidation'])
  expect(JSON.parse(readFileSync(f, 'utf8'))['memory-consolidation']).toBe(WEEK_MS + 5)
})
