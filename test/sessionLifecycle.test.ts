import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSessionStore } from '../sessions/store'
import { createSessionLifecycle, formatSessions } from '../sessions/lifecycle'

const setup = () => {
  const store = createSessionStore(join(mkdtempSync(join(tmpdir(), 'lc-')), 'sessions.json'), () => 0)
  const interrupted: string[] = []
  return { store, interrupted, life: createSessionLifecycle(store, k => interrupted.push(k)) }
}

describe('session lifecycle (002 FR9)', () => {
  test('new then resume 1 restores the old session, interrupting each time', () => {
    const { store, interrupted, life } = setup()
    store.record('1', 'old', 'old question')
    life.new('1')
    expect(store.current('1')).toBeUndefined()
    store.record('1', 'fresh', 'fresh question')
    expect(life.resume('1', 1).sessionId).toBe('old')
    expect(store.current('1')).toBe('old')
    expect(life.list('1').map(s => s.sessionId)).toEqual(['fresh'])
    expect(interrupted).toEqual(['1', '1'])
  })

  test('a turn that was running across new does not undo it', () => {
    const { store, life } = setup()
    store.record('1', 'old', 'q')
    const since = store.generation('1')
    life.new('1')
    store.record('1', 'old', 'q', since)
    expect(store.current('1')).toBeUndefined()
    store.record('1', 'fresh', 'q2', store.generation('1'))
    expect(store.current('1')).toBe('fresh')
  })

  test('bad resume number interrupts nothing', () => {
    const { interrupted, life } = setup()
    expect(() => life.resume('1', 1)).toThrow('/sessions')
    expect(interrupted).toEqual([])
  })

  test('formatSessions numbers most recent first', () => {
    expect(formatSessions([])).toBe('No earlier sessions here.')
    expect(formatSessions([{ sessionId: 'a', startedAt: 0, title: 'Infra' }, { sessionId: 'b', startedAt: 0, title: '' }]))
      .toBe('1. Infra (1970-01-01)\n2. (untitled) (1970-01-01)')
  })
})
