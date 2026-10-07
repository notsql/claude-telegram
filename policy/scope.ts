/**
 * `PreToolUse` http hook handler (003 FR1): hard scope denies that permission
 * rules can't express. Telegram tools may only target the session's own chat,
 * and in groups file tools stay inside the turn's cwd, the trusted dirs and
 * the inbox. Anything else gets `{}` (no opinion).
 */

import { parseKey } from '../sessions/key.ts'
import { expandPath, isInside } from './args.ts'

const CHAT_TOOLS = ['mcp__tg__reply', 'mcp__tg__react', 'mcp__tg__edit_message']
const FILE_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']

export type ScopeOpts = {
  trustedDirs: () => string[]
  /** Always readable, e.g. the inbox where inbound photos land. */
  extraDirs: string[]
}

export function scopeDecision(payload: Record<string, unknown>, key: string, opts: ScopeOpts) {
  const tool = String(payload.tool_name ?? '')
  const input = (payload.tool_input ?? {}) as Record<string, unknown>
  const { chatId } = parseKey(key)

  if (CHAT_TOOLS.includes(tool) && input.chat_id !== undefined && String(input.chat_id) !== chatId) {
    return deny(`This session can only message chat ${chatId}.`)
  }

  // Groups only (FR8 read-only defaults); the owner DM may touch any path.
  if (chatId.startsWith('-') && FILE_TOOLS.includes(tool)) {
    const raw = input.file_path ?? input.notebook_path ?? input.path
    if (typeof raw === 'string' && raw) {
      const cwd = String(payload.cwd ?? '/')
      const path = expandPath(raw, cwd)
      const roots = [cwd, ...opts.trustedDirs(), ...opts.extraDirs].map(d => expandPath(d, cwd))
      if (!roots.some(r => isInside(path, r))) return deny(`${raw} is outside this chat's working directory.`)
    }
  }
  return {}
}

const deny = (permissionDecisionReason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason },
})
