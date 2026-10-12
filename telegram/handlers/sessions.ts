/**
 * Session controls: /stop interrupts the running turn (001 FR8); /sessions
 * has New, Resume and Compact as buttons (008 FR14).
 */

import type { Bot } from 'grammy'
import type { InlineKeyboardMarkup } from 'grammy/types'
import { sessionStatus, type SessionToolDeps } from '../../agent/sessionTools.ts'
import type { Command } from '../../commands/registry.ts'
import { policyOf } from '../../policy/resolve.ts'
import { resumeView, SESSIONS_CALLBACK, sessionsView } from '../../sessions/commands.ts'
import { sessionKey } from '../../sessions/key.ts'
import { withClose } from '../close.ts'
import { answer, isOwner, keyOf, ownerOnly } from './ui.ts'

export type SessionsDeps = SessionToolDeps & {
  /** The running turn's controller, per key. */
  runningTurns: Map<string, AbortController>
  hasSession: (key: string) => boolean
  /** Queues `/compact` as the key's next turn. */
  compact: (key: string) => void
}

export function registerSessions(bot: Bot, deps: SessionsDeps): { stop: Command; sessions: Command } {
  const { lifecycle } = deps
  const status = (key: string) => sessionsView(sessionStatus(deps, key, policyOf(key)))

  bot.callbackQuery(SESSIONS_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    if (!msg || !isOwner(ctx)) return ownerOnly(ctx)
    const key = keyOf(msg)
    const [, action, arg] = ctx.match as unknown as [string, 'n' | 'c' | 'l' | 'r' | 'b', string]
    const edit = (text: string, keyboard?: InlineKeyboardMarkup) =>
      ctx.editMessageText(text, keyboard ? { reply_markup: withClose(keyboard) } : {}).catch(() => {})
    await answer(ctx)
    switch (action) {
      case 'n':
        lifecycle.new(key)
        return void await edit('🆕 New session. The next message starts with no earlier context.')
      case 'c':
        if (!deps.hasSession(key)) return void await edit('No session to compact yet.')
        deps.compact(key)
        return void await edit('🗜 Compacting this session.')
      case 'l': {
        const r = resumeView(lifecycle.list(key), Number(arg))
        return void await edit(r.text, r.keyboard)
      }
      case 'r':
        try {
          const picked = lifecycle.resume(key, Number(arg))
          return void await edit(`⏪ Resumed: ${picked.title || '(untitled)'}`)
        } catch (err) {
          return void await edit((err as Error).message)
        }
      case 'b': {
        const r = status(key)
        return void await edit(r.text, r.keyboard)
      }
    }
  })

  return {
    stop: { name: 'stop', description: 'Interrupt the running turn here', menu: ['private', 'group'], handler: async ctx => {
      if (!isOwner(ctx)) return
      const turn = deps.runningTurns.get(sessionKey(ctx.msg!))
      if (!turn) return void await ctx.reply('Nothing is running here.')
      turn.abort()
    } },
    sessions: { name: 'sessions', description: 'New, resume or compact this session', menu: ['private', 'group'], handler: async ctx => {
      if (!isOwner(ctx)) return
      const r = status(sessionKey(ctx.msg!))
      await ctx.reply(r.text, { reply_markup: withClose(r.keyboard) })
    } },
  }
}
