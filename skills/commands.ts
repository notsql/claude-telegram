/**
 * `/skills [show|rm] [name]` for 008 (T806), over the chat's skill store.
 * The bare list carries Show / Archive / Remove buttons (`skc:<action>:<name>`).
 */

import type { InlineKeyboardMarkup } from 'grammy/types'
import type { SkillStore } from './store.ts'

export type SkillAction = 'show' | 'arch' | 'rm'
export type SkillsReply = { text: string; keyboard?: InlineKeyboardMarkup; changes?: boolean }

const MAX_LISTED = 30

export function listSkills(store: SkillStore): SkillsReply {
  const all = store.list().sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_LISTED)
  if (!all.length) return { text: 'No skills yet.' }
  return {
    text: all.map(s => `• ${s.name}${s.metadata.source === 'tg' ? ' (learned)' : ''}: ${s.description}`).join('\n'),
    keyboard: { inline_keyboard: all.map(s => [
      { text: s.name, callback_data: `skc:show:${s.name}` },
      { text: '📦', callback_data: `skc:arch:${s.name}` },
      { text: '🗑', callback_data: `skc:rm:${s.name}` },
    ]) },
  }
}

/** Runs one action; `changes` marks the ones that need an approver. */
export function skillAction(store: SkillStore, action: SkillAction, name: string): SkillsReply {
  if (!store.read(name)) return { text: `No skill named ${name}.` }
  switch (action) {
    case 'show': return { text: store.text(name)!.slice(0, 4000) }
    case 'arch': store.archive(name); return { text: `📦 Archived ${name}`, changes: true }
    case 'rm': store.remove(name); return { text: `🗑 Removed ${name}`, changes: true }
  }
}

/** `/skills`, `/skills show <name>`, `/skills rm <name>`; undefined for an unknown subcommand. */
export function parseSkillsArgs(args: string): { action: SkillAction; name: string } | 'list' | undefined {
  const [sub, name] = args.trim().split(/\s+/)
  if (!sub) return 'list'
  if ((sub === 'show' || sub === 'rm') && name) return { action: sub, name }
}
