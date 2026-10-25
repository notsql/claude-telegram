/**
 * `PreToolUse` http hook handler (003 FR1): scope checks that permission rules
 * can't express. In groups, a file tool reaching outside the turn's cwd, the
 * trusted dirs and the inbox needs an approver's OK first. Anything else gets
 * `{}`. Memory and history tools are denied when the policy turns them off
 * (also refused inside the tools). Telegram tools may message any allowlisted chat (owner decision
 * 2026-10-07); `assertAllowedChat` still refuses the rest. With the 020
 * guard on, off-limits actions are denied first and send / pay / sign /
 * delete calls always ask, whatever the policy says.
 */

import { parseKey } from '../sessions/key.ts'
import { expandPath, isInside } from './args.ts'
import { classify, type ActionClass } from './consequential.ts'
import type { Policy } from './schema.ts'

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']

export type ScopeOpts = {
  trustedDirs: () => string[]
  policy: (key: string) => Policy
  /** Always readable, e.g. the inbox where inbound photos land. */
  extraDirs: string[]
  /** Asks the key's approvers; true if allowed. `title` heads a 020 action card. */
  confirm: (key: string, toolName: string, input: Record<string, unknown>, title?: string) => Promise<boolean>
  /** 020: `TELEGRAM_ACTION_GUARD=1`. */
  actionGuard?: boolean
}

export async function scopeDecision(payload: Record<string, unknown>, key: string, opts: ScopeOpts) {
  const tool = String(payload.tool_name ?? '')
  const input = (payload.tool_input ?? {}) as Record<string, unknown>
  const { chatId } = parseKey(key)

  if (opts.actionGuard) {
    const c = classify(tool, input, { cwd: String(payload.cwd ?? '/') })
    if (c && 'offLimits' in c) {
      return deny(`Off-limits even with approval: ${c.offLimits}. Explain this to the owner and offer to prepare the steps for them to do themselves.`)
    }
    // FR3: asked every time, ahead of Always rules and chat policy; unanswered is a deny.
    if (c) {
      return (await opts.confirm(key, tool, input, `${ICON[c.class]} ${c.summary}`))
        ? decide('allow', 'Approved on Telegram.')
        : deny(`The owner did not approve this ${c.class} action. Don't retry it; ask what they want instead.`)
    }
  }

  const name = tool.replace(/^mcp__tg__/, '')
  if (name !== tool) {
    const p = opts.policy(key)
    if (name.startsWith('memory_') && p.memoryScope === 'none') return deny('Memory is off in this chat (memoryScope: none).')
    if (name === 'history_search' && p.historyScope === 'none') return deny('History search is off in this chat (historyScope: none).')
  }

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

const ICON: Record<ActionClass, string> = { send: '✉️', pay: '💳', sign: '✍️', delete: '🗑' }

const decide = (permissionDecision: 'allow' | 'deny', permissionDecisionReason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
})
const deny = (reason: string) => decide('deny', reason)
