/**
 * `/usage` (008 FR1): Claude Code's own `/usage` report, the subscription's
 * session and weekly limits. `claude -p /usage` answers locally with no model
 * call; hooks, MCP servers and the transcript are off, as in `oneshot.ts`.
 */

export async function planUsage(): Promise<string> {
  // T003: inherited Claude Code env makes the child reuse the parent's session.
  const { CLAUDECODE, CLAUDE_CODE_SESSION_ID, ...env } = process.env
  const child = Bun.spawn([
    'claude', '-p', '/usage',
    '--output-format', 'json',
    '--settings', '{"disableAllHooks":true}',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence',
  ], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', env, timeout: 60_000 })
  const [out, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  let res: { is_error?: boolean; result?: string }
  try {
    res = JSON.parse(out)
  } catch {
    throw new Error(`usage: claude exited ${exitCode} without JSON output`)
  }
  if (res.is_error || !res.result) throw new Error(`usage: ${res.result ?? `exit ${exitCode}`}`)
  return res.result
}
