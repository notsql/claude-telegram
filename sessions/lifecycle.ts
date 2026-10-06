import type { PastSession, SessionStore } from './store.ts'

/**
 * Session lifecycle for a chat or topic (FR9), shared by the daemon's commands
 * and 008's handlers and tools. `new` and `resume` interrupt the key's running
 * turn first, so it can't keep working in the session being left.
 */
export function createSessionLifecycle(store: SessionStore, interrupt: (key: string) => void) {
  return {
    new(key: string): void {
      interrupt(key)
      store.new(key)
    },

    /** Throws when `n` isn't a number from `list`. */
    resume(key: string, n: number): PastSession {
      if (!store.list(key)[n - 1]) throw new Error(`No session #${n}. /sessions lists them.`)
      interrupt(key)
      return store.resume(key, n)
    },

    list(key: string): PastSession[] {
      return store.list(key)
    },
  }
}

export type SessionLifecycle = ReturnType<typeof createSessionLifecycle>

/** Numbered for `resume <n>`, most recent first. */
export function formatSessions(past: PastSession[]): string {
  if (!past.length) return 'No earlier sessions here.'
  return past
    .map((s, i) => `${i + 1}. ${s.title || '(untitled)'} (${new Date(s.startedAt).toISOString().slice(0, 10)})`)
    .join('\n')
}
