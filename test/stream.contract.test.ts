/**
 * Contract test for agent/stream.ts against stream-json captured from the
 * real CLI (T003 spike, Claude Code 2.1.288). Re-capture the fixtures when the
 * minimum CLI version is raised; a failure here means the output drifted.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { assistantText, parseLine, parseStreamJson, toolUses, type StreamEvent } from '../agent/stream'

const FIXTURES = join(import.meta.dir, 'fixtures', 'stream-json')
const load = (name: string) => readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')

function parseAll(text: string): StreamEvent[] {
  return text.split('\n').map(parseLine).filter((e): e is StreamEvent => e !== null)
}

/** The guarantees runner.ts relies on. Returns a list of violations. */
function contractViolations(events: StreamEvent[]): string[] {
  const out: string[] = []
  for (const e of events) if (e.kind === 'invalid') out.push(e.error)
  const init = events.find(e => e.kind === 'init')
  const results = events.filter(e => e.kind === 'result')
  if (!init) out.push('no system/init event')
  if (results.length !== 1) out.push(`expected 1 result, got ${results.length}`)
  if (init?.kind === 'init' && results[0]?.kind === 'result'
    && init.event.session_id !== results[0].event.session_id) {
    out.push('init and result session_id differ')
  }
  return out
}

const byKind = <K extends StreamEvent['kind']>(events: StreamEvent[], kind: K) =>
  events.filter((e): e is Extract<StreamEvent, { kind: K }> => e.kind === kind)

describe('stream-json contract', () => {
  for (const name of ['hooks-tools', 'mcp-reply', 'resume', 'sigint-mid-tool']) {
    test(`${name}: satisfies the contract`, () => {
      expect(contractViolations(parseAll(load(name)))).toEqual([])
    })
  }

  test('hooks-tools: hook responses, tool calls and a denial are visible', () => {
    const events = parseAll(load('hooks-tools'))
    const hooks = byKind(events, 'hook_response').map(e => e.event.hook_event)
    expect(hooks).toContain('UserPromptSubmit')
    expect(hooks).toContain('PermissionRequest')
    expect(hooks).toContain('Stop')
    const tools = byKind(events, 'assistant').flatMap(e => toolUses(e.event).map(t => t.name))
    expect(tools).toEqual(['Bash', 'Write', 'Bash'])
    const [result] = byKind(events, 'result')
    expect(result!.event.is_error).toBe(false)
    expect(result!.event.permission_denials?.map(d => d.tool_name)).toEqual(['Write'])
  })

  test('mcp-reply: tg server connected and reply tool called', () => {
    const events = parseAll(load('mcp-reply'))
    const [init] = byKind(events, 'init')
    expect(init!.event.mcp_servers).toContainEqual(expect.objectContaining({ name: 'tg', status: 'connected' }))
    const tools = byKind(events, 'assistant').flatMap(e => toolUses(e.event).map(t => t.name))
    expect(tools).toContain('mcp__tg__reply')
  })

  test('resume: final assistant text and successful result', () => {
    const events = parseAll(load('resume'))
    const text = byKind(events, 'assistant').map(e => assistantText(e.event)).join('')
    expect(text).toContain('ZEBRA')
    expect(byKind(events, 'result')[0]!.event.subtype).toBe('success')
  })

  test('sigint-mid-tool: interrupted turn ends in an error result', () => {
    const events = parseAll(load('sigint-mid-tool'))
    expect(byKind(events, 'tool_progress').length).toBeGreaterThan(0)
    const [result] = byKind(events, 'result')
    expect(result!.event.is_error).toBe(true)
    expect(result!.event.subtype).toBe('error_during_execution')
  })

  test('unknown event types pass through', () => {
    const kinds = parseAll(load('resume')).filter(e => e.kind === 'unknown').map(e => e.type)
    expect(kinds).toContain('active_goal')
    expect(kinds).toContain('system/post_turn_summary')
  })
})

describe('doctored fixtures fail the contract', () => {
  const lines = load('resume').trim().split('\n')
  const edit = (pred: (o: any) => boolean, fn: (o: any) => void) =>
    lines.map(l => {
      const o = JSON.parse(l)
      if (pred(o)) fn(o)
      return JSON.stringify(o)
    }).join('\n')

  test('init without session_id', () => {
    const v = contractViolations(parseAll(edit(o => o.subtype === 'init', o => delete o.session_id)))
    expect(v.some(s => s.startsWith('init:'))).toBe(true)
  })

  test('result with a non-boolean is_error', () => {
    const v = contractViolations(parseAll(edit(o => o.type === 'result', o => { o.is_error = 'no' })))
    expect(v.some(s => s.startsWith('result:'))).toBe(true)
  })

  test('result missing entirely', () => {
    const v = contractViolations(parseAll(lines.filter(l => !l.includes('"type":"result"')).join('\n')))
    expect(v).toContain('expected 1 result, got 0')
  })

  test('truncated line', () => {
    const v = contractViolations(parseAll(lines.map(l => l.includes('"subtype":"init"') ? l.slice(0, 50) : l).join('\n')))
    expect(v.some(s => s.startsWith('bad JSON'))).toBe(true)
  })
})

test('parseStreamJson reassembles lines split across chunks', async () => {
  const text = load('mcp-reply')
  const bytes = new TextEncoder().encode(text)
  async function* chunks() {
    for (let i = 0; i < bytes.length; i += 97) yield bytes.subarray(i, i + 97)
  }
  const streamed: StreamEvent[] = []
  for await (const e of parseStreamJson(chunks())) streamed.push(e)
  expect(streamed).toEqual(parseAll(text))
})
