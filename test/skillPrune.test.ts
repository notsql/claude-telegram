import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSkillStore } from '../skills/store'
import { pruneDue, staleSkills, WEEK_MS } from '../skills/prune'

const skill = (root: string, name: string, meta: string) => {
  mkdirSync(join(root, name))
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\nmetadata:\n${meta}\n---\n## Steps\n1.\n`)
}

test('stale: learned skills unused for 60 days, by last use else last update', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-prune-'))
  skill(root, 'old', '  source: tg\n  updated: 2026-06-01')
  skill(root, 'old-but-used', '  source: tg\n  updated: 2026-06-01')
  skill(root, 'fresh', '  source: tg\n  updated: 2026-10-01')
  skill(root, 'mine', '  updated: 2026-01-01')
  const usage = { all: () => ({ 'old-but-used': { count: 1, last_used: '2026-09-30T00:00:00Z', outcomes: { success: 1, corrected: 0, failed: 0 }, bad_since_refine: 0 } }) }
  expect(staleSkills(createSkillStore(root), usage, Date.parse('2026-10-07'))).toEqual(['old'])
})

test('the pass runs once a week', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tg-prune-')), 'skills-prune.json')
  expect(pruneDue(file, 1_000)).toBe(true)
  expect(pruneDue(file, 2_000)).toBe(false)
  expect(pruneDue(file, 1_000 + WEEK_MS)).toBe(true)
})
