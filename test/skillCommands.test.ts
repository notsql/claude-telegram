import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSkillStore } from '../skills/store'
import { listSkills, parseSkillsArgs, skillAction } from '../skills/commands'

const setup = () => {
  const store = createSkillStore(mkdtempSync(join(tmpdir(), 'tg-skc-')))
  store.create({ name: 'deploy-blog', description: 'Deploy the blog.', sections: { Steps: '1. build' } })
  store.create({ name: 'tidy-notes', description: 'Tidy notes.', sections: { Steps: '1. tidy' } })
  return store
}

test('/skills lists with show, archive and remove buttons', () => {
  const r = listSkills(setup())
  expect(r.text).toBe('• deploy-blog (learned): Deploy the blog.\n• tidy-notes (learned): Tidy notes.')
  expect(r.keyboard!.inline_keyboard[0]!.map(b => 'callback_data' in b && b.callback_data)).toEqual(['skc:show:deploy-blog', 'skc:arch:deploy-blog', 'skc:rm:deploy-blog'])
  expect(listSkills(createSkillStore(mkdtempSync(join(tmpdir(), 'tg-skc-')))).text).toBe('No skills yet.')
})

test('show, archive and remove', () => {
  const store = setup()
  expect(skillAction(store, 'show', 'deploy-blog').text).toContain('name: deploy-blog')
  expect(skillAction(store, 'arch', 'deploy-blog')).toEqual({ text: '📦 Archived deploy-blog', changes: true })
  expect(skillAction(store, 'rm', 'tidy-notes').changes).toBe(true)
  expect(existsSync(join(store.root, 'tidy-notes'))).toBe(false)
  expect(skillAction(store, 'show', 'deploy-blog').text).toBe('No skill named deploy-blog.')
})

test('argument parsing', () => {
  expect(parseSkillsArgs('')).toBe('list')
  expect(parseSkillsArgs('show deploy-blog')).toEqual({ action: 'show', name: 'deploy-blog' })
  expect(parseSkillsArgs('rm')).toBeUndefined()
  expect(parseSkillsArgs('nuke x')).toBeUndefined()
})
