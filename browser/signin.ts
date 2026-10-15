/**
 * ⚙️ Settings → 🌐 Browser sign-in (015 FR3): opens a site in the shared
 * browser so the owner can sign in there themselves, from a DM or any group
 * or topic. The profile keeps the login for the agent.
 */

import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Bot, Context } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { withClose } from '../telegram/close.ts'
import { answer, appendLabel, createReplyPrompts, isOwner, keyOf, ownerOnly, sendTo } from '../telegram/handlers/ui.ts'
import type { Handoffs } from './handoff.ts'

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

export const SIGNIN_CALLBACK = /^web:(m|a|d|s)(?::([0-9a-f]+))?$/

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

export const ONBOARD_TEXT = "🌐 I have my own browser on your Mac now. Sign in there to the sites you'd like me to use for you, like your utility, bank, telco or school portals, and I can check bills, statements and notices without asking.\n\nYou sign in yourself, 2FA included; I never see your passwords, and I stay signed in. You can do this any time in ⚙️ Settings → 🌐 Browser sign-in, and I'll ask on my own when a task needs a site you haven't signed in to."

export function registerSignin(bot: Bot, o: {
  open: (url: string) => Promise<void>
  log: (line: string) => void
  handoffs: Handoffs
  /** Where the onboarding offer goes: the bot-wide 📍 Updates chat. */
  updatesTo: () => string | undefined
  /** The offer is sent once; a marker file in here records it. */
  dir: string
}) {
  const sites = createReplyPrompts<true>(bot.api)
  bot.callbackQuery(SIGNIN_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    // The window opens on the owner's Mac, so only the owner, from any chat.
    if (!isOwner(ctx) || !msg) return ownerOnly(ctx)
    const [, action, id] = ctx.match as unknown as [string, 'm' | 'a' | 'd' | 's', string?]
    if (action === 'd') {
      const r = o.handoffs.done(id!)
      if (r === undefined) return answer(ctx, 'Already done.')
      void answer(ctx, r ? '✅ Carrying on' : 'That conversation was reset; ask me again.')
      return appendLabel(ctx, r ? '✅ Signed in' : '✅ Signed in (conversation was reset)')
    }
    if (action === 's') {
      if (!o.handoffs.skip(id!)) return answer(ctx, 'Already done.')
      void answer(ctx, 'Skipped')
      return appendLabel(ctx, 'Skipped')
    }
    void answer(ctx)
    if (action === 'a') return sites.ask(keyOf(msg), '🔑 Which site? Reply to this message with its address.', 'e.g. portal.spgroup.com.sg', true)
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
      await o.open(url)
    } catch (err) {
      o.log(`signin: ${err}`)
      await ctx.reply(`Couldn't open the browser: ${err instanceof Error ? err.message : err}`)
      return true
    }
    await ctx.reply(`Opened ${url} in the agent's browser on your Mac. Sign in there; the agent stays signed in afterwards.`)
    return true
  }

  /** 015 FR6: once, when the browser first runs, suggest signing in to the sites the agent could use. */
  async function offer(): Promise<void> {
    const marker = join(o.dir, 'onboarded')
    const to = o.updatesTo()
    if (!to || existsSync(marker)) return
    writeFileSync(marker, `${new Date().toISOString()}\n`)
    await sendTo(bot.api, to, ONBOARD_TEXT, { reply_markup: withClose({ inline_keyboard: [[{ text: '🔑 Sign in to a site', callback_data: 'web:a' }]] }) })
  }

  return { siteReply, offer }
}
