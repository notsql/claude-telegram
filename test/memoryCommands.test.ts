import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createMemoryStore } from '../memory/store'
import { userDir } from '../memory/paths'
import { forget, remember, showMemory } from '../memory/commands'

const on = { memoryScope: 'global' as const }
const fresh = () => createMemoryStore(mkdtempSync(join(tmpdir(), 'tg-mem-')))

test('/remember saves, updates a similar entry, refuses secrets, and undoes', () => {
  const s = fresh()
  const a = remember(s, 'I use pnpm, not npm', '1', on)
  expect(a.text).toBe('🧠 Saved: I use pnpm, not npm')
  expect(remember(s, 'I use pnpm not npm for JS', '1', on).change!.verb).toBe('Updated')
  expect(s.list()).toHaveLength(1)
  expect(remember(s, 'my API key sk-abcdefghijklmnopqrstuv', '1', on).text).toContain('Not saved')
  expect(remember(s, ' ', '1', on).text).toStartWith('Usage')
  a.change!.undo()
  expect(s.list()).toHaveLength(0)
})

test('/forget deletes one match, lists several, and undo restores', () => {
  const s = fresh()
  remember(s, 'I use pnpm', '1', on)
  remember(s, 'Deploys go through pnpm release', '1', on)
  expect(forget(s, 'pnpm', on).text).toStartWith('Which one?')
  const r = forget(s, 'i-use-pnpm', on)
  expect(r.text).toBe('🧠 Forgot: I use pnpm')
  expect(forget(s, 'nothing here', on).text).toContain('Nothing in memory')
  r.change!.undo()
  expect(s.read('i-use-pnpm')).toBeDefined()
})

test('/memory lists shared entries and the sender model; memoryScope none refuses all', () => {
  const s = fresh()
  remember(s, 'I use pnpm', '1', on)
  const u = createMemoryStore(userDir(s.dir, '42'))
  u.write({ type: 'user', name: 'name', description: 'Preferred name', body: 'Kai' })
  expect(showMemory(s, u, on).text).toBe('🧠 Shared memory (1):\n• i-use-pnpm (feedback): I use pnpm\n\nAbout you (1):\n• Preferred name: Kai')
  const none = { memoryScope: 'none' as const }
  for (const r of [remember(s, 'x', '1', none), forget(s, 'x', none), showMemory(s, u, none)]) expect(r.text).toContain('memoryScope: none')
})

test('008 AC5: /forget npm and the memory_delete tool leave the same store', async () => {
  const { createMemoryTools } = await import('../memory/tools')
  const viaCommand = fresh(), viaTool = fresh()
  for (const s of [viaCommand, viaTool]) {
    remember(s, 'I use pnpm, not npm', '1', on)
    remember(s, 'Deploys go out on Fridays', '1', on)
  }
  const changes: string[] = []
  const r = forget(viaCommand, 'npm', on)
  if (r.change) changes.push(r.change.verb)
  const name = viaTool.search('npm')[0]!.name
  createMemoryTools(viaTool, () => viaTool, (_k, c) => changes.push(c.verb)).call('memory_delete', { name }, '1', on)
  expect(viaCommand.list().map(e => e.name)).toEqual(viaTool.list().map(e => e.name))
  expect(viaCommand.list()).toHaveLength(1)
  expect(changes).toEqual(['Forgot', 'Forgot'])
})
