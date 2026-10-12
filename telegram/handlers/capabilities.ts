/** Install / Details / Skip on a capability request card (012 FR5). Owner only. */

import type { Bot } from 'grammy'
import type { CapabilityRequests } from '../../capabilities/request.ts'
import { answer, appendLabel, failed, isOwner, ownerOnly } from './ui.ts'

export function registerCapabilities(bot: Bot, requests: CapabilityRequests) {
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
}
