import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isMissingSession, turnArgv, type TurnOutcome } from '../agent/runner'
import { policyArgs } from '../policy/args'
import { parseLine, type StreamEvent } from '../agent/stream'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', 'stream-json', `${name}.jsonl`), 'utf8')
    .split('\n').map(parseLine).filter((e): e is StreamEvent => e !== null)

function outcomeOf(events: StreamEvent[]): TurnOutcome {
  const outcome: TurnOutcome = { exitCode: 0 }
  for (const ev of events) {
    if (ev.kind === 'init') outcome.init = ev.event
    else if (ev.kind === 'result') outcome.result = ev.event
  }
  return outcome
}

describe('isMissingSession (002 FR3)', () => {
  test('a resume of a deleted transcript is detected', () => {
    expect(isMissingSession(outcomeOf(fixture('resume-missing')))).toBe(true)
  })

  test('a normal resumed turn is not', () => {
    expect(isMissingSession(outcomeOf(fixture('resume')))).toBe(false)
  })
})

describe('turnArgv (012 T1207)', () => {
  const opts = { settingsFile: '/s.json', mcpPort: 1, mcpToken: 't', hookToken: 'h', cwd: '/', maxTurns: 5, policyArgs: ['--allowedTools', 'mcp__tg'] }

  test('user-scope MCP servers stay visible (no --strict-mcp-config)', () => {
    const argv = turnArgv('k', 'hi', opts)
    expect(argv).not.toContain('--strict-mcp-config')
    expect(Object.keys(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers)).toEqual(['tg'])
  })

  test('the browser MCP is not disallowed by default policy', () => {
    expect(policyArgs({}).join(' ')).not.toContain('safari')
  })

  test('the ladder covers WebFetch, then the browser MCP (FR1.4)', () => {
    const skill = readFileSync(join(import.meta.dir, '..', 'assets', 'skills', 'tg-capability-ladder', 'SKILL.md'), 'utf8')
    const web = skill.indexOf('WebFetch'), browser = skill.indexOf('mcp__safari-mcp__')
    expect(web).toBeGreaterThan(-1)
    expect(browser).toBeGreaterThan(web)
  })
})
