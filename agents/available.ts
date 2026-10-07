/**
 * Agents a chat can run as (009 FR3, FR4): the user-scope agents in
 * `~/.claude/agents/` and the project agents under the turn's cwd. A policy's
 * `agent` must name one of them; this is checked when `/agent` saves it.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { Access } from '../access.ts'

/** The frontmatter `name`, falling back to the file name. */
function agentName(file: string): string {
  const fm = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1]
  const name = fm?.match(/^name:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, '')
  return name || file.split('/').pop()!.replace(/\.md$/, '')
}

/** Sorted, de-duplicated agent names from `<claudeDir>/agents` and `<cwd>/.claude/agents`. */
export function availableAgents(claudeDir: string, cwd?: string): string[] {
  const dirs = [join(claudeDir, 'agents'), ...(cwd ? [join(cwd, '.claude', 'agents')] : [])]
  const names = dirs.flatMap(dir => existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.md')).map(f => agentName(join(dir, f)))
    : [])
  return [...new Set(names)].sort()
}

/**
 * Sets (or with `undefined` clears) `agent` on the policy entry for `key`.
 * Throws when the name is not an available agent. Mutates `access`.
 */
export function setPolicyAgent(access: Access, key: string, name: string | undefined, available: string[]): void {
  if (name !== undefined && !available.includes(name)) throw new Error(`No agent named ${name}.`)
  const policy = ((access.chats ??= {})[key] ??= {}).policy ??= {}
  if (name === undefined) delete policy.agent
  else policy.agent = name
}
