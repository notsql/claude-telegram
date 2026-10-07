/**
 * Write notices (004 FR9): "🧠 Saved *pnpm preference* · Undo" in the session
 * target, with an Undo button (`mem:undo:<id>`) that restores the previous
 * version or removes a new file and its index line. Undo handles live in
 * memory, so they lapse on daemon restart; the newest MAX_PENDING are kept.
 */

import { randomBytes } from 'crypto'
import type { Api } from 'grammy'
import { parseKey } from '../sessions/key.ts'
import { threadOpts } from '../telegram/send.ts'
import type { MemoryChange } from './tools.ts'

const MAX_PENDING = 200

export function noticeText(c: Pick<MemoryChange, 'verb' | 'description'>): string {
  return `🧠 ${c.verb}: ${c.description}`
}

export function createNotices(api: Pick<Api, 'sendMessage'>) {
  const undos = new Map<string, MemoryChange>()

  return {
    notify(key: string, change: MemoryChange): Promise<unknown> {
      const id = randomBytes(6).toString('hex')
      undos.set(id, change)
      if (undos.size > MAX_PENDING) undos.delete(undos.keys().next().value!)
      const target = parseKey(key)
      return api.sendMessage(target.chatId, noticeText(change), {
        ...threadOpts(target),
        reply_markup: { inline_keyboard: [[{ text: '↩️ Undo', callback_data: `mem:undo:${id}` }]] },
      }).catch(() => {})
    },

    /** Runs the undo for `id` once; the label to show, or undefined when it is gone. */
    undo(id: string): string | undefined {
      const c = undos.get(id)
      if (!c) return undefined
      undos.delete(id)
      c.undo()
      return `↩️ Undone: ${c.verb.toLowerCase()} ${c.name}`
    },
  }
}
