/**
 * Watcher supervisor (013 FR1, FR3, FR4): runs each enabled `stream` and
 * `webhook` source's command and restarts it with exponential backoff when it
 * exits. A `stream` child's stdout is read as NDJSON; a `webhook` child posts
 * to `/ingest/<id>` with a per-start random secret. Like the daemon's own PID
 * file, each child's `<pid> <start time>` is recorded so a child orphaned by a
 * crashed daemon is replaced instead of running twice.
 *
 * Source config: `{command: string[], env?: Record<string,string>}`. `{port}`
 * and `{secret}` in the command are filled in. The adapter is chosen by the
 * command's basename. Watchers are read-only: no adapter has a send path, and
 * sends belong to `send.ts` behind an owner tap (FR4).
 *
 * `poll` sources (`{command, intervalSec}`) run their command every interval
 * and parse stdout with a poll adapter, chosen by basename, that also advances
 * the source's cursor. `agent-poll` sources (`{connector, intervalSec?}`, default
 * 30 min) ask a one-shot `tg-poller` for items since the cursor using only that
 * connector's tools. A failed poll counts an error and waits for the next interval.
 */

import { randomBytes } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { basename, join } from 'path'
import type { Item } from './store.ts'
import { z } from 'zod'
import { recordError, setCursor, type Source } from './registry.ts'
import { lineReader } from './ingest.ts'
import { tgcliItem } from './adapters/tgcli.ts'
import { wacliItem } from './adapters/wacli.ts'
import { githubCommand, githubItems } from './adapters/github.ts'
import { killStale, writePidFile } from '../util/proc.ts'

type Adapter = { map: (source: string, payload: unknown) => Item | null; signatureHeader?: string }

export const ADAPTERS: Record<string, Adapter> = {
  tgcli: { map: tgcliItem },
  wacli: { map: wacliItem, signatureHeader: 'x-wacli-signature' },
}

type PollAdapter = {
  command: (command: string[], cursor: string | null) => string[]
  parse: (source: string, stdout: string, cursor: string | null) => { items: Item[]; cursor: string | null }
}

export const POLL_ADAPTERS: Record<string, PollAdapter> = {
  gh: { command: githubCommand, parse: githubItems },
}

export const AgentPollSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    ts: z.string(),
    title: z.string(),
    from: z.string().optional(),
    url: z.string().optional(),
    toMe: z.boolean().optional(),
  })),
  cursor: z.string(),
})

export type RunPoller = (input: string, schema: typeof AgentPollSchema, allowedTools: string[]) => Promise<z.infer<typeof AgentPollSchema>>

/** claude.ai connector "Google Calendar" → its MCP tool prefix `mcp__claude_ai_Google_Calendar`. */
export const connectorTools = (connector: string) => `mcp__claude_ai_${connector.trim().replace(/\s+/g, '_')}`

export function agentPollInput(connector: string, cursor: string | null, now: number): string {
  const since = cursor ?? new Date(new Date(now).setHours(0, 0, 0, 0)).toISOString()
  return `Using the ${connector} connector, list items new or changed since ${since} (now is ${new Date(now).toISOString()}). For a calendar, list today's and tomorrow's events instead.`
}

export function agentPollItems(source: string, connector: string, out: z.infer<typeof AgentPollSchema>, now: number): Item[] {
  return out.items.map(i => {
    const ts = Date.parse(i.ts)
    return {
      source,
      extId: i.id,
      ts: Number.isNaN(ts) ? now : ts,
      from: { id: i.from ?? connector, name: i.from ?? connector },
      chat: { id: connector, name: connector, isGroup: false },
      text: i.title,
      url: i.url,
      toMe: i.toMe ?? false,
      fromMe: false,
    }
  })
}

export type Child = { pid: number; stdout: ReadableStream<Uint8Array> | null; exited: Promise<number>; kill: () => void }
export type Spawner = (cmd: string[], env: Record<string, string>, stdout: boolean) => Child

const bunSpawn: Spawner = (cmd, env, stdout) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdin: 'ignore', stdout: stdout ? 'pipe' : 'ignore', stderr: 'inherit' })
  return { pid: p.pid, stdout: stdout ? (p.stdout as ReadableStream<Uint8Array>) : null, exited: p.exited, kill: () => p.kill() }
}

/** 1s, 2s, 4s … capped at 5 min; reset once a child has stayed up for a minute. */
export const backoffMs = (attempt: number) => Math.min(1000 * 2 ** attempt, 300_000)
const HEALTHY_MS = 60_000

type SourceConfig = { command: string[]; env?: Record<string, string>; intervalSec?: number; connector?: string }

export type SupervisorOpts = {
  stateDir: string
  sources: Source[]
  /** Called with each payload: a parsed NDJSON line or webhook body. */
  onPayload: (source: Source, payload: unknown) => void
  /** Called with each item a `poll` or `agent-poll` source returns. */
  onItem?: (source: Source, item: Item) => void
  /** One-shot `tg-poller` call for `agent-poll` sources; those are skipped without it. */
  runPoller?: RunPoller
  log: (line: string) => void
  spawn?: Spawner
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Where `<id>.pid` files live; omitted in tests. */
  pidDir?: string
}

export function adapterFor(source: Source): Adapter | undefined {
  const cmd = (source.config as SourceConfig).command
  return Array.isArray(cmd) ? ADAPTERS[basename(String(cmd[0]))] : undefined
}

