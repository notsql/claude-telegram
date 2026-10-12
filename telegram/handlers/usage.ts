/**
 * /usage (008 FR1, FR17): the subscription's limits from Claude Code's own
 * /usage; ℹ️ Learn more shows what's using them, « Back returns to the bars.
 */

import type { Bot } from 'grammy'
import { formatUsage, planUsage, USAGE_CALLBACK, usageKeyboard } from '../../agent/planUsage.ts'
import type { Command } from '../../commands/registry.ts'
import { withClose } from '../close.ts'
import { answer, failed, isOwner, ownerOnly } from './ui.ts'

const errorText = (err: unknown) => `Couldn't read usage: ${err instanceof Error ? err.message : err}`

export function registerUsage(bot: Bot): Command {
  /** The report behind each `/usage` message, so Learn more doesn't run `claude` again. Lost on restart. */
  const reports = new Map<string, string>()

  bot.callbackQuery(USAGE_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    if (!msg || !isOwner(ctx)) return ownerOnly(ctx)
    const id = `${msg.chat.id}:${msg.message_id}`
    let report = reports.get(id)
    if (!report) {
      void answer(ctx, 'Reading usage…')
      try {
        reports.set(id, report = await planUsage())
      } catch (err) {
        return failed(ctx, errorText(err))
      }
    } else await answer(ctx)
    const detail = ctx.match![1] === 'more'
    await ctx.editMessageText(formatUsage(report, detail).slice(0, 4000), { reply_markup: withClose(usageKeyboard(detail)) }).catch(() => {})
  })

  return { name: 'usage', description: 'Plan usage limits and when they reset', menu: ['private', 'group'], handler: async ctx => {
    if (!isOwner(ctx)) return
    void ctx.replyWithChatAction('typing').catch(() => {})
    try {
      const report = await planUsage()
      const sent = await ctx.reply(formatUsage(report).slice(0, 4000), { reply_markup: withClose(usageKeyboard(false)) })
      reports.set(`${sent.chat.id}:${sent.message_id}`, report)
    } catch (err) {
      await ctx.reply(errorText(err))
    }
  } }
}
