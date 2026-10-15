/**
 * The shared browser (015 FR1): one headed Playwright MCP server with a
 * persistent WebKit profile, so a login the owner makes survives turns and
 * restarts. It runs through the daemon's own Bun (`BUN_BE_BUN=1`), since
 * launchd's PATH has no Node, and is respawned if it exits.
 */

import { mkdirSync } from 'fs'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PACKAGE = '@playwright/mcp@0.0.83'
const RESPAWN_MS = 5000

const bunx = (...args: string[]) => [process.execPath, 'x', '--bun', ...args]

/** `--allowed-hosts` because the server checks `Host` against `localhost` even when bound to 127.0.0.1. */
export function browserArgv(port: number, dir: string): string[] {
  return bunx(PACKAGE,
    '--host', '127.0.0.1', '--allowed-hosts', `127.0.0.1:${port}`, '--port', String(port),
    '--browser', 'webkit', '--user-data-dir', join(dir, 'profile'), '--shared-browser-context',
    '--output-dir', join(dir, 'output'))
}

export const browserUrl = (port: number) => `http://127.0.0.1:${port}/mcp`

function freePort(): number {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = s.port
  s.stop(true)
  return port
}

export function startBrowser(opts: { dir: string; log: (line: string) => void }) {
  const port = freePort()
  const env = { ...process.env, BUN_BE_BUN: '1' }
  let child: ReturnType<typeof Bun.spawn> | undefined
  let stopped = false
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 })

  async function run(): Promise<void> {
    // A no-op when the matching WebKit build is already installed.
    const install = Bun.spawn(bunx('-p', PACKAGE, 'playwright', 'install', 'webkit'), { cwd: opts.dir, env, stdout: 'ignore', stderr: 'inherit' })
    if (await install.exited !== 0) opts.log('browser: webkit install failed; starting anyway')
    while (!stopped) {
      child = Bun.spawn(browserArgv(port, opts.dir), { cwd: opts.dir, env, stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' })
      const code = await child.exited
      if (stopped) break
      opts.log(`browser: exited with ${code}; restarting in ${RESPAWN_MS / 1000}s`)
      await Bun.sleep(RESPAWN_MS)
    }
  }
  void run()

  return {
    port,
    /** Opens `url` in a new tab, leaving any tab the agent is using alone. */
    async openTab(url: string): Promise<void> {
      const client = new Client({ name: 'tg-daemon', version: '0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(browserUrl(port))))
      try {
        const r = await client.callTool({ name: 'browser_tabs', arguments: { action: 'new', url } })
        if (r.isError) throw new Error(JSON.stringify(r.content))
      } finally {
        await client.close()
      }
    },
    stop(): void {
      stopped = true
      child?.kill('SIGTERM')
    },
  }
}
