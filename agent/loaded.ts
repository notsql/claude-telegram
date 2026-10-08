/**
 * What turns in a cwd actually load (008 FR19): plugins (including synced
 * ones that aren't in `installed_plugins.json`) and MCP servers (user,
 * project and claude.ai connectors), from the `system/init` event. Every
 * turn adds to it; a cwd with no turn yet is probed once with a local
 * `claude -p /cost` that makes no model call. Kept in memory only.
 */

import type { InitEvent } from './stream.ts'

export type McpServer = { name: string; source?: string }
export type Loaded = { plugins: string[]; mcpServers: McpServer[] }

/** Claude Code's tool prefix for a server: `claude.ai Notion` → `claude_ai_Notion` (tools are `mcp__<prefix>__<tool>`). */
export const mcpPrefix = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_')

export function createLoadedCache(probe: (cwd: string) => Promise<InitEvent | undefined>) {
  const byCwd = new Map<string, { plugins: Set<string>; mcp: Map<string, McpServer> }>()

  function record(cwd: string, init: InitEvent | undefined): void {
    const seen = byCwd.get(cwd) ?? { plugins: new Set<string>(), mcp: new Map<string, McpServer>() }
    byCwd.set(cwd, seen)
    for (const p of (init?.plugins ?? []) as { source?: string }[]) if (p.source) seen.plugins.add(p.source)
    for (const m of init?.mcp_servers ?? []) seen.mcp.set(m.name, { name: m.name, ...(typeof m.source === 'string' && { source: m.source }) })
  }

  /** What has been seen so far, without probing. */
  function peek(cwd: string): Loaded {
    const seen = byCwd.get(cwd)
    return { plugins: [...seen?.plugins ?? []].sort(), mcpServers: [...seen?.mcp.values() ?? []].sort((a, b) => a.name.localeCompare(b.name)) }
  }

  return {
    record,
    peek,
    async get(cwd: string): Promise<Loaded> {
      if (!byCwd.has(cwd)) record(cwd, await probe(cwd).catch(() => undefined))
      return peek(cwd)
    },
  }
}

/** The `init` event of a local `claude -p /cost` in `cwd`, with the daemon's settings file. */
export async function probeInit(cwd: string, settingsFile: string): Promise<InitEvent | undefined> {
  const { CLAUDECODE, CLAUDE_CODE_SESSION_ID, ...env } = process.env
  const child = Bun.spawn([
    'claude', '-p', '/cost', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--settings', settingsFile,
  ], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env, timeout: 60_000 })
  const out = await new Response(child.stdout).text()
  for (const line of out.split('\n')) {
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'system' && ev.subtype === 'init') return ev as InitEvent
    } catch {}
  }
}
