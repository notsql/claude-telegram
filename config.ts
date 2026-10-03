/**
 * Daemon config (T014) from env or the state-dir `.env`: per-turn
 * `--max-turns`, a daily turn budget, the default workspace `cwd`, and the
 * minimum `claude` CLI version (FR12), pinned to the T003 spike.
 */

import { join } from 'path'
import { STATE_DIR } from './access.ts'

export const MIN_CLAUDE_VERSION = '2.1.288'

export type Config = {
  maxTurns: number
  /** Turns allowed per local day; 0 means no budget. */
  dailyTurnBudget: number
  cwd: string
}

function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`)
  return n
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  return {
    maxTurns: positiveInt(env, 'TELEGRAM_MAX_TURNS', 30),
    dailyTurnBudget: positiveInt(env, 'TELEGRAM_DAILY_TURN_BUDGET', 0),
    cwd: env.TELEGRAM_WORKSPACE || join(STATE_DIR, 'workspace'),
  }
}

/** The refusal message when `claude --version` output is older than the minimum, else null. */
export function cliVersionRefusal(output: string, min = MIN_CLAUDE_VERSION): string | null {
  const m = output.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return `could not read the claude CLI version from "${output.trim()}"`
  const have = m.slice(1, 4).map(Number)
  const want = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (have[i]! > want[i]!) return null
    if (have[i]! < want[i]!) return `claude ${m[0]} is older than the required ${min}; run \`claude update\`.`
  }
  return null
}

/** Counts turns per local day. `take()` returns false once the budget is spent. */
export function createTurnBudget(limit: number, now: () => Date = () => new Date()) {
  let day = ''
  let used = 0
  return {
    take(): boolean {
      if (limit === 0) return true
      const today = now().toDateString()
      if (today !== day) { day = today; used = 0 }
      if (used >= limit) return false
      used++
      return true
    },
  }
}
