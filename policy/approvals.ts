/**
 * `PermissionRequest` http hook handler (003 FR1–FR4). Claude Code calls it
 * only when no permission rule resolved a tool call. The request is held open
 * while the prompt waits in the session's chat; the answer becomes the hook's
 * decision. Unanswered prompts expire into a deny, so approvals fail closed.
 */

import { InlineKeyboard, type Api } from 'grammy'
import { randomInt } from 'crypto'
import { parseKey } from '../sessions/key.ts'
import { threadOpts } from '../telegram/send.ts'
import { deriveRule } from './rules.ts'
import type { AuditEntry } from './audit.ts'

/** 5 lowercase letters without 'l', the alphabet of the `yes xxxxx` text reply (FR5). */
const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'

/** `yes abcde` / `no abcde` typed in chat (FR5), same as the legacy channel. */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

/** The request id and decision of a text reply, or undefined if `text` isn't one. */
export function parseTextReply(text: string): { id: string; decision: 'allow' | 'deny' } | undefined {
  const m = PERMISSION_REPLY_RE.exec(text)
  return m ? { id: m[2]!.toLowerCase(), decision: m[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny' } : undefined
}

export type Decision = 'allow' | 'deny' | 'always'

type Pending = {
  key: string
  toolName: string
  input: Record<string, unknown>
  chatId: string
  messageId?: number
  resolve: (d: Decision | 'expired') => void
  /** Telegram user id that answered. */
  by?: string
}

export type ApprovalsOpts = {
  api: Api
  timeoutSec: number
  /** Persists an Always rule to the key's `alwaysAllow` so later turns get it natively. */
  saveRule: (key: string, rule: string) => void
  audit?: (entry: AuditEntry) => void
}

export function createApprovals({ api, timeoutSec, saveRule, audit }: ApprovalsOpts) {
  const pending = new Map<string, Pending>()

  const newId = () => {
    let id: string
    do id = Array.from({ length: 5 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('')
    while (pending.has(id))
    return id
  }

  /** `always: false` drops the Always button, for prompts no rule could cover. */
  const keyboard = (id: string, always = true) => {
    const kb = new InlineKeyboard()
      .text('See more', `perm:more:${id}`)
      .text('✅ Allow', `perm:allow:${id}`)
      .text('❌ Deny', `perm:deny:${id}`)
    return always ? kb.row().text('♾ Always (this chat)', `perm:always:${id}`) : kb
  }

  /** Sends the prompt to the key's chat and waits for a decision or expiry. Audited. */
  async function ask(key: string, toolName: string, input: Record<string, unknown>, always = true) {
    const target = parseKey(key)
    const id = newId()
    let by: string | undefined
    const decision = await new Promise<Decision | 'expired'>(resolve => {
      const p: Pending = { key, toolName, input, chatId: target.chatId, resolve }
      pending.set(id, p)
      const timer = setTimeout(() => {
        resolve('expired')
        if (p.messageId != null) void api.editMessageText(p.chatId, p.messageId, `${title(p)}\n\n⌛ Expired`).catch(() => {})
      }, timeoutSec * 1000)
      p.resolve = d => { clearTimeout(timer); pending.delete(id); by = p.by; resolve(d) }
      // FR5: the id is what a typed `yes xxxxx` answer refers to.
      void api.sendMessage(target.chatId, `${title(p)}\n\nOr reply "yes ${id}" / "no ${id}".`, { ...threadOpts(target), reply_markup: keyboard(id, always) })
        .then(m => { p.messageId = m.message_id })
        .catch(err => process.stderr.write(`telegram daemon: permission prompt send failed: ${err}\n`))
    })
    pending.delete(id)
    return { decision, by }
  }

  async function handle(payload: Record<string, unknown>, key: string) {
    const toolName = String(payload.tool_name ?? '')
    const input = (payload.tool_input ?? {}) as Record<string, unknown>
    const { decision, by } = await ask(key, toolName, input)
    const rules: string[] = []
    const out = hookOutput(decision, toolName, input, payload.permission_suggestions, r => { rules.push(r); saveRule(key, r) })
    audit?.({ event: 'approval', key, tool: toolName, decision, ...(by && { user: by }), ...(rules.length && { rule: rules.join(' ') }) })
    return out
  }

  /**
   * A one-off prompt from the PreToolUse hook (`ask` there is a deny in -p).
   * No Always: rules can't widen the scope check.
   */
  async function confirm(key: string, toolName: string, input: Record<string, unknown>): Promise<boolean> {
    const { decision, by } = await ask(key, toolName, input, false)
    audit?.({ event: 'approval', key, tool: toolName, decision, ...(by && { user: by }) })
    return decision === 'allow' || decision === 'always'
  }

  return {
    handle,
    confirm,
    /** Answers a pending request; false if it is unknown or already decided. */
    decide(id: string, d: Decision, by?: string): boolean {
      const p = pending.get(id)
      if (!p) return false
      p.by = by
      p.resolve(d)
      return true
    },
    /** Session key of a pending request, for the approvers check (FR3). */
    keyOf: (id: string) => pending.get(id)?.key,
    /** The expanded "See more" text, or undefined once decided. */
    details(id: string): string | undefined {
      const p = pending.get(id)
      if (!p) return undefined
      return `${title(p)}\n\n${JSON.stringify(p.input, null, 2).slice(0, 3500)}`
    },
    keyboard,
  }
}

const title = (p: Pick<Pending, 'toolName'>) => `🔐 Permission: ${p.toolName}`

type RuleValue = { toolName: string; ruleContent?: string }

const ruleString = (r: RuleValue) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)

/**
 * The allow rules Claude Code itself suggests for this call
 * (`permission_suggestions`). They cover what our derived rule can miss, such
 * as the `Read(//dir/**)` a Bash command needs for a path outside the cwd.
 */
function suggestedRules(suggestions: unknown): RuleValue[] {
  if (!Array.isArray(suggestions)) return []
  return suggestions.flatMap(s =>
    s?.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules)
      ? s.rules.filter((r: RuleValue) => typeof r?.toolName === 'string')
      : [])
}

export function hookOutput(
  d: Decision | 'expired',
  toolName: string,
  input: Record<string, unknown>,
  suggestions: unknown,
  saveRule: (rule: string) => void,
) {
  if (d === 'deny' || d === 'expired') {
    const message = d === 'deny' ? 'Denied by the user on Telegram.' : 'No answer on Telegram before the approval timed out.'
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } }
  }
  const decision: Record<string, unknown> = { behavior: 'allow' }
  if (d === 'always') {
    let rules = suggestedRules(suggestions)
    if (!rules.length) {
      const rule = deriveRule(toolName, input)
      const m = /^([^(]+)\((.*)\)$/.exec(rule)
      rules = [m ? { toolName: m[1]!, ruleContent: m[2] } : { toolName: rule }]
    }
    for (const r of rules) saveRule(ruleString(r))
    decision.updatedPermissions = [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }]
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}
