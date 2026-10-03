import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createInitGuard } from '../agent/initGuard'
import { parseLine, type StreamEvent } from '../agent/stream'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', 'stream-json', `${name}.jsonl`), 'utf8')
    .split('\n').map(parseLine).filter((e): e is StreamEvent => e !== null)

const sessionStart = parseLine(JSON.stringify({
  type: 'system', subtype: 'hook_response', hook_id: 'h', hook_name: 'SessionStart:startup',
  hook_event: 'SessionStart', outcome: 'success',
}))!

/** Runs the guard over events and returns its verdict at init. */
function verdict(events: StreamEvent[]): string[] | null {
  const guard = createInitGuard()
  for (const ev of events) {
    const v = guard(ev)
    if (v) return v
  }
  return null
}

const withInit = (events: StreamEvent[], patch: Record<string, unknown>) => events.map(e =>
  e.kind === 'init' ? parseLine(JSON.stringify({ ...e.event, ...patch }))! : e)

describe('initGuard (FR14, AC9)', () => {
  const daemonTurn = [sessionStart, ...fixture('mcp-reply')]

  test('passes a full daemon init', () => {
    expect(verdict(daemonTurn)).toEqual([])
  })

  test('refuses when hooks are inactive', () => {
    expect(verdict(fixture('mcp-reply'))).toEqual(['no SessionStart hook_response (hooks inactive)'])
  })

  test('refuses when the tg MCP server is missing or not connected', () => {
    expect(verdict([sessionStart, ...fixture('resume')])).toEqual(['MCP server tg missing'])
    const failed = withInit(daemonTurn, { mcp_servers: [{ name: 'tg', status: 'failed' }] })
    expect(verdict(failed)).toEqual(['MCP server tg failed'])
  })

  test('refuses a bare-like init on every count', () => {
    const bare = withInit(fixture('resume'), { skills: [] })
    expect(verdict(bare)).toHaveLength(3)
  })

  test('ignores non-SessionStart hook responses', () => {
    expect(verdict(fixture('hooks-tools'))).toContain('no SessionStart hook_response (hooks inactive)')
  })
})
