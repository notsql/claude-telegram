/**
 * ⚙️ Settings → 📡 Sources (013 T1309, 008 FR15): owner-only fallback to the
 * source_* tools. Source titles are untrusted, so no parse_mode.
 */

import type { Database } from 'bun:sqlite'
import type { Bot } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { loadSources, loadTarget, saveSources, saveTarget, setEnabled, type Source } from '../../watch/registry.ts'
import { BUILTINS, propose } from '../../watch/onboard.ts'
import { addExample, loadExamples } from '../../watch/prefs.ts'
import { withClose } from '../close.ts'
import { answer, isOwner, keyOf, ownerOnly } from './ui.ts'

const ago = (t: number, now: number) => {
  const m = Math.round((now - t) / 60_000)
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

export const SOURCES_CALLBACK = /^src:(m|s|a|t|here|pause|resume|add)(?::([a-z0-9][a-z0-9_-]*))?$/

type View = { text: string; keyboard: { inline_keyboard: InlineKeyboardButton[][] } }
const icon = (s: Source) => (!s.enabled ? '⏸' : s.status === 'error' ? '⚠️' : '✅')
const back = (data: string): InlineKeyboardButton[] => [{ text: '« Back', callback_data: data }]

/**
 * The 📡 Sources settings page: one button per source, ➕ Add source, and
 * 📍 Send updates here unless `here` (this chat's key) is already the target.
 * 🎯 Tune shows real messages, so it is offered in a DM only.
 */
export function sourcesView(stateDir: string, here: string, dm = false): View {
  const sources = loadSources(stateDir)
  const target = loadTarget(stateDir)
  const where = !target ? 'your DM' : target.key === here ? 'this chat' : target.title
  return {
    text: `📡 Sources\n\n${sources.length ? 'Tap a source to see it or pause it.' : 'None yet.'}\n\nWhat needs you is summarised and sent to ${where}.`,
    keyboard: { inline_keyboard: [
      ...sources.map(s => [{ text: `${icon(s)} ${s.title}`, callback_data: `src:s:${s.id}` }]),
      [{ text: '➕ Add source', callback_data: 'src:a' }],
      ...(target?.key === here ? [] : [[{ text: '📍 Send updates here', callback_data: 'src:here' }]]),
      ...(dm ? [[{ text: `🎯 Tune what gets flagged (${loadExamples(stateDir).length})`, callback_data: 'src:t' }]] : []),
      back('pol:m'),
    ] },
  }
}

/** One source: status, last item and errors, with Pause or Resume. */
export function sourceView(stateDir: string, id: string, now = Date.now()): View | undefined {
  const s = loadSources(stateDir).find(x => x.id === id)
  if (!s) return
  const status = !s.enabled ? 'Paused' : s.status === 'error' ? 'Failing' : 'Watching'
  const last = s.lastItemAt ? `Last item ${ago(s.lastItemAt, now)}` : 'No items yet'
  return {
    text: [`${icon(s)} ${s.title}`, '', `${status} (${s.kind})`, last, ...(s.errors ? [`${s.errors} error${s.errors === 1 ? '' : 's'}`] : [])].join('\n'),
    keyboard: { inline_keyboard: [
      [s.enabled
        ? { text: '⏸ Pause', callback_data: `src:pause:${s.id}` }
        : { text: '▶️ Resume', callback_data: `src:resume:${s.id}` }],
      back('src:m'),
    ] },
  }
}

type Candidate = { id: number; source: string; from_name: string | null; chat_name: string | null; is_group: number; text: string }

/** The next message to rate: flagged ones first, then the newest; never one already rated or skipped. */
export function nextCandidate(db: Database, exclude: number[]): Candidate | undefined {
  return db.query(
    `SELECT id, source, from_name, chat_name, is_group, text FROM items
     WHERE from_me = 0 AND length(text) >= 15 AND label IS NOT 'noise'
       AND id NOT IN (SELECT value FROM json_each(?))
     ORDER BY label IN ('urgent', 'action') DESC, ts DESC LIMIT 1`,
  ).get(JSON.stringify(exclude)) as Candidate | undefined
}

/** 🎯 Tune: one real message at a time, asking whether it deserves a reminder. */
export function tuneView(stateDir: string, c: Candidate | undefined): View {
  const n = loadExamples(stateDir).length
  if (!c) return { text: `🎯 Tune what gets flagged\n\nNothing new to rate. ${n} answer${n === 1 ? '' : 's'} saved.`, keyboard: { inline_keyboard: [back('src:m')] } }
  const where = c.is_group && c.chat_name ? ` in ${c.chat_name}` : ''
  const body = c.text.length > 400 ? `${c.text.slice(0, 400)}…` : c.text
  return {
    text: `🎯 Tune what gets flagged\n\nWould you want a reminder about this?\n\n${c.from_name ?? 'unknown'}${where} · ${c.source}\n${body}\n\n${n} answer${n === 1 ? '' : 's'} so far.`,
    keyboard: { inline_keyboard: [
      [{ text: '✅ Yes, remind me', callback_data: `src:t:y-${c.id}` }, { text: '🔕 No', callback_data: `src:t:n-${c.id}` }],
      [{ text: '⏭ Skip', callback_data: `src:t:s-${c.id}` }],
      back('src:m'),
    ] },
  }
}

/** ➕ Add source: the built-ins not added yet. */
export function addView(stateDir: string): View {
  const sources = loadSources(stateDir)
  const missing = Object.values(BUILTINS).filter(b => !sources.some(s => s.id === b.id))
  return {
    text: `➕ Add source\n\n${missing.length ? 'Pick one to watch.' : 'Every built-in source is added.'} Ask me to watch anything else.`,
    keyboard: { inline_keyboard: [
      ...missing.map(b => [{ text: b.title, callback_data: `src:add:${b.id}` }]),
      back('src:m'),
    ] },
  }
}

export function registerSources(bot: Bot, o: {
  stateDir: string
  db: Database
  live: { start: (s: Source) => unknown; stop: (id: string) => void }
  /** Resolves a CLI to its absolute path (`findBin`); injectable for tests. */
  which: (bin: string) => string | null
}) {
  // Skipped messages, until restart.
  const skipped = new Set<number>()
  bot.callbackQuery(SOURCES_CALLBACK, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    const [, action, id] = ctx.match as unknown as [string, 'm' | 's' | 'a' | 't' | 'here' | 'pause' | 'resume' | 'add', string?]
    const msg = ctx.callbackQuery.message
    if (!msg) return answer(ctx)
    const here = keyOf(msg)
    const dm = msg.chat.type === 'private'
    const show = (v: View) => ctx.editMessageText(v.text, { reply_markup: withClose(v.keyboard) }).catch(() => {})
    try {
      if (action === 'pause' || action === 'resume') {
        const s = setEnabled(o.stateDir, id!, action === 'resume')
        if (s.enabled) o.live.start(s)
        else o.live.stop(s.id)
        void answer(ctx, action === 'resume' ? `▶️ Resumed ${s.title}` : `⏸ Paused ${s.title}`)
        return void await show(sourceView(o.stateDir, s.id)!)
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
        void answer(ctx, `➕ Added ${b.title}`)
        return void await show(sourcesView(o.stateDir, here, dm))
      }
      if (action === 't') {
        if (!dm) return answer(ctx, 'Tuning shows your messages, so it only works in a DM.')
        const m = id && /^([yns])-(\d+)$/.exec(id)
        if (m) {
          const item = o.db.query('SELECT text FROM items WHERE id = ?').get(Number(m[2])) as { text: string } | null
          if (m[1] === 's') skipped.add(Number(m[2]))
          else if (item) addExample(o.stateDir, { itemId: Number(m[2]), text: item.text, want: m[1] === 'y', at: Date.now() })
        }
        void answer(ctx)
        return void await show(tuneView(o.stateDir, nextCandidate(o.db, [...loadExamples(o.stateDir).map(e => e.itemId), ...skipped])))
      }
      if (action === 'here') {
        saveTarget(o.stateDir, { key: here, title: msg.chat.type === 'private' ? 'your DM' : (msg.chat.title ?? 'a group') })
        void answer(ctx, '📍 Updates will come here')
        return void await show(sourcesView(o.stateDir, here, dm))
      }
    } catch (e) {
      return answer(ctx, e instanceof Error ? e.message : String(e))
    }
    const v = action === 's' ? sourceView(o.stateDir, id!) : action === 'a' ? addView(o.stateDir) : sourcesView(o.stateDir, here, dm)
    if (!v) return answer(ctx, 'That source is gone.')
    void answer(ctx)
    await show(v)
  })
}
