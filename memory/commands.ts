/**
 * Manual curation from 008's `/memory` buttons (004 US6, 008 FR13). The view
 * lists entries as buttons (`mo:<name>`), pages with `mp:<n>`, adds with `ma`
 * and shows the sender model with `mu`; an entry offers Forget (`md:<name>`).
 * Writes return the change for a notice with Undo. All refuse when the chat's
 * policy has `memoryScope: none`.
 */

import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types'
import { match } from '../reflection/apply.ts'
import type { Policy } from '../policy/schema.ts'
import { slug } from './guard.ts'
import type { MemoryStore } from './store.ts'
import type { MemoryChange } from './tools.ts'

export type CommandResult = { text: string; change?: MemoryChange; keyboard?: InlineKeyboardMarkup }

/** Memory names are slugs of at most 60 chars, so `mo:<name>` fits the 64-byte callback limit. */
export const MEMORY_CALLBACK = /^m(o|d|p|a|u):([a-z0-9-]{0,60})$/
const PAGE = 10

const OFF: CommandResult = { text: 'Memory is off in this chat (memoryScope: none).' }

/** The Add button's reply: saved as feedback; a similar existing entry is updated instead. */
export function remember(store: MemoryStore, text: string, key: string, policy: Policy): CommandResult {
  if (policy.memoryScope === 'none') return OFF
  text = text.trim()
  if (!text) return { text: 'Nothing to remember.' }
  const description = text.split('\n')[0]!.slice(0, 150)
  const name = slug(text.split(/\s+/).slice(0, 6).join(' '))
  const existing = match(store, name, description)
  try {
    const r = store.write({
      type: existing?.type ?? 'feedback',
      name: existing?.name ?? name,
      description,
      body: text,
      metadata: { ...existing?.metadata, source: 'telegram', session_key: key, updated: new Date().toISOString().slice(0, 10) },
    })
    const verb = r.op === 'create' ? 'Saved' : 'Updated'
    return {
      text: `🧠 ${verb}: ${description}`,
      change: { verb, name: r.entry.name, description, undo: () => store.restore(r.entry.name, r.backup) },
    }
  } catch (err) {
    return { text: `Not saved: ${err instanceof Error ? err.message : err}` }
  }
}

/** Forget: deletes an exact name, or the single search hit; lists them when ambiguous. */
export function forget(store: MemoryStore, query: string, policy: Policy): CommandResult {
  if (policy.memoryScope === 'none') return OFF
  query = query.trim()
  if (!query) return { text: 'Nothing to forget.' }
  const hits = store.read(query) ? [store.read(query)!] : store.search(query)
  if (!hits.length) return { text: `Nothing in memory matches "${query}".` }
  if (hits.length > 1) return { text: `Which one?\n${hits.slice(0, 10).map(e => `• ${e.name}: ${e.description}`).join('\n')}` }
  const e = hits[0]!
  const del = store.delete(e.name)!
  return {
    text: `🧠 Forgot: ${e.description}`,
    change: { verb: 'Forgot', name: e.name, description: e.description, undo: () => store.restore(e.name, del.backup) },
  }
}

/** `/memory`: shared entries as buttons, newest first, paged, with Add and About you. */
export function memoryView(store: MemoryStore, policy: Policy, page = 0): CommandResult {
  if (policy.memoryScope === 'none') return OFF
  const all = store.list().sort((a, b) => b.mtimeMs - a.mtimeMs)
  const pages = Math.max(1, Math.ceil(all.length / PAGE))
  page = Math.min(Math.max(page, 0), pages - 1)
  const shown = all.slice(page * PAGE, (page + 1) * PAGE)
  const rows: InlineKeyboardButton[][] = shown.map(e => [{ text: `${e.description || e.name}`.slice(0, 60), callback_data: `mo:${e.name}` }])
  if (pages > 1) {
    rows.push([
      ...(page > 0 ? [{ text: '« Prev', callback_data: `mp:${page - 1}` }] : []),
      ...(page < pages - 1 ? [{ text: 'Next »', callback_data: `mp:${page + 1}` }] : []),
    ])
  }
  rows.push([{ text: '➕ Add', callback_data: 'ma:' }, { text: '👤 About you', callback_data: 'mu:' }])
  const text = all.length
    ? `🧠 Shared memory (${all.length})${pages > 1 ? `, page ${page + 1}/${pages}` : ''}. Tap one to see or forget it.`
    : '🧠 Shared memory is empty. Tap Add, or just tell me what to remember.'
  return { text, keyboard: { inline_keyboard: rows } }
}

/** One entry, with Forget and Back. */
export function entryView(store: MemoryStore, name: string, policy: Policy): CommandResult {
  if (policy.memoryScope === 'none') return OFF
  const e = store.read(name)
  if (!e) return { text: `Nothing in memory named ${name}.`, keyboard: { inline_keyboard: [[{ text: '« Back', callback_data: 'mp:0' }]] } }
  return {
    text: `🧠 ${e.name} (${e.type})\n${e.description}\n\n${e.body}`.slice(0, 4000),
    keyboard: { inline_keyboard: [[{ text: '🗑 Forget', callback_data: `md:${e.name}` }, { text: '« Back', callback_data: 'mp:0' }]] },
  }
}

/** What is known about the sender. */
export function aboutYou(userStore: MemoryStore, policy: Policy): CommandResult {
  if (policy.memoryScope === 'none') return OFF
  const you = userStore.list()
  return {
    text: [`👤 About you (${you.length}):`, ...(you.length ? you.map(e => `• ${e.description}: ${e.body}`) : ['(nothing yet)'])].join('\n').slice(0, 4000),
    keyboard: { inline_keyboard: [[{ text: '« Back', callback_data: 'mp:0' }]] },
  }
}
