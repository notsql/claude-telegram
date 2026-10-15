/**
 * Daemon config (T014) from env or the state-dir `.env`: per-turn
 * `--max-turns`, a daily turn budget, how many sessions run at once (002
 * FR5), the default workspace `cwd`, and the
 * minimum `claude` CLI version (FR12), pinned to the T003 spike.
 */

import { chmodSync, readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './access.ts'

export const ENV_FILE = join(STATE_DIR, '.env')

/**
 * Loads the state-dir `.env` into `process.env`; real env wins. The bot token
 * lives here (plugin-spawned servers get no env block), so it is kept owner-only.
 */
export function loadEnvFile(): void {
  try {
    chmodSync(ENV_FILE, 0o600)
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]
    }
  } catch {}
}

const MIN_CLAUDE_VERSION = '2.1.288'

export type Config = {
  maxTurns: number
  /** Turns allowed per local day; 0 means no budget. */
  dailyTurnBudget: number
  /** Sessions whose turns may run at the same time; at least 1. */
  maxConcurrentSessions: number
  cwd: string
  /** Source watchers (013 FR12); on only when `TELEGRAM_WATCH=1`. */
  watch: boolean
  /** The shared sign-in browser (015 FR5); on only when `TELEGRAM_BROWSER=1`. */
  browser: boolean
}

function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`)
  return n
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const maxConcurrentSessions = positiveInt(env, 'TELEGRAM_MAX_CONCURRENT_SESSIONS', 3)
  if (maxConcurrentSessions < 1) throw new Error('TELEGRAM_MAX_CONCURRENT_SESSIONS must be at least 1')
  return {
    maxTurns: positiveInt(env, 'TELEGRAM_MAX_TURNS', 30),
    dailyTurnBudget: positiveInt(env, 'TELEGRAM_DAILY_TURN_BUDGET', 0),
    maxConcurrentSessions,
    cwd: env.TELEGRAM_WORKSPACE || join(STATE_DIR, 'workspace'),
    watch: env.TELEGRAM_WATCH === '1',
    browser: env.TELEGRAM_BROWSER === '1',
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
