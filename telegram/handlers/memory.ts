/**
 * 008 FR13: /memory, with Add, Forget and About you as buttons; plus Undo on
 * memory notices (004 FR9) and Save or Skip on proposed memories (004 FR6).
 */

import type { Bot, Context } from 'grammy'
import type { Command } from '../../commands/registry.ts'
import { aboutYou, entryView, forget, MEMORY_CALLBACK, memoryView, remember, type CommandResult } from '../../memory/commands.ts'
import { noticeText, type createNotices } from '../../memory/notices.ts'
import type { createMemoryStore } from '../../memory/store.ts'
import type { createApplier } from '../../reflection/apply.ts'
import { policyOf } from '../../policy/resolve.ts'
import { sessionKey } from '../../sessions/key.ts'
import { withClose } from '../close.ts'
import { answer, appendLabel, canChange, createReplyPrompts, failed, isOwner, keyOf, ownerOnly, sendTo } from './ui.ts'

type MemoryStore = ReturnType<typeof createMemoryStore>

export type MemoryDeps = {
  memory: MemoryStore
  userStore: (userId: string) => MemoryStore
  notices: ReturnType<typeof createNotices>
  applier: ReturnType<typeof createApplier>
}

export function registerMemory(bot: Bot, { memory, userStore, notices, applier }: MemoryDeps) {
  const adds = createReplyPrompts<string>(bot.api)
  // Writes get the Undo notice; views get their buttons.
  const reply = (ctx: Context, r: CommandResult) =>
    ctx.reply(r.text, r.change ? { reply_markup: notices.undoKeyboard(r.change) } : r.keyboard ? { reply_markup: withClose(r.keyboard) } : {})

  const command: Command = { name: 'memory', description: 'See, add and forget what I remember', menu: ['private', 'group'], handler: async ctx => {
    if (!isOwner(ctx)) return
    await reply(ctx, memoryView(memory, policyOf(sessionKey(ctx.msg!))))
  } }

  bot.callbackQuery(MEMORY_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    if (!msg || !isOwner(ctx)) return ownerOnly(ctx)
    const key = keyOf(msg)
    const policy = policyOf(key)
    const [, action, arg] = ctx.match as unknown as [string, 'o' | 'd' | 'p' | 'a' | 'u', string]
    const edit = (r: CommandResult) => ctx.editMessageText(r.text, { reply_markup: withClose(r.keyboard) }).catch(() => {})
    if (action === 'd') {
      if (!canChange(ctx, key)) return answer(ctx, 'Not authorised.')
      void answer(ctx, '🧠 Forgotten')
      const r = forget(memory, arg, policy)
      if (!r.change) return failed(ctx, r.text)
      await edit(memoryView(memory, policy))
      await sendTo(bot.api, key, r.text, { reply_markup: notices.undoKeyboard(r.change) })
      return
    }
    await answer(ctx)
    if (action === 'o') return void await edit(entryView(memory, arg, policy))
    if (action === 'p') return void await edit(memoryView(memory, policy, Number(arg)))
    if (action === 'u') return void await edit(aboutYou(userStore(String(ctx.from.id)), policy))
    await adds.ask(key, '🧠 What should I remember? Reply to this message.', 'Something to remember', key)
  })

  // Undo on a memory notice.
  bot.callbackQuery(/^mem:undo:([0-9a-f]+)$/, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    const label = notices.undo(ctx.match[1]!)
    if (!label) return answer(ctx, 'Nothing to undo.')
    await answer(ctx, label)
    await appendLabel(ctx, label)
  })

  // Save or Skip a proposed memory (autoLearn: propose).
  bot.callbackQuery(/^mem:(save|skip):([0-9a-f]+)$/, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    const save = ctx.match[1] === 'save'
    void answer(ctx, save ? '✅ Saved' : 'Skipped')
    const r = applier.decide(ctx.match[2]!, save)
    if (!r || r.error) return failed(ctx, r?.error ?? 'already decided')
    if (r.change) await ctx.editMessageText(noticeText(r.change), { reply_markup: notices.undoKeyboard(r.change) }).catch(() => {})
    else await ctx.deleteMessage().catch(() => {})
  })

  /** A reply to an Add prompt; true when `ctx` was one and has been handled. */
  async function addReply(ctx: Context): Promise<boolean> {
    const key = adds.peek(ctx)
    if (!key || !isOwner(ctx)) return false
    adds.done(ctx)
    await reply(ctx, remember(memory, ctx.message!.text ?? '', key, policyOf(key)))
    return true
  }

  return { command, addReply }
}