export function createSupervisor(opts: SupervisorOpts) {
  const spawn = opts.spawn ?? bunSpawn
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const watched = opts.sources.filter(s => s.enabled && (s.kind === 'stream' || s.kind === 'webhook'))
  const polled = opts.sources.filter(s => s.enabled && (s.kind === 'poll' || s.kind === 'agent-poll'))
  const secrets = new Map(watched.filter(s => s.kind === 'webhook').map(s => [s.id, randomBytes(32).toString('hex')]))
  const children = new Map<string, Child>()
  let stopped = false

  async function run(source: Source, port: number): Promise<void> {
    const { command, env = {} } = source.config as SourceConfig
    const cmd = command.map(a => a.replaceAll('{port}', String(port)).replaceAll('{secret}', secrets.get(source.id) ?? ''))
    const pidFile = opts.pidDir && join(opts.pidDir, `${source.id}.pid`)
    for (let attempt = 0; !stopped;) {
      const started = now()
      let code: number
      try {
        if (pidFile) {
          const stale = killStale(pidFile)
          if (stale) opts.log(`watch ${source.id}: replacing stale pid=${stale}`)
        }
        const child = spawn(cmd, env, source.kind === 'stream')
        children.set(source.id, child)
        if (pidFile) writePidFile(pidFile, child.pid)
        opts.log(`watch ${source.id}: started pid=${child.pid}`)
        const reading = child.stdout ? readLines(source, child.stdout) : Promise.resolve()
        code = await child.exited
        await reading
      } catch (err) {
        opts.log(`watch ${source.id}: spawn failed: ${err}`)
        code = -1
      }
      children.delete(source.id)
      if (pidFile) rmSync(pidFile, { force: true })
      if (stopped) break
      if (now() - started >= HEALTHY_MS) attempt = 0
      const delay = backoffMs(attempt++)
      opts.log(`watch ${source.id}: exited code=${code}, restarting in ${delay / 1000}s`)
      try { recordError(opts.stateDir, source.id) } catch {}
      await sleep(delay)
    }
  }

  /** One poll; returns the source's new cursor. Throws on failure. */
  async function pollOnce(source: Source, cursor: string | null): Promise<string | null> {
    const cfg = source.config as SourceConfig
    let found: { items: Item[]; cursor: string | null }
    if (source.kind === 'poll') {
      const adapter = POLL_ADAPTERS[basename(String(cfg.command[0]))]!
      const child = spawn(adapter.command(cfg.command, cursor), cfg.env ?? {}, true)
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      if (code !== 0) throw new Error(`exited code=${code}`)
      found = adapter.parse(source.id, out, cursor)
    } else {
      const connector = cfg.connector!
      const t = now()
      const out = await opts.runPoller!(agentPollInput(connector, cursor, t), AgentPollSchema, [connectorTools(connector)])
      found = { items: agentPollItems(source.id, connector, out, t), cursor: out.cursor }
    }
    for (const item of found.items) opts.onItem?.(source, item)
    return found.cursor
  }

  async function poll(source: Source): Promise<void> {
    const cfg = source.config as SourceConfig
    const intervalMs = (cfg.intervalSec ?? (source.kind === 'agent-poll' ? 1800 : 300)) * 1000
    let cursor = source.cursor
    while (!stopped) {
      try {
        const next = await pollOnce(source, cursor)
        if (next !== cursor) {
          cursor = next
          setCursor(opts.stateDir, source.id, cursor)
        }
      } catch (err) {
        opts.log(`watch ${source.id}: poll failed: ${err}`)
        try { recordError(opts.stateDir, source.id) } catch {}
      }
      if (stopped) break
      await sleep(intervalMs)
    }
  }

  async function readLines(source: Source, stdout: ReadableStream<Uint8Array>) {
    const reader = lineReader(line => {
      let payload: unknown
      try {
        payload = JSON.parse(line)
      } catch {
        opts.log(`watch ${source.id}: skipping non-JSON line`)
        return
      }
      try {
        opts.onPayload(source, payload)
      } catch (err) {
        opts.log(`watch ${source.id}: store failed: ${err}`)
      }
    })
    for await (const chunk of stdout) reader.push(chunk)
    reader.end()
  }

  return {
    /** Webhook secret for a running webhook source; undefined otherwise. */
    secretOf: (id: string) => secrets.get(id),
    source: (id: string) => watched.find(s => s.id === id),
    /** Starts every watched source; `port` is the hook endpoint's. Resolves when all have stopped. */
    start(port: number): Promise<void> {
      if (opts.pidDir) mkdirSync(opts.pidDir, { recursive: true, mode: 0o700 })
      const runs: Promise<void>[] = []
      for (const s of watched) {
        if (!adapterFor(s)) {
          opts.log(`watch ${s.id}: no adapter for its command; skipped`)
          continue
        }
        runs.push(run(s, port))
      }
      for (const s of polled) {
        const cfg = s.config as SourceConfig
        const ok = s.kind === 'poll'
          ? Array.isArray(cfg.command) && !!POLL_ADAPTERS[basename(String(cfg.command[0]))]
          : typeof cfg.connector === 'string' && !!opts.runPoller
        if (!ok) {
          opts.log(`watch ${s.id}: no ${s.kind === 'poll' ? 'poll adapter for its command' : 'connector or poller'}; skipped`)
          continue
        }
        runs.push(poll(s))
      }
      return Promise.all(runs).then(() => {})
    },
    stop() {
      stopped = true
      for (const c of children.values()) c.kill()
    },
  }
}
