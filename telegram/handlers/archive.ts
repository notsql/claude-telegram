/**
 * Archive or Keep prompts for unused learned skills (006 FR8) and agents
 * (009 T911), sent to an owner by the weekly pruning job.
 */

import type { Bot } from 'grammy'
import { randomBytes } from 'crypto'
import { answer, ownerOnly, isOwner, sendTo } from './ui.ts'

/** Archive prompts per weekly run, per kind. */
export const MAX_ARCHIVE_PROMPTS = 5

/** Registers the `<prefix>:arch|keep` buttons; returns the function that asks. */
export function registerArchivePrompts<T extends { name: string }>(bot: Bot, prefix: 'skl' | 'agt', noun: string, archive: (item: T) => void) {
  const asks = new Map<string, T>()

  bot.callbackQuery(new RegExp(`^${prefix}:(arch|keep):([0-9a-f]+)$`), async ctx => {
    const id = ctx.match![2]!
    const item = asks.get(id)
    if (!item) return answer(ctx, 'Already decided.')
    if (!isOwner(ctx)) return ownerOnly(ctx)
    asks.delete(id)
    let label = `Kept ${item.name}`
    if (ctx.match![1] === 'arch') {
      try { archive(item); label = `📦 Archived ${item.name}` } catch (err) { label = (err as Error).message }
    }
    await answer(ctx, label)
    await ctx.editMessageText(label).catch(() => {})
  })

  /** Posts the prompt to session key `to` (the 📍 Updates chat). */
  return (to: string, item: T, days: number) => {
    const id = randomBytes(6).toString('hex')
    asks.set(id, item)
    void sendTo(bot.api, to, `📦 ${noun} ${item.name} hasn't been used in ${days} days. Archive it?`, {
      reply_markup: { inline_keyboard: [[
        { text: '📦 Archive', callback_data: `${prefix}:arch:${id}` },
        { text: 'Keep', callback_data: `${prefix}:keep:${id}` },
      ]] },
    })
  }
}
