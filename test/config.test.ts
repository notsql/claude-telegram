import { describe, expect, test } from 'bun:test'
import { cliVersionRefusal, createTurnBudget, loadConfig } from '../config'

describe('config', () => {
  test('defaults and overrides', () => {
    const d = loadConfig({})
    expect(d.maxTurns).toBe(30)
    expect(d.dailyTurnBudget).toBe(0)
    expect(d.cwd).toEndWith('/workspace')
    expect(loadConfig({ TELEGRAM_MAX_TURNS: '5', TELEGRAM_WORKSPACE: '/w' })).toMatchObject({ maxTurns: 5, cwd: '/w' })
    expect(() => loadConfig({ TELEGRAM_MAX_TURNS: 'x' })).toThrow('TELEGRAM_MAX_TURNS')
  })

  test('cli version check', () => {
    expect(cliVersionRefusal('2.1.288 (Claude Code)')).toBeNull()
    expect(cliVersionRefusal('2.10.0 (Claude Code)')).toBeNull()
    expect(cliVersionRefusal('2.1.99 (Claude Code)')).toContain('older')
    expect(cliVersionRefusal('garbage')).toContain('could not read')
  })

  test('daily budget resets each day', () => {
    let now = new Date(2026, 9, 3, 23)
    const b = createTurnBudget(2, () => now)
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false])
    now = new Date(2026, 9, 4, 1)
    expect(b.take()).toBe(true)
    expect(createTurnBudget(0).take()).toBe(true)
  })
})
