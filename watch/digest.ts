/**
 * Inbox digests and open loops (013 FR8). The `digest-morning` and
 * `digest-evening` system jobs first sweep loops: a `toMe` item with no later
 * `fromMe` item in the same thread after `loopAfter` opens an `awaiting_me`
 * loop; a loop closes once such a reply arrives or its item is `done`. Then one
 * plain-text message lists undelivered `fyi` and un-pinged `action` items by
 * source and person, plus every open loop, and marks those items `digested`.
 * Composing is deterministic: no model call. Item text is untrusted and sent
 * without parse_mode.
 */

import type { Database } from 'bun:sqlite'

export type DigestApi = { sendMessage(chatId: string, text: string): Promise<unknown> }

export type DigestOpts = {
  db: Database
  api: DigestApi
  owner: string
  title: string
  loopAfterMs?: number
  now?: () => number
}

type ItemRow = { id: number; source: string; from_name: string | null; from_id: string | null; chat_name: string | null; is_group: number; label: string; text: string }
type LoopRow = { kind: string; summary: string; source: string }

const LOOP_AFTER_MS = 4 * 3_600_000
const SNIPPET = 140
const MAX_MESSAGE = 4000

const snip = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > SNIPPET ? `${one.slice(0, SNIPPET)}…` : one
}

/** A later `fromMe` item in the same source, chat and thread as item `i`. */
const REPLIED = `EXISTS (SELECT 1 FROM items r WHERE r.from_me = 1 AND r.source = i.source
  AND r.chat_id IS i.chat_id AND r.thread_id IS i.thread_id AND r.ts > i.ts)`

/** Closes answered or done loops, then opens `awaiting_me` loops for unanswered items older than `loopAfterMs`. */
export function sweepLoops(db: Database, t: number, loopAfterMs = LOOP_AFTER_MS): void {
  db.transaction(() => {
    db.query(
      `UPDATE loops SET closed_at = ? WHERE closed_at IS NULL AND id IN (
         SELECT l.id FROM loops l JOIN items i ON i.id = l.item_id
         WHERE i.status = 'done' OR (l.kind = 'awaiting_me' AND ${REPLIED}))`,
    ).run(t)
    db.query(
      `INSERT INTO loops (item_id, kind, summary, opened_at)
       SELECT i.id, 'awaiting_me', coalesce(i.from_name, i.from_id, 'unknown') || ': ' || i.text, ?
       FROM items i WHERE i.to_me = 1 AND i.from_me = 0 AND i.ts <= ? AND i.status != 'done'
         AND i.label IS NOT 'noise' AND NOT ${REPLIED}
         AND NOT EXISTS (SELECT 1 FROM loops l WHERE l.item_id = i.id)`,
    ).run(t, t - loopAfterMs)
  })()
}

export function composeDigest(title: string, items: ItemRow[], loops: LoopRow[]): string | null {
  if (!items.length && !loops.length) return null
  const out = [title]
  const bySource = new Map<string, Map<string, ItemRow[]>>()
  for (const r of items) {
    const who = (r.from_name ?? r.from_id ?? 'unknown') + (r.is_group && r.chat_name ? ` in ${r.chat_name}` : '')
    let people = bySource.get(r.source)
    if (!people) bySource.set(r.source, people = new Map())
    people.set(who, [...(people.get(who) ?? []), r])
  }
  for (const [source, people] of bySource) {
    out.push('', source)
    for (const [who, rs] of people) {
      out.push(`  ${who}${rs.length > 1 ? ` (${rs.length})` : ''}`)
      for (const r of rs) out.push(`    • ${r.label === 'action' ? '[action] ' : ''}${snip(r.text)}`)
    }
  }
  const section = (kind: string, heading: string) => {
    const ls = loops.filter(l => l.kind === kind)
    if (ls.length) out.push('', `${heading} (${ls.length})`, ...ls.map(l => `  • ${l.source} · ${snip(l.summary)}`))
  }
  section('awaiting_me', 'Awaiting me')
  section('i_promised', 'I promised')
  const text = out.join('\n')
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text
}

/** One digest run; returns whether anything was sent. Items become `digested` only after the send succeeds. */
export async function runDigest(o: DigestOpts): Promise<boolean> {
  const t = o.now?.() ?? Date.now()
  sweepLoops(o.db, t, o.loopAfterMs)
  const items = o.db.query(
    `SELECT id, source, from_name, from_id, chat_name, is_group, label, text FROM items
     WHERE label IN ('fyi', 'action') AND from_me = 0 AND status = 'new' ORDER BY source, ts`,
  ).all() as ItemRow[]
  const loops = o.db.query(
    `SELECT l.kind, l.summary, i.source FROM loops l JOIN items i ON i.id = l.item_id
     WHERE l.closed_at IS NULL ORDER BY l.opened_at, l.id`,
  ).all() as LoopRow[]
  const text = composeDigest(o.title, items, loops)
  if (!text) return false
  await o.api.sendMessage(o.owner, text)
  const mark = o.db.query(`UPDATE items SET status = 'digested' WHERE id = ? AND status = 'new'`)
  o.db.transaction(() => { for (const r of items) mark.run(r.id) })()
  return true
}
