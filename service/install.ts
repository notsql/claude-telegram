/**
 * FR11 service management: a launchd agent on macOS, a systemd user unit on
 * Linux. Starts at login/boot, restarts on exit, logs to STATE_DIR/logs. The
 * unit runs `selfCommand(['start'])` (011 FR4) with a PATH that finds `claude`.
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { STATE_DIR } from '../access.ts'
import { selfCommand } from '../util/self.ts'
// FR3: text imports are bundled into the compiled binary
import launchd from './launchd.plist.tmpl' with { type: 'text' }
import systemd from './systemd.service.tmpl' with { type: 'text' }

const LABEL = 'com.claude.telegram'
const UNIT = 'claude-telegram.service'
const LOG_DIR = join(STATE_DIR, 'logs')

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// systemd: `%` is a specifier and `$` expands in ExecStart, even inside quotes.
const sdEscape = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')

export function render(tmpl: string, vars: Record<string, string>, escape = (s: string) => s): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`template variable ${k} not set`)
    return escape(vars[k]!)
  })
}

/** Directories of `claude` and the self command first, then the system defaults, de-duplicated. */
export function servicePath(claude: string, self: string): string {
  const dirs = [dirname(claude), dirname(self), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  return [...new Set(dirs)].join(':')
}

type UnitInputs = { cmd: string[]; claude: string; stateDir: string; logDir: string }

/** The unit file text; `cmd` is the program and its arguments (FR4). */
export function renderUnit(kind: 'launchd' | 'systemd', u: UnitInputs): string {
  const esc = kind === 'launchd' ? xmlEscape : sdEscape
  const vars: Record<string, string> = Object.fromEntries(Object.entries({
    LABEL, PATH: servicePath(u.claude, u.cmd[0]!), STATE_DIR: u.stateDir, LOG_DIR: u.logDir,
  }).map(([k, v]) => [k, esc(v)]))
  vars.ARGS = kind === 'launchd'
    ? u.cmd.map(a => `    <string>${esc(a)}</string>`).join('\n')
    : u.cmd.map(a => `"${esc(a)}"`).join(' ')
  return render(kind === 'launchd' ? launchd : systemd, vars)
}

/** `launchctl print` output: the service's own (tab-indented) state and pid lines. */
export function parseLaunchctlPrint(out: string): { running: boolean; pid?: number } {
  const state = /^\tstate = (\S+)/m.exec(out)?.[1]
  const pid = /^\tpid = (\d+)/m.exec(out)?.[1]
  return { running: state === 'running', ...(pid ? { pid: Number(pid) } : {}) }
}

function sh(cmd: string[], allowFail = false): void {
  const r = Bun.spawnSync(cmd, { stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0 && !allowFail) throw new Error(`${cmd.join(' ')} exited ${r.exitCode}`)
}

const mac = () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error(`unsupported platform: ${process.platform}`)
  return process.platform === 'darwin'
}
const unitFile = () => mac()
  ? join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
  : join(homedir(), '.config', 'systemd', 'user', UNIT)
const target = () => `gui/${process.getuid!()}/${LABEL}`

/** Writes the unit and (re)loads it; replaces an older unit with the same label. */
export function install(): void {
  const claude = Bun.which('claude')
  if (!claude) throw new Error('`claude` not found on PATH; install it and log in first')
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
  const dest = unitFile()
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, renderUnit(mac() ? 'launchd' : 'systemd', { cmd: selfCommand(['start']), claude, stateDir: STATE_DIR, logDir: LOG_DIR }))
  if (mac()) {
    sh(['launchctl', 'bootout', target()], true)
    sh(['launchctl', 'bootstrap', `gui/${process.getuid!()}`, dest])
  } else {
    sh(['systemctl', '--user', 'daemon-reload'])
    sh(['systemctl', '--user', 'enable', '--now', UNIT])
  }
  console.log(`installed ${dest}\nlogs: ${LOG_DIR}`)
  if (!mac()) console.log(`to start at boot without logging in: loginctl enable-linger ${process.env.USER ?? '$USER'}`)
}

export function uninstall(): void {
  if (mac()) sh(['launchctl', 'bootout', target()], true)
  else sh(['systemctl', '--user', 'disable', '--now', UNIT], true)
  rmSync(unitFile(), { force: true })
  if (!mac()) sh(['systemctl', '--user', 'daemon-reload'], true)
  console.log(`removed ${unitFile()}`)
}

export function stop(): void {
  sh(mac() ? ['launchctl', 'bootout', target()] : ['systemctl', '--user', 'stop', UNIT])
}

export function restart(): void {
  sh(mac() ? ['launchctl', 'kickstart', '-k', target()] : ['systemctl', '--user', 'restart', UNIT])
}

/** Exit code: 0 running, 1 installed but stopped, 3 not installed. */
export function status(): number {
  if (!existsSync(unitFile())) {
    console.log(`not installed (${unitFile()} missing)`)
    return 3
  }
  let s: { running: boolean; pid?: number }
  if (mac()) {
    const r = Bun.spawnSync(['launchctl', 'print', target()], { stderr: 'ignore' })
    s = r.exitCode === 0 ? parseLaunchctlPrint(r.stdout.toString()) : { running: false }
  } else {
    const active = Bun.spawnSync(['systemctl', '--user', 'is-active', UNIT]).stdout.toString().trim() === 'active'
    const pid = Number(/MainPID=(\d+)/.exec(Bun.spawnSync(['systemctl', '--user', 'show', '-p', 'MainPID', UNIT]).stdout.toString())?.[1] ?? 0)
    s = { running: active, ...(pid ? { pid } : {}) }
  }
  console.log(s.running ? `running${s.pid ? ` (pid ${s.pid})` : ''}` : 'stopped')
  return s.running ? 0 : 1
}

/** Tail of daemon.err.log (and .out if non-empty); `-f` follows. */
export async function logs(args: string[]): Promise<void> {
  const files = ['daemon.err.log', 'daemon.out.log'].map(f => join(LOG_DIR, f))
    .filter((f, i) => existsSync(f) && (i === 0 || statSync(f).size > 0))
  if (!files.length) {
    console.log(`no logs in ${LOG_DIR}`)
    return
  }
  await Bun.spawn(['tail', '-n', '50', ...(args.includes('-f') ? ['-f'] : []), ...files], { stdio: ['inherit', 'inherit', 'inherit'] }).exited
}
