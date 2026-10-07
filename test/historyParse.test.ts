import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseLine, summariseTool, unwrapInbound } from '../history/parse'

const parseFixture = (f: string) =>
  readFileSync(join(import.meta.dir, 'fixtures/history', f), 'utf8').trim().split('\n').map(parseLine).filter(Boolean)

test('daemon transcript: meta extracted, wrapper stripped, tools summarised, results and junk skipped', () => {
  const S = '11111111-2222-3333-4444-555555555555'
  expect(parseFixture('daemon.jsonl')).toEqual([
    { kind: 'message', sessionId: S, role: 'user', ts: Date.parse('2026-10-07T01:00:01.000Z'), text: 'which package manager & why?',
      tg: { chat: '-1001234567890', thread: '7', msg: '42', user: 'alice' } },
    { kind: 'message', sessionId: S, role: 'assistant', ts: Date.parse('2026-10-07T01:00:02.100Z'),
      text: 'tool: Bash({"command":"ls *lock*","description":"List lockfiles"})' },
    { kind: 'message', sessionId: S, role: 'assistant', ts: Date.parse('2026-10-07T01:00:04.000Z'), text: 'pnpm: there is a pnpm-lock.yaml.' },
    { kind: 'message', sessionId: S, role: 'assistant', ts: Date.parse('2026-10-07T01:00:05.000Z'), text: 'Replied.' },
    { kind: 'title', sessionId: S, title: 'Package manager question' },
  ])
})

test('tool results never reach the index', () => {
  const all = JSON.stringify(parseFixture('daemon.jsonl'))
  expect(all).not.toContain('SECRET_TOKEN')
  expect(all).not.toContain('sent (id: 43)')
})

test('cli transcript: human prompts kept; harness, meta and peer lines skipped', () => {
  expect(parseFixture('cli.jsonl').map(p => p.kind === 'message' ? `${p.role}: ${p.text}` : `title: ${p.title}`)).toEqual([
    'user: rename the deploy script',
    'user: see this screenshot',
    'assistant: tool: Edit({"file_path":"/home/u/proj/package.json","old_string":"deploy","new_string":"sh…)',
    'assistant: Renamed deploy to ship in package.json.',
    'title: Rename deploy',
  ])
})

test('long tool args are truncated; non-wrapper text passes through', () => {
  const s = summariseTool('Write', { content: 'x'.repeat(500) })
  expect(s.length).toBeLessThan(100)
  expect(s).toEndWith('…)')
  expect(unwrapInbound('plain')).toEqual({ text: 'plain' })
  expect(unwrapInbound('<channel source="telegram" chat_id="5" message_id="1">a &lt;b&gt; c</channel>'))
    .toEqual({ text: 'a <b> c', tg: { chat: '5', msg: '1' } })
})

test('malformed lines are skipped, not thrown', () => {
  for (const l of ['', 'nope', 'null', '[]', '{"type":"user"}', '{"type":"assistant","sessionId":"s","message":{}}'])
    expect(parseLine(l)).toBeUndefined()
})
