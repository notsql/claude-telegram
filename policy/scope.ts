/**
 * `PreToolUse` http hook handler (003 FR1): scope checks that permission rules
 * can't express. In groups, a file tool reaching outside the turn's cwd, the
 * trusted dirs and the inbox needs an approver's OK first. Anything else gets
 * `{}`. Telegram tools may message any allowlisted chat (owner decision
 * 2026-10-07); `assertAllowedChat` still refuses the rest.
 */

import { parseKey } from '../sessions/key.ts'
import { expandPath, isInside } from './args.ts'

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']

export type ScopeOpts = {
  trustedDirs: () => string[]
  /** Always readable, e.g. the inbox where inbound photos land. */
  extraDirs: string[]
  /** Asks the key's approvers; true if allowed. */
  confirm: (key: string, toolName: string, input: Record<string, unknown>) => Promise<boolean>
}

export async function scopeDecision(payload: Record<string, unknown>, key: string, opts: ScopeOpts) {
  const tool = String(payload.tool_name ?? '')
  const input = (payload.tool_input ?? {}) as Record<string, unknown>
  const { chatId } = parseKey(key)

  // Groups only (FR8 read-only defaults); the owner DM may touch any path.
  if (chatId.startsWith('-') && FILE_TOOLS.includes(tool)) {
    const raw = input.file_path ?? input.notebook_path ?? input.path
    if (typeof raw === 'string' && raw) {
      const cwd = String(payload.cwd ?? '/')
      const path = expandPath(raw, cwd)
      const roots = [cwd, ...opts.trustedDirs(), ...opts.extraDirs].map(d => expandPath(d, cwd))
      if (!roots.some(r => isInside(path, r))) {
        return (await opts.confirm(key, tool, input))
          ? decide('allow', 'Approved on Telegram.')
          : deny(`${raw} is outside this chat's working directory and was not approved.`)
      }
    }
  }
  return {}
}

const decide = (permissionDecision: 'allow' | 'deny', permissionDecisionReason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
})
const deny = (reason: string) => decide('deny', reason)
