/**
 * ⚙️ Settings → 📡 Sources (013 T1309, 008 FR15): owner-only fallback to the
 * source_* tools. Source titles are untrusted, so no parse_mode.
 */

import type { Bot } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { loadSources, saveSources, setEnabled, type Source } from '../../watch/registry.ts'
import { BUILTINS, propose } from '../../watch/onboard.ts'
import { withClose } from '../close.ts'
import { answer, isOwner, ownerOnly } from './ui.ts'

const ago = (t: number, now: number) => {
  const m = Math.round((now - t) / 60_000)
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

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

export function registerSources(bot: Bot, o: {
  stateDir: string
  live: { start: (s: Source) => unknown; stop: (id: string) => void }
  /** Resolves a CLI to its absolute path (`Bun.which`); injectable for tests. */
  which: (bin: string) => string | null
}) {
  bot.callbackQuery(SOURCES_CALLBACK, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
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
}
