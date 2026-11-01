/**
 * Repeated tasks (014 T1408). The weekly `pattern-mining` system job hands the
 * owner's own requests from 005 history, and the to-dos they tapped 🤖 Do it
 * on, to the `tg-pattern-miner` one-shot. It proposes a `routine` (a schedule,
 * 007) or a `skill` (006) and cites the requests behind each. The daemon counts
 * the evidence from those ids, never from the model's claim (FR3): at least
 * `MIN_DAYS` different days, over at least `MIN_SPAN_DAYS`, at `MIN_CONFIDENCE`.
 * Nothing is applied without a tap (FR4): cards go to the Updates chat with
 * Yes / No / Not now, No suppresses that pattern for 30 days and Not now for 7.
 * The miner sees no one else's messages (FR8).
 */

import type { Database } from 'bun:sqlite'
import type { Bot } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { Cron } from 'croner'
import { z } from 'zod'
import { cronText } from '../scheduler/describe.ts'
import { answer, appendLabel, isOwner, keyOf, ownerOnly } from '../telegram/handlers/ui.ts'
import { bold, italic, joined, rich, type Rich } from '../telegram/rich.ts'

export const MinerSchema = z.object({
  proposals: z.array(z.object({
    kind: z.enum(['routine', 'skill']),
    subject: z.string(),
    claim: z.string(),
    title: z.string(),
    prompt: z.string(),
    cron: z.string().optional(),
    ids: z.array(z.string()),
    confidence: z.number(),
  })),
})

type Proposal = z.infer<typeof MinerSchema>['proposals'][number]
export type RunMiner = (agent: 'tg-pattern-miner', input: string, schema: typeof MinerSchema) => Promise<z.infer<typeof MinerSchema>>

/** A thing the owner asked for: `h<id>` from history, `d<rowid>` from a Do it tap. */
export type Request = { id: string; ts: number; text: string }

type Evidence = { n: number; days: number }
export type Pattern = Omit<Proposal, 'ids' | 'confidence' | 'subject'> & Evidence & { id: number }

const DAY_MS = 86_400_000
const LOOKBACK_DAYS = 60
const MIN_DAYS = 4
const MIN_SPAN_DAYS = 7
const MIN_CONFIDENCE = 0.7
const MAX_PROPOSALS = 5
const MAX_REQUESTS = 600
const MAX_TEXT = 200
const REJECT_MS = 30 * DAY_MS
const LATER_MS = 7 * DAY_MS

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** FR1: a 🤖 Do it tap on `task`. */
export const recordDoIt = (db: Database, task: string, ts = Date.now()) =>
  void db.query(`INSERT INTO signals (ts, kind, subject) VALUES (?, 'do_it', ?)`).run(ts, task.slice(0, MAX_TEXT))

/** Real Telegram messages from chats only owners can start turns in, newest last. Scheduled and button-started turns carry no message id. */
export function ownerRequests(history: Database, inbox: Database, since: number, ownersOnly: (chat: string) => boolean): Request[] {
  const asked = (history.query(
    `SELECT id, ts, tg_chat, text FROM messages WHERE role = 'user' AND tg_msg IS NOT NULL AND ts >= ? AND text != '(photo)' ORDER BY ts DESC LIMIT ${MAX_REQUESTS}`,
  ).all(since) as { id: number; ts: number; tg_chat: string; text: string }[])
    .filter(m => ownersOnly(m.tg_chat)).map(m => ({ id: `h${m.id}`, ts: m.ts, text: m.text }))
  const tapped = (inbox.query(`SELECT rowid AS id, ts, subject FROM signals WHERE kind = 'do_it' AND ts >= ?`).all(since) as { id: number; ts: number; subject: string }[])
    .map(s => ({ id: `d${s.id}`, ts: s.ts, text: s.subject }))
  return [...asked, ...tapped].sort((a, b) => a.ts - b.ts)
}

export function minerInput(requests: Request[], known: string[], now: number): string {
  const when = (t: number) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  return [
    `It is now ${new Date(now).toString()}. Below is what the owner asked their agent to do, or tapped Do it on, in time order.`,
    ...(known.length ? [`Already scheduled or already a skill, so never propose these:\n${known.map(k => `- ${esc(k)}`).join('\n')}`] : []),
    ...requests.map(r => `<request id="${r.id}" at="${when(r.ts)}">${esc(r.text.slice(0, MAX_TEXT))}</request>`),
  ].join('\n')
}

/** Evidence from the ids that really exist: `n` different days, `days` from first to last. */
export function evidence(ids: string[], requests: Request[]): Evidence {
  const byId = new Map(requests.map(r => [r.id, r.ts]))
  const times = ids.flatMap(id => byId.get(id) ?? [])
  if (!times.length) return { n: 0, days: 0 }
  return { n: new Set(times.map(t => new Date(t).toDateString())).size, days: Math.round((Math.max(...times) - Math.min(...times)) / DAY_MS) }
}

