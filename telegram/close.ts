/**
 * ✖ Close on every inline menu (008 FR16). `ui:close` deletes the menu
 * message, or strips its buttons when Telegram won't delete it (over 48 h old).
 */

import type { InlineKeyboardMarkup } from 'grammy/types'

export const CLOSE_CALLBACK = /^ui:close$/
const CLOSE = { text: '✖ Close', callback_data: 'ui:close' }

/** The keyboard with ✖ Close, beside a lone « Back or on its own row. */
export function withClose(kb?: InlineKeyboardMarkup): InlineKeyboardMarkup {
  const rows = (kb?.inline_keyboard ?? []).map(r => [...r])
  const last = rows.at(-1)
  if (last?.length === 1 && last[0]!.text.startsWith('«')) last.push(CLOSE)
  else rows.push([CLOSE])
  return { inline_keyboard: rows }
}
