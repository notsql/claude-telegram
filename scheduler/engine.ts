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

/** FR7: missed runs younger than this run once on boot. */
export const CATCH_UP_WINDOW_MS = 6 * 60 * 60 * 1000

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

  /**
   * FR7: start up after downtime. A job whose stored `nextRun` passed less
   * than `window` ago runs once; older misses are skipped and noted in
   * `lastStatus` (a missed one-off is also disabled, as it can never run).
   */
  function boot(window = CATCH_UP_WINDOW_MS, now = Date.now()): { due: string[]; missed: string[] } {
    const jobs = loadJobs(opts.stateDir)
    const due: string[] = []
    const missed: string[] = []
    for (const job of jobs) {
      if (!job.enabled || job.nextRun == null || job.nextRun > now) continue
      if (now - job.nextRun < window) {
        due.push(job.id)
      } else {
        missed.push(job.id)
        job.lastStatus = 'missed'
        if (job.kind === 'at') job.enabled = false
      }
    }
    if (missed.length) saveJobs(opts.stateDir, jobs)
    reload()
    for (const id of due) opts.fire(id)
    return { due, missed }
  }

  return { boot, reload, stop, scheduled: () => [...crons.keys()] }
}

export type Engine = ReturnType<typeof createEngine>
