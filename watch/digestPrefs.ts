/**
 * Digest settings (013 FR16): when the digest comes and what is in it, kept
 * in `STATE_DIR/digest-prefs.json`. A missing file means the owner hasn't been
 * offered the setup yet; the digest then runs with `DEFAULT_PREFS`. The crons
 * are rebuilt from the file on every change, so new times apply without a restart.
 */

import { Cron } from 'croner'
import { join } from 'path'
import { z } from 'zod'
import { readJson, writeJson } from '../util/files.ts'

export const MAX_TIMES = 4

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'times are HH:MM, 24-hour')

export const DigestPrefsSchema = z.object({
  times: z.array(Time).max(MAX_TIMES),
  weekdays: z.boolean(),
  /** 📬 `urgent`/`action` items and awaiting-me loops. */
  waiting: z.boolean(),
  /** 📰 `fyi` items. */
  fyi: z.boolean(),
  /** 🤝 i_promised loops. */
  promised: z.boolean(),
  /** Source ids left out; new sources are in by default. */
  skip: z.array(z.string()),
  /** The owner's own instructions for the summarizer. */
  note: z.string().max(500),
})

export type DigestPrefs = z.infer<typeof DigestPrefsSchema>

export const DEFAULT_PREFS: DigestPrefs = { times: ['08:30', '18:30'], weekdays: false, waiting: true, fyi: true, promised: true, skip: [], note: '' }

const path = (stateDir: string) => join(stateDir, 'digest-prefs.json')

/** The saved prefs, or undefined if never saved (or unreadable). */
export function loadDigestPrefs(stateDir: string): DigestPrefs | undefined {
  const r = DigestPrefsSchema.safeParse(readJson(path(stateDir)))
  return r.success ? r.data : undefined
}

/** Times are kept sorted and unique. Throws on invalid prefs. */
export function saveDigestPrefs(stateDir: string, p: DigestPrefs): DigestPrefs {
  const clean = DigestPrefsSchema.parse({ ...p, times: [...new Set(p.times)].sort() })
  writeJson(path(stateDir), clean)
  return clean
}

export const prefsOf = (stateDir: string) => loadDigestPrefs(stateDir) ?? DEFAULT_PREFS

/** One cron expression per time. */
export const cronsOf = (p: DigestPrefs) => p.times.map(t => `${Number(t.slice(3))} ${Number(t.slice(0, 2))} * * ${p.weekdays ? '1-5' : '*'}`)

/** Morning before 12:00, Afternoon before 17:00, else Evening. */
export const digestTitle = (hour: number) => `${hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening'} digest`

/** "08:30 and 18:30, every day", or "Off". */
export function whenText(p: DigestPrefs): string {
  if (!p.times.length) return 'Off'
  const ts = p.times.length === 1 ? p.times[0] : `${p.times.slice(0, -1).join(', ')} and ${p.times.at(-1)}`
  return `${ts}, ${p.weekdays ? 'weekdays only' : 'every day'}`
}

export function startDigestCrons(o: { tz: string; prefs: () => DigestPrefs; run: () => unknown }) {
  let crons: Cron[] = []
  const stop = () => { for (const c of crons) c.stop(); crons = [] }
  const reload = () => {
    stop()
    crons = cronsOf(o.prefs()).map(e => new Cron(e, { timezone: o.tz, protect: true }, () => void o.run()))
  }
  reload()
  return {
    reload,
    stop,
    nextRun: () => crons.map(c => c.nextRun()).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
  }
}
