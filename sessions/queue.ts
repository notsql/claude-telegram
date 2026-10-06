/**
 * Turn scheduling (002 FR5, FR6): turns for one session key run one at a time,
 * at most `concurrency` keys run at once, and keys waiting for a slot are
 * served FIFO. Items that arrive while their key is busy or waiting are batched
 * into that key's next turn.
 */

export type TurnQueueOpts<T> = {
  concurrency: number
  /** Runs one turn over every item that was pending when it started. */
  run: (key: string, batch: T[]) => Promise<void>
  /** Called for an item that can't start right away (key busy or no free slot). */
  onQueued?: (key: string, item: T) => void
}

export function createTurnQueue<T>(opts: TurnQueueOpts<T>) {
  const pending = new Map<string, T[]>()
  const running = new Set<string>()
  // Keys with pending items that are waiting for a slot, in arrival order.
  const waiting: string[] = []
  const active = new Set<Promise<void>>()

  function pump(): void {
    while (running.size < opts.concurrency && waiting.length) {
      const key = waiting.shift()!
      const batch = pending.get(key)!
      pending.delete(key)
      running.add(key)
      const p: Promise<void> = opts.run(key, batch)
        .catch(() => {})
        .finally(() => {
          running.delete(key)
          active.delete(p)
          // Back of the line, so a busy chat can't starve the others.
          if (pending.has(key)) waiting.push(key)
          pump()
        })
      active.add(p)
    }
  }

  return {
    enqueue(key: string, item: T): void {
      const batch = pending.get(key)
      if (batch) {
        batch.push(item)
      } else {
        pending.set(key, [item])
        if (!running.has(key)) waiting.push(key)
      }
      pump()
      if (pending.has(key)) opts.onQueued?.(key, item)
    },

    /** Resolves once nothing is running or waiting. */
    async idle(): Promise<void> {
      while (active.size) await Promise.all(active)
    },
  }
}
