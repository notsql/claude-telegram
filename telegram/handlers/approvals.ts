/**
 * Approval answers (003 FR2, FR3, FR5): the `perm:<allow|deny|always|more>:<id>`
 * buttons, or a typed `yes abcde`. Only the key's approvers may answer; the
 * first answer wins.
 */

import type { Bot, Context } from 'grammy'
import { parseTextReply, type createApprovals } from '../../policy/approvals.ts'
import { answer, appendLabel, failed, isApprover } from './ui.ts'

const PERM_CALLBACK = /^perm:(allow|deny|always|more):([a-km-z]{5})$/

/**
 * Registers the buttons as the catch-all for callback data, so call it after
 * every other button handler. Returns the typed-answer check.
 */
export function registerApprovals(bot: Bot, approvals: ReturnType<typeof createApprovals>, react: (ctx: Context, emoji: string) => void) {
  bot.on('callback_query:data', async ctx => {
    const m = PERM_CALLBACK.exec(ctx.callbackQuery.data)
    if (!m) return answer(ctx)
    const [, action, id] = m as unknown as [string, 'allow' | 'deny' | 'always' | 'more', string]
    const key = approvals.keyOf(id)
    if (!key) return answer(ctx, 'Already decided.')
    if (!isApprover(key, ctx.from.id)) return answer(ctx, 'Not authorised to approve.')
    if (action === 'more') {
      const kb = approvals.keyboard(id)
      kb.inline_keyboard[0]!.shift()
      await ctx.editMessageText(approvals.details(id)!, { reply_markup: kb, parse_mode: 'HTML' }).catch(() => {})
      return answer(ctx)
    }
    const label = { allow: '✅ Allowed for this session', deny: '❌ Denied', always: '♾ Always allowed' }[action]
    void answer(ctx, label)
    if (!approvals.decide(id, action, String(ctx.from.id))) return failed(ctx, 'already decided')
    await appendLabel(ctx, label)
  })

  /** `yes abcde` answers a pending approval like the buttons. True if it was one. */
  return function textApproval(ctx: Context, text: string): boolean {
    const reply = parseTextReply(text)
    const key = reply && approvals.keyOf(reply.id)
    if (!reply || !key || !isApprover(key, ctx.from!.id)) return false
    if (!approvals.decide(reply.id, reply.decision, String(ctx.from!.id))) return false
    react(ctx, reply.decision === 'allow' ? '👍' : '👎')
    return true
  }
}
