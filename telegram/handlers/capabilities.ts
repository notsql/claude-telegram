/** Install / Details / Skip on a capability request card (012 FR5), Undo on its notice (FR10) and /caps (US5). Owner only. */

import type { Bot } from 'grammy'
import type { Command } from '../../commands/registry.ts'
import type { CapabilityNotices } from '../../capabilities/notices.ts'
import type { CapabilityRequests } from '../../capabilities/request.ts'
import type { Resumer } from '../../capabilities/resume.ts'
import { withClose } from '../close.ts'
import { answer, appendLabel, failed, isOwner, ownerOnly } from './ui.ts'

export function registerCapabilities(bot: Bot, requests: CapabilityRequests, resumer: Resumer, notices: CapabilityNotices) {
  // FR7: the owner finished the login; resume the origin session (FR8).
  bot.callbackQuery(/^cap:done:([0-9a-f]+)$/, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    const r = resumer.done(ctx.match[1]!)
    if (r === undefined) return answer(ctx, 'Already done.')
    void answer(ctx)
    await appendLabel(ctx, r ? '✅ Done; continuing the task' : '✅ Done; the session was reset, so not continuing')
  })

  // FR10: Undo on a notice, or Uninstall in /caps.
  bot.callbackQuery(/^cap:undo:([0-9a-f]+)$/, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    void answer(ctx, 'Uninstalling…')
    const label = await notices.undo(ctx.match[1]!)
    if (!label) return failed(ctx, 'already undone or in progress')
    await appendLabel(ctx, label)
  })

  bot.callbackQuery(/^cap:(install|details|skip):([0-9a-f]+)$/, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    const [, action, id] = ctx.match as unknown as [string, 'install' | 'details' | 'skip', string]
    if (action === 'details') {
      const d = requests.details(id)
      if (!d) return answer(ctx, 'Already decided.')
      const kb = ctx.callbackQuery.message?.reply_markup
      if (kb) kb.inline_keyboard[0] = kb.inline_keyboard[0]!.filter(b => !('callback_data' in b) || !b.callback_data.startsWith('cap:details:'))
      await ctx.editMessageText(d, { reply_markup: kb }).catch(() => {})
      return answer(ctx)
    }
    void answer(ctx, action === 'install' ? 'Installing…' : 'Skipped')
    const r = await requests.decide(id, action, String(ctx.from.id))
    if (!r) return failed(ctx, 'already decided')
    await appendLabel(ctx, r.text)
  })

  // US5: the ledger, as a fallback to the notices.
  const command: Command = { name: 'caps', description: 'Acquired tools and how to remove them', menu: ['private', 'group'], handler: async ctx => {
    if (!isOwner(ctx)) return
    const v = notices.list()
    await ctx.reply(v.text, v.keyboard ? { reply_markup: withClose(v.keyboard) } : {})
  } }
  return { command }
}
