import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { chatJobs, deleteJob, setJobEnabled } from '../scheduler/manage'
import { loadJobs, saveJobs, type Job } from '../scheduler/store'

const job = (id: string, sessionKey: string, over: Partial<Job> = {}): Job => ({
  id, kind: 'cron', expr: '0 8 * * *', tz: 'UTC', prompt: 'p', sessionKey,
  mode: 'fresh', enabled: true, createdBy: '1', createdAt: 0, lastRun: null, lastStatus: null, nextRun: null, failures: 0,
  ...over,
} as Job)

test('list per chat, pause, resume with a clean failure count, delete', () => {
  const d = mkdtempSync(join(tmpdir(), 'tg-manage-'))
  saveJobs(d, [job('j_a', '1'), job('j_b', '-100', { enabled: false, failures: 3 })])
  expect(chatJobs(d, '1').map(j => j.id)).toEqual(['j_a'])
  expect(setJobEnabled(d, 'j_a', false)!.enabled).toBe(false)
  expect(loadJobs(d)[1]!.failures).toBe(3)
  expect(setJobEnabled(d, 'j_b', true)).toMatchObject({ enabled: true, failures: 0 })
  expect(loadJobs(d).find(j => j.id === 'j_b')).toMatchObject({ enabled: true, failures: 0 })
  expect(deleteJob(d, 'j_a')!.id).toBe('j_a')
  expect(deleteJob(d, 'j_a')).toBeNull()
  expect(setJobEnabled(d, 'j_x', true)).toBeNull()
  expect(loadJobs(d).map(j => j.id)).toEqual(['j_b'])
})
