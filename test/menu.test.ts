import { expect, test } from 'bun:test'
import { buildMenus, createMenu, type MenuScope } from '../commands/menu'

const builtins = [
  { name: 'new', description: 'Start fresh', menu: ['private', 'group'] as const },
  { name: 'memory', description: 'Show memory', menu: ['private'] as const },
  { name: 'policy', description: 'Edit policy', menu: ['private', 'admin'] as const },
].map(b => ({ ...b, menu: [...b.menu] }))

test('AC1: built-ins then skills by use; groups leave out DM-only commands', () => {
  const m = buildMenus(builtins, [
    { command: 'tidy', description: '', uses: 1 },
    { command: 'deploy_blog', description: 'Deploy the blog', uses: 9 },
  ])
  expect(m.all_private_chats.map(c => c.command)).toEqual(['new', 'memory', 'policy', 'deploy_blog', 'tidy'])
  expect(m.all_private_chats[4]!.description).toBe('Run the tidy skill')
  expect(m.all_group_chats.map(c => c.command)).toEqual(['new', 'deploy_blog', 'tidy'])
  expect(m.all_chat_administrators.map(c => c.command)).toEqual(['new', 'policy', 'deploy_blog', 'tidy'])
})

test('at most 100 commands per scope', () => {
  const skills = Array.from({ length: 150 }, (_, i) => ({ command: `s${i}`, description: 'x', uses: 0 }))
  expect(buildMenus(builtins, skills).all_private_chats).toHaveLength(100)
})

test('AC2: refreshes are debounced, spaced a minute apart, and only push changes', async () => {
  let skills = ['a']
  const pushes: string[] = []
  const menu = createMenu(
    () => buildMenus([], skills.map(command => ({ command, description: 'x', uses: 0 }))),
    async (scope: MenuScope, cmds) => { if (scope === 'all_private_chats') pushes.push(cmds.map(c => c.command).join()) },
    50,
  )
  menu.refresh()
  menu.refresh()
  await Bun.sleep(10)
  expect(pushes).toEqual(['a'])
  menu.refresh()
  await Bun.sleep(70)
  expect(pushes).toEqual(['a'])
  skills = ['a', 'b']
  menu.refresh(5)
  await Bun.sleep(8)
  expect(pushes).toEqual(['a'])
  await Bun.sleep(60)
  expect(pushes).toEqual(['a', 'a,b'])
})
