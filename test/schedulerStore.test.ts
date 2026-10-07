import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { jobsPath, loadJobs, saveJobs, type Job } from '../scheduler/store'

const dir = () => mkdtempSync(join(tmpdir(), 'tg-jobs-'))
const job: Job = {
  id: 'j_1', kind: 'cron', expr: '30 8 * * 1-5', tz: 'Asia/Singapore', title: 'Briefing',
  prompt: 'Summarise', sessionKey: '123', mode: 'fresh', enabled: true, createdBy: '123',
  createdAt: 1, lastRun: null, lastStatus: null, nextRun: 2, failures: 0,
}

test('missing file loads as no jobs', () => {
  expect(loadJobs(dir())).toEqual([])
})

test('save then load round-trips and leaves no temp file', () => {
  const d = dir()
  const { expr: _, ...base } = job as Extract<Job, { kind: 'cron' }>
  const at: Job = { ...base, id: 'j_2', kind: 'at', at: '2026-10-08T15:00:00+08:00', policyOverride: { allowedTools: ['Read'] } }
  saveJobs(d, [job, at])
  expect(loadJobs(d)).toEqual([job, at])
  expect(existsSync(`${jobsPath(d)}.tmp`)).toBe(false)
})

test('mode defaults to fresh', () => {
  const d = dir()
  const { mode: _, ...noMode } = job
  writeFileSync(jobsPath(d), JSON.stringify({ jobs: [noMode] }))
  expect(loadJobs(d)[0]!.mode).toBe('fresh')
})

test('invalid jobs are rejected on load and save', () => {
  const d = dir()
  writeFileSync(jobsPath(d), JSON.stringify({ jobs: [{ ...job, expr: undefined }] }))
  expect(() => loadJobs(d)).toThrow()
  expect(() => saveJobs(d, [{ ...job, kind: 'weekly' } as unknown as Job])).toThrow()
})
