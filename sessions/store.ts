import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export type PastSession = { sessionId: string; startedAt: number; title: string }

/**
 * One session key's state (FR2). `startedAt` and `title` describe the current
 * session so it can be archived into `history` as-is on `new`/`resume`.
 */
export type SessionEntry = {
  sessionId?: string
  startedAt?: number
  title?: string
  history: PastSession[]
  lastActive: number
}

const TITLE_MAX = 60

function truncateTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > TITLE_MAX ? flat.slice(0, TITLE_MAX - 1) + '…' : flat
}

export function createSessionStore(file: string, now: () => number = Date.now) {
  let data: Record<string, SessionEntry> = load()
  // Bumped by new/resume so a turn that was running across one can't undo it.
  const generations = new Map<string, number>()
  const bump = (key: string) => generations.set(key, (generations.get(key) ?? 0) + 1)

  function load(): Record<string, SessionEntry> {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`)
      } catch {}
      process.stderr.write(`telegram channel: sessions.json is corrupt, moved aside. Starting fresh.\n`)
      return {}
    }
  }

  // Atomic tmp+rename: a crash mid-write leaves the previous file intact.
  function save(): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, file)
  }

  function entry(key: string): SessionEntry {
    return (data[key] ??= { history: [], lastActive: 0 })
  }

  /** Moves the current session (if any) to the front of history. */
  function archive(e: SessionEntry): void {
    if (e.sessionId) {
      e.history.unshift({ sessionId: e.sessionId, startedAt: e.startedAt ?? 0, title: e.title ?? '' })
    }
    delete e.sessionId
    delete e.startedAt
    delete e.title
  }

  return {
    /** The Claude Code session to `--resume` for this key, if any. */
    current(key: string): string | undefined {
      return data[key]?.sessionId
    },

    /**
     * Stores the `session_id` from a turn's `system/init` (FR3). Resume can
     * return a new ID, which replaces the current one without touching history.
     * `firstMessage` titles the session when it is new. With `since` (from
     * `generation` when the turn started), a `new`/`resume` in between wins.
     */
    record(key: string, sessionId: string, firstMessage: string, since?: number): void {
      if (since != null && since !== (generations.get(key) ?? 0)) return
      const e = entry(key)
      if (!e.sessionId) {
        e.startedAt = now()
        e.title = truncateTitle(firstMessage)
      }
      e.sessionId = sessionId
      e.lastActive = now()
      save()
    },

    /** Archives the current session; the next turn starts fresh (FR9 `new`). */
    new(key: string): void {
      bump(key)
      archive(entry(key))
      save()
    },

    /**
     * Makes history item `n` (1-based, as numbered by `list`) current again,
     * archiving the current session in its place (FR9 `resume <n>`).
     */
    resume(key: string, n: number): PastSession {
      const e = entry(key)
      const picked = e.history[n - 1]
      if (!Number.isInteger(n) || !picked) throw new Error(`no session #${n}`)
      bump(key)
      e.history.splice(n - 1, 1)
      archive(e)
      e.sessionId = picked.sessionId
      e.startedAt = picked.startedAt
      e.title = picked.title
      e.lastActive = now()
      save()
      return picked
    },

    /** Pass to `record` as `since`. */
    generation(key: string): number {
      return generations.get(key) ?? 0
    },

    /** Every Claude Code session id this key has used, current first (005 FR6 `chat` scope). */
    sessionIds(key: string): string[] {
      const e = data[key]
      return e ? [...(e.sessionId ? [e.sessionId] : []), ...e.history.map(h => h.sessionId)] : []
    },

    /** The session key a Claude Code session belongs to; undefined for terminal sessions (005 FR2). */
    keyOf(sessionId: string): string | undefined {
      for (const [key, e] of Object.entries(data)) {
        if (e.sessionId === sessionId || e.history.some(h => h.sessionId === sessionId)) return key
      }
    },

    /** The current session's title, from its first message. */
    title(key: string): string | undefined {
      return data[key]?.sessionId ? data[key]!.title : undefined
    },

    /** Past sessions for this key, most recent first (FR9 `list`). */
    list(key: string): PastSession[] {
      return data[key]?.history ?? []
    },
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>
