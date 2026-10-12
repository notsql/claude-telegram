/**
 * Process identity for PID files (011 FR4): a PID file holds `<pid> <start time>`,
 * so a recycled PID never matches. LC_ALL=C: launchd and a shell otherwise
 * format the date differently.
 */

import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

export const startTime = (pid: number) =>
  execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } }).trim()

/** SIGTERMs the process recorded in `path` if it is still the same process. Returns its PID when killed. */
export function killStale(path: string): number | undefined {
  try {
    const [pid, ...started] = readFileSync(path, 'utf8').trim().split(' ')
    const stale = parseInt(pid!, 10)
    if (stale > 1 && stale !== process.pid && started.length && startTime(stale) === started.join(' ')) {
      process.kill(stale, 'SIGTERM')
      return stale
    }
  } catch {}
}

export const writePidFile = (path: string, pid: number) => writeFileSync(path, `${pid} ${startTime(pid)}`)
