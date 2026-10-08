/**
 * Applies reflection proposals (004 FR6–FR8). Each proposal is matched
 * against existing entries first: the same name, or a description whose
 * token overlap (Jaccard) is over 0.6, turns a create into an update of that
 * entry, so a preference said three times stays one file (AC5). Then, by the
 * chat's `autoLearn`: `auto` writes and sends a notice with Undo; `propose`
 * asks with ✅ Save / ✕ Skip buttons (`mem:save|skip:<id>`); `off` does
 * nothing. At most MAX_WRITES_PER_TURN changes per pass. Refused writes
 * (secrets, size) are dropped and logged.
 */

import { randomBytes } from 'crypto'
import { MAX_WRITES_PER_TURN, slug } from '../memory/guard.ts'
import { jaccard, tokens, type MemoryStore, type MemoryType } from '../memory/store.ts'
import type { MemoryChange } from '../memory/tools.ts'
import type { Policy } from '../policy/schema.ts'
import type { Proposals } from './prompt.ts'

export const SIMILAR = 0.6
const MAX_PENDING = 100

/** One resolved change, ready to run. */
type Planned = {
  store: MemoryStore
  op: 'create' | 'update' | 'delete'
  type: MemoryType
  name: string
  description: string
  body: string
  metadata: Record<string, string>
}

export type ApplyOpts = {
  store: MemoryStore
  userStore: (userId: string) => MemoryStore
  policy: (key: string) => Policy
  /** A change was written: send its notice with Undo. */
  notify: (key: string, change: MemoryChange) => void
  /** Ask the chat; `id` goes in the Save/Skip buttons. */
  ask: (key: string, text: string, id: string) => void
  log?: (line: string) => void
}

/** The existing entry a proposal refers to: by name, else by a similar description. */
export function match(store: MemoryStore, name: string, description: string) {
  const byName = store.read(name)
  if (byName) return byName
  const want = tokens(description)
  let best: { e: ReturnType<MemoryStore['list']>[number]; score: number } | undefined
  for (const e of store.list()) {
    const score = jaccard(want, tokens(e.description))
    if (score > SIMILAR && (!best || score > best.score)) best = { e, score }
  }
  return best?.e
}

export function createApplier(opts: ApplyOpts) {
  const log = opts.log ?? (() => {})
  const pending = new Map<string, { key: string; plan: Planned }>()

  function plan(store: MemoryStore, p: { op: Planned['op']; type: MemoryType; name: string; description: string; body: string }, metadata: Record<string, string>): Planned | undefined {
    const existing = match(store, slug(p.name), p.description)
    if (p.op === 'delete') return existing && { store, ...p, op: 'delete', name: existing.name, description: existing.description, metadata }
    return existing
      ? { store, ...p, op: 'update', name: existing.name, metadata: { ...existing.metadata, ...metadata } }
      : { store, ...p, op: 'create', metadata }
  }

  function run(key: string, pl: Planned): MemoryChange | undefined {
    const name = pl.name
    if (pl.op === 'delete') {
      const del = pl.store.delete(name)
      return del && { verb: 'Forgot', name, description: pl.description, undo: () => pl.store.restore(name, del.backup) }
    }
    const r = pl.store.write({ type: pl.type, name, description: pl.description, body: pl.body, metadata: { ...pl.metadata, session_key: key } })
    return { verb: r.op === 'create' ? 'Saved' : 'Updated', name: r.entry.name, description: r.entry.description, undo: () => pl.store.restore(r.entry.name, r.backup) }
  }

  const describe = (pl: Planned) => `${pl.op === 'delete' ? 'Forget' : pl.op === 'update' ? 'Update' : 'Remember'}: ${pl.description}`

  return {
    apply(key: string, proposals: Proposals): void {
      const policy = opts.policy(key)
      if (policy.memoryScope === 'none' || !policy.autoLearn || policy.autoLearn === 'off') return
      const today = new Date().toISOString().slice(0, 10)
      const meta = { source: 'reflection', updated: today }
      const plans = [
        ...proposals.memory.map(p => plan(opts.store, p, meta)),
        ...proposals.user_model
          .filter(p => /^\d+$/.test(p.user_id))
          .map(p => plan(opts.userStore(p.user_id), { ...p, type: 'user' }, { ...meta, user_id: p.user_id })),
      ].filter((p): p is Planned => !!p).slice(0, MAX_WRITES_PER_TURN)

      for (const pl of plans) {
        if (policy.autoLearn === 'propose') {
          const id = randomBytes(6).toString('hex')
          pending.set(id, { key, plan: pl })
          if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!)
          opts.ask(key, `🧠 ${describe(pl)}?`, id)
          continue
        }
        try {
          const change = run(key, pl)
          if (change) opts.notify(key, change)
        } catch (err) {
          log(`reflection: dropped ${pl.name}: ${err instanceof Error ? err.message : err}`)
        }
      }
    },

    /** A Save or Skip tap. Returns the change on Save, or undefined when skipped, gone or refused. */
    decide(id: string, save: boolean): { change?: MemoryChange; error?: string } | undefined {
      const p = pending.get(id)
      if (!p) return undefined
      pending.delete(id)
      if (!save) return {}
      try {
        return { change: run(p.key, p.plan) }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
