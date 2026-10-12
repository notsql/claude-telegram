/**
 * Inbox delivery (013 FR7): ping cards in the owner DM for `urgent` and
 * `action` items, with Open / Draft reply / Snooze (1h, tonight, tomorrow) /
 * Mute sender / Done. Quiet hours hold pings except `urgent` from a VIP, and
 * at most `pingsPerHour` go out. Held items stay `new`, so the next tick or the
 * digest picks them up; nothing is dropped. Snoozed items ping again once
 * `snooze_until` passes. Item text is untrusted and sent as plain text.
 */

import type { Database } from 'bun:sqlite'
import type { Bot } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { answer, appendLabel, isOwner, ownerOnly } from '../telegram/handlers/ui.ts'

export type DeliverApi = {
  sendMessage(chatId: string, text: string, extra: { reply_markup: { inline_keyboard: InlineKeyboardButton[][] } }): Promise<unknown>
}

export type DeliverOpts = {
  db: Database
  api: DeliverApi
  owner: string
  vips: string[]
  /** Called on Mute sender; durable mutes are memory (014). */
  mute: (source: string, fromId: string) => void
  /** Local "HH:MM" bounds; default 23:00–07:30. */
  quiet?: { start: string; end: string }
  pingsPerHour?: number
  intervalMs?: number
  now?: () => number
  log?: (msg: string) => void
}

type Row = {
  id: number; source: string; from_id: string | null; from_name: string | null
  chat_name: string | null; is_group: number; text: string; url: string | null; label: string; reason: string | null
}

export type Action = 'done' | 'snz1' | 'snzn' | 'snzt' | 'mute' | 'draft'

const MAX_TEXT = 500
const mins = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h! * 60 + m! }

export function inQuietHours(t: number, quiet: { start: string; end: string }): boolean {
  const d = new Date(t)
  const m = d.getHours() * 60 + d.getMinutes()
  const s = mins(quiet.start), e = mins(quiet.end)
  return s <= e ? m >= s && m < e : m >= s || m < e
}

/** Next local time-of-day `hhmm` strictly after `t`. */
function nextAt(t: number, hhmm: string): number {
  const d = new Date(t)
  const m = mins(hhmm)
  d.setHours(Math.floor(m / 60), m % 60, 0, 0)
  if (d.getTime() <= t) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** Snooze ends: 1h, tonight 19:00, tomorrow 08:30 (the morning digest). */
export function snoozeUntil(action: 'snz1' | 'snzn' | 'snzt', t: number): number {
  if (action === 'snz1') return t + 3_600_000
  if (action === 'snzn') return nextAt(t, '19:00')
  const d = new Date(t)
  d.setDate(d.getDate() + 1)
  d.setHours(8, 30, 0, 0)
  return d.getTime()
}

export function cardText(r: Row): string {
  const icon = r.label === 'urgent' ? '🔴' : '🟠'
  const who = r.from_name ?? r.from_id ?? 'unknown'
  const where = r.is_group && r.chat_name ? ` in ${r.chat_name}` : ''
  const body = r.text.length > MAX_TEXT ? `${r.text.slice(0, MAX_TEXT)}…` : r.text
  return `${icon} ${r.source} · ${who}${where}${r.reason ? `: ${r.reason}` : ''}\n\n${body}`
}

export function cardButtons(r: Row): InlineKeyboardButton[][] {
  const cb = (a: Action) => `inb:${a}:${r.id}`
  return [
    [
      ...(r.url ? [{ text: 'Open', url: r.url }] : []),
      { text: 'Draft reply', callback_data: cb('draft') },
    ],
    [
      { text: 'Snooze 1h', callback_data: cb('snz1') },
      { text: 'Tonight', callback_data: cb('snzn') },
      { text: 'Tomorrow', callback_data: cb('snzt') },
    ],
    [
      { text: 'Mute sender', callback_data: cb('mute') },
      { text: 'Done', callback_data: cb('done') },
    ],
  ]
}

export function createDeliver(o: DeliverOpts) {
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const quiet = o.quiet ?? { start: '23:00', end: '07:30' }
  const cap = o.pingsPerHour ?? 6
  const sent: number[] = []
  let running = false
  let timer: ReturnType<typeof setInterval> | undefined

  const setStatus = o.db.query('UPDATE items SET status = ?, snooze_until = ? WHERE id = ?')

  /** Pings every due item the quiet hours and the hourly cap allow. */
  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const t = now()
      const due = o.db.query(
        `SELECT * FROM items WHERE label IN ('urgent', 'action') AND from_me = 0
           AND (status = 'new' OR (status = 'snoozed' AND snooze_until <= ?))
         ORDER BY label = 'urgent' DESC, ts`,
      ).all(t) as Row[]
      const quietNow = inQuietHours(t, quiet)
      for (const r of due) {
        if (quietNow && !(r.label === 'urgent' && r.from_id && o.vips.includes(r.from_id))) continue
        while (sent.length && sent[0]! <= now() - 3_600_000) sent.shift()
        if (sent.length >= cap) break
        try {
          await o.api.sendMessage(o.owner, cardText(r), { reply_markup: { inline_keyboard: cardButtons(r) } })
          sent.push(now())
          setStatus.run('pinged', null, r.id)
        } catch (e) {
          log(`deliver: ${e instanceof Error ? e.message : e}`)
        }
      }
    } finally {
      running = false
    }
  }

  /** A button tap; returns the label to show. */
  function tap(action: Action, id: number): string {
    const r = o.db.query('SELECT source, from_id, from_name FROM items WHERE id = ?').get(id) as Pick<Row, 'source' | 'from_id' | 'from_name'> | null
    if (!r) return 'Item no longer stored.'
    switch (action) {
      case 'done':
        setStatus.run('done', null, id)
        o.db.query('UPDATE loops SET closed_at = ? WHERE item_id = ? AND closed_at IS NULL').run(now(), id)
        return '✅ Done'
      case 'snz1': case 'snzn': case 'snzt': {
        const until = snoozeUntil(action, now())
        setStatus.run('snoozed', until, id)
        const d = new Date(until)
        return `💤 Snoozed until ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      }
      case 'mute':
        if (r.from_id) o.mute(r.source, r.from_id)
        setStatus.run('done', null, id)
        return `🔕 Muted ${r.from_name ?? r.from_id ?? 'sender'}`
      case 'draft':
        return 'Drafting replies is not available yet.'
    }
  }

  return {
    tick,
    tap,
    start() { timer ??= setInterval(() => void tick(), o.intervalMs ?? 30_000) },
    stop() { if (timer) clearInterval(timer); timer = undefined },
  }
}

/** Registers the `inb:<action>:<id>` buttons, owner only. */
export function registerInboxButtons(bot: Bot, deliver: Pick<ReturnType<typeof createDeliver>, 'tap'>): void {
  bot.callbackQuery(/^inb:(done|snz1|snzn|snzt|mute|draft):(\d+)$/, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    const action = ctx.match![1] as Action
    const label = deliver.tap(action, Number(ctx.match![2]))
    await answer(ctx, label)
    if (action !== 'draft') await appendLabel(ctx, label)
  })
}
