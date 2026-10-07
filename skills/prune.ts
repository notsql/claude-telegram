/**
 * Archive pruning (006 FR8): a weekly pass proposes archiving learned skills
 * unused for STALE_DAYS. "Unused" goes by the last invocation, else the last
 * update. Archiving moves the skill to `<root>/.archive/`. The schedule is
 * a 007 system job (`scheduler/system.ts`).
 */

import type { SkillStore } from './store.ts'
import type { SkillUsageStore } from './usage.ts'

export const STALE_DAYS = 60
const DAY_MS = 24 * 60 * 60 * 1000

/** Learned skills not used (or, never used, not updated) for `days`, oldest first. */
export function staleSkills(store: SkillStore, usage: Pick<SkillUsageStore, 'all'>, now = Date.now(), days = STALE_DAYS): string[] {
  const used = usage.all()
  return store.list()
    .filter(s => s.metadata.source === 'tg')
    .map(s => ({ name: s.name, at: Date.parse(used[s.name]?.last_used ?? s.metadata.updated ?? s.metadata.created ?? '') }))
    .filter(s => Number.isFinite(s.at) && now - s.at > days * DAY_MS)
    .sort((a, b) => a.at - b.at)
    .map(s => s.name)
}
