/**
 * Archive pruning (006 FR8): a weekly pass proposes archiving hermes skills
 * unused for STALE_DAYS. "Unused" goes by the last invocation, else the last
 * update. Archiving moves the skill to `<root>/.archive/`. 007's system jobs
 * (T708) will own the schedule; until then the daemon checks daily and runs
 * the pass when WEEK_MS has passed since the last one.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { SkillStore } from './store.ts'
import type { SkillUsageStore } from './usage.ts'

export const STALE_DAYS = 60
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Hermes skills not used (or, never used, not updated) for `days`, oldest first. */
export function staleSkills(store: SkillStore, usage: Pick<SkillUsageStore, 'all'>, now = Date.now(), days = STALE_DAYS): string[] {
  const used = usage.all()
  return store.list()
    .filter(s => s.metadata.source === 'hermes')
    .map(s => ({ name: s.name, at: Date.parse(used[s.name]?.last_used ?? s.metadata.updated ?? s.metadata.created ?? '') }))
    .filter(s => Number.isFinite(s.at) && now - s.at > days * DAY_MS)
    .sort((a, b) => a.at - b.at)
    .map(s => s.name)
}

/** True when the weekly pass is due; records `now` as the last run when it is. */
export function pruneDue(stateFile: string, now = Date.now()): boolean {
  let last: number | undefined
  try { last = JSON.parse(readFileSync(stateFile, 'utf8')).lastPrune } catch {}
  if (last !== undefined && now - last < WEEK_MS) return false
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ lastPrune: now }) + '\n')
  return true
}
