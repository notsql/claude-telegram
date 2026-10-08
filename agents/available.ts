/**
 * Agents a chat can run as (009 FR3, FR4): the user-scope agents in
 * `~/.claude/agents/` and the project agents under the turn's cwd. A policy's
 * `agent` must name one of them; this is checked when `/settings` saves it.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { Access } from '../access.ts'

/** The frontmatter `name` (falling back to the file name), `description` and `tools`. */
function agentInfo(file: string): { name: string; description: string; tools: string } {
  const fm = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  const field = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.+?)\\s*$`, 'm'))?.[1]?.replace(/^['"]|['"]$/g, '') ?? ''
  return { name: field('name') || file.split('/').pop()!.replace(/\.md$/, ''), description: field('description'), tools: field('tools') }
}

function agentFiles(claudeDir: string, cwd?: string): string[] {
  const dirs = [join(claudeDir, 'agents'), ...(cwd ? [join(cwd, '.claude', 'agents')] : [])]
  return dirs.flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')).map(f => join(dir, f)) : [])
}

/** Sorted, de-duplicated agent names from `<claudeDir>/agents` and `<cwd>/.claude/agents`. */
export function availableAgents(claudeDir: string, cwd?: string): string[] {
  return [...new Set(agentFiles(claudeDir, cwd).map(f => agentInfo(f).name))].sort()
}

/**
 * Agents a chat can usefully run as, with descriptions, for `/settings` (008
 * FR20). Structured-output-only agents (tg-reflector, tg-summarizer) can't
 * hold a conversation, so they're left out.
 */
export function chatAgents(claudeDir: string, cwd?: string): { name: string; description: string }[] {
  const seen = new Map<string, { name: string; description: string }>()
  for (const f of agentFiles(claudeDir, cwd)) {
    const a = agentInfo(f)
    if (a.tools !== 'StructuredOutput' && !seen.has(a.name)) seen.set(a.name, { name: a.name, description: a.description })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
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
