/**
 * `/policy` inline editor (003 US4, T309). Owner only. Offers a fixed set of
 * values per field; `bypassPermissions`, `cwd` and trust settings are never
 * offered here (FR9, FR13) and edits outside the set are rejected.
 */

import { InlineKeyboard } from 'grammy'
import type { Access } from '../access.ts'
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

export function renderPolicy(key: string, p: Policy): string {
  const lines = [`Policy for ${key}`, '']
  for (const f of Object.keys(EDITABLE) as EditableField[]) lines.push(`${f}: ${p[f] ?? 'default'}`)
  if (p.allowedTools?.length) lines.push(`allowedTools: ${p.allowedTools.join(', ')}`)
  if (p.alwaysAllow?.length) lines.push(`alwaysAllow: ${p.alwaysAllow.join(', ')}`)
  if (p.cwd) lines.push(`cwd: ${p.cwd}`)
  return lines.join('\n')
}

/** One row per field; tapping a value sets it (`pol:<field>:<value>`). */
export function policyKeyboard(p: Policy): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const [f, values] of Object.entries(EDITABLE)) {
    for (const v of values) kb.text(String(p[f as EditableField] ?? 'default') === v ? `• ${v}` : v, `pol:${f}:${v}`)
    kb.row()
  }
  return kb
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
