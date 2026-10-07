/**
 * Skill usage (006 FR7, FR8) in `skills-usage.json`: per learned skill, how
 * often it was invoked, when last, and how those runs went. Invocations come
 * from the `PostToolUse` hook (matcher `Skill`); outcomes come from the
 * reflection pass. More than REFINE_AFTER - 1 failed or corrected outcomes
 * since the last refinement trigger a refinement proposal.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export const OUTCOMES = ['success', 'corrected', 'failed'] as const
export type Outcome = typeof OUTCOMES[number]
export const REFINE_AFTER = 3

export type SkillUsage = {
  count: number
  last_used?: string
  outcomes: Record<Outcome, number>
  /** Failed or corrected runs since the last refinement. */
  bad_since_refine: number
}

export function createSkillUsage(file: string) {
  const load = (): Record<string, SkillUsage> => {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
  }
  const save = (all: Record<string, SkillUsage>) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  const entry = (all: Record<string, SkillUsage>, name: string) =>
    (all[name] ??= { count: 0, outcomes: { success: 0, corrected: 0, failed: 0 }, bad_since_refine: 0 })

  return {
    all: load,
    get: (name: string): SkillUsage | undefined => load()[name],

    invoked(name: string, now = new Date()): void {
      const all = load()
      const e = entry(all, name)
      e.count++
      e.last_used = now.toISOString()
      save(all)
    },

    /** Records a run's outcome; true when it is time to refine the skill (the counter then resets). */
    outcome(name: string, outcome: Outcome): boolean {
      const all = load()
      const e = entry(all, name)
      e.outcomes[outcome]++
      if (outcome !== 'success') e.bad_since_refine++
      const refine = e.bad_since_refine >= REFINE_AFTER
      if (refine) e.bad_since_refine = 0
      save(all)
      return refine
    },
  }
}

export type SkillUsageStore = ReturnType<typeof createSkillUsage>

/** The skill a `PostToolUse` payload invoked, or undefined when it is not a `Skill` call. Plugin prefixes are dropped. */
export function invokedSkill(payload: Record<string, unknown>): string | undefined {
  if (payload.tool_name !== 'Skill') return undefined
  const skill = (payload.tool_input as { skill?: unknown } | undefined)?.skill
  return typeof skill === 'string' ? skill.trim().split(/\s/)[0]!.split(':').pop() : undefined
}
