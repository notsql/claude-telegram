/**
 * `/settings` inline editor for the chat's policy (003 US4, T309; 008 FR15).
 * Owner only. The main page lists each setting as a button (`pol:f:<field>`)
 * that explains its values (`pol:s:<field>:<value>`), plus Reset (`pol:z`,
 * confirmed by `pol:y`). 🔐 Permissions (`pol:p`) has the permission mode and
 * one button per kind of rule (`pol:c:<kind>:<page>`); a rule (`pol:r:<kind>:<i>`)
 * shows its details, and an Always rule can be removed (`pol:x:<i>`). Offers a fixed set of values per field; `bypassPermissions`,
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

export const POLICY_CALLBACK = /^pol:(m|p|f|s|c|r|x|z|y)(?::(\w+))?(?::(\w+))?$/
const PAGE = 8

/** What each setting does, and what each value means, shown before you pick. */
const ABOUT: { [F in EditableField]: { what: string; values: Record<(typeof EDITABLE)[F][number], string> } } = {
  permissionMode: {
    what: 'How tool use is approved.',
    values: {
      default: 'Asks you before using a tool that no rule allows.',
      acceptEdits: 'Edits files without asking; other tools still ask.',
      plan: 'Only reads and plans; makes no changes.',
    },
  },
  model: {
    what: 'The model for turns in this chat.',
    values: {
      default: "Claude Code's default model.",
      sonnet: 'Balanced speed and capability.',
      opus: 'Most capable; uses your limits fastest.',
      haiku: 'Fastest and lightest.',
    },
  },
  memoryScope: {
    what: 'Whether the agent uses shared memory here.',
    values: {
      global: 'Reads and saves the memory shared by all chats.',
      none: 'No memory in this chat.',
    },
  },
  historyScope: {
    what: 'Which past conversations search can see.',
    values: {
      all: 'Every chat and topic.',
      chat: 'Only this chat.',
      none: 'Search is off.',
    },
  },
  autoLearn: {
    what: 'Whether the agent learns new skills from what it does.',
    values: {
      off: 'Never learns skills.',
      propose: 'Suggests a skill and waits for your ✅ Save.',
      auto: 'Saves skills itself and tells you.',
    },
  },
  schedulerAllowed: {
    what: 'Whether scheduled jobs can be created here.',
    values: {
      true: 'The agent can schedule jobs and reminders here.',
      false: 'No scheduled jobs here.',
    },
  },
}

