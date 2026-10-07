import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createMemoryStore } from '../memory/store'
import { userDir } from '../memory/paths'
import { readDelta } from '../reflection/transcript'
import { createReflectionWorker } from '../reflection/worker'
import { createApplier } from '../reflection/apply'
import type { Proposals } from '../reflection/prompt'

const dir = () => mkdtempSync(join(tmpdir(), 'tg-refl-'))
const line = (o: object) => JSON.stringify(o) + '\n'
const user = (text: string) => line({ type: 'user', message: { content: text } })
const agent = (blocks: object[]) => line({ type: 'assistant', message: { content: blocks } })

test('reads only the new, complete dialogue lines', () => {
  const path = join(dir(), 't.jsonl')
  writeFileSync(path, user('hi') + line({ type: 'attachment' }) + agent([{ type: 'thinking', thinking: 'x' }, { type: 'tool_use', name: 'mcp__tg__reply', input: { text: 'hello' } }]))
  const a = readDelta(path, 0)
  expect(a.text).toBe('USER: hi\n\nAGENT: [tool mcp__tg__reply: hello]')
  appendFileSync(path, user('I use pnpm') + '{"type":"user","mess')
  const b = readDelta(path, a.offset)
  expect(b.text).toBe('USER: I use pnpm')
  expect(readDelta(path, b.offset).text).toBe('')
})

test('Stop is debounced per key, PreCompact runs at once, and policy off skips', async () => {
  const path = join(dir(), 't.jsonl')
  writeFileSync(path, user('one'))
  const inputs: string[] = []
  let learning = true
  const w = createReflectionWorker({
    reflect: async input => { inputs.push(input); return { memory: [], user_model: [] } },
    existing: () => (learning ? 'prefers-pnpm (feedback): uses pnpm' : null),
    apply: () => {},
    debounceMs: 20,
  })
  w.enqueue('1', { transcript_path: path })
  w.enqueue('1', { transcript_path: path })
  await Bun.sleep(60)
  expect(inputs).toHaveLength(1)
  expect(inputs[0]).toContain('prefers-pnpm (feedback)')
  expect(inputs[0]).toContain('USER: one')

  appendFileSync(path, user('two'))
  await w.enqueue('1', { transcript_path: path }, true)
  expect(inputs).toHaveLength(2)
  expect(inputs[1]).not.toContain('USER: one')

  appendFileSync(path, user('three'))
  learning = false
  await w.enqueue('1', { transcript_path: path }, true)
  expect(inputs).toHaveLength(2)
})

function applier(autoLearn: 'auto' | 'propose' | 'off') {
  const store = createMemoryStore(dir())
  const notes: string[] = []
  const asks: string[] = []
  const a = createApplier({
    store,
    userStore: id => createMemoryStore(userDir(store.dir, id)),
    policy: () => ({ memoryScope: 'global', autoLearn }),
    notify: (_k, c) => notes.push(`${c.verb} ${c.name}`),
    ask: (_k, text, id) => asks.push(`${id} ${text}`),
  })
  return { store, a, notes, asks }
}
const pref = (name: string, description: string): Proposals => ({
  memory: [{ op: 'create', type: 'feedback', name, description, body: 'Use pnpm.', reason: 'said so' }],
  user_model: [],
})

test('the same preference three times is one file (AC5)', () => {
  const { store, a, notes } = applier('auto')
  a.apply('1', pref('prefers-pnpm', 'User uses pnpm, not npm'))
  a.apply('2', pref('pnpm-preference', 'User uses pnpm not npm for JS'))
  a.apply('3', pref('prefers-pnpm', 'Prefers pnpm'))
  expect(store.list().map(e => e.name)).toEqual(['prefers-pnpm'])
  expect(notes).toEqual(['Saved prefers-pnpm', 'Updated prefers-pnpm', 'Updated prefers-pnpm'])
  expect(store.read('prefers-pnpm')!.metadata).toMatchObject({ source: 'reflection', session_key: '3' })
})

test('user-model proposals land under users/<id>; secrets and extras are dropped', () => {
  const { store, a } = applier('auto')
  a.apply('-100:1', {
    memory: [
      { op: 'create', type: 'reference', name: 'key', description: 'API key', body: 'sk-abcdefghijklmnopqrstuvw', reason: '' },
      { op: 'delete', type: 'project', name: 'missing', description: '', body: '', reason: '' },
    ],
    user_model: [
      { op: 'create', user_id: '42', name: 'name', description: 'Preferred name', body: 'Kai', reason: '' },
      { op: 'create', user_id: '../x', name: 'evil', description: 'x', body: 'x', reason: '' },
    ],
  })
  expect(store.list()).toEqual([])
  expect(createMemoryStore(userDir(store.dir, '42')).read('name')).toMatchObject({ type: 'user', body: 'Kai', metadata: { user_id: '42' } })
})

test('propose asks first; Save writes, Skip does not; off does nothing', () => {
  const { store, a, asks } = applier('propose')
  a.apply('1', pref('prefers-pnpm', 'User uses pnpm'))
  a.apply('1', pref('tabs', 'User prefers tabs'))
  expect(store.list()).toEqual([])
  const [save, skip] = asks.map(s => s.split(' ')[0]!)
  expect(asks[0]).toContain('🧠 Remember: User uses pnpm?')
  expect(a.decide(save!, true)!.change!.verb).toBe('Saved')
  expect(a.decide(skip!, false)).toEqual({})
  expect(a.decide(skip!, true)).toBeUndefined()
  expect(store.list().map(e => e.name)).toEqual(['prefers-pnpm'])

  const off = applier('off')
  off.a.apply('1', pref('x', 'y'))
  expect(off.store.list()).toEqual([])
})
