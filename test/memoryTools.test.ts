import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createMemoryStore } from '../memory/store'
import { createMemoryTools, type MemoryChange } from '../memory/tools'

function setup() {
  const store = createMemoryStore(mkdtempSync(join(tmpdir(), 'tg-mem-')))
  const changes: [string, MemoryChange][] = []
  const tools = createMemoryTools(store, (key, c) => changes.push([key, c]))
  return { store, tools, changes }
}
const on = { memoryScope: 'global' as const }
const fact = { type: 'project', name: 'topic-infra', description: 'This topic is about the infra repo', body: 'infra repo' }
const out = (r: any) => r.content[0].text as string

test('a fact saved in a group topic is stamped and recalled from the DM and another topic (AC4)', () => {
  const { store, tools, changes } = setup()
  expect(out(tools.call('memory_write', fact, '-100123:7', on))).toBe('saved topic-infra')
  expect(store.read('topic-infra')!.metadata.session_key).toBe('-100123:7')
  expect(out(tools.call('memory_search', { query: 'infra repo' }, '555', on))).toContain('topic-infra')
  expect(out(tools.call('memory_read', { name: 'topic-infra' }, '-100123:9', on))).toContain('infra repo')
  expect(changes.map(([k, c]) => [k, c.verb])).toEqual([['-100123:7', 'Saved']])
})

test('memoryScope none hides and refuses the tools (AC4)', () => {
  const { tools } = setup()
  expect(tools.list({ memoryScope: 'none' })).toEqual([])
  const r = tools.call('memory_search', { query: 'x' }, '555', { memoryScope: 'none' })!
  expect(r.isError).toBe(true)
  expect(tools.call('reply', {}, '555', on)).toBeUndefined()
})

test('update patches fields and keeps metadata; delete undo restores', () => {
  const { store, tools, changes } = setup()
  tools.call('memory_write', fact, '1', on)
  expect(out(tools.call('memory_update', { name: 'topic-infra', patch: { body: 'terraform' } }, '2', on))).toBe('updated topic-infra')
  expect(store.read('topic-infra')).toMatchObject({ body: 'terraform', type: 'project', metadata: { session_key: '2' } })
  tools.startTurn('2')
  tools.call('memory_delete', { name: 'topic-infra' }, '2', on)
  expect(store.read('topic-infra')).toBeUndefined()
  changes.at(-1)![1].undo()
  expect(store.read('topic-infra')!.body).toBe('terraform')
})

test('refuses secrets and more than 3 writes per turn', () => {
  const { tools } = setup()
  const r = tools.call('memory_write', { ...fact, name: 'key', body: 'my API key sk-abcdefghijklmnopqrstu' }, '1', on)!
  expect(r.isError).toBe(true)
  expect(out(r)).toContain('secrets are never saved')
  for (const n of ['b', 'c']) tools.call('memory_write', { ...fact, name: n }, '1', on)
  expect(out(tools.call('memory_write', { ...fact, name: 'd' }, '1', on))).toContain('limit of 3')
  tools.startTurn('1')
  expect(out(tools.call('memory_write', { ...fact, name: 'd' }, '1', on))).toBe('saved d')
})
