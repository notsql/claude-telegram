/**
 * Runs one daemon turn: spawns `claude -p`, feeds the prompt over stream-json
 * stdin, parses its stream-json output and resolves with the final `result`. The caller picks the Claude Code session
 * to resume (002 FR3) and reads the new one from `init`. The MCP config is
 * rendered per turn so its URL carries the session key (T003: the query
 * string reaches the server, `${VAR}` in `headers` is interpolated).
 */

import { readFileSync } from 'fs'
import { parseStreamJson, type InitEvent, type ResultEvent, type StreamEvent } from './stream.ts'
import { TELEGRAM_INSTRUCTIONS } from './prompt.ts'
import { createInitGuard } from './initGuard.ts'
import { createUsageLimitWatcher } from './auth.ts'
import { browserUrl } from '../browser/server.ts'

export type RunTurnOpts = {
  /** Rendered hook settings file (`hooks/settings.ts`). */
  settingsFile: string
  mcpPort: number
  /** The shared browser's MCP port (015 FR2); no `browser` server when unset. */
  browserPort?: number
  /** Bearer tokens for the MCP and hook endpoints, passed to the child only through env. */
  mcpToken: string
  hookToken: string
  cwd: string
  maxTurns: number
  /** Appended after the Telegram instructions, e.g. the 020 action rules. */
  extraInstructions?: string
  /** Policy flags from `policy/args.ts`. */
  policyArgs: string[]
  /** Extra settings merged over the hook settings file (`policySettings`). */
  settings?: Record<string, unknown>
  /** Claude Code session to `--resume`; omitted for a fresh session. */
  resume?: string
  /** Every parsed event, for logging and progress. */
  onEvent?: (ev: StreamEvent) => void
  /** Receives a sender that adds a message to the running turn (002 FR11); it returns false once the turn takes no more. */
  onSteer?: (send: (prompt: string) => boolean) => void
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

const BG_WAIT_CEILING_MS = 15 * 60 * 1000

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

function renderMcpConfig(port: number, key: string, browserPort?: number) {
  return { mcpServers: {
    tg: {
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp?key=${encodeURIComponent(key)}`,
      headers: { Authorization: 'Bearer ${TG_MCP_TOKEN}' },
    },
    ...(browserPort ? { browser: { type: 'http', url: browserUrl(browserPort) } } : {}),
  } }
}

/**
 * The `claude -p` argv for a turn. No `--strict-mcp-config`: user-scope MCP
 * servers (the browser MCP for ladder rung 4, servers added by 012) load
 * alongside `tg`.
 */
export function turnArgv(key: string, opts: RunTurnOpts): string[] {
  return [
    'claude', '-p',
    ...(opts.resume ? ['--resume', opts.resume] : []),
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    // 009 FR5: subagent text in the stream (T901: present without it in 2.1.292).
    '--forward-subagent-text',
    '--settings', opts.settings ? mergeSettings(opts.settingsFile, opts.settings) : opts.settingsFile,
    '--mcp-config', JSON.stringify(renderMcpConfig(opts.mcpPort, key, opts.browserPort)),
    '--append-system-prompt', opts.extraInstructions ? `${TELEGRAM_INSTRUCTIONS}\n\n${opts.extraInstructions}` : TELEGRAM_INSTRUCTIONS,
    ...opts.policyArgs,
    '--max-turns', String(opts.maxTurns),
  ]
}

export async function runTurn(key: string, prompt: string, opts: RunTurnOpts): Promise<TurnOutcome> {
  // T003: inherited Claude Code env makes the child reuse the parent's session.
  const { CLAUDECODE, CLAUDE_CODE_SESSION_ID, ...env } = process.env
  const child = Bun.spawn(turnArgv(key, opts), {
    cwd: opts.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    // 009 FR6: background subagents keep `-p` open until they finish, up to this ceiling.
    env: { ...env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS), TG_SESSION_KEY: key, TG_MCP_TOKEN: opts.mcpToken, TG_HOOK_TOKEN: opts.hookToken },
  })

  // 002 FR11: stdin stays open until the first `result`, so messages sent
  // mid-turn reach the model at its next step. One written just before that
  // result still runs, as a second result in the same process (2.1.312).
  let open = true
  const close = () => {
    if (!open) return
    open = false
    try { child.stdin.end() } catch {}
  }
  const send = (text: string): boolean => {
    if (!open) return false
    try {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
      child.stdin.flush()
      return true
    } catch {
      return false
    }
  }
  send(prompt)
  opts.onSteer?.(send)

  const onAbort = () => { close(); interruptChild(child) }
  if (opts.signal?.aborted) onAbort()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })

  const outcome: Omit<TurnOutcome, 'exitCode'> = {}
  const guard = createInitGuard()
  const usageLimit = createUsageLimitWatcher()
  for await (const ev of parseStreamJson(child.stdout)) {
    const problems = guard(ev)
    if (problems?.length) {
      outcome.refused = problems
      close()
      child.kill('SIGTERM')
      break
    }
    const pausedUntil = usageLimit(ev)
    if (pausedUntil) outcome.pausedUntil = pausedUntil
    if (ev.kind === 'init') {
      outcome.init = ev.event
    } else if (ev.kind === 'result') {
      outcome.result = ev.event
      close()
    }
    opts.onEvent?.(ev)
  }
  close()
  return { ...outcome, exitCode: await child.exited }
}

/**
 * A `--resume` whose transcript is gone (e.g. cleaned up after
 * `cleanupPeriodDays`) ends with this error result and no `init`.
 */
export function isMissingSession(outcome: TurnOutcome): boolean {
  return !outcome.init && !!outcome.result?.errors?.some(e => e.startsWith('No conversation found'))
}

/** The hook settings file with `extra` over it; `enabledPlugins` merges, but the file's own entries win (the channel plugin stays off). */
export function mergeSettings(file: string, extra: Record<string, unknown>): string {
  const base = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const plugins = { ...(extra.enabledPlugins as object), ...(base.enabledPlugins as object) }
  return JSON.stringify({ ...base, ...extra, ...(Object.keys(plugins).length && { enabledPlugins: plugins }) })
}
