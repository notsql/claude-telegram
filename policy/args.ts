import { homedir } from 'os'
import { resolve, sep } from 'path'

/** `~` and relative paths resolved against `base`. */
export function expandPath(p: string, base: string, home = homedir()): string {
  return resolve(base, p === '~' ? home : p.startsWith('~/') ? home + p.slice(1) : p)
}

export function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/**
 * FR13: `claude -p` runs a cwd's project hooks and MCP servers without a trust
 * prompt, so a chat `cwd` must be inside an owner-approved `trustedDirs` entry.
 */
export function isTrustedCwd(cwd: string, trustedDirs: string[] = [], home = homedir()): boolean {
  const path = expandPath(cwd, home, home)
  return trustedDirs.some(d => isInside(path, expandPath(d, home, home)))
}
