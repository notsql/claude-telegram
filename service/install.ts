/**
 * FR11 service installer: a launchd agent on macOS, a systemd user unit on
 * Linux. Starts at login/boot, restarts on exit, logs to STATE_DIR/logs, and
 * bakes a PATH that finds both `claude` and `bun`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { STATE_DIR } from '../access.ts'

const LABEL = 'com.claude.telegram'
const ROOT = dirname(import.meta.dir)

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function render(tmpl: string, vars: Record<string, string>, escape = (s: string) => s): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`template variable ${k} not set`)
    return escape(vars[k]!)
  })
}

/** Directories of `claude` and `bun` first, then the system defaults, de-duplicated. */
export function servicePath(claude: string, bun: string): string {
  const dirs = [dirname(claude), dirname(bun), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  return [...new Set(dirs)].join(':')
}

function run(cmd: string[], allowFail = false): void {
  const r = Bun.spawnSync(cmd, { stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0 && !allowFail) throw new Error(`${cmd.join(' ')} exited ${r.exitCode}`)
}

function main(): void {
  const claude = Bun.which('claude')
  if (!claude) throw new Error('`claude` not found on PATH; install it and log in first')
  // The PATH symlink, not `process.execPath`: Homebrew resolves that to a
  // versioned Cellar dir that vanishes on `brew upgrade bun`.
  const bun = Bun.which('bun') ?? process.execPath
  const logDir = join(STATE_DIR, 'logs')
  mkdirSync(logDir, { recursive: true, mode: 0o700 })
  const vars = {
    LABEL, ROOT, BUN: bun, DAEMON: join(ROOT, 'daemon.ts'),
    PATH: servicePath(claude, bun), STATE_DIR, LOG_DIR: logDir,
  }
  const tmpl = (name: string) => readFileSync(join(import.meta.dir, name), 'utf8')

  if (process.platform === 'darwin') {
    const dest = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, render(tmpl('launchd.plist.tmpl'), vars, xmlEscape))
    const domain = `gui/${process.getuid!()}`
    run(['launchctl', 'bootout', `${domain}/${LABEL}`], true)
    run(['launchctl', 'bootstrap', domain, dest])
    console.log(`installed ${dest}\nlogs: ${logDir}`)
  } else if (process.platform === 'linux') {
    const dest = join(homedir(), '.config', 'systemd', 'user', 'claude-telegram.service')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, render(tmpl('systemd.service.tmpl'), vars))
    run(['systemctl', '--user', 'daemon-reload'])
    run(['systemctl', '--user', 'enable', '--now', 'claude-telegram.service'])
    console.log(`installed ${dest}\nlogs: ${logDir}`)
    console.log(`to start at boot without logging in: loginctl enable-linger ${process.env.USER ?? '$USER'}`)
  } else {
    throw new Error(`unsupported platform: ${process.platform}`)
  }
}

if (import.meta.main) main()
