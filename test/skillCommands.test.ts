import { expect, test } from 'bun:test'
import { parseSkillsArgs, SKILLS_CALLBACK, skillsView, skillView } from '../skills/commands'

const skill = (name: string, uses = 0) => ({ name, command: name.replace(/\W/g, '_'), description: `${name} desc`, uses })

test('FR12: /skills lists every skill as buttons, most used first, paged', () => {
  const r = skillsView([skill('tidy'), skill('deploy-blog', 5)])
  expect(r.keyboard!.inline_keyboard).toEqual([[
    { text: 'deploy-blog', callback_data: 'sk:o:deploy_blog' },
    { text: 'tidy', callback_data: 'sk:o:tidy' },
  ]])
  const many = Array.from({ length: 30 }, (_, i) => skill(`s${String(i).padStart(2, '0')}`))
  const p1 = skillsView(many, 1)
  expect(p1.text).toContain('page 2/3')
  expect(p1.keyboard!.inline_keyboard.at(-1)).toEqual([{ text: '« Prev', callback_data: 'sk:p:0' }, { text: 'Next »', callback_data: 'sk:p:2' }])
  expect(skillsView([]).keyboard).toBeUndefined()
})

test('FR12: a skill opens with Run and Show; Archive and Remove only for own skills', () => {
  const data = (own: boolean) => skillView(skill('telegram:access'), own).keyboard!.inline_keyboard.flat().map(b => 'callback_data' in b ? b.callback_data : '')
  expect(data(false)).toEqual(['sk:r:telegram_access', 'sk:s:telegram_access', 'sk:p:0'])
  expect(data(true)).toEqual(['sk:r:telegram_access', 'sk:s:telegram_access', 'sk:a:telegram_access', 'sk:d:telegram_access', 'sk:p:0'])
  for (const d of data(true)) expect(SKILLS_CALLBACK.test(d)).toBe(true)
})

test('parseSkillsArgs', () => {
  expect(parseSkillsArgs(' ')).toBe('list')
  expect(parseSkillsArgs('Deploy_blog staging now')).toEqual({ command: 'deploy_blog', args: 'staging now' })
})
