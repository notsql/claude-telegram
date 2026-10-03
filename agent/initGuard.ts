/**
 * Never-bare guard (FR14). `--bare` skips hooks, skills, CLAUDE.md, plugins
 * and the subscription login, and may become the `-p` default. Fed every
 * stream event, it checks the turn's `system/init` against the state a daemon
 * turn must have. The CLI emits the `SessionStart` `hook_response` before
 * `init` (checked against 2.1.288), so the verdict is final at `init`.
 * Plugins are not checked: an owner with none installed is valid.
 */

import type { InitEvent, StreamEvent } from './stream.ts'

/** Problems with the init state; empty when the turn may continue. */
export function initProblems(init: InitEvent, sessionStartSeen: boolean): string[] {
  const out: string[] = []
  const tg = init.mcp_servers.find(s => s.name === 'tg')
  if (tg?.status !== 'connected') out.push(`MCP server tg ${tg ? tg.status : 'missing'}`)
  if (!sessionStartSeen) out.push('no SessionStart hook_response (hooks inactive)')
  if (!init.skills?.length) out.push('no skills loaded')
  return out
}

/** Returns a per-turn checker: null until `init`, then the problem list. */
export function createInitGuard() {
  let sessionStartSeen = false
  return (ev: StreamEvent): string[] | null => {
    if (ev.kind === 'hook_response' && ev.event.hook_event === 'SessionStart') sessionStartSeen = true
    return ev.kind === 'init' ? initProblems(ev.event, sessionStartSeen) : null
  }
}
