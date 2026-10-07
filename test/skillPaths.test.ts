import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { nameRefusal, skillsRoot, takenNames, userSkillsRoot, validName } from '../skills/paths'

const skill = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`)
}

test('roots: user by default, project when skillScope is project and cwd is set', () => {
  expect(skillsRoot({}, '/c', '/h')).toBe('/c/skills')
  expect(skillsRoot({ skillScope: 'project' }, '/c', '/h')).toBe('/c/skills')
  expect(skillsRoot({ skillScope: 'project', cwd: '~/blog' }, '/c', '/h')).toBe('/h/blog/.claude/skills')
})

test('names: [a-z0-9-]{1,48}', () => {
  expect(validName('deploy-blog')).toBe(true)
  for (const bad of ['', 'Deploy', 'a_b', 'a'.repeat(49), '../x']) expect(validName(bad)).toBe(false)
})

test('collisions: built-ins, plugin skills by bare name and other roots, but not the target root', () => {
  const base = mkdtempSync(join(tmpdir(), 'tg-skp-'))
  const cwd = mkdtempSync(join(tmpdir(), 'tg-skp-cwd-'))
  skill(join(userSkillsRoot(base), 'mine'), 'mine')
  skill(join(cwd, '.claude', 'skills', 'proj'), 'proj')
  skill(join(base, 'plugins', 'cache', 'mkt', 'telegram', '1.0', 'skills', 'access'), 'access')
  const taken = takenNames(userSkillsRoot(base), [cwd], base)
  expect(taken.has('mine')).toBe(false)
  expect(taken.has('proj')).toBe(true)
  expect(nameRefusal('access', taken)).toContain('already used')
  expect(nameRefusal('init', taken)).toContain('already used')
  expect(nameRefusal('Bad Name', taken)).toContain('must match')
  expect(nameRefusal('deploy-blog', taken)).toBeNull()
})
