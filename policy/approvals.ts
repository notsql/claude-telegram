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

/** 5 lowercase letters without 'l', the alphabet of the `yes xxxxx` text reply (FR5). */
const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'

export type Decision = 'allow' | 'deny' | 'always'

type Pending = {
  key: string
  toolName: string
  input: Record<string, unknown>
  chatId: string
  messageId?: number
  resolve: (d: Decision | 'expired') => void
}

export type ApprovalsOpts = {
  api: Api
  timeoutSec: number
  /** Persists an Always rule to the key's `alwaysAllow` so later turns get it natively. */
  saveRule: (key: string, rule: string) => void
}

export function createApprovals({ api, timeoutSec, saveRule }: ApprovalsOpts) {
  const pending = new Map<string, Pending>()

  const newId = () => {
    let id: string
    do id = Array.from({ length: 5 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('')
    while (pending.has(id))
    return id
  }

  const keyboard = (id: string) => new InlineKeyboard()
    .text('See more', `perm:more:${id}`)
    .text('✅ Allow', `perm:allow:${id}`)
    .text('❌ Deny', `perm:deny:${id}`)

  async function handle(payload: Record<string, unknown>, key: string) {
    const toolName = String(payload.tool_name ?? '')
    const input = (payload.tool_input ?? {}) as Record<string, unknown>
    const target = parseKey(key)
    const id = newId()
    const decision = await new Promise<Decision | 'expired'>(resolve => {
      const p: Pending = { key, toolName, input, chatId: target.chatId, resolve }
      pending.set(id, p)
      const timer = setTimeout(() => {
        resolve('expired')
        if (p.messageId != null) void api.editMessageText(p.chatId, p.messageId, `${title(p)}\n\n⌛ Expired`).catch(() => {})
      }, timeoutSec * 1000)
      p.resolve = d => { clearTimeout(timer); pending.delete(id); resolve(d) }
      void api.sendMessage(target.chatId, title(p), { ...threadOpts(target), reply_markup: keyboard(id) })
        .then(m => { p.messageId = m.message_id })
        .catch(err => process.stderr.write(`telegram daemon: permission prompt send failed: ${err}\n`))
    })
    pending.delete(id)
    return hookOutput(decision, toolName, input, rule => saveRule(key, rule))
  }

  return {
    handle,
    /** Answers a pending request; false if it is unknown or already decided. */
    decide(id: string, d: Decision): boolean {
      const p = pending.get(id)
      if (!p) return false
      p.resolve(d)
      return true
    },
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

export function hookOutput(d: Decision | 'expired', toolName: string, input: Record<string, unknown>, saveRule: (rule: string) => void) {
  if (d === 'deny' || d === 'expired') {
    const message = d === 'deny' ? 'Denied by the user on Telegram.' : 'No answer on Telegram before the approval timed out.'
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } }
  }
  const decision: Record<string, unknown> = { behavior: 'allow' }
  if (d === 'always') {
    const rule = deriveRule(toolName, input)
    saveRule(rule)
    const m = /^([^(]+)\((.*)\)$/.exec(rule)
    decision.updatedPermissions = [{
      type: 'addRules',
      rules: [m ? { toolName: m[1], ruleContent: m[2] } : { toolName: rule }],
      behavior: 'allow',
      destination: 'session',
    }]
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}
