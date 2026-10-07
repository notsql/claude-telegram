/**
 * `/skills` (008 FR12): one entry point for every skill, as buttons, instead
 * of one `/` menu command per skill. The list pages through all discovered
 * skills (`sk:p:<page>`); tapping one opens it (`sk:o:<command>`) with Run,
 * Show and, for the chat's own skills, Archive and Remove. Callback data
 * carries the Telegram command name, which fits the 64-byte limit.
 */

import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types'

export type SkillEntry = { name: string; command: string; description: string; uses: number }
export type SkillAction = 'o' | 'r' | 's' | 'a' | 'd'
export type SkillsReply = { text: string; keyboard?: InlineKeyboardMarkup }

export const SKILLS_CALLBACK = /^sk:(p|o|r|s|a|d):([a-z0-9_]{1,32})$/
const PAGE = 12

/** Most used first, then by name. */
export function skillsView(skills: SkillEntry[], page = 0): SkillsReply {
  if (!skills.length) return { text: 'No skills yet. Ask me to learn one, or add one under ~/.claude/skills.' }
  const sorted = [...skills].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
  const pages = Math.ceil(sorted.length / PAGE)
  page = Math.min(Math.max(page, 0), pages - 1)
  const shown = sorted.slice(page * PAGE, (page + 1) * PAGE)
  const rows: InlineKeyboardButton[][] = []
  for (let i = 0; i < shown.length; i += 2) {
    rows.push(shown.slice(i, i + 2).map(s => ({ text: s.name, callback_data: `sk:o:${s.command}` })))
  }
  if (pages > 1) {
    rows.push([
      ...(page > 0 ? [{ text: '« Prev', callback_data: `sk:p:${page - 1}` }] : []),
      ...(page < pages - 1 ? [{ text: 'Next »', callback_data: `sk:p:${page + 1}` }] : []),
    ])
  }
  const text = `🧩 Skills (${sorted.length})${pages > 1 ? `, page ${page + 1}/${pages}` : ''}. Tap one to run or manage it.`
  return { text, keyboard: { inline_keyboard: rows } }
}

/** One skill; `own` adds Archive and Remove for skills in the chat's skill store. */
export function skillView(s: SkillEntry, own: boolean): SkillsReply {
  const row: InlineKeyboardButton[] = [
    { text: '▶️ Run', callback_data: `sk:r:${s.command}` },
    { text: '📄 Show', callback_data: `sk:s:${s.command}` },
  ]
  const manage: InlineKeyboardButton[] = own
    ? [{ text: '📦 Archive', callback_data: `sk:a:${s.command}` }, { text: '🗑 Remove', callback_data: `sk:d:${s.command}` }]
    : []
  return {
    text: `🧩 ${s.name}\n\n${s.description || '(no description)'}\n\nTo pass arguments, send /skills ${s.command} <args>.`,
    keyboard: { inline_keyboard: [row, ...(manage.length ? [manage] : []), [{ text: '« Back', callback_data: 'sk:p:0' }]] },
  }
}

/** `/skills` lists; `/skills <command> [args]` runs that skill. */
export function parseSkillsArgs(args: string): 'list' | { command: string; args: string } {
  const m = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/)
  return m ? { command: m[1]!.toLowerCase(), args: m[2]?.trim() ?? '' } : 'list'
}
