import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSkillStore, patchSections } from '../skills/store'

const root = () => mkdtempSync(join(tmpdir(), 'tg-skills-'))
const draft = {
  name: 'deploy-blog',
  description: 'Build and deploy the blog. Use when asked to publish the blog.',
  sections: { Steps: '1. pnpm build\n2. wrangler pages deploy', 'When to use': 'Publishing the blog.' },
  extra: [['argument-hint', '"[staging|prod]"']] as [string, string][],
  metadata: { created_from: 'sess-1', session_key: '123' },
}

test('create writes a hermes SKILL.md at version 1 with sections in template order', () => {
  const s = createSkillStore(root())
  const r = s.create(draft)
  expect(r).toMatchObject({ op: 'create', version: 1 })
  const text = s.text('deploy-blog')!
  expect(text).toContain('argument-hint: "[staging|prod]"')
  expect(text.indexOf('## When to use')).toBeLessThan(text.indexOf('## Steps'))
  expect(s.read('deploy-blog')!.metadata).toMatchObject({ source: 'hermes', version: '1', created_from: 'sess-1' })
  expect(() => s.create(draft)).toThrow('already exists')
  expect(() => s.create({ ...draft, name: 'Bad' })).toThrow('must match')
  expect(() => s.create({ ...draft, name: 'x', sections: { Steps: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123' } })).toThrow('secrets')
})

test('patch replaces only named sections, backs up and bumps version; undo restores', () => {
  const s = createSkillStore(root())
  s.create(draft)
  const r = s.patch('deploy-blog', { sections: { Pitfalls: 'Run pnpm install first.', Steps: '1. pnpm i\n2. pnpm build' } })
  expect(r.version).toBe(2)
  const sk = s.read('deploy-blog')!
  expect(sk.body).toContain('Publishing the blog.')
  expect(sk.body).toContain('1. pnpm i')
  expect(sk.body.indexOf('## Steps')).toBeLessThan(sk.body.indexOf('## Pitfalls'))
  expect(existsSync(join(sk.dir, '.bak', '1.md'))).toBe(true)
  expect(s.undo('deploy-blog')).toBe(true)
  expect(s.read('deploy-blog')!.metadata.version).toBe('1')
  expect(s.read('deploy-blog')!.body).not.toContain('Pitfalls')
  expect(s.undo('deploy-blog')).toBe(false)
})

test('non-hermes skills are only patched with foreign: true; archive moves the dir', () => {
  const r = root()
  mkdirSync(join(r, 'mine'))
  writeFileSync(join(r, 'mine', 'SKILL.md'), '---\nname: mine\ndescription: My own\n---\n## Steps\nold\n')
  const s = createSkillStore(r)
  expect(() => s.patch('mine', { sections: { Steps: 'new' } })).toThrow('not written by hermes')
  s.patch('mine', { sections: { Steps: 'new' } }, { foreign: true })
  expect(readFileSync(join(r, 'mine', 'SKILL.md'), 'utf8')).toContain('new')
  expect(s.list().map(x => x.name)).toEqual(['mine'])
  s.archive('mine')
  expect(s.list()).toEqual([])
  expect(existsSync(join(r, '.archive', 'mine', 'SKILL.md'))).toBe(true)
})

test('patchSections keeps unknown sections after the template ones', () => {
  expect(patchSections('intro\n\n## Notes\nn\n\n## Steps\ns', { Verify: 'v' })).toBe('intro\n\n## Steps\ns\n\n## Verify\nv\n\n## Notes\nn')
})
