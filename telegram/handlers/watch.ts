/**
 * ⚙️ Settings → 📡 Sources and /inbox (013 T1309, 008 FR2, FR15): owner-DM-only
 * fallbacks to the source_* and inbox_* tools. Item text is untrusted, so no
 * parse_mode. Done / Snooze on /inbox reuse deliver's `inb:` buttons.
 */

import type { Database } from 'bun:sqlite'
import type { Bot, Context } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import type { Command } from '../../commands/registry.ts'
import { loadSources, saveSources, setEnabled, type Source } from '../../watch/registry.ts'
import { BUILTINS, propose } from '../../watch/onboard.ts'
import { withClose } from '../close.ts'
import { answer, isOwner, ownerOnly } from './ui.ts'

const MAX_ITEMS = 10
const MAX_TEXT = 200
const ago = (t: number, now: number) => {
  const m = Math.round((now - t) / 60_000)
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s)

export const SOURCES_CALLBACK = /^src:(m|pause|resume|add)(?::([a-z0-9][a-z0-9_-]*))?$/

/** The 📡 Sources settings page: each source with Pause/Resume, then ➕ for built-ins not added yet. */
export function sourcesView(stateDir: string, now = Date.now()): { text: string; keyboard: { inline_keyboard: InlineKeyboardButton[][] } } {
  const sources: Source[] = loadSources(stateDir)
  const lines = sources.map(s => {
    const icon = !s.enabled ? '⏸' : s.status === 'error' ? '⚠️' : '✅'
    const last = s.lastItemAt ? `last item ${ago(s.lastItemAt, now)}` : 'no items yet'
    return `${icon} ${s.title} (${s.id}, ${s.kind}): ${last}${s.errors ? `, ${s.errors} error${s.errors === 1 ? '' : 's'}` : ''}`
  })
  const missing = Object.values(BUILTINS).filter(b => !sources.some(s => s.id === b.id))
  const keyboard = {
    inline_keyboard: [
      ...sources.map(s => [s.enabled
        ? { text: `⏸ Pause ${s.title}`, callback_data: `src:pause:${s.id}` }
        : { text: `▶️ Resume ${s.title}`, callback_data: `src:resume:${s.id}` }]),
      ...missing.map(b => [{ text: `➕ ${b.title}`, callback_data: `src:add:${b.id}` }]),
      [{ text: '« Back', callback_data: 'pol:m' }],
    ],
  }
  const body = sources.length ? lines.join('\n') : 'None yet.'
  return { text: `📡 Sources\n\n${body}\n\nWatched for pings and digests. Ask me to add any other source.`, keyboard }
}

type Entry = { id: number; source: string; from_name: string | null; text: string; label: string | null; summary: string | null }

/** Un-done urgent/action items and items with an open loop, newest first. */
export function inboxEntries(db: Database): Entry[] {
  return db.query(
    `SELECT i.id, i.source, i.from_name, i.text, i.label, l.summary FROM items i
       LEFT JOIN loops l ON l.item_id = i.id AND l.closed_at IS NULL
     WHERE i.status != 'done' AND (i.label IN ('urgent', 'action') OR l.id IS NOT NULL)
     GROUP BY i.id ORDER BY i.ts DESC LIMIT ?`,
  ).all(MAX_ITEMS) as Entry[]
}

export const entryText = (e: Entry) => {
  const icon = e.label === 'urgent' ? '🔴' : e.label === 'action' ? '🟠' : '🔁'
  return `${icon} ${e.source} · ${e.from_name ?? 'unknown'}${e.summary ? `\nLoop: ${clip(e.summary)}` : ''}\n\n${clip(e.text)}`
}

const entryButtons = (id: number): InlineKeyboardButton[][] => [[
  { text: 'Snooze 1h', callback_data: `inb:snz1:${id}` },
  { text: 'Tomorrow', callback_data: `inb:snzt:${id}` },
  { text: 'Done', callback_data: `inb:done:${id}` },
]]

const ownerDm = (ctx: Context) => isOwner(ctx) && ctx.chat?.type === 'private'

export function registerWatchCommands(bot: Bot, o: {
  stateDir: string
  db: Database
  live: { start: (s: Source) => unknown; stop: (id: string) => void }
  /** Resolves a CLI to its absolute path (`Bun.which`); injectable for tests. */
  which: (bin: string) => string | null
}) {
  bot.callbackQuery(SOURCES_CALLBACK, async ctx => {
    if (!ownerDm(ctx)) return ownerOnly(ctx)
    const [, action, id] = ctx.match as unknown as [string, 'm' | 'pause' | 'resume' | 'add', string?]
    let note = ''
    try {
      if (action === 'pause' || action === 'resume') {
        const s = setEnabled(o.stateDir, id!, action === 'resume')
        if (s.enabled) o.live.start(s)
        else o.live.stop(s.id)
        note = action === 'resume' ? `▶️ Resumed ${s.title}` : `⏸ Paused ${s.title}`
      }
      if (action === 'add') {
        const b = BUILTINS[id!]
        const r = b && propose({ builtin: id }, o.which)
        if (!b || !r) return answer(ctx, 'Unknown source.')
        // A missing CLI goes through the agent, which offers to install it (012).
        if ('error' in r) return answer(ctx, `${b.title} needs a tool that isn't installed. Ask me to watch ${b.title} and I'll offer to install it.`)
        const sources = loadSources(o.stateDir)
        if (!sources.some(s => s.id === r.source.id)) {
          saveSources(o.stateDir, [...sources, r.source])
          o.live.start(r.source)
        }
        note = `➕ Added ${b.title}`
      }
    } catch (e) {
      return answer(ctx, e instanceof Error ? e.message : String(e))
    }
    void answer(ctx, note || undefined)
    const v = sourcesView(o.stateDir)
    await ctx.editMessageText(v.text, { reply_markup: withClose(v.keyboard) }).catch(() => {})
  })

  const inbox: Command = { name: 'inbox', description: 'Urgent and action items, open loops', menu: ['private'], handler: async ctx => {
    if (!ownerDm(ctx)) return
    const entries = inboxEntries(o.db)
    if (!entries.length) return ctx.reply('Inbox clear: nothing urgent, no open loops.')
    await ctx.reply(`Inbox: ${entries.length}${entries.length === MAX_ITEMS ? '+' : ''} open`)
    for (const e of entries.reverse()) await ctx.reply(entryText(e), { reply_markup: { inline_keyboard: entryButtons(e.id) } })
  } }

  return { inbox }
}
