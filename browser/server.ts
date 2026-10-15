/**
 * The shared browser (015 FR1): one headed Playwright MCP server with a
 * persistent WebKit profile, so a login the owner makes survives turns and
 * restarts. It runs through the daemon's own Bun (`BUN_BE_BUN=1`), since
 * launchd's PATH has no Node, and is respawned if it exits. The server
 * closes the browser, and its window, when its last client disconnects, so
 * the daemon holds one connection open for as long as the server runs.
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
    '--viewport-size', '960x720', '--output-dir', join(dir, 'output'))
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
  let holder: Client | undefined
  let stopped = false
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 })

  async function run(): Promise<void> {
    // A no-op when the matching WebKit build is already installed.
    const install = Bun.spawn(bunx('-p', PACKAGE, 'playwright', 'install', 'webkit'), { cwd: opts.dir, env, stdout: 'ignore', stderr: 'inherit' })
    if (await install.exited !== 0) opts.log('browser: webkit install failed; starting anyway')
    while (!stopped) {
      child = Bun.spawn(browserArgv(port, opts.dir), { cwd: opts.dir, env, stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' })
      void hold(child)
      const code = await child.exited
      holder = undefined
      if (stopped) break
      opts.log(`browser: exited with ${code}; restarting in ${RESPAWN_MS / 1000}s`)
      await Bun.sleep(RESPAWN_MS)
    }
  }
  void run()

  /** Connects the holder once the server listens; gives up if this server process exits first. */
  async function hold(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    while (!stopped && proc.exitCode === null) {
      const client = new Client({ name: 'tg-daemon', version: '0' })
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(browserUrl(port))))
        holder = client
        return
      } catch {
        await Bun.sleep(1000)
      }
    }
  }

  return {
    port,
    /** Loads `url` in the browser's one window, which also opens it. */
    async open(url: string): Promise<void> {
      if (!holder) throw new Error('the browser is still starting; try again in a few seconds')
      const r = await holder.callTool({ name: 'browser_navigate', arguments: { url } })
      if (r.isError) throw new Error(JSON.stringify(r.content))
    },
    stop(): void {
      stopped = true
      void holder?.close()
      child?.kill('SIGTERM')
    },
  }
}
