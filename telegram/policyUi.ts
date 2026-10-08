/**
 * `/settings` inline editor for the chat's policy (003 US4, T309; 008 FR15). Owner only. The main page
 * lists each setting as a button (`pol:f:<field>`) that opens its values
 * (`pol:s:<field>:<value>`); 🔐 Permissions (`pol:p`) lists the permission mode
 * and every tool rule (`pol:r:<i>`), and an Always rule can be removed
 * (`pol:x:<i>`). Offers a fixed set of values per field; `bypassPermissions`,
 * `cwd` and trust settings are never offered here (FR9, FR13) and edits outside
 * the set are rejected.
 */

import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types'
import type { Access } from '../access.ts'
import { toolLabel, words } from '../policy/approvals.ts'
import type { Policy } from '../policy/schema.ts'

/** Field → values settable from Telegram. `default` on model clears the override. */
export const EDITABLE = {
  permissionMode: ['default', 'acceptEdits', 'plan'],
  model: ['default', 'sonnet', 'opus', 'haiku'],
  memoryScope: ['global', 'none'],
  historyScope: ['all', 'chat', 'none'],
  autoLearn: ['off', 'propose', 'auto'],
  schedulerAllowed: ['true', 'false'],
} as const satisfies Partial<Record<keyof Policy, readonly string[]>>

export type EditableField = keyof typeof EDITABLE

export const POLICY_CALLBACK = /^pol:(m|p|f|s|r|x)(?::(\w+))?(?::(\w+))?$/

const ABOUT: Record<EditableField, string> = {
  permissionMode: 'How tool use is approved. Default asks you, Accept edits allows file edits without asking, Plan only plans.',
  model: 'The model for turns in this chat.',
  memoryScope: 'Whether the agent reads and writes shared memory here.',
  historyScope: 'Which past conversations search can see.',
  autoLearn: 'Whether the agent learns skills: off, propose them for your approval, or save them automatically.',
  schedulerAllowed: 'Whether scheduled jobs can be created here.',
}

const RULES = [
  ['allowedTools', '✅', 'Allowed without asking'],
  ['disallowedTools', '⛔', 'Blocked'],
  ['alwaysAllow', '♾', 'Always allowed (from ♾ Always)'],
] as const

export type PolicyView = { text: string; keyboard: InlineKeyboardMarkup }

/** `permissionMode` → `Permission mode`, `acceptEdits` → `Accept edits`, `true` → `Yes`. */
export function label(name: string): string {
  if (name === 'true' || name === 'false') return name === 'true' ? 'Yes' : 'No'
  return words(name).replace(/ ([A-Z][a-z])/g, (_, w: string) => ` ${w.toLowerCase()}`)
}

/** `Bash(npm test *)` → `Bash: npm test *`; MCP tools as in approval prompts. */
export function ruleLabel(rule: string): string {
  const m = /^([^(]+)\((.*)\)$/.exec(rule)
  return m ? `${toolLabel(m[1]!)}: ${m[2]}` : toolLabel(rule)
}

const value = (p: Policy, f: EditableField) => label(String(p[f] ?? 'default'))
const button = (text: string, data: string): InlineKeyboardButton => ({ text: text.slice(0, 64), callback_data: data })

/** Every tool rule, numbered for `pol:r:<i>`. */
function rules(p: Policy) {
  return RULES.flatMap(([field, icon, heading]) => (p[field] ?? []).map(rule => ({ field, icon, heading, rule })))
}

/** The main page: one button per setting, then Permissions. */
export function policyView(key: string, p: Policy): PolicyView {
  const lines = [`⚙️ Settings for ${key}`, '', 'Tap a setting to change it.']
  if (p.agent) lines.push(`Agent: ${p.agent}`)
  if (p.cwd) lines.push(`Working directory: ${p.cwd}`)
  const rows = (Object.keys(EDITABLE) as EditableField[])
    .filter(f => f !== 'permissionMode')
    .map(f => [button(`${label(f)}: ${value(p, f)}`, `pol:f:${f}`)])
  rows.push([button(`🔐 Permissions (${value(p, 'permissionMode')}, ${rules(p).length} rules)`, 'pol:p')])
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } }
}

/** One setting: what it does, and its values with the current one marked. */
export function fieldView(f: EditableField, p: Policy): PolicyView {
  const current = String(p[f] ?? 'default')
  return {
    text: `${label(f)}: ${value(p, f)}\n\n${ABOUT[f]}`,
    keyboard: { inline_keyboard: [
      EDITABLE[f].map(v => button(`${v === current ? '• ' : ''}${label(v)}`, `pol:s:${f}:${v}`)),
      [button('« Back', f === 'permissionMode' ? 'pol:p' : 'pol:m')],
    ] },
  }
}

/** Permissions: the mode, then every rule by kind; tap a rule for details. */
export function permissionsView(p: Policy): PolicyView {
  const all = rules(p)
  const lines = ['🔐 Permissions', '', `Permission mode: ${value(p, 'permissionMode')}`]
  for (const [field, icon, heading] of RULES) {
    const list = p[field] ?? []
    if (list.length) lines.push('', `${icon} ${heading}:`, ...list.map(r => `• ${ruleLabel(r)}`))
  }
  if (!all.length) lines.push('', 'No tool rules: every tool asks first.')
  lines.push('', 'Allowed and blocked tools are set from the terminal; Always rules can be removed here.')
  return {
    text: lines.join('\n').slice(0, 4000),
    keyboard: { inline_keyboard: [
      [button(`Permission mode: ${value(p, 'permissionMode')}`, 'pol:f:permissionMode')],
      ...all.slice(0, 90).map((r, i) => [button(`${r.icon} ${ruleLabel(r.rule)}`, `pol:r:${i}`)]),
      [button('« Back', 'pol:m')],
    ] },
  }
}

/** One rule; Always rules get Remove. */
export function ruleView(p: Policy, i: number): PolicyView {
  const r = rules(p)[i]
  const back = [button('« Back', 'pol:p')]
  if (!r) return { text: 'That rule is gone.', keyboard: { inline_keyboard: [back] } }
  return {
    text: `${r.icon} ${r.heading}\n${ruleLabel(r.rule)}\n\nRule: ${r.rule}`,
    keyboard: { inline_keyboard: r.field === 'alwaysAllow' ? [[button('🗑 Remove', `pol:x:${i}`)], back] : [back] },
  }
}

/** The Always rule at `i` in `p`'s rule list, if it is one. */
export function alwaysRuleAt(p: Policy, i: number): string | undefined {
  const r = rules(p)[i]
  return r?.field === 'alwaysAllow' ? r.rule : undefined
}

/**
 * Applies one edit to the key's own policy entry. Returns the stored value,
 * or throws when the field or value isn't offered in Telegram.
 */
export function applyPolicyEdit(access: Access, key: string, field: string, value: string): unknown {
  const allowed = (EDITABLE as Record<string, readonly string[]>)[field]
  if (!allowed?.includes(value)) throw new Error(`${field}=${value} can't be set from Telegram`)
  const policy = ((access.chats ??= {})[key] ??= {}).policy ??= {}
  const record = policy as Record<string, unknown>
  if (field === 'model' && value === 'default') delete record.model
  else record[field] = field === 'schedulerAllowed' ? value === 'true' : value
  return record[field]
}
