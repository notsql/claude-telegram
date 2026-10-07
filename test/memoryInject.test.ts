import { expect, test } from 'bun:test'
import { mkdtempSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createMemoryStore } from '../memory/store'
import { memoryRoot, userDir } from '../memory/paths'
import { createInjector } from '../memory/inject'

function setup(budgetTokens?: number) {
  const store = createMemoryStore(mkdtempSync(join(tmpdir(), 'tg-mem-')))
  const inj = createInjector({ store, userStore: id => createMemoryStore(userDir(store.dir, id)), budgetTokens })
  return { store, inj, user: (id: string) => createMemoryStore(userDir(store.dir, id)) }
}
const on = { memoryScope: 'global' as const }
const ctx = (r: any) => (r.hookSpecificOutput?.additionalContext ?? '') as string
const bump = (path: string) => { const t = new Date(Date.now() + 5000); utimesSync(path, t, t) }

test('after /new, a fresh session gets the index and the sender model (AC2)', () => {
  const { store, inj, user } = setup()
  store.write({ type: 'feedback', name: 'prefers-pnpm', description: 'User uses pnpm, not npm', body: 'pnpm' })
  user('42').write({ type: 'user', name: 'name', description: 'Preferred name', body: 'Call them Kai' })
  const c = ctx(inj.sessionStart({ session_id: 's1', cwd: '/elsewhere' }, on, ['42']))
  expect(c).toContain('<memory>\n- [prefers-pnpm](prefers-pnpm.md) — User uses pnpm, not npm\n</memory>')
  expect(c).toContain('<user_model user_id="42">\n- Preferred name: Call them Kai\n</user_model>')
})

test('later prompts add only what changed; a new group participant is added once', () => {
  const { store, inj, user } = setup()
  store.write({ type: 'project', name: 'a', description: 'fact a', body: 'a' })
  user('7').write({ type: 'user', name: 'tz', description: 'Timezone', body: 'UTC+8' })
  inj.sessionStart({ session_id: 's1' }, on, ['42'])
  expect(inj.userPromptSubmit({ session_id: 's1' }, on, ['42'])).toEqual({})
  expect(ctx(inj.userPromptSubmit({ session_id: 's1' }, on, ['7', '42']))).toBe('<user_model user_id="7">\n- Timezone: UTC+8\n</user_model>')
  expect(inj.userPromptSubmit({ session_id: 's1' }, on, ['7'])).toEqual({})

  store.write({ type: 'project', name: 'b', description: 'fact b', body: 'b' })
  bump(join(store.dir, 'MEMORY.md'))
  expect(ctx(inj.userPromptSubmit({ session_id: 's1' }, on, ['7']))).toStartWith('<memory updated="true">')
  // A resume of a known session is a delta too (T401 b).
  expect(inj.sessionStart({ session_id: 's1', source: 'resume' }, on, ['7'])).toEqual({})
})

test('the workspace cwd skips the index Claude Code already loads (T401 a)', () => {
  const { store, inj } = setup()
  store.write({ type: 'project', name: 'a', description: 'fact a', body: 'a' })
  const native = { session_id: 's1', cwd: '/x' }
  const inj2 = createInjector({ store: { ...store, dir: memoryRoot('/x') }, userStore: () => store })
  expect(ctx(inj2.sessionStart(native, on, []))).not.toContain('<memory>')
  expect(ctx(inj.sessionStart(native, on, []))).toContain('<memory>')
})

test('memoryScope none injects nothing (AC4), and the budget keeps the newest index lines', () => {
  const { store, inj } = setup()
  store.write({ type: 'project', name: 'a', description: 'fact a', body: 'a' })
  expect(inj.sessionStart({ session_id: 's1' }, { memoryScope: 'none' }, [])).toEqual({})
  const { store: big, inj: small } = setup(20)
  for (const n of ['old', 'mid', 'new']) big.write({ type: 'project', name: n, description: `fact ${n}`, body: n })
  const c = ctx(small.sessionStart({ session_id: 's1' }, on, []))
  expect(c).toContain('new.md')
  expect(c).not.toContain('old.md')
})
