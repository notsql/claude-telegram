/**
 * Job operations behind the 008 `/cron` inline manager (007 US5) and the
 * failure notice buttons (FR8). Callers reload the engine after a change.
 */

import { loadJobs, saveJobs, type Job } from './store.ts'

export const chatJobs = (stateDir: string, key: string): Job[] => loadJobs(stateDir).filter(j => j.sessionKey === key)

/** Pauses or resumes a job; resuming clears its failure count. Null if it is gone. */
export function setJobEnabled(stateDir: string, id: string, enabled: boolean): Job | null {
  const jobs = loadJobs(stateDir)
  const job = jobs.find(j => j.id === id)
  if (!job) return null
  job.enabled = enabled
  if (enabled) job.failures = 0
  saveJobs(stateDir, jobs)
  return job
}

/** Removes a job and returns it, or null if it was already gone. */
export function deleteJob(stateDir: string, id: string): Job | null {
  const jobs = loadJobs(stateDir)
  const job = jobs.find(j => j.id === id)
  if (!job) return null
  saveJobs(stateDir, jobs.filter(j => j !== job))
  return job
}
