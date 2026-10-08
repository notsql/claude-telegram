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
import { isReadOnly } from './readOnly.ts'
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
  /** Keeps an Allow rule for the rest of the key's session (until /new or /resume). */
  sessionRule?: (key: string, rule: string) => void
  audit?: (entry: AuditEntry) => void
}

export function createApprovals({ api, timeoutSec, saveRule, sessionRule, audit }: ApprovalsOpts) {
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
    return always ? kb.row().text('♾ Always', `perm:always:${id}`) : kb
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
        if (p.messageId != null) void api.editMessageText(p.chatId, p.messageId, `${heading(p)}\n\n⌛ Expired`).catch(() => {})
      }, timeoutSec * 1000)
      p.resolve = d => { clearTimeout(timer); pending.delete(id); by = p.by; resolve(d) }
      // FR5: the id is what a typed `yes xxxxx` answer refers to.
      void api.sendMessage(target.chatId, `${heading(p)}\n\nOr reply "yes ${id}" / "no ${id}".`, { ...threadOpts(target), reply_markup: keyboard(id, always) })
        .then(m => { p.messageId = m.message_id })
        .catch(err => process.stderr.write(`telegram daemon: permission prompt send failed: ${err}\n`))
    })
    pending.delete(id)
    return { decision, by }
  }

  async function handle(payload: Record<string, unknown>, key: string) {
    const toolName = String(payload.tool_name ?? '')
    const input = (payload.tool_input ?? {}) as Record<string, unknown>
    // FR14: reads never prompt; only writes and updates reach the chat.
    if (isReadOnly(toolName, input)) {
      audit?.({ event: 'approval', key, tool: toolName, decision: 'auto' })
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
    }
    const { decision, by } = await ask(key, toolName, input)
    const rules: string[] = []
    const out = hookOutput(decision, toolName, input, payload.permission_suggestions, (r, persist) => {
      rules.push(r)
      if (persist) saveRule(key, r)
      else sessionRule?.(key, r)
    })
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
    /** The expanded "See more" text as HTML, the command or input in a code block; undefined once decided. */
    details(id: string): string | undefined {
      const p = pending.get(id)
      if (!p) return undefined
      const bash = p.toolName === 'Bash' && typeof p.input.command === 'string'
      const body = (bash ? String(p.input.command) : JSON.stringify(p.input, null, 2)).slice(0, 3500)
      return `${escapeHtml(heading(p))}\n\n<pre><code class="language-${bash ? 'bash' : 'json'}">${escapeHtml(body)}</code></pre>`
    },
    keyboard,
  }
}

/** FR4: the tool plus what the call is for: Bash's own description, else its main argument. */
function heading(p: Pick<Pending, 'toolName' | 'input'>): string {
  const i = p.input
  const what = [i.description, i.file_path, i.notebook_path, i.url, i.query, i.pattern, i.prompt]
    .find((v): v is string => typeof v === 'string' && v.trim() !== '')
  return `🔐 Permission: ${toolLabel(p.toolName)}${what ? `\n${what.trim().slice(0, 300)}` : ''}`
}

/**
 * A readable tool name: `WebFetch` → `Web Fetch`,
 * `mcp__claude_ai_Notion__notion-query-data-sources` → `Notion · Notion Query Data Sources`,
 * `mcp__claude_ai_Atlassian_Rovo__getJiraIssue` → `Atlassian Rovo · Get Jira Issue`.
 */
export function toolLabel(toolName: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (!mcp) return words(toolName)
  const server = mcp[1]!.replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ')
  return `${server} · ${words(mcp[2]!)}`
}

/** Splits snake, kebab, camel and Pascal case into Title Case words; acronyms (`URL`) stay whole. */
export function words(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(w => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

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
  /** `persist` is true for Always (the chat's policy), false for Allow (this session only). */
  keep: (rule: string, persist: boolean) => void,
) {
  if (d === 'deny' || d === 'expired') {
    const message = d === 'deny' ? 'Denied by the user on Telegram.' : 'No answer on Telegram before the approval timed out.'
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } }
  }
  const decision: Record<string, unknown> = { behavior: 'allow' }
  let rules = suggestedRules(suggestions)
  if (!rules.length) {
    const rule = deriveRule(toolName, input)
    const m = /^([^(]+)\((.*)\)$/.exec(rule)
    rules = [m ? { toolName: m[1]!, ruleContent: m[2] } : { toolName: rule }]
  }
  for (const r of rules) keep(ruleString(r), d === 'always')
  decision.updatedPermissions = [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }]
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}
