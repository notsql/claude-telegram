/**
 * Reflection worker (004 FR6), shared with 006. The `Stop` hook enqueues a
 * pass after each turn, debounced per session key so a fast back-and-forth is
 * reflected on once; `PreCompact` runs one straight away, before compaction
 * drops context. Each pass reads the transcript from where the last one
 * stopped, asks the reflector for proposals and hands them to `apply`.
 * Passes for one key never overlap. A daily cap bounds the cost.
 */

import { createTurnBudget } from '../config.ts'
import { readDelta } from './transcript.ts'
import { reflectionInput, type Proposals } from './prompt.ts'

export const DEBOUNCE_MS = 30_000
export const DAILY_CAP = 100

export type ReflectionOpts = {
  /** Runs the reflector one-shot on the full input. */
  reflect: (input: string) => Promise<Proposals>
  /** Existing memory for the key, or null when the key's policy turns memory learning off. */
  existing: (key: string) => string | null
  /** 006: the skills block for this turn's `delta`, or null when skill learning is off. */
  skills?: (key: string, delta: string, payload: Record<string, unknown>) => string | null
  /** `delta` is the dialogue the proposals came from (006 refinement reads it). */
  apply: (key: string, proposals: Proposals, delta: string) => Promise<void> | void
  debounceMs?: number
  dailyCap?: number
  log?: (line: string) => void
}

export function createReflectionWorker(opts: ReflectionOpts) {
  const log = opts.log ?? (() => {})
  const offsets = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const latest = new Map<string, Record<string, unknown>>()
  const chains = new Map<string, Promise<void>>()
  const budget = createTurnBudget(opts.dailyCap ?? DAILY_CAP)

  async function pass(key: string): Promise<void> {
    const payload = latest.get(key)
    if (!payload) return
    const path = payload.transcript_path as string
    const existing = opts.existing(key)
    if (existing === null && !opts.skills) return
    const { text, offset } = readDelta(path, offsets.get(path) ?? 0)
    offsets.set(path, offset)
    if (!text) return
    const skills = opts.skills?.(key, text, payload) ?? null
    if (existing === null && skills === null) return
    if (!budget.take()) return log('reflection: daily cap reached, skipping')
    const input = reflectionInput(existing, text, skills)
    let proposals: Proposals
    try {
      proposals = await opts.reflect(input)
    } catch (err) {
      log(`reflection failed, retrying once: ${err}`)
      proposals = await opts.reflect(input)
    }
    log(`reflection ${key}: ${proposals.memory.length} memory, ${proposals.user_model.length} user-model, ${proposals.skills.length} skill proposals`)
    if (proposals.skills.length) log(`reflection ${key} skills: ${JSON.stringify(proposals.skills)}`)
    await opts.apply(key, proposals, text)
  }

  function run(key: string): Promise<void> {
    const next = (chains.get(key) ?? Promise.resolve())
      .then(() => pass(key))
      .catch(err => log(`reflection ${key} failed: ${err}`))
    chains.set(key, next)
    return next
  }

  return {
    /** From a `Stop` (debounced) or `PreCompact` (immediate) hook payload. */
    enqueue(key: string, payload: Record<string, unknown>, immediate = false): Promise<void> | undefined {
      if (typeof payload.transcript_path !== 'string') return undefined
      latest.set(key, payload)
      clearTimeout(timers.get(key))
      timers.delete(key)
      if (immediate) return run(key)
      timers.set(key, setTimeout(() => { timers.delete(key); void run(key) }, opts.debounceMs ?? DEBOUNCE_MS))
      return undefined
    },
  }
}
