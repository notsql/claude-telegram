/**
 * Source health (013 FR10): a source that failed 5 times in a row, or has
 * been silent past its `expectSilenceMaxSec`, posts one notice to the owner DM
 * with **Fix** (a turn in the owner DM that diagnoses it with the 012 ladder)
 * and **Pause** (paused live). It is not posted again until the source
 * recovers (an item resets its errors and silence) and fails anew.
 */

import type { Bot } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { answer, appendLabel, isOwner, ownerOnly } from '../telegram/handlers/ui.ts'
import { loadSources, type Source } from './registry.ts'

export const ERROR_THRESHOLD = 5
const CHECK_MS = 60_000

export type HealthDeps = {
  stateDir: string
  api: { sendMessage(chatId: string, text: string, extra: { reply_markup: { inline_keyboard: InlineKeyboardButton[][] } }): Promise<unknown> }
  owner: string
  /** Starts the Fix turn in the owner DM. */
  fix: (prompt: string) => void
  /** Pauses the source in sources.json and the supervisor. */
  pause: (id: string) => void
  log: (line: string) => void
  now?: () => number
}

/** Why `s` is unhealthy, or undefined. Silence counts from its last item, or from `since` if it has none. */
export function problem(s: Source, now: number, since: number): string | undefined {
  if (!s.enabled) return undefined
  if (s.errors >= ERROR_THRESHOLD) return `failed ${s.errors} times in a row`
  const max = (s.config as { expectSilenceMaxSec?: number }).expectSilenceMaxSec
  if (max && now - (s.lastItemAt ?? since) > max * 1000) return `silent for over ${Math.round(max / 60)} min`
  return undefined
}

export const fixPrompt = (s: Source, why: string) =>
  `The owner tapped Fix on watched source "${s.id}" (${s.kind}, config ${JSON.stringify(s.config)}), which ${why}. `
  + 'Diagnose why (e.g. run its command with --help or a status/auth check), fix it with the tg-capability-ladder skill '
  + '(re-auth or install what is missing; the owner runs any login), then tell the owner what you found. Use source_resume if it is paused.'

export function createHealth(d: HealthDeps) {
  const now = d.now ?? Date.now
  const since = now()
  /** Sources with a notice out. */
  const notified = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined

  async function check(): Promise<void> {
    let sources: Source[]
    try { sources = loadSources(d.stateDir) } catch { return }
    for (const s of sources) {
      const why = problem(s, now(), since)
      if (!why) { notified.delete(s.id); continue }
      if (notified.has(s.id)) continue
      notified.add(s.id)
      await d.api.sendMessage(d.owner, `⚠️ Source ${s.title} (${s.id}) ${why}.`, {
        reply_markup: { inline_keyboard: [[{ text: '🔧 Fix', callback_data: `wsh:fix:${s.id}` }, { text: '⏸ Pause', callback_data: `wsh:pause:${s.id}` }]] },
      }).catch(err => d.log(`watch ${s.id}: health notice failed: ${err}`))
    }
  }

  /** Owner's Fix or Pause; returns the label to show. */
  function tap(action: 'fix' | 'pause', id: string): string {
    const s = loadSources(d.stateDir).find(x => x.id === id)
    if (!s) return `${id} no longer exists`
    if (action === 'pause') {
      d.pause(id)
      return '⏸ Paused'
    }
    d.fix(fixPrompt(s, problem(s, now(), since) ?? 'was reported unhealthy'))
    return '🔧 Diagnosing…'
  }

  return {
    check,
    tap,
    start() { timer = setInterval(() => void check(), CHECK_MS) },
    stop() { clearInterval(timer) },
  }
}

export type Health = ReturnType<typeof createHealth>

/** `wsh:fix|pause:<sourceId>`, owner only. */
export function registerHealthButtons(bot: Bot, health: Health) {
  bot.callbackQuery(/^wsh:(fix|pause):([a-z0-9][a-z0-9_-]*)$/, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    await answer(ctx)
    await appendLabel(ctx, health.tap(ctx.match![1] as 'fix' | 'pause', ctx.match![2]!))
  })
}
