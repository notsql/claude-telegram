import { describe, expect, test } from 'bun:test'
import { createTurnQueue } from '../sessions/queue'

/** A run() whose turns finish only when the test says so. */
function controlled() {
  const log: string[] = []
  const finishers = new Map<string, () => void>()
  const run = (key: string, batch: string[]) => {
    log.push(`start ${key} [${batch.join(',')}]`)
    return new Promise<void>(r => finishers.set(key, () => { log.push(`end ${key}`); r() }))
  }
  const finish = async (key: string) => {
    finishers.get(key)!()
    finishers.delete(key)
    await Bun.sleep(0)
  }
  return { log, run, finish }
}

describe('turn queue (002 FR5, FR6)', () => {
  test('different keys run concurrently up to the limit', async () => {
    const c = controlled()
    const q = createTurnQueue({ concurrency: 2, run: c.run })
    q.enqueue('a', 'a1')
    q.enqueue('b', 'b1')
    q.enqueue('c', 'c1')
    expect(c.log).toEqual(['start a [a1]', 'start b [b1]'])
    await c.finish('b')
    expect(c.log).toEqual(['start a [a1]', 'start b [b1]', 'end b', 'start c [c1]'])
  })

  test('one key runs serially and batches messages that arrive mid-turn, in order', async () => {
    const c = controlled()
    const q = createTurnQueue({ concurrency: 3, run: c.run })
    q.enqueue('a', 'a1')
    q.enqueue('a', 'a2')
    q.enqueue('a', 'a3')
    expect(c.log).toEqual(['start a [a1]'])
    await c.finish('a')
    expect(c.log).toEqual(['start a [a1]', 'end a', 'start a [a2,a3]'])
  })

  test('a busy key goes to the back of the line for a slot', async () => {
    const c = controlled()
    const q = createTurnQueue({ concurrency: 1, run: c.run })
    q.enqueue('a', 'a1')
    q.enqueue('b', 'b1')
    q.enqueue('a', 'a2')
    await c.finish('a')
    expect(c.log.at(-1)).toBe('start b [b1]')
    await c.finish('b')
    expect(c.log.at(-1)).toBe('start a [a2]')
  })

  test('onQueued fires only for items that cannot start right away', async () => {
    const c = controlled()
    const queued: string[] = []
    const q = createTurnQueue({ concurrency: 1, run: c.run, onQueued: (_, item) => queued.push(item) })
    q.enqueue('a', 'a1')
    q.enqueue('a', 'a2')
    q.enqueue('b', 'b1')
    expect(queued).toEqual(['a2', 'b1'])
  })

  test('a failing turn does not stall the key', async () => {
    const seen: string[][] = []
    let first = true
    const q = createTurnQueue<string>({
      concurrency: 1,
      run: async (_, batch) => {
        seen.push(batch)
        if (first) { first = false; throw new Error('boom') }
      },
    })
    q.enqueue('a', 'a1')
    q.enqueue('a', 'a2')
    await q.idle()
    expect(seen).toEqual([['a1'], ['a2']])
  })

  test('idle waits for running and queued turns', async () => {
    const c = controlled()
    const q = createTurnQueue({ concurrency: 1, run: c.run })
    q.enqueue('a', 'a1')
    q.enqueue('b', 'b1')
    let done = false
    void q.idle().then(() => { done = true })
    await c.finish('a')
    expect(done).toBe(false)
    await c.finish('b')
    await Bun.sleep(0)
    expect(done).toBe(true)
  })
})
