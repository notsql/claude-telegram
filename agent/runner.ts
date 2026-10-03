/**
 * Runs one daemon turn: spawns `claude -p`, parses its stream-json output and
 * resolves with the final `result`. Holds a single global session that every
 * turn resumes (002 replaces this with per-key sessions). The MCP config is
 * rendered per turn so its URL carries the session key (T003: the query
 * string reaches the server, `${VAR}` in `headers` is interpolated).
 */

import { parseStreamJson, type InitEvent, type ResultEvent, type StreamEvent } from './stream.ts'
import { TELEGRAM_INSTRUCTIONS } from './prompt.ts'
import { createInitGuard } from './initGuard.ts'

export type RunTurnOpts = {
  /** Rendered hook settings file (`hooks/settings.ts`). */
  settingsFile: string
  mcpPort: number
  /** Bearer tokens for the MCP and hook endpoints, passed to the child only through env. */
  mcpToken: string
  hookToken: string
  cwd: string
  /** Every parsed event, for logging and progress. */
  onEvent?: (ev: StreamEvent) => void
  /** Abort ends the turn: SIGINT, then SIGTERM after 5s (FR8, FR9). */
  signal?: AbortSignal
}

export type TurnOutcome = {
  init?: InitEvent
  /** Missing when the child exited without a `result` (e.g. SIGTERM). */
  result?: ResultEvent
  /** Set when the never-bare guard (FR14) killed the turn; the caller alerts the owner. */
  refused?: string[]
  exitCode: number
}

let sessionId: string | undefined

export function renderMcpConfig(port: number, key: string) {
  return { mcpServers: { tg: {
    type: 'http',
    url: `http://127.0.0.1:${port}/mcp?key=${encodeURIComponent(key)}`,
    headers: { Authorization: 'Bearer ${TG_MCP_TOKEN}' },
  } } }
}

export async function runTurn(key: string, prompt: string, opts: RunTurnOpts): Promise<TurnOutcome> {
  // T003: inherited Claude Code env makes the child reuse the parent's session.
  const { CLAUDECODE, CLAUDE_CODE_SESSION_ID, ...env } = process.env
  const child = Bun.spawn([
    'claude', '-p', prompt,
    ...(sessionId ? ['--resume', sessionId] : []),
    '--output-format', 'stream-json', '--verbose',
    '--settings', opts.settingsFile,
    '--mcp-config', JSON.stringify(renderMcpConfig(opts.mcpPort, key)),
    '--append-system-prompt', TELEGRAM_INSTRUCTIONS,
    // The daemon's own tools; with no handler a PermissionRequest denies in -p.
    '--allowedTools', 'mcp__tg',
  ], {
    cwd: opts.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...env, TG_SESSION_KEY: key, TG_MCP_TOKEN: opts.mcpToken, TG_HOOK_TOKEN: opts.hookToken },
  })

  const onAbort = () => {
    child.kill('SIGINT')
    setTimeout(() => child.kill('SIGTERM'), 5000).unref()
  }
  if (opts.signal?.aborted) onAbort()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })

  const outcome: Omit<TurnOutcome, 'exitCode'> = {}
  const guard = createInitGuard()
  for await (const ev of parseStreamJson(child.stdout)) {
    const problems = guard(ev)
    if (problems?.length) {
      outcome.refused = problems
      child.kill('SIGTERM')
      break
    }
    if (ev.kind === 'init') {
      outcome.init = ev.event
      sessionId = ev.event.session_id
    } else if (ev.kind === 'result') {
      outcome.result = ev.event
    }
    opts.onEvent?.(ev)
  }
  return { ...outcome, exitCode: await child.exited }
}
