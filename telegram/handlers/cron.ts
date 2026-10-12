/**
 * /cron (008 T807, 007 US5): this chat's jobs with pause/resume, delete and
 * run-now buttons; + New job steps through how often, day and hour, then
 * asks what to do (008 FR18). Also Retry or Disable on a failure notice (007 FR8).
 */

import type { Bot, Context } from 'grammy'
import type { InlineKeyboardMarkup } from 'grammy/types'
import { CRON_CALLBACK, CRON_NEW_CALLBACK, cronView, newJobView, whenFor, type CronAction } from '../../commands/cron.ts'
import type { Command } from '../../commands/registry.ts'
import { policyOf } from '../../policy/resolve.ts'
import { chatJobs, deleteJob, setJobEnabled } from '../../scheduler/manage.ts'
import type { createScheduleTools } from '../../scheduler/tools.ts'
import { sessionKey } from '../../sessions/key.ts'
import { withClose } from '../close.ts'
import { answer, canChange, createReplyPrompts, failed, isOwner, keyOf, ownerOnly } from './ui.ts'

export type CronDeps = {
  stateDir: string
  tools: ReturnType<typeof createScheduleTools>
  /** Re-reads jobs.json after a change. */
  reload: () => void
  runNow: (id: string) => void
}

export function registerCron(bot: Bot, { stateDir, tools, reload, runNow }: CronDeps) {
  const adds = createReplyPrompts<{ key: string; when: string }>(bot.api)
  const view = (key: string) => cronView(chatJobs(stateDir, key))

  bot.callbackQuery(CRON_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    if (!msg) return answer(ctx)
    const key = keyOf(msg)
    if (!canChange(ctx, key)) return answer(ctx, 'Not authorised.')
    const [, action, id] = ctx.match as unknown as [string, CronAction, string]
    if (!chatJobs(stateDir, key).some(j => j.id === id)) return answer(ctx, 'Job is gone.')
    void answer(ctx, { run: '▶️ Running now', del: '🗑 Deleted', pause: '⏸ Paused', resume: '▶ Resumed' }[action])
    try {
      if (action === 'run') runNow(id)
      else {
        if (action === 'del') deleteJob(stateDir, id)
        else setJobEnabled(stateDir, id, action === 'resume')
        reload()
      }
    } catch (err) {
      return failed(ctx, err instanceof Error ? err.message : String(err))
    }
    const { text, keyboard } = view(key)
    await ctx.editMessageText(text, { reply_markup: withClose(keyboard) }).catch(() => {})
  })

  bot.callbackQuery(CRON_NEW_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    if (!msg) return answer(ctx)
    const key = keyOf(msg)
    if (!canChange(ctx, key)) return answer(ctx, 'Not authorised.')
    await answer(ctx)
    const [, action, spec] = ctx.match as unknown as [string, 'list' | 'w', string]
    const show = (r: { text: string; keyboard?: InlineKeyboardMarkup }) =>
      ctx.editMessageText(r.text, { reply_markup: withClose(r.keyboard) }).catch(() => {})
    if (action === 'list') return void await show(view(key))
    const step = newJobView(spec)
    if (step !== 'ready') return void await show(step)
    const { when, label } = whenFor(spec)
    await ctx.editMessageText(`+ New job, ${label}.`).catch(() => {})
    await adds.ask(key, `⏰ ${label[0]!.toUpperCase()}${label.slice(1)}. What should I do then? Reply to this message.`, 'e.g. Send me a summary of the news', { key, when })
  })

  // Retry re-enables an auto-disabled job with a clean failure count.
  bot.callbackQuery(/^sch:(retry|off):(j_[0-9a-f]+)$/, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    const [, action, id] = ctx.match as unknown as [string, 'retry' | 'off', string]
    if (!setJobEnabled(stateDir, id, action === 'retry')) return answer(ctx, 'Job is gone.')
    reload()
    if (action === 'retry') runNow(id)
    await answer(ctx, action === 'retry' ? '🔁 Retrying' : '⏸ Disabled')
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
  })

  const command: Command = { name: 'cron', description: "Manage this chat's scheduled jobs", menu: ['private', 'group'], requiresApprover: true, handler: async ctx => {
    const { text, keyboard } = view(sessionKey(ctx.msg!))
    await ctx.reply(text, { reply_markup: withClose(keyboard) })
  } }

  /** A reply to a New job prompt; true when `ctx` was one and has been handled. */
  async function addReply(ctx: Context): Promise<boolean> {
    const pending = adds.peek(ctx)
    if (!pending || !canChange(ctx, pending.key)) return false
    adds.done(ctx)
    const r = tools.call('schedule_create', { when: pending.when, prompt: ctx.message!.text ?? '' }, pending.key, policyOf(pending.key))!
    const text = r.content.map(c => c.text).join('\n')
    if (r.isError) await ctx.reply(`⚠️ Not scheduled: ${text}`)
    else await ctx.reply(`✅ ${text}`, { reply_markup: withClose(view(pending.key).keyboard) })
    return true
  }

  return { command, addReply }
}
