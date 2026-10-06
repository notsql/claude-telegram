import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isMissingSession, type TurnOutcome } from '../agent/runner'
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
