import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assign, discoverSkills, loadTable, normalise, saveTable } from '../commands/skillMap'

const tmp = () => mkdtempSync(join(tmpdir(), 'tg-skills-'))
const skill = (dir: string, fm: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}\n---\nbody\n`)
}

test('normalise maps to the Telegram charset and truncates to 32', () => {
  expect(normalise('deploy-blog')).toBe('deploy_blog')
  expect(normalise('telegram:access')).toBe('telegram_access')
  expect(normalise('very-long-skill-name-exceeding-32-chars')).toBe('very_long_skill_name_exceeding_3')
})

test('AC4: two skills that normalise to the same name both get distinct commands', () => {
  const t = assign({}, ['deploy-blog', 'deploy_blog', 'Deploy:Blog'])
  expect(new Set(Object.values(t)).size).toBe(3)
  expect(t).toEqual({ 'Deploy:Blog': 'deploy_blog', 'deploy-blog': 'deploy_blog_2', 'deploy_blog': 'deploy_blog_3' })
})

test('suffix keeps long names within 32 chars', () => {
  const t = assign({}, ['very-long-skill-name-exceeding-32-chars', 'very-long-skill-name-exceeding-32-other'])
  expect(Object.values(t).sort()).toEqual(['very_long_skill_name_exceeding_3', 'very_long_skill_name_exceeding_2'].sort())
  for (const c of Object.values(t)) expect(c).toMatch(/^[a-z0-9_]{1,32}$/)
})

test('assignments persist and stay stable; built-ins are reserved', () => {
  const file = join(tmp(), 'commands.json')
  saveTable(file, assign({}, ['deploy_blog']))
  const t = assign(loadTable(file), ['deploy-blog', 'deploy_blog', 'status'], ['status'])
  expect(t).toEqual({ deploy_blog: 'deploy_blog', 'deploy-blog': 'deploy_blog_2', status: 'status_2' })
  expect(loadTable(join(tmp(), 'missing.json'))).toEqual({})
})

test('discovers user, project and plugin skills; skips user-invocable: false', () => {
  const home = tmp(), cwd = tmp()
  skill(join(home, 'skills', 'deploy'), 'name: deploy-blog\ndescription: "Ship the blog"')
  skill(join(home, 'skills', 'hidden'), 'name: hidden\nuser-invocable: false')
  skill(join(cwd, '.claude', 'skills', 'lint'), 'description: Lint it')
  skill(join(home, 'plugins', 'cache', 'mkt', 'telegram', '1.0.0', 'skills', 'access'), 'name: access\ndescription: Manage access')
  const got = discoverSkills(home, [cwd]).map(({ name, description }) => ({ name, description }))
  expect(got).toEqual([
    { name: 'deploy-blog', description: 'Ship the blog' },
    { name: 'lint', description: 'Lint it' },
    { name: 'telegram:access', description: 'Manage access' },
  ])
})
