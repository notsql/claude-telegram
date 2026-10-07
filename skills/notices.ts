/**
 * Skill write notices (006 FR10): "📘 Learned skill deploy-blog" in the
 * session target, with Show (`skl:show:<id>`, sends the SKILL.md) and Undo
 * (`skl:undo:<id>`, restores the previous version, or removes a new skill).
 * Handles live in memory, so they lapse on daemon restart.
 */

import { randomBytes } from 'crypto'
import type { Api } from 'grammy'
import { parseKey } from '../sessions/key.ts'
import { threadOpts } from '../telegram/send.ts'
import type { SkillChange } from './apply.ts'

const MAX_PENDING = 200
/** Telegram's message limit, with room for the header. */
const MAX_SHOW_CHARS = 3900

export function skillNoticeText(c: Pick<SkillChange, 'verb' | 'name' | 'version'>): string {
  return c.verb === 'Learned' ? `📘 Learned skill ${c.name}` : `📘 Updated skill ${c.name} (v${c.version})`
}

export function createSkillNotices(api: Pick<Api, 'sendMessage'>) {
  const changes = new Map<string, { key: string; change: SkillChange; undone?: boolean }>()

  function keyboard(key: string, change: SkillChange) {
    const id = randomBytes(6).toString('hex')
    changes.set(id, { key, change })
    if (changes.size > MAX_PENDING) changes.delete(changes.keys().next().value!)
    return { inline_keyboard: [[
      { text: '📄 Show', callback_data: `skl:show:${id}` },
      { text: '↩️ Undo', callback_data: `skl:undo:${id}` },
    ]] }
  }

  return {
    keyboard,

    keyOf: (id: string) => changes.get(id)?.key,

    notify(key: string, change: SkillChange): Promise<unknown> {
      const target = parseKey(key)
      return api.sendMessage(target.chatId, skillNoticeText(change), { ...threadOpts(target), reply_markup: keyboard(key, change) }).catch(() => {})
    },

    /** The SKILL.md as it is now, trimmed to one message. */
    show(id: string): string | undefined {
      const c = changes.get(id)
      if (!c) return undefined
      const text = c.change.store.text(c.change.name)
      if (text === undefined) return `Skill ${c.change.name} no longer exists.`
      return text.length > MAX_SHOW_CHARS ? `${text.slice(0, MAX_SHOW_CHARS)}\n…` : text
    },

    /** Runs the undo once; the label to show, or undefined when it is gone. */
    undo(id: string): string | undefined {
      const c = changes.get(id)
      if (!c || c.undone) return undefined
      c.undone = true
      c.change.undo()
      return c.change.verb === 'Learned' ? `↩️ Removed skill ${c.change.name}` : `↩️ Restored ${c.change.name} to v${c.change.version - 1}`
    },
  }
}

export type SkillNotices = ReturnType<typeof createSkillNotices>
