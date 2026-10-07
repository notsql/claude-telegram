/**
 * Runs one daemon turn: spawns `claude -p`, parses its stream-json output and
 * resolves with the final `result`. The caller picks the Claude Code session
 * to resume (002 FR3) and reads the new one from `init`. The MCP config is
 * rendered per turn so its URL carries the session key (T003: the query
 * string reaches the server, `${VAR}` in `headers` is interpolated).
 */

import { parseStreamJson, type InitEvent, type ResultEvent, type StreamEvent } from './stream.ts'
import { TELEGRAM_INSTRUCTIONS } from './prompt.ts'
import { createInitGuard } from './initGuard.ts'
import { createUsageLimitWatcher } from './auth.ts'

export type RunTurnOpts = {
  /** Rendered hook settings file (`hooks/settings.ts`). */
  settingsFile: string
  mcpPort: number
  /** Bearer tokens for the MCP and hook endpoints, passed to the child only through env. */
  mcpToken: string
  hookToken: string
  cwd: string
  maxTurns: number
  /** Policy flags from `policy/args.ts`. */
  policyArgs: string[]
  /** Claude Code session to `--resume`; omitted for a fresh session. */
  resume?: string
  /** Every parsed event, for logging and progress. */
  onEvent?: (ev: StreamEvent) => void
  /** Abort ends the turn via `interruptChild` (FR8, FR9). */
  signal?: AbortSignal
}

export type TurnOutcome = {
  init?: InitEvent
  /** Missing when the child exited without a `result` (e.g. SIGTERM). */
  result?: ResultEvent
  /** Set when the never-bare guard (FR14) killed the turn; the caller alerts the owner. */
  refused?: string[]
  /** Epoch ms to pause the queue until, when the turn hit a usage limit (FR10). */
  pausedUntil?: number
  exitCode: number
}

type Killable = { kill(signal: NodeJS.Signals): void; exited: Promise<number> }

/**
 * FR8: SIGINT ends the turn cleanly with an error `result` (T003). SIGTERM
 * after `termMs` drops the result; SIGKILL after `killMs` more covers a child
 * that ignores both, so the queue can never hang on it.
 */
export function interruptChild(child: Killable, termMs = 5000, killMs = 2000): void {
  child.kill('SIGINT')
  const term = setTimeout(() => child.kill('SIGTERM'), termMs)
  const kill = setTimeout(() => child.kill('SIGKILL'), termMs + killMs)
  void child.exited.finally(() => { clearTimeout(term); clearTimeout(kill) })
}

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
    ...(opts.resume ? ['--resume', opts.resume] : []),
    '--output-format', 'stream-json', '--verbose',
    '--settings', opts.settingsFile,
    '--mcp-config', JSON.stringify(renderMcpConfig(opts.mcpPort, key)),
    '--append-system-prompt', TELEGRAM_INSTRUCTIONS,
    ...opts.policyArgs,
    '--max-turns', String(opts.maxTurns),
  ], {
    cwd: opts.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...env, TG_SESSION_KEY: key, TG_MCP_TOKEN: opts.mcpToken, TG_HOOK_TOKEN: opts.hookToken },
  })

  const onAbort = () => interruptChild(child)
  if (opts.signal?.aborted) onAbort()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })

  const outcome: Omit<TurnOutcome, 'exitCode'> = {}
  const guard = createInitGuard()
  const usageLimit = createUsageLimitWatcher()
  for await (const ev of parseStreamJson(child.stdout)) {
    const problems = guard(ev)
    if (problems?.length) {
      outcome.refused = problems
      child.kill('SIGTERM')
      break
    }
    const pausedUntil = usageLimit(ev)
    if (pausedUntil) outcome.pausedUntil = pausedUntil
    if (ev.kind === 'init') {
      outcome.init = ev.event
    } else if (ev.kind === 'result') {
      outcome.result = ev.event
    }
    opts.onEvent?.(ev)
  }
  return { ...outcome, exitCode: await child.exited }
}

/**
 * A `--resume` whose transcript is gone (e.g. cleaned up after
 * `cleanupPeriodDays`) ends with this error result and no `init`.
 */
export function isMissingSession(outcome: TurnOutcome): boolean {
  return !outcome.init && !!outcome.result?.errors?.some(e => e.startsWith('No conversation found'))
}
