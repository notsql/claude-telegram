/**
 * Manual curation for 008's `/remember`, `/forget` and `/memory` (004 US6).
 * Each returns text for the chat and, for writes, the change for a notice
 * with Undo. All refuse when the chat's policy has `memoryScope: none`.
 */

import { match } from '../reflection/apply.ts'
import type { Policy } from '../policy/schema.ts'
import { slug } from './guard.ts'
import type { MemoryStore } from './store.ts'
import type { MemoryChange } from './tools.ts'

export type CommandResult = { text: string; change?: MemoryChange }

const OFF: CommandResult = { text: 'Memory is off in this chat (memoryScope: none).' }

/** `/remember <text>`: saved as feedback; a similar existing entry is updated instead. */
export function remember(store: MemoryStore, text: string, key: string, policy: Policy): CommandResult {
  if (policy.memoryScope === 'none') return OFF
  text = text.trim()
  if (!text) return { text: 'Usage: /remember <something to keep in mind>' }
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

/** `/forget <name or words>`: deletes an exact name, or the single search hit; lists them when ambiguous. */
export function forget(store: MemoryStore, query: string, policy: Policy): CommandResult {
  if (policy.memoryScope === 'none') return OFF
  query = query.trim()
  if (!query) return { text: 'Usage: /forget <name or words from it>' }
  const hits = store.read(query) ? [store.read(query)!] : store.search(query)
  if (!hits.length) return { text: `Nothing in memory matches "${query}".` }
  if (hits.length > 1) return { text: `Which one? Send /forget <name>:\n${hits.slice(0, 10).map(e => `• ${e.name}: ${e.description}`).join('\n')}` }
  const e = hits[0]!
  const del = store.delete(e.name)!
  return {
    text: `🧠 Forgot: ${e.description}`,
    change: { verb: 'Forgot', name: e.name, description: e.description, undo: () => store.restore(e.name, del.backup) },
  }
}

/** `/memory`: the shared index, plus what is known about the sender. */
export function showMemory(store: MemoryStore, userStore: MemoryStore, policy: Policy): CommandResult {
  if (policy.memoryScope === 'none') return OFF
  const shared = store.list().sort((a, b) => b.mtimeMs - a.mtimeMs)
  const you = userStore.list()
  const lines = [
    `🧠 Shared memory (${shared.length}):`,
    ...(shared.length ? shared.map(e => `• ${e.name} (${e.type}): ${e.description}`) : ['(empty)']),
    '',
    `About you (${you.length}):`,
    ...(you.length ? you.map(e => `• ${e.description}: ${e.body}`) : ['(nothing yet)']),
  ]
  return { text: lines.join('\n') }
}
