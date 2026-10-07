/**
 * Scheduler engine (007 FR2): one croner instance per enabled job, keyed by
 * job id, each in the job's explicit timezone. `reload()` rebuilds them from
 * `jobs.json` after any change and stores each job's `nextRun`. `protect`
 * keeps two runs of the same job from overlapping (FR9).
 */

import { Cron } from 'croner'
import { loadJobs, saveJobs, type Job } from './store.ts'

/** A cron expression or an ISO timestamp, as croner takes it. */
export const pattern = (job: Job) => (job.kind === 'cron' ? job.expr : job.at)

export type EngineOpts = {
  stateDir: string
  /** Called when a job is due, with its id; the caller reads the current job from the store. */
  fire: (id: string) => unknown
}

export function createEngine(opts: EngineOpts) {
  const crons = new Map<string, Cron>()

  function stop(): void {
    for (const c of crons.values()) c.stop()
    crons.clear()
  }

  function reload(): void {
    stop()
    const jobs = loadJobs(opts.stateDir)
    let changed = false
    for (const job of jobs) {
      let next: number | null = null
      if (job.enabled) {
        const cron = new Cron(pattern(job), { timezone: job.tz, protect: true }, () => { opts.fire(job.id) })
        next = cron.nextRun()?.getTime() ?? null
        if (next == null) cron.stop()
        else crons.set(job.id, cron)
      }
      if (next !== job.nextRun) {
        job.nextRun = next
        changed = true
      }
    }
    if (changed) saveJobs(opts.stateDir, jobs)
  }

  return { reload, stop, scheduled: () => [...crons.keys()] }
}

export type Engine = ReturnType<typeof createEngine>
