/**
 * Helpers shared by the button and command handlers: who may tap what, the
 * optimistic-tap failure path, and force-reply prompts that wait for an answer.
 */

import type { Api, Bot, Context } from 'grammy'
import type { Message } from 'grammy/types'
import { loadAccess } from '../../access.ts'
import { authorised } from '../../commands/dispatch.ts'
import { policyOf } from '../../policy/resolve.ts'
import { parseKey, sessionKey } from '../../sessions/key.ts'
import { CLOSE_CALLBACK } from '../close.ts'
import { threadOpts } from '../send.ts'

export const isOwner = (ctx: Context) => !!ctx.from && loadAccess().allowFrom.includes(String(ctx.from.id))

export const isApprover = (key: string, userId: number) => (policyOf(key).approvers ?? []).includes(String(userId))

/** State changes from a button or reply: groups need an approver (008 FR10), DMs an owner. */
export const canChange = (ctx: Context, key: string) =>
  authorised({ requiresApprover: true }, ctx.chat?.type !== 'private', isApprover(key, ctx.from!.id), isOwner(ctx))

/** The session key of the message a button sits on. */
export const keyOf = (msg: Pick<Message, 'chat' | 'message_thread_id' | 'is_topic_message'>) => sessionKey(msg)

/** Answers a tap, ignoring a query that has already expired. */
export const answer = (ctx: Context, text?: string, alert = false) =>
  ctx.answerCallbackQuery(text ? { text, ...(alert && { show_alert: true }) } : undefined).catch(() => {})

export const ownerOnly = (ctx: Context) => answer(ctx, 'Owner only.')

/** An optimistic tap that didn't work out: the message says why and keeps its buttons. */
export async function failed(ctx: Context, reason: string): Promise<void> {
  const msg = ctx.callbackQuery?.message
  if (!msg || !('text' in msg) || !msg.text) return
  await ctx.editMessageText(`${msg.text}\n\n⚠️ Not done: ${reason}`, { entities: msg.entities, reply_markup: msg.reply_markup }).catch(() => {})
}

/** Appends a result line to the tapped message, dropping its buttons. Keeping the entities keeps code blocks formatted. */
export async function appendLabel(ctx: Context, label: string): Promise<void> {
  const msg = ctx.callbackQuery?.message
  if (msg && 'text' in msg && msg.text) await ctx.editMessageText(`${msg.text}\n\n${label}`, { entities: msg.entities }).catch(() => {})
}

/** Sends to a session key, in its forum topic (002 FR4). */
export const sendTo = (api: Api, key: string, text: string, extra: Parameters<Api['sendMessage']>[2] = {}) => {
  const target = parseKey(key)
  return api.sendMessage(target.chatId, text, { ...threadOpts(target), ...extra }).catch(() => undefined)
}

/**
 * Force-reply prompts ("Reply to this message") waiting for an answer, each
 * holding a value until the reply arrives. Lost on restart.
 */
export function createReplyPrompts<T>(api: Api) {
  const waiting = new Map<string, T>()
  const idOf = (ctx: Context) => {
    const to = ctx.message?.reply_to_message
    return to && ctx.chat ? `${ctx.chat.id}:${to.message_id}` : undefined
  }
  return {
    async ask(key: string, text: string, placeholder: string, value: T, selective = true): Promise<void> {
      const sent = await sendTo(api, key, text, { reply_markup: { force_reply: true, selective, input_field_placeholder: placeholder } })
      if (sent) waiting.set(`${sent.chat.id}:${sent.message_id}`, value)
    },
    /** The value of the prompt `ctx` replies to, if it is one. */
    peek(ctx: Context): T | undefined {
      const id = idOf(ctx)
      return id ? waiting.get(id) : undefined
    },
    done(ctx: Context): void {
      const id = idOf(ctx)
      if (id) waiting.delete(id)
    },
  }
}

/** 008 FR16: ✕ Close on any menu; owner only, like the menus. */
export function registerClose(bot: Bot): void {
  bot.callbackQuery(CLOSE_CALLBACK, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    await answer(ctx)
    await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {}))
  })
}
