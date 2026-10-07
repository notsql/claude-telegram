import { expect, test } from 'bun:test'
import { buildMenus, createMenu, type MenuScope } from '../commands/menu'

const builtins = [
  { name: 'new', description: 'Start fresh', menu: ['private', 'group'] as const },
  { name: 'memory', description: 'Show memory', menu: ['private'] as const },
  { name: 'policy', description: 'Edit policy', menu: ['private', 'admin'] as const },
].map(b => ({ ...b, menu: [...b.menu] }))

test('AC1: built-ins only, groups leave out DM-only commands; skills sit behind /skills (FR12)', () => {
  const m = buildMenus(builtins)
  expect(m.all_private_chats.map(c => c.command)).toEqual(['new', 'memory', 'policy'])
  expect(m.all_group_chats.map(c => c.command)).toEqual(['new'])
  expect(m.all_chat_administrators.map(c => c.command)).toEqual(['new', 'policy'])
})

test('AC2: refreshes are debounced, spaced a minute apart, and only push changes', async () => {
  let names = ['a']
  const pushes: string[] = []
  const menu = createMenu(
    () => buildMenus(names.map(name => ({ name, description: 'x', menu: ['private' as const] }))),
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
  names = ['a', 'b']
  menu.refresh(5)
  await Bun.sleep(8)
  expect(pushes).toEqual(['a'])
  await Bun.sleep(60)
  expect(pushes).toEqual(['a', 'a,b'])
})
