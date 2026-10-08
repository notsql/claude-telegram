/**
 * `/settings` → 🧩 → Plugins → 🛒 Browse plugins (008 FR21). `sto:c` lists
 * the categories, `sto:l:<category>:<page>` their plugins, `sto:d:<id>` a
 * plugin's page. Install and Uninstall confirm first (`sto:i|r:<id>`, then
 * `sto:I|R:<id>`); Update (`sto:u:<id>`) runs straight away.
 */

import type { InlineKeyboardButton } from 'grammy/types'
import type { CatalogEntry } from '../skills/catalog.ts'
import { prettyName } from './extensionsUi.ts'
import type { PolicyView } from './policyUi.ts'

export const STORE_CALLBACK = /^sto:(c|l|d|i|I|r|R|u)(?::([\w@.-]{1,58}))?(?::(\d+))?$/
const PAGE = 10

const button = (text: string, data: string): InlineKeyboardButton => ({ text: text.slice(0, 64), callback_data: data })
const listable = (entries: CatalogEntry[]) => entries.filter(e => STORE_CALLBACK.test(`sto:d:${e.id}`))
const label = (e: CatalogEntry) => prettyName(e.name)

export function categoriesView(entries: CatalogEntry[]): PolicyView {
  const counts = new Map<string, number>()
  for (const e of listable(entries)) counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
  const cats = [...counts.keys()].sort((a, b) => a === 'other' ? 1 : b === 'other' ? -1 : a.localeCompare(b))
  const rows: InlineKeyboardButton[][] = []
  for (let i = 0; i < cats.length; i += 2) {
    rows.push(cats.slice(i, i + 2).map(c => button(`${prettyName(c)} (${counts.get(c)})`, `sto:l:${c}:0`)))
  }
  rows.push([button('« Back', 'ext:p')])
  const markets = [...new Set(entries.map(e => e.marketplace))]
  return {
    text: markets.length
      ? `🛒 Browse plugins from ${markets.join(', ')}. Pick a category.\n\nAdd more marketplaces from the terminal with /plugin.`
      : 'No marketplaces added yet. Add one from the terminal with /plugin.',
    keyboard: { inline_keyboard: rows },
  }
}

export function listView(entries: CatalogEntry[], category: string, page: number, installed: Set<string>): PolicyView {
  const list = listable(entries).filter(e => e.category === category)
  const pages = Math.max(1, Math.ceil(list.length / PAGE))
  page = Math.min(Math.max(page, 0), pages - 1)
  const rows = list.slice(page * PAGE, (page + 1) * PAGE).map(e => [button(`${installed.has(e.id) ? '✓ ' : ''}${label(e)}`, `sto:d:${e.id}`)])
  if (pages > 1) {
    rows.push([
      ...(page > 0 ? [button('« Prev', `sto:l:${category}:${page - 1}`)] : []),
      ...(page < pages - 1 ? [button('Next »', `sto:l:${category}:${page + 1}`)] : []),
    ])
  }
  rows.push([button('« Back', 'sto:c')])
  return {
    text: `🛒 ${prettyName(category)}${pages > 1 ? `, page ${page + 1}/${pages}` : ''}. ✓ installed. Tap one for details.`,
    keyboard: { inline_keyboard: rows },
  }
}

export function pluginView(e: CatalogEntry, installed: boolean): PolicyView {
  return {
    text: [
      `🔌 ${label(e)}${installed ? ' (installed)' : ''}`, '',
      ...(e.description ? [e.description, ''] : []),
      `Category: ${prettyName(e.category)}`,
      ...(e.author ? [`By: ${e.author}`] : []),
      `Marketplace: ${e.marketplace}`,
      ...(e.homepage ? [e.homepage] : []),
    ].join('\n'),
    keyboard: { inline_keyboard: [
      installed ? [button('⬆️ Update', `sto:u:${e.id}`), button('🗑 Uninstall', `sto:r:${e.id}`)] : [button('📥 Install', `sto:i:${e.id}`)],
      [button('« Back', `sto:l:${e.category}:0`)],
    ] },
  }
}

export function confirmView(e: CatalogEntry, action: 'i' | 'r'): PolicyView {
  return action === 'i'
    ? {
        text: `📥 Install ${label(e)}?\n\nIt runs the plugin's code (hooks, MCP servers) on this computer as you. Only install plugins you trust.\n\nIt will be on in this chat only; switch it on elsewhere under Plugins.`,
        keyboard: { inline_keyboard: [[button('📥 Install', `sto:I:${e.id}`), button('« Back', `sto:d:${e.id}`)]] },
      }
    : {
        text: `🗑 Uninstall ${label(e)}? It goes from every chat and the terminal.`,
        keyboard: { inline_keyboard: [[button('🗑 Uninstall', `sto:R:${e.id}`), button('« Back', `sto:d:${e.id}`)]] },
      }
}

/** The outcome of an install, update or uninstall, with « Back to the plugin's page. */
export function resultView(e: CatalogEntry, text: string): PolicyView {
  return { text: text.slice(0, 4000), keyboard: { inline_keyboard: [[button('« Back', `sto:d:${e.id}`)]] } }
}
