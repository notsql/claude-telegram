/**
 * Plain-words echo of a schedule (007 FR6, plan "Natural-language time"):
 * the cron or ISO form the agent picked, as readable text with its timezone
 * and the next runs, so the user can catch a misreading.
 */

import { Cron } from 'croner'
import { pattern } from './engine.ts'
import type { Job } from './store.ts'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: string) => n.padStart(2, '0')
const isNum = (f: string) => /^\d+$/.test(f)

function days(dow: string): string | null {
  if (dow === '*') return 'Every day'
  if (dow === '1-5') return 'Every weekday'
  if (dow === '0,6' || dow === '6,0') return 'Every weekend day'
  const list = dow.split(',')
  if (list.every(d => /^[0-7]$/.test(d))) return `Every ${list.map(d => DAYS[Number(d) % 7]).join(', ')}`
  return null
}

/** Common five-field patterns in words; anything else is shown as the raw expression. */
export function cronText(expr: string): string {
  const raw = `cron "${expr}"`
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return raw
  const [min, hour, dom, month, dow] = f as [string, string, string, string, string]
  if (!isNum(min) || month !== '*') return raw
  if (hour === '*' && dom === '*' && dow === '*') return `Every hour at :${pad(min)}`
  if (!isNum(hour)) return raw
  const at = `at ${pad(hour)}:${pad(min)}`
  if (dom === '*') {
    const d = days(dow)
    return d ? `${d} ${at}` : raw
  }
  if (isNum(dom) && dow === '*') return `On day ${dom} of every month ${at}`
  return raw
}

/** "Thu 8 Oct 2026, 08:30" in `tz`, built from parts so ICU versions can't change the layout. */
export function formatTime(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`
}

/** The next `n` run times after `from`; empty for a one-off in the past. */
export function nextRuns(job: Job, n = 3, from = new Date()): Date[] {
  return new Cron(pattern(job), { timezone: job.tz, paused: true }).nextRuns(n, from)
}

export function describeJob(job: Job, from = new Date()): string {
  const runs = nextRuns(job, job.kind === 'at' ? 1 : 3, from)
  const what = job.kind === 'cron'
    ? `${cronText(job.expr)} (${job.tz})`
    : `Once, ${runs[0] ? formatTime(runs[0], job.tz) : `at ${job.at} (already past)`} (${job.tz})`
  if (job.kind === 'at' || !runs.length) return what
  return `${what}\nNext runs:\n${runs.map(d => `• ${formatTime(d, job.tz)}`).join('\n')}`
}
