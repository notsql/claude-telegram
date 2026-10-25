/**
 * ⚙️ Settings → 🛡 Actions (020 FR5): the last action cards and off-limits
 * blocks from `audit.log`, newest first, owner-only in any chat.
 */

import { existsSync, readFileSync } from 'fs'
import type { Bot } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { ACTION_ICON, type ActionClass } from '../../policy/consequential.ts'
import { withClose } from '../close.ts'
import { answer, isOwner, ownerOnly } from './ui.ts'

export const ACTIONS_CALLBACK = /^act:m$/

const SHOWN = 50
const OUTCOME: Record<string, string> = { allow: 'approved', always: 'approved', deny: 'cancelled', expired: 'timed out' }

type Line = { ts: string; decision: string; action: string; summary?: string }

/** Action entries from the audit log, newest first. */
export function actionLines(auditFile: string, max = SHOWN): Line[] {
  if (!existsSync(auditFile)) return []
  const out: Line[] = []
  const rows = readFileSync(auditFile, 'utf8').split('\n')
  for (let i = rows.length - 1; i >= 0 && out.length < max; i--) {
    try {
      const e = JSON.parse(rows[i]!)
      if (e.event === 'approval' && typeof e.action === 'string') out.push(e)
    } catch {}
  }
  return out
}

export function actionsView(lines: Line[], now = new Date()): { text: string; keyboard: { inline_keyboard: InlineKeyboardButton[][] } } {
  const when = (ts: string) => {
    const d = new Date(ts)
    const hm = d.toTimeString().slice(0, 5)
    return d.toDateString() === now.toDateString() ? hm : `${d.toISOString().slice(5, 10)} ${hm}`
  }
  const row = (l: Line) => l.action === 'off_limits'
    ? `⛔ ${when(l.ts)} blocked: ${l.summary ?? 'off-limits'}`
    : `${ACTION_ICON[l.action as ActionClass] ?? '•'} ${when(l.ts)} ${OUTCOME[l.decision] ?? l.decision}: ${(l.summary ?? '').slice(0, 70)}`
  const text = [
    '🛡 Actions',
    '',
    'Sending, paying, signing and deleting always ask you first. Trading securities and moving money between accounts are blocked.',
    '',
    ...(lines.length ? lines.map(row) : ['Nothing yet.']),
  ].join('\n').slice(0, 4000)
  return { text, keyboard: { inline_keyboard: [[{ text: '« Back', callback_data: 'pol:m' }]] } }
}

export function registerActions(bot: Bot, auditFile: string): void {
  bot.callbackQuery(ACTIONS_CALLBACK, async ctx => {
    if (!isOwner(ctx) || !ctx.callbackQuery.message) return ownerOnly(ctx)
    void answer(ctx)
    const v = actionsView(actionLines(auditFile))
    await ctx.editMessageText(v.text, { reply_markup: withClose(v.keyboard) }).catch(() => {})
  })
}
