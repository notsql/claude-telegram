/**
 * `/cron` inline manager (008 US4, 007 US5): this chat's jobs, one button row
 * each with ⏸ / ▶ / 🗑 / ▶️ Run now. A thin view over 007's functions.
 * + New job (008 FR18) picks how often (`crn:w:<spec>`), then the day and
 * hour, then asks for what to do by reply. The spec builds up as
 * `<freq>[.<day>][@<hour>]`, e.g. `weekly.1@09`.
 */

import type { InlineKeyboardButton } from 'grammy/types'
import { describeJob } from '../scheduler/describe.ts'
import { jobTitle } from '../scheduler/run.ts'
import type { Job } from '../scheduler/store.ts'

export type CronAction = 'pause' | 'resume' | 'del' | 'run'
export const CRON_CALLBACK = /^crn:(pause|resume|del|run):(j_[0-9a-f]+)$/
export const CRON_NEW_CALLBACK = /^crn:(list|w):((?:once|daily|wkdy|weekly|hourly)?(?:\.[0-6])?(?:@\d{2})?)$/

const NEW_JOB = { text: '+ New job', callback_data: 'crn:w:' }
const BACK = { text: '« Back', callback_data: 'crn:list:' }

export function cronView(jobs: Job[], now = new Date()) {
  if (!jobs.length) return { text: 'No scheduled jobs in this chat. Tap + New job, or ask me in plain words.', keyboard: { inline_keyboard: [[NEW_JOB]] } }
  const text = jobs.map(j => `${j.enabled ? '' : '⏸ '}${j.id} "${jobTitle(j)}"${j.lastStatus ? ` (last: ${j.lastStatus})` : ''}\n${describeJob(j, now)}`).join('\n\n')
  const keyboard = { inline_keyboard: [...jobs.map(j => [
    j.enabled
      ? { text: `⏸ ${j.id}`, callback_data: `crn:pause:${j.id}` }
      : { text: `▶ ${j.id}`, callback_data: `crn:resume:${j.id}` },
    { text: '🗑', callback_data: `crn:del:${j.id}` },
    { text: '▶️ Run now', callback_data: `crn:run:${j.id}` },
  ]), [NEW_JOB]] }
  return { text, keyboard }
}

const FREQS = [['once', 'Once'], ['daily', 'Every day'], ['wkdy', 'Weekdays'], ['weekly', 'Every week'], ['hourly', 'Every hour']] as const
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Spec = { freq: string; day?: number; hour?: number }

function parseSpec(spec: string): Spec {
  const m = /^(\w*)(?:\.(\d))?(?:@(\d{2}))?$/.exec(spec)!
  return { freq: m[1]!, ...(m[2] && { day: Number(m[2]) }), ...(m[3] && { hour: Number(m[3]) }) }
}

const rows = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n))

/** The next step of + New job for `spec`, or `ready` once it is a full schedule. */
export function newJobView(spec: string): { text: string; keyboard: { inline_keyboard: InlineKeyboardButton[][] } } | 'ready' {
  const s = parseSpec(spec)
  if (!s.freq) {
    return {
      text: '+ New job. How often should it run?',
      keyboard: { inline_keyboard: [...rows(FREQS.map(([f, t]) => ({ text: t, callback_data: `crn:w:${f}` })), 2), [BACK]] },
    }
  }
  if (s.freq === 'hourly' || s.hour !== undefined) return 'ready'
  if (s.freq === 'weekly' && s.day === undefined) {
    return {
      text: '+ New job, every week. Which day?',
      keyboard: { inline_keyboard: [...rows([1, 2, 3, 4, 5, 6, 0].map(d => ({ text: DAYS[d]!, callback_data: `crn:w:weekly.${d}` })), 4), [{ text: '« Back', callback_data: 'crn:w:' }]] },
    }
  }
  const hours = Array.from({ length: 18 }, (_, i) => i + 6)
  return {
    text: `+ New job, ${label(s)}. At what time?`,
    keyboard: { inline_keyboard: [...rows(hours.map(h => ({ text: `${String(h).padStart(2, '0')}:00`, callback_data: `crn:w:${spec}@${String(h).padStart(2, '0')}` })), 6), [{ text: '« Back', callback_data: 'crn:w:' }]] },
  }
}

function label(s: Spec): string {
  const at = s.hour === undefined ? '' : ` at ${String(s.hour).padStart(2, '0')}:00`
  if (s.freq === 'once') return `once${at}`
  if (s.freq === 'daily') return `every day${at}`
  if (s.freq === 'wkdy') return `every weekday${at}`
  if (s.freq === 'weekly') return `every ${s.day === undefined ? 'week' : DAYS[s.day]}${at}`
  return 'every hour'
}

/** A full spec as `schedule_create`'s `when`: a cron expression, or a local ISO time for `once` (the next time that hour comes round). */
export function whenFor(spec: string, now = new Date()): { when: string; label: string } {
  const s = parseSpec(spec)
  const h = s.hour ?? 0
  const when = {
    hourly: '0 * * * *',
    daily: `0 ${h} * * *`,
    wkdy: `0 ${h} * * 1-5`,
    weekly: `0 ${h} * * ${s.day}`,
  }[s.freq]
  if (when) return { when, label: label(s) }
  const at = new Date(now)
  at.setHours(h, 0, 0, 0)
  if (at <= now) at.setDate(at.getDate() + 1)
  const p = (n: number) => String(n).padStart(2, '0')
  return {
    when: `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(h)}:00:00`,
    label: `once, ${at.getDate() === now.getDate() ? 'today' : 'tomorrow'} at ${p(h)}:00`,
  }
}
