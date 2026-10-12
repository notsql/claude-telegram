/**
 * 004 FR3: whose user model to inject, per session key: the latest sender
 * first, then others active recently. In memory only.
 */

const ACTIVE_MS = 2 * 60 * 60 * 1000

export function createParticipants(now: () => number = Date.now) {
  const seen = new Map<string, Map<string, number>>()
  return {
    saw(key: string, userId: string): void {
      const m = seen.get(key) ?? new Map<string, number>()
      m.delete(userId)
      m.set(userId, now())
      seen.set(key, m)
    },
    active(key: string): string[] {
      return [...seen.get(key) ?? []].filter(([, t]) => now() - t < ACTIVE_MS).map(([id]) => id).reverse()
    },
  }
}
