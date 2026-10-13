/**
 * Built-in maintenance jobs (007 FR10): weekly memory consolidation (004 FR8,
 * run as tg-curator) and weekly skill pruning (006 FR8). The daemon registers
 * them here rather than in `jobs.json`, so they never show up in the agent's
 * `schedule_list`. Each run is stamped in a state file; on start a job whose
 * last run is more than a week old (the daemon was down at its slot) runs once.
 */

import { Cron } from 'croner'
import { readJson, writeAtomic } from '../util/files.ts'

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export const SYSTEM_JOBS = [
  { id: 'memory-consolidation', title: 'Weekly memory consolidation', expr: '0 3 * * 0' },
  { id: 'skill-pruning', title: 'Weekly skill pruning', expr: '30 3 * * 0' },
  // 013 FR8: only when source watchers are on.
  { id: 'digest-morning', title: 'Morning digest', expr: '30 8 * * *', watch: true },
  { id: 'digest-evening', title: 'Evening digest', expr: '30 18 * * *', watch: true },
  // 013 FR14: before the morning digest, and once after lunch.
  { id: 'attention-sweep', title: 'Attention sweep', expr: '0 8,13 * * *', watch: true },
] as const

export type SystemJobId = (typeof SYSTEM_JOBS)[number]['id']

export type SystemJobOpts = {
  /** `{ [id]: lastRunMs }`. */
  stateFile: string
  tz: string
  /** 013 FR12: registers the `watch` jobs (digests, sweep) only when true. */
  watch?: boolean
  run: (id: SystemJobId) => unknown
  now?: () => number
}

export function startSystemJobs(opts: SystemJobOpts) {
  const now = () => opts.now?.() ?? Date.now()
  const state = readJson<Record<string, number>>(opts.stateFile) ?? {}
  const save = () => writeAtomic(opts.stateFile, JSON.stringify(state) + '\n')
  const fire = (id: SystemJobId) => {
    state[id] = now()
    save()
    opts.run(id)
  }

  const caughtUp: SystemJobId[] = []
  const jobs = SYSTEM_JOBS.filter(j => !('watch' in j) || opts.watch)
  const crons = jobs.map(j => {
    const last = state[j.id]
    // First start: count from now rather than running straight away.
    if (last === undefined) { state[j.id] = now(); save() }
    else if (now() - last >= WEEK_MS) caughtUp.push(j.id)
    return new Cron(j.expr, { timezone: opts.tz, protect: true }, () => fire(j.id))
  })
  for (const id of caughtUp) fire(id)

  return {
    caughtUp,
    nextRun: (id: SystemJobId) => crons[jobs.findIndex(j => j.id === id)]?.nextRun() ?? null,
    stop: () => { for (const c of crons) c.stop() },
  }
}
