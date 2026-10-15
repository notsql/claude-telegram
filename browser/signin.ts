/**
 * ⚙️ Settings → 🌐 Browser sign-in (015 FR3): opens a site in the shared
 * browser so the owner can sign in there themselves, from a DM or any group
 * or topic. The profile keeps the login for the agent.
 */

import type { Bot, Context } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { withClose } from '../telegram/close.ts'
import { answer, createReplyPrompts, isOwner, keyOf, ownerOnly } from '../telegram/handlers/ui.ts'

/** An http(s) URL from the reply text, adding `https://` when there's no scheme; null if it isn't one. */
export function signinUrl(arg: string): string | null {
  const raw = arg.trim()
  if (!raw || /\s/.test(raw)) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export const SIGNIN_CALLBACK = /^web:(m|a)$/

type View = { text: string; keyboard: { inline_keyboard: InlineKeyboardButton[][] } }

export function signinView(): View {
  return {
    text: "🌐 Browser sign-in\n\nThe agent's browser runs on your Mac and keeps your logins. Open a site there and sign in yourself, 2FA included. The agent stays signed in afterwards, even after restarts, and never needs your password.",
    keyboard: { inline_keyboard: [
      [{ text: '🔑 Sign in to a site', callback_data: 'web:a' }],
      [{ text: '« Back', callback_data: 'pol:m' }],
    ] },
  }
}

export function registerSignin(bot: Bot, o: { openTab: (url: string) => Promise<void>; log: (line: string) => void }) {
  const sites = createReplyPrompts<true>(bot.api)
  bot.callbackQuery(SIGNIN_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    // The window opens on the owner's Mac, so only the owner, from any chat.
    if (!isOwner(ctx) || !msg) return ownerOnly(ctx)
    void answer(ctx)
    if (ctx.match![1] === 'a') return sites.ask(keyOf(msg), '🔑 Which site? Reply to this message with its address.', 'e.g. portal.spgroup.com.sg', true)
    const v = signinView()
    await ctx.editMessageText(v.text, { reply_markup: withClose(v.keyboard) }).catch(() => {})
  })

  /** The owner's reply naming a site; true if it was one. */
  async function siteReply(ctx: Context): Promise<boolean> {
    if (!sites.peek(ctx) || !isOwner(ctx)) return false
    const url = signinUrl(ctx.message?.text ?? '')
    if (!url) {
      await ctx.reply("That doesn't look like a web address. Reply to the question again with one, e.g. portal.spgroup.com.sg.")
      return true
    }
    sites.done(ctx)
    try {
      await o.openTab(url)
    } catch (err) {
      o.log(`signin: ${err}`)
      await ctx.reply(`Couldn't open the browser: ${err instanceof Error ? err.message : err}`)
      return true
    }
    await ctx.reply(`Opened ${url} in the agent's browser on your Mac. Sign in there; the agent stays signed in afterwards.`)
    return true
  }

  return { siteReply }
}
