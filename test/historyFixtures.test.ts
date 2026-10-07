import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// Shape guard for the T501 fixtures that parse.ts (T503) is tested against.
const lines = (f: string) => readFileSync(join(import.meta.dir, 'fixtures/history', f), 'utf8').trim().split('\n')
const json = (f: string) => lines(f).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })

test('daemon fixture: wrapper prompt, reply tool, tool result, title, junk lines', () => {
  const rows = json('daemon.jsonl')
  expect(lines('daemon.jsonl').length - rows.length).toBe(1)
  expect(rows.find(r => r.promptSource === 'sdk').message.content).toStartWith('<channel source="telegram" ')
  const blocks = rows.filter(r => r.type === 'assistant').flatMap(r => r.message.content)
  expect(blocks.map(b => b.type)).toEqual(['thinking', 'tool_use', 'tool_use', 'text'])
  expect(blocks.find(b => b.name === 'mcp__tg__reply').input.text).toBeString()
  expect(rows.some(r => r.message?.content?.[0]?.type === 'tool_result')).toBe(true)
  expect(rows.find(r => r.type === 'ai-title').aiTitle).toBeString()
})

test('cli fixture: human prompts, harness lines, peer hand-back, custom title', () => {
  const rows = json('cli.jsonl')
  expect(rows.filter(r => r.origin?.kind === 'human')).toHaveLength(2)
  expect(rows.filter(r => r.isMeta)).toHaveLength(1)
  expect(rows.some(r => r.origin?.kind === 'peer')).toBe(true)
  expect(rows.find(r => r.type === 'custom-title').customTitle).toBeString()
})
