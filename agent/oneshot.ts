/**
 * Runs a one-shot structured call for 004–006: `claude -p --output-format json
 * --json-schema …` with every hook disabled, so it never reaches the daemon's
 * hook endpoint, and with no tools, no MCP servers and no saved transcript. The CLI validates against the schema; zod checks it again.
 * Until 009 T902 ships the `tg-*` agents, calls without one use haiku.
 */

import { z } from 'zod'

export async function runOneShot<T extends z.ZodType>(
  agent: string | undefined,
  input: string,
  schema: T,
): Promise<z.infer<T>> {
  // T003: inherited Claude Code env makes the child reuse the parent's session.
  const { CLAUDECODE, CLAUDE_CODE_SESSION_ID, ...env } = process.env
  const child = Bun.spawn([
    'claude', '-p', input,
    ...(agent ? ['--agent', agent] : ['--model', 'haiku']),
    '--output-format', 'json',
    // The CLI's validator rejects zod's default draft-2020-12 `$schema`.
    '--json-schema', JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' })),
    '--settings', '{"disableAllHooks":true}',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence',
  ], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', env })

  const [out, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  let res: { is_error?: boolean; result?: string; structured_output?: unknown }
  try {
    res = JSON.parse(out)
  } catch {
    throw new Error(`oneshot: claude exited ${exitCode} without JSON output`)
  }
  if (res.is_error || res.structured_output === undefined) {
    throw new Error(`oneshot: no structured_output (exit ${exitCode}): ${res.result ?? ''}`)
  }
  return schema.parse(res.structured_output)
}
