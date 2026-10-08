import { homedir } from 'os'
import { resolve, sep } from 'path'
import type { Policy } from './schema.ts'

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

/**
 * Policy → `claude -p` flags (FR1, FR7), so Claude Code enforces them
 * natively. Always rules join `--allowedTools`, which takes the same rule
 * syntax as settings `permissions.allow`. The daemon's own tools never prompt.
 */
export function policyArgs(p: Policy): string[] {
  const allowed = [...new Set(['mcp__tg', ...(p.allowedTools ?? []), ...(p.alwaysAllow ?? [])])]
  return [
    ...(p.model ? ['--model', p.model] : []),
    ...(p.permissionMode ? ['--permission-mode', p.permissionMode] : []),
    '--allowedTools', ...allowed,
    ...(p.disallowedTools?.length ? ['--disallowedTools', ...p.disallowedTools] : []),
    ...(p.agent ? ['--agent', p.agent] : []),
  ]
}

/**
 * 008 FR19: the chat's skill and plugin switches as settings, merged into the
 * turn's `--settings` (a second `--settings` flag replaces the first, T821).
 */
export function policySettings(p: Policy): Record<string, unknown> | undefined {
  const off = p.disabledSkills ?? []
  if (!off.length && !Object.keys(p.plugins ?? {}).length) return
  return {
    ...(off.length && { skillOverrides: Object.fromEntries(off.map(n => [n, 'off'])) }),
    ...(p.plugins && Object.keys(p.plugins).length && { enabledPlugins: p.plugins }),
  }
}
