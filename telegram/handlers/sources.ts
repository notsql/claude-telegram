/**
 * ⚙️ Settings → 📡 Sources (013 T1309, 008 FR15): owner-only fallback to the
 * source_* tools. Source titles are untrusted, so no parse_mode.
 */

import type { Bot } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { loadSources, loadTarget, saveSources, saveTarget, setEnabled, type Source } from '../../watch/registry.ts'
import { BUILTINS, propose } from '../../watch/onboard.ts'
import { withClose } from '../close.ts'
import { answer, isOwner, keyOf, ownerOnly } from './ui.ts'

const ago = (t: number, now: number) => {
  const m = Math.round((now - t) / 60_000)
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

export const SOURCES_CALLBACK = /^src:(m|s|a|here|pause|resume|add)(?::([a-z0-9][a-z0-9_-]*))?$/

type View = { text: string; keyboard: { inline_keyboard: InlineKeyboardButton[][] } }
const icon = (s: Source) => (!s.enabled ? '⏸' : s.status === 'error' ? '⚠️' : '✅')
const back = (data: string): InlineKeyboardButton[] => [{ text: '« Back', callback_data: data }]

/**
 * The 📡 Sources settings page: one button per source, ➕ Add source, and
 * 📍 Send updates here unless `here` (this chat's key) is already the target.
 */
export function sourcesView(stateDir: string, here: string): View {
  const sources = loadSources(stateDir)
  const target = loadTarget(stateDir)
  const where = !target ? 'your DM' : target.key === here ? 'this chat' : target.title
  return {
    text: `📡 Sources\n\n${sources.length ? 'Tap a source to see it or pause it.' : 'None yet.'}\n\nWhat needs you is summarised and sent to ${where}.`,
    keyboard: { inline_keyboard: [
      ...sources.map(s => [{ text: `${icon(s)} ${s.title}`, callback_data: `src:s:${s.id}` }]),
      [{ text: '➕ Add source', callback_data: 'src:a' }],
      ...(target?.key === here ? [] : [[{ text: '📍 Send updates here', callback_data: 'src:here' }]]),
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
  live: { start: (s: Source) => unknown; stop: (id: string) => void }
  /** Resolves a CLI to its absolute path (`findBin`); injectable for tests. */
  which: (bin: string) => string | null
}) {
  bot.callbackQuery(SOURCES_CALLBACK, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    const [, action, id] = ctx.match as unknown as [string, 'm' | 's' | 'a' | 'here' | 'pause' | 'resume' | 'add', string?]
    const msg = ctx.callbackQuery.message
    if (!msg) return answer(ctx)
    const here = keyOf(msg)
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
        return void await show(sourcesView(o.stateDir, here))
      }
      if (action === 'here') {
        saveTarget(o.stateDir, { key: here, title: msg.chat.type === 'private' ? 'your DM' : (msg.chat.title ?? 'a group') })
        void answer(ctx, '📍 Updates will come here')
        return void await show(sourcesView(o.stateDir, here))
      }
    } catch (e) {
      return answer(ctx, e instanceof Error ? e.message : String(e))
    }
    const v = action === 's' ? sourceView(o.stateDir, id!) : action === 'a' ? addView(o.stateDir) : sourcesView(o.stateDir, here)
    if (!v) return answer(ctx, 'That source is gone.')
    void answer(ctx)
    await show(v)
  })
}
