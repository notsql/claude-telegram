/**
 * Where learned skills live (006 FR1) and which names they may take (FR5).
 * Skills go to `~/.claude/skills/<name>/`, or `<chat cwd>/.claude/skills/`
 * when the chat policy sets `skillScope: project`. Archived skills move to
 * `<root>/.archive/`. A name must match `[a-z0-9-]{1,48}` and must not clash
 * with a built-in command or a skill installed anywhere else.
 */

import { homedir } from 'os'
import { join } from 'path'
import { claudeDir } from '../memory/paths.ts'
import { expandPath, isInside } from '../policy/args.ts'
import { discoverSkills } from '../commands/skillMap.ts'
import type { Policy } from '../policy/schema.ts'

export const NAME_RE = /^[a-z0-9-]{1,48}$/

/** Claude Code built-in commands and bundled skills a learned skill must not shadow. */
export const BUILTIN_NAMES = new Set([
  'add-dir', 'agents', 'bug', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'exit', 'export', 'help',
  'hooks', 'init', 'login', 'logout', 'mcp', 'memory', 'model', 'permissions', 'plugin', 'pr-comments',
  'release-notes', 'resume', 'review', 'security-review', 'skills', 'status', 'vim', 'simplify', 'loop',
  'schedule', 'claude-api', 'update-config', 'keybindings-help', 'code-review', 'run',
])

export const userSkillsRoot = (base = claudeDir()) => join(base, 'skills')
export const projectSkillsRoot = (cwd: string) => join(cwd, '.claude', 'skills')
export const archiveDir = (root: string) => join(root, '.archive')

/** The root a chat's learned skills are written to. */
export function skillsRoot(policy: Policy, base = claudeDir(), home = homedir()): string {
  return policy.skillScope === 'project' && policy.cwd
    ? projectSkillsRoot(expandPath(policy.cwd, home, home))
    : userSkillsRoot(base)
}

export function validName(name: string): boolean {
  return NAME_RE.test(name)
}

/**
 * Bare names of every skill installed outside `root` (user, project, plugin),
 * plus the built-ins. Plugin skills count by their bare name, so `access`
 * clashes with `telegram:access`.
 */
export function takenNames(root: string, cwds: string[], base = claudeDir()): Set<string> {
  const names = new Set(BUILTIN_NAMES)
  for (const s of discoverSkills(base, cwds)) {
    if (isInside(s.path, root)) continue
    names.add(s.name.split(':').pop()!)
  }
  return names
}

/** Why `name` can't be used for a new skill in `root`, or null. */
export function nameRefusal(name: string, taken: Set<string>): string | null {
  if (!validName(name)) return `skill name "${name}" must match [a-z0-9-]{1,48}`
  if (taken.has(name)) return `skill name "${name}" is already used by a built-in or installed skill`
  return null
}
