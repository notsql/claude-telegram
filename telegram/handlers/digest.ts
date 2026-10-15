/**
 * ⚙️ Settings → 📡 Sources → 🗞 Digest (013 FR16): when the digest comes and
 * what is in it. The same When → What pages are the one-time 🗞 Set up your
 * digest message, sent to the 📍 Updates chat (008 FR23) when the first source
 * is added. Owner only; source titles are untrusted, so no parse_mode.
 */

import type { Bot, Context } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { DEFAULT_PREFS, loadDigestPrefs, MAX_TIMES, prefsOf, saveDigestPrefs, whenText, type DigestPrefs } from '../../watch/digestPrefs.ts'
import { loadSources } from '../../watch/registry.ts'
import { withClose } from '../close.ts'
import { answer, createReplyPrompts, isOwner, keyOf, ownerOnly, sendTo } from './ui.ts'

export const DIGEST_CALLBACK = /^dg:(m|f|p|d|t|x|h|a|c|w|s|n)(?::([a-z0-9][a-z0-9_-]*))?$/

type View = { text: string; keyboard: { inline_keyboard: InlineKeyboardButton[][] } }
type Action = 'm' | 'f' | 'p' | 'd' | 't' | 'x' | 'h' | 'a' | 'c' | 'w' | 's' | 'n'

const PRESETS = [
  { id: 'both', text: '☀️🌙 Morning and evening', times: ['08:30', '18:30'] },
  { id: 'am', text: '☀️ Morning only', times: ['08:30'] },
  { id: 'pm', text: '🌙 Evening only', times: ['18:30'] },
  { id: 'off', text: '🔕 No digest', times: [] },
]
const SECTIONS = [
  { id: 'waiting', text: '📬 Waiting on you' },
  { id: 'fyi', text: '📰 FYI updates' },
  { id: 'promised', text: '🤝 Things I promised' },
] as const
type Section = (typeof SECTIONS)[number]['id']

const back = (data: string): InlineKeyboardButton[] => [{ text: '« Back', callback_data: data }]
const tick = (on: boolean, text: string) => `${on ? '✅' : '⬜'} ${text}`
const hhmm = (t: string) => t.replace(':', '')

export const SETUP_INTRO = '🗞 Set up your digest\n\nA few times a day I can send a roundup of what needs you from your sources. Step 1 of 2: when should it come?'

/** Step 1: how often. */
export function whenView(p: DigestPrefs, intro = '🗞 Digest · When'): View {
  const same = (ts: string[]) => ts.join() === p.times.join()
  const custom = !PRESETS.some(x => same(x.times))
  return {
    text: `${intro}\n\nNow: ${whenText(p)}`,
    keyboard: { inline_keyboard: [
      ...PRESETS.map(x => [{ text: `${same(x.times) ? '● ' : ''}${x.text}`, callback_data: `dg:p:${x.id}` }]),
      [{ text: `${custom ? '● ' : ''}🕐 Custom times…`, callback_data: 'dg:t' }],
      [{ text: `${p.weekdays ? '' : '● '}📅 Every day`, callback_data: 'dg:d:all' }, { text: `${p.weekdays ? '● ' : ''}💼 Weekdays only`, callback_data: 'dg:d:wk' }],
      [{ text: 'Next: what to include »', callback_data: 'dg:c' }],
    ] },
  }
}

/** 🕐 Custom times: tap one to remove it, + Add a time for the hour grid. */
export function timesView(p: DigestPrefs): View {
  return {
    text: `🕐 Digest times\n\n${p.times.length ? 'Tap a time to remove it.' : 'No times: the digest is off.'}`,
    keyboard: { inline_keyboard: [
      ...p.times.map(t => [{ text: `🕐 ${t}  ✕`, callback_data: `dg:x:${hhmm(t)}` }]),
      ...(p.times.length < MAX_TIMES ? [[{ text: '+ Add a time', callback_data: 'dg:h' }]] : []),
      back('dg:f'),
    ] },
  }
}

/** The hour grid, then the quarter hours of the picked hour. */
export function hourView(hour?: string): View {
  if (hour === undefined) {
    const hours = Array.from({ length: 18 }, (_, i) => String(i + 6).padStart(2, '0'))
    const rows: InlineKeyboardButton[][] = []
    for (let i = 0; i < hours.length; i += 6) rows.push(hours.slice(i, i + 6).map(h => ({ text: h, callback_data: `dg:h:${h}` })))
    return { text: '🕐 Add a time\n\nPick the hour.', keyboard: { inline_keyboard: [...rows, back('dg:t')] } }
  }
  return {
    text: `🕐 Add a time\n\nPick the minutes past ${hour}:00.`,
    keyboard: { inline_keyboard: [
      ['00', '15', '30', '45'].map(m => ({ text: `${hour}:${m}`, callback_data: `dg:a:${hour}${m}` })),
      back('dg:h'),
    ] },
  }
}

/** Step 2: what to include. */
export function whatView(stateDir: string, p: DigestPrefs): View {
  const sources = loadSources(stateDir)
  return {
    text: `🗞 Digest · What to include\n\nTap to switch on or off.${sources.length ? ' Sources below are where items come from.' : ''}${p.note ? `\n\nYour note: ${p.note}` : ''}`,
    keyboard: { inline_keyboard: [
      ...SECTIONS.map(x => [{ text: tick(p[x.id], x.text), callback_data: `dg:w:${x.id}` }]),
      ...sources.map(s => [{ text: tick(!p.skip.includes(s.id), `📡 ${s.title}`), callback_data: `dg:s:${s.id}` }]),
      [{ text: `✏️ ${p.note ? 'Change note' : 'Add a note'}…`, callback_data: 'dg:n' }],
      [{ text: '✓ Done', callback_data: 'dg:m' }],
    ] },
  }
}