const keyOfProposal = (p: Proposal) => `${p.kind}:${p.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

const validCron = (expr?: string) => {
  try { return !!expr && !!new Cron(expr, { paused: true }).nextRun() } catch { return false }
}

const sound = (p: Proposal, e: Evidence) =>
  e.n >= MIN_DAYS && e.days >= MIN_SPAN_DAYS && p.confidence >= MIN_CONFIDENCE && !!p.prompt.trim() && !!p.claim.trim()
  && (p.kind === 'skill' || validCron(p.cron))

export function cardText(p: Pattern): Rich {
  return joined([
    bold('📈 Repeated task'),
    p.claim,
    rich(`• ${p.n} days in the last ${p.days + 1}\n• `, italic(p.kind === 'routine' ? `Schedule: ${cronText(p.cron!)}` : 'Make it a skill you can reuse')),
  ], '\n')
}

export const cardButtons = (id: number): InlineKeyboardButton[][] => [[
  { text: '✅ Yes', callback_data: `ptn:yes:${id}` },
  { text: 'No', callback_data: `ptn:no:${id}` },
  { text: 'Not now', callback_data: `ptn:later:${id}` },
]]

export type MiningOpts = {
  db: Database
  history: Database
  run: RunMiner
  budget: { take(): boolean }
  ownersOnly: (chat: string) => boolean
  /** Job titles and skill names the owner already has. */
  known: () => string[]
  /** Posts a card to the Updates chat. */
  post: (text: Rich, buttons: InlineKeyboardButton[][]) => Promise<unknown>
  now?: () => number
  log?: (msg: string) => void
}

/** One weekly pass; returns how many cards went out. */
export async function runMining(o: MiningOpts): Promise<number> {
  const now = o.now?.() ?? Date.now()
  const requests = ownerRequests(o.history, o.db, now - LOOKBACK_DAYS * DAY_MS, o.ownersOnly)
  if (new Set(requests.map(r => new Date(r.ts).toDateString())).size < MIN_DAYS) return 0
  if (!o.budget.take()) { o.log?.('patterns: daily turn budget spent, skipped'); return 0 }
  const { proposals } = await o.run('tg-pattern-miner', minerInput(requests, o.known(), now), MinerSchema)
  const blocked = o.db.query(`SELECT 1 FROM patterns WHERE key = ? AND (status IN ('accepted', 'pending') OR until > ?)`)
  const save = o.db.query(
    `INSERT INTO patterns (key, kind, claim, title, prompt, cron, n, days, status, until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
     ON CONFLICT(key) DO UPDATE SET claim = excluded.claim, title = excluded.title, prompt = excluded.prompt, cron = excluded.cron, n = excluded.n, days = excluded.days, status = 'pending', until = NULL
     RETURNING id`,
  )
  let sent = 0
  for (const p of proposals) {
    if (sent >= MAX_PROPOSALS) break
    const e = evidence(p.ids, requests)
    const key = keyOfProposal(p)
    if (!sound(p, e) || blocked.get(key, now)) continue
    const { id } = save.get(key, p.kind, p.claim.trim(), p.title.trim(), p.prompt.trim(), p.cron ?? null, e.n, e.days) as { id: number }
    await o.post(cardText({ ...p, ...e, id }), cardButtons(id))
    sent++
  }
  return sent
}

export type PatternAction = 'yes' | 'no' | 'later'

export type TapOpts = {
  db: Database
  /** Yes on a routine: creates the job in the chat `key`; returns an error, if any. */
  schedule: (p: Pattern, key: string) => string | undefined
  /** Yes on a skill: starts a turn in the chat `key` that authors it. */
  learn: (p: Pattern, key: string) => void
  now?: () => number
}

/** A tap on a card in the chat `key`; returns the label to show. */
export function tapPattern(o: TapOpts, action: PatternAction, id: number, key: string): string {
  const now = o.now?.() ?? Date.now()
  const p = o.db.query(`SELECT * FROM patterns WHERE id = ? AND status = 'pending'`).get(id) as Pattern | null
  if (!p) return 'Already answered.'
  const set = o.db.query('UPDATE patterns SET status = ?, until = ? WHERE id = ?')
  if (action === 'no') { set.run('rejected', now + REJECT_MS, id); return '🙅 Got it, I won\'t suggest this again for a month.' }
  if (action === 'later') { set.run('later', now + LATER_MS, id); return '💤 I\'ll ask again next week.' }
  if (p.kind === 'routine') {
    const err = o.schedule(p, key)
    if (err) return `⚠️ Not scheduled: ${err}`
  } else o.learn(p, key)
  set.run('accepted', null, id)
  return p.kind === 'routine' ? `✅ Scheduled: ${cronText(p.cron!)}` : '✅ Learning it now…'
}

/** Registers the `ptn:<action>:<id>` buttons, owner only. */
export function registerPatternButtons(bot: Bot, o: TapOpts): void {
  bot.callbackQuery(/^ptn:(yes|no|later):(\d+)$/, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    const msg = ctx.callbackQuery.message
    if (!msg) return answer(ctx)
    const label = tapPattern(o, ctx.match![1] as PatternAction, Number(ctx.match![2]), keyOf(msg))
    await answer(ctx, label)
    await appendLabel(ctx, label)
  })
}

/** The turn behind Yes on a skill; `skill_create` applies the chat's `autoLearn` as usual. */
export const learnPrompt = (p: Pattern) =>
  `The owner agreed to turn a repeated task into a skill. Delegate to the tg-skill-author agent to write it, then say what you made.\nTask: ${p.title}\nWhy: ${p.claim}\nHow it goes: ${p.prompt}`
