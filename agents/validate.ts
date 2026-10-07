/**
 * Guardrails for learned agents (009 FR9). A draft is refused when it:
 * - is not named `tg-…`
 * - has no explicit `tools` list (no inherit-all)
 * - lists the `Agent` tool (owner-only; there is no opt-in yet, so always refused)
 * - asks for `permissionMode` `bypassPermissions` or `auto`
 * - defines an MCP server inline instead of naming an existing one
 * - patches an agent this bot did not write (`source: tg` marker)
 * - contains something that looks like a secret
 */

import { secretRefusal } from '../memory/guard.ts'

export type AgentDraft = {
  name: string
  description: string
  tools: string[]
  model?: string
  skills?: string[]
  memory?: 'user' | 'project' | 'local'
  permissionMode?: string
  /** Names of existing MCP servers only. Anything else is an inline definition and refused. */
  mcpServers?: unknown[]
  body: string
}

export const AGENT_NAME = /^tg-[a-z0-9]+(-[a-z0-9]+)*$/
const FORBIDDEN_MODES = ['bypassPermissions', 'auto']
const MAX_NAME = 48

/** Why the draft is refused, or undefined when it passes. `existingSource` is the marker of the agent a patch replaces. */
export function agentRefusal(d: AgentDraft, patch?: { existingSource?: string }): string | undefined {
  if (!AGENT_NAME.test(d.name) || d.name.length > MAX_NAME) return `agent name must be tg- plus kebab-case, at most ${MAX_NAME} characters`
  if (!d.description.trim()) return 'description is required'
  if (!Array.isArray(d.tools) || !d.tools.length || d.tools.some(t => typeof t !== 'string' || !t.trim() || t.trim() === '*')) {
    return 'tools must be an explicit list'
  }
  if (d.tools.some(t => /^(Agent|Task)(\(|$)/.test(t.trim()))) return 'the Agent tool needs the owner\'s approval'
  if (d.permissionMode && FORBIDDEN_MODES.includes(d.permissionMode)) return `permissionMode ${d.permissionMode} is not allowed`
  if (d.mcpServers?.some(s => typeof s !== 'string')) return 'mcpServers may only name existing servers, not define them'
  if (patch && patch.existingSource !== 'tg') return `${d.name} was not written by this bot, so it can't be patched`
  return secretRefusal([d.description, d.body, ...d.tools].join('\n'), 'agents') ?? undefined
}
