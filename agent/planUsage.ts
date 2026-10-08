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

/** `█████░░░░░` for a percentage. */
export function bar(pct: number, width = 10): string {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/**
 * The `/usage` report with a bar per limit and per contributor. Lines it
 * doesn't recognise pass through, so a changed report still reads.
 */
export function formatUsage(report: string): string {
  const out = ['📊 Plan usage']
  for (const raw of report.split('\n')) {
    const line = raw.trim()
    const limit = /^(.+?): (\d+)% used(?: · (resets .+))?$/.exec(line)
    const part = /^(\d+)% of your usage (?:came from |was )?(.+)$/.exec(line)
    if (limit) out.push('', `${limit[1]}: ${limit[2]}%`, bar(Number(limit[2])), ...(limit[3] ? [limit[3][0]!.toUpperCase() + limit[3].slice(1)] : []))
    else if (part) out.push(`${bar(Number(part[1]))} ${part[1]}% ${part[2]}`)
    else if (/^What's contributing/.test(line)) out.push('', "What's using it")
    else if (/^Approximate, based on/.test(line)) out.push('(approximate, from sessions on this machine)')
    else if (/^Last /.test(line)) out.push('', line)
    else if (/^You are currently using/.test(line) || !line) continue
    else out.push(`  ${line}`)
  }
  return out.join('\n')
}