/** The 🗞 Digest page: current choices. */
export function digestView(stateDir: string, p: DigestPrefs): View {
  const sources = loadSources(stateDir)
  const on = SECTIONS.filter(x => p[x.id]).map(x => x.text)
  const skipped = sources.filter(s => p.skip.includes(s.id)).map(s => s.title)
  return {
    text: [
      '🗞 Digest', '',
      `When: ${whenText(p)}`,
      `Includes: ${on.length ? on.join(', ') : 'nothing'}`,
      `Sources: ${skipped.length ? `all but ${skipped.join(', ')}` : 'all'}`,
      ...(p.note ? [`Note: ${p.note}`] : []),
    ].join('\n'),
    keyboard: { inline_keyboard: [
      [{ text: '🕐 Change when', callback_data: 'dg:f' }],
      [{ text: '📋 Change what', callback_data: 'dg:c' }],
      back('src:m'),
    ] },
  }
}

export function registerDigest(bot: Bot, o: {
  stateDir: string
  /** Where automatic messages go (the 📍 Updates chat), or undefined with no owner. */
  to: () => string | undefined
  /** Rebuilds the digest crons after a change of times. */
  reload: () => void
}) {
  const notes = createReplyPrompts<true>(bot.api)
  const save = (fn: (p: DigestPrefs) => DigestPrefs) => saveDigestPrefs(o.stateDir, fn(prefsOf(o.stateDir)))
  const saveTimes = (fn: (p: DigestPrefs) => DigestPrefs) => { const p = save(fn); o.reload(); return p }

  bot.callbackQuery(DIGEST_CALLBACK, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    const [, action, arg] = ctx.match as unknown as [string, Action, string?]
    const msg = ctx.callbackQuery.message
    if (!msg) return answer(ctx)
    const show = (v: View) => ctx.editMessageText(v.text, { reply_markup: withClose(v.keyboard) }).catch(() => {})
    let p = prefsOf(o.stateDir)
    let v: View
    try {
      switch (action) {
        case 'p': {
          const preset = PRESETS.find(x => x.id === arg)
          if (!preset) return answer(ctx)
          p = saveTimes(q => ({ ...q, times: preset.times }))
          v = whenView(p)
          break
        }
        case 'd':
          p = saveTimes(q => ({ ...q, weekdays: arg === 'wk' }))
          v = whenView(p)
          break
        case 'x':
          p = saveTimes(q => ({ ...q, times: q.times.filter(t => hhmm(t) !== arg) }))
          v = timesView(p)
          break
        case 'a': {
          if (!arg || !/^\d{4}$/.test(arg)) return answer(ctx)
          const t = `${arg.slice(0, 2)}:${arg.slice(2)}`
          if (p.times.length >= MAX_TIMES && !p.times.includes(t)) return answer(ctx, `At most ${MAX_TIMES} times.`)
          p = saveTimes(q => ({ ...q, times: [...q.times, t] }))
          v = timesView(p)
          break
        }
        case 'w': {
          const id = SECTIONS.find(x => x.id === arg)?.id as Section | undefined
          if (!id) return answer(ctx)
          p = save(q => ({ ...q, [id]: !q[id] }))
          v = whatView(o.stateDir, p)
          break
        }
        case 's':
          p = save(q => ({ ...q, skip: q.skip.includes(arg!) ? q.skip.filter(x => x !== arg) : [...q.skip, arg!] }))
          v = whatView(o.stateDir, p)
          break
        case 'n': {
          void answer(ctx)
          return void await notes.ask(keyOf(msg), '✏️ Reply with a note for your digest, e.g. "skip anything about crypto" or "always include school emails". Reply - to clear it.', 'What should the digest do?', true)
        }
        case 'f': v = whenView(p); break
        case 't': v = timesView(p); break
        case 'h': v = hourView(arg); break
        case 'c': v = whatView(o.stateDir, p); break
        default: v = digestView(o.stateDir, p)
      }
    } catch (e) {
      return answer(ctx, e instanceof Error ? e.message : String(e))
    }
    void answer(ctx)
    await show(v)
  })

  /** The owner's reply to ✏️ Add a note; true if it was one. */
  async function noteReply(ctx: Context): Promise<boolean> {
    if (!notes.peek(ctx) || !isOwner(ctx)) return false
    notes.done(ctx)
    const text = ctx.message?.text?.trim() ?? ''
    const p = save(q => ({ ...q, note: text === '-' ? '' : text.slice(0, 500) }))
    const v = whatView(o.stateDir, p)
    await ctx.reply(v.text, { reply_markup: withClose(v.keyboard) })
    return true
  }

  /** Sends 🗞 Set up your digest to the 📍 Updates chat once: only while no prefs are saved, and saving the defaults. */
  async function offer(): Promise<void> {
    const to = o.to()
    if (!to || loadDigestPrefs(o.stateDir)) return
    saveDigestPrefs(o.stateDir, DEFAULT_PREFS)
    const v = whenView(DEFAULT_PREFS, SETUP_INTRO)
    await sendTo(bot.api, to, v.text, { reply_markup: withClose(v.keyboard) })
  }

  return { noteReply, offer }
}