const RULES = [
  { field: 'allowedTools', icon: '✅', heading: 'Allowed without asking', about: 'These run without a permission prompt. Set from the terminal.' },
  { field: 'disallowedTools', icon: '⛔', heading: 'Blocked', about: 'These are never available here. Set from the terminal.' },
  { field: 'alwaysAllow', icon: '♾', heading: 'Always allowed', about: 'Saved when someone tapped ♾ Always on a permission prompt. Tap one to remove it.' },
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

const current = (p: Policy, f: EditableField) => String(p[f] ?? 'default')
const value = (p: Policy, f: EditableField) => label(current(p, f))
const button = (text: string, data: string): InlineKeyboardButton => ({ text: text.slice(0, 64), callback_data: data })
const SETTINGS = (Object.keys(EDITABLE) as EditableField[]).filter(f => f !== 'permissionMode')

/** The main page: each setting with what it does, as buttons, then Permissions and Reset. */
export function policyView(key: string, p: Policy): PolicyView {
  const lines = [`⚙️ Settings for ${key}`, '']
  for (const f of SETTINGS) lines.push(`${label(f)}: ${value(p, f)}`, `${ABOUT[f].what}`, '')
  lines.push(`🔐 Permissions: ${value(p, 'permissionMode')} mode. Which tools run without asking.`)
  lines.push('🧩 Skills, plugins & MCP: which ones are on in this chat.')
  lines.push(`🤖 Agent: ${p.agent ?? 'Default assistant'}. Who answers here.`)
  if (p.cwd) lines.push(`Working directory: ${p.cwd}`)
  lines.push('', 'Tap a setting to change it.')
  return {
    text: lines.join('\n'),
    keyboard: { inline_keyboard: [
      ...SETTINGS.map(f => [button(`${label(f)}: ${value(p, f)}`, `pol:f:${f}`)]),
      [button('🔐 Permissions', 'pol:p')],
      [button('🧩 Skills, plugins & MCP', 'ext:m')],
      [button(`🤖 Agent: ${p.agent ?? 'Default'}`, 'agn:m')],
      [button('↺ Reset to defaults', 'pol:z')],
    ] },
  }
}

/** One setting: what it does and what each value means, with the current one marked. */
export function fieldView(f: EditableField, p: Policy): PolicyView {
  const values = ABOUT[f].values as Record<string, string>
  return {
    text: [`${label(f)}: ${value(p, f)}`, ABOUT[f].what, '', ...EDITABLE[f].map(v => `${v === current(p, f) ? '• ' : ''}${label(v)}: ${values[v]}`)].join('\n'),
    keyboard: { inline_keyboard: [
      EDITABLE[f].map(v => button(`${v === current(p, f) ? '• ' : ''}${label(v)}`, `pol:s:${f}:${v}`)),
      [button('« Back', f === 'permissionMode' ? 'pol:p' : 'pol:m')],
    ] },
  }
}

/** Permissions: the mode, then one button per kind of rule with its count. */
export function permissionsView(p: Policy): PolicyView {
  const mode = current(p, 'permissionMode') as (typeof EDITABLE)['permissionMode'][number]
  return {
    text: [
      '🔐 Permissions', '',
      `Permission mode: ${value(p, 'permissionMode')}`, ABOUT.permissionMode.values[mode] ?? '', '',
      ...RULES.flatMap(r => [`${r.icon} ${r.heading} (${(p[r.field] ?? []).length})`]),
      '', 'Tap a group to see its rules.',
    ].join('\n'),
    keyboard: { inline_keyboard: [
      [button(`Permission mode: ${value(p, 'permissionMode')}`, 'pol:f:permissionMode')],
      ...RULES.map((r, c) => [button(`${r.icon} ${r.heading} (${(p[r.field] ?? []).length})`, `pol:c:${c}:0`)]),
      [button('« Back', 'pol:m')],
    ] },
  }
}

/** One kind of rule, paged; tap a rule for details. */
export function rulesView(p: Policy, c: number, page = 0): PolicyView {
  const r = RULES[c]
  if (!r) return permissionsView(p)
  const list = p[r.field] ?? []
  const pages = Math.max(1, Math.ceil(list.length / PAGE))
  page = Math.min(Math.max(page, 0), pages - 1)
  const rows = list.slice(page * PAGE, (page + 1) * PAGE).map((rule, j) => [button(ruleLabel(rule), `pol:r:${c}:${page * PAGE + j}`)])
  if (pages > 1) {
    rows.push([
      ...(page > 0 ? [button('« Prev', `pol:c:${c}:${page - 1}`)] : []),
      ...(page < pages - 1 ? [button('Next »', `pol:c:${c}:${page + 1}`)] : []),
    ])
  }
  rows.push([button('« Back', 'pol:p')])
  return {
    text: [`${r.icon} ${r.heading} (${list.length})${pages > 1 ? `, page ${page + 1}/${pages}` : ''}`, r.about, ...(list.length ? [] : ['', 'None.'])].join('\n'),
    keyboard: { inline_keyboard: rows },
  }
}

/** One rule; Always rules get Remove. */
export function ruleView(p: Policy, c: number, i: number): PolicyView {
  const r = RULES[c]
  const rule = r && p[r.field]?.[i]
  const back = [button('« Back', `pol:c:${c}:${Math.floor(i / PAGE)}`)]
  if (!r || !rule) return { text: 'That rule is gone.', keyboard: { inline_keyboard: [back] } }
  return {
    text: `${r.icon} ${r.heading}\n${ruleLabel(rule)}\n\nRule: ${rule}\n${r.about}`,
    keyboard: { inline_keyboard: r.field === 'alwaysAllow' ? [[button('🗑 Remove', `pol:x:${i}`)], back] : [back] },
  }
}

/** Reset asks first, naming what changes and what stays. */
export function resetView(): PolicyView {
  return {
    text: `↺ Reset ${(Object.keys(EDITABLE) as EditableField[]).map(label).join(', ')} to this chat's defaults?\n\nThis also removes every permission rule here (${RULES.map(r => r.heading.toLowerCase()).join(', ')}), puts every skill, plugin and MCP server back as installed, and goes back to the default assistant.`,
    keyboard: { inline_keyboard: [[button('↺ Reset', 'pol:y'), button('« Back', 'pol:m')]] },
  }
}

/** The Always rule at `i`, if there is one. */
export function alwaysRuleAt(p: Policy, i: number): string | undefined {
  return p.alwaysAllow?.[i]
}

/** Clears every Telegram-editable field, permission rule, skill or plugin switch and agent from the key's own policy, so defaults apply. Mutates `access`. */
export function resetPolicy(access: Access, key: string): void {
  const policy = access.chats?.[key]?.policy as Record<string, unknown> | undefined
  if (policy) for (const f of [...Object.keys(EDITABLE), ...RULES.map(r => r.field), 'disabledSkills', 'plugins', 'disabledMcpServers', 'agent']) delete policy[f]
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
