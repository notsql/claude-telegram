import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createEngine } from '../scheduler/engine'
import { loadJobs, saveJobs, type Job } from '../scheduler/store'

const dir = () => mkdtempSync(join(tmpdir(), 'tg-engine-'))
const job = (over: Partial<Job> = {}): Job => ({
  id: 'j_1', kind: 'cron', expr: '* * * * * *', tz: 'Asia/Singapore', prompt: 'p', sessionKey: '1',
  mode: 'fresh', enabled: true, createdBy: '1', createdAt: 0, lastRun: null, lastStatus: null, nextRun: null, failures: 0,
  ...over,
} as Job)

test('a job fires on a short interval and its nextRun is stored', async () => {
  const d = dir()
  saveJobs(d, [job()])
  const fired: string[] = []
  const engine = createEngine({ stateDir: d, fire: id => fired.push(id) })
  engine.reload()
  expect(loadJobs(d)[0]!.nextRun).toBeGreaterThan(Date.now() - 1000)
  await new Promise(r => setTimeout(r, 2100))
  engine.stop()
  expect(fired.length).toBeGreaterThanOrEqual(1)
  expect(fired[0]).toBe('j_1')
})

test('reload picks up changes: disabled jobs and past one-offs are not scheduled', () => {
  const d = dir()
  saveJobs(d, [job()])
  const engine = createEngine({ stateDir: d, fire: () => {} })
  engine.reload()
  expect(engine.scheduled()).toEqual(['j_1'])
  saveJobs(d, [
    job({ enabled: false }),
    { ...job({ id: 'j_2' }), kind: 'at', at: '2020-01-01T00:00:00Z' } as Job,
    { ...job({ id: 'j_3' }), kind: 'at', at: '2099-01-01T08:00:00' } as Job,
  ])
  engine.reload()
  expect(engine.scheduled()).toEqual(['j_3'])
  const jobs = loadJobs(d)
  expect(jobs.map(j => j.nextRun)).toEqual([null, null, Date.parse('2099-01-01T00:00:00Z')])
  engine.stop()
})
