/**
 * `/sessions` buttons (008 FR14): one entry point for the session commands.
 * The menu shows the session status with 🆕 New (`ssn`), ⏪ Resume (`ssl:<page>`)
 * and 🗜 Compact (`ssc`); Resume lists earlier sessions as buttons (`ssr:<n>`)
 * with « Back (`ssb`).
 */

import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types'
import type { PastSession } from './store.ts'

export type SessionsView = { text: string; keyboard: InlineKeyboardMarkup }

export const SESSIONS_CALLBACK = /^ss(n|c|l|r|b):(\d{0,4})$/
const PAGE = 8

/** `/sessions`: the status text with the session actions. */
export function sessionsView(status: string): SessionsView {
  return {
    text: status,
    keyboard: { inline_keyboard: [[
      { text: '🆕 New', callback_data: 'ssn:' },
      { text: '⏪ Resume', callback_data: 'ssl:0' },
      { text: '🗜 Compact', callback_data: 'ssc:' },
    ]] },
  }
}

/** Earlier sessions as buttons, most recent first, paged; `n` matches `lifecycle.resume`. */
export function resumeView(past: PastSession[], page = 0): SessionsView {
  const pages = Math.max(1, Math.ceil(past.length / PAGE))
  page = Math.min(Math.max(page, 0), pages - 1)
  const rows: InlineKeyboardButton[][] = past.slice(page * PAGE, (page + 1) * PAGE).map((s, i) => {
    const n = page * PAGE + i + 1
    return [{ text: `${s.title || '(untitled)'} · ${new Date(s.startedAt).toISOString().slice(0, 10)}`.slice(0, 64), callback_data: `ssr:${n}` }]
  })
  if (pages > 1) {
    rows.push([
      ...(page > 0 ? [{ text: '« Prev', callback_data: `ssl:${page - 1}` }] : []),
      ...(page < pages - 1 ? [{ text: 'Next »', callback_data: `ssl:${page + 1}` }] : []),
    ])
  }
  rows.push([{ text: '« Back', callback_data: 'ssb:' }])
  const text = past.length
    ? `⏪ Earlier sessions (${past.length})${pages > 1 ? `, page ${page + 1}/${pages}` : ''}. Tap one to resume it.`
    : 'No earlier sessions here.'
  return { text, keyboard: { inline_keyboard: rows } }
}
