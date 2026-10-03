/**
 * Subscription-only auth (FR10). The daemon never reads or forwards
 * credentials: it refuses an `ANTHROPIC_API_KEY` (the CLI would bill it),
 * asks `claude auth status` whether the login exists, and watches each turn
 * for usage-limit signals so the queue can pause until the window resets.
 */

import type { StreamEvent } from './stream.ts'

/** The startup refusal message, or null when no API key is set. */
export function apiKeyRefusal(env: Record<string, string | undefined>): string | null {
  return env.ANTHROPIC_API_KEY
    ? 'ANTHROPIC_API_KEY is set; the claude CLI would bill it instead of your subscription. Unset it and restart.'
    : null
}

/** Whether `claude auth status` reports a login. False on any failure. */
export function isLoggedIn(): boolean {
  try {
    const proc = Bun.spawnSync(['claude', 'auth', 'status'], { stdout: 'pipe', stderr: 'ignore' })
    return proc.exitCode === 0 && JSON.parse(proc.stdout.toString()).loggedIn === true
  } catch {
    return false
  }
}

const LIMIT_ERRORS = new Set(['rate_limit', 'billing_error'])
const FALLBACK_PAUSE_MS = 60 * 60 * 1000

/**
 * Returns a per-turn checker. Feed it every event; at the `result` it returns
 * the epoch ms the queue should pause until, or null when the turn did not hit
 * a limit. T003 could not reproduce a limit, so a limit counts when an error
 * result follows an `api_retry` limit error or a non-`allowed` rate-limit
 * status. The reset time comes from `resetsAt`, else one hour from `now`.
 */
export function createUsageLimitWatcher(now: () => number = Date.now) {
  let limited = false
  let resetsAt: number | undefined
  return (ev: StreamEvent): number | null => {
    if (ev.kind === 'api_retry' && LIMIT_ERRORS.has(String(ev.event.error))) limited = true
    if (ev.kind === 'rate_limit') {
      if (ev.event.rate_limit_info.status !== 'allowed') limited = true
      if (ev.event.rate_limit_info.resetsAt) resetsAt = ev.event.rate_limit_info.resetsAt * 1000
    }
    if (ev.kind !== 'result' || !ev.event.is_error || !limited) return null
    return resetsAt && resetsAt > now() ? resetsAt : now() + FALLBACK_PAUSE_MS
  }
}
