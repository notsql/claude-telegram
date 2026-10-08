import type { PastSession, SessionStore } from './store.ts'

/** Models `session_set_model` may pick (008 FR1), as in the `/settings` editor. */
export const MODELS = ['sonnet', 'opus', 'haiku']

export type TurnStats = { turns: number; costUsd: number }

/**
 * Session lifecycle for a chat or topic (FR9), shared by the daemon's commands
 * and 008's handlers and tools. `new` and `resume` interrupt the key's running
 * turn first, so it can't keep working in the session being left; the agent's
 * own tools pass `interrupt: false`, since that turn is the caller. A model
 * picked for a session, and rules from the approval Allow button (003 FR15),
 * last until the next `new` or `resume`, in memory.
 */
export function createSessionLifecycle(store: SessionStore, interrupt: (key: string) => void) {
  const models = new Map<string, string>()
  const allowed = new Map<string, Set<string>>()
  const stats = new Map<string, TurnStats>()
  const leave = (key: string, opts: { interrupt?: boolean }) => {
    if (opts.interrupt !== false) interrupt(key)
    models.delete(key)
    allowed.delete(key)
  }

  return {
    new(key: string, opts: { interrupt?: boolean } = {}): void {
      leave(key, opts)
      store.new(key)
    },

    /** Throws when `n` isn't a number from `list`. */
    resume(key: string, n: number, opts: { interrupt?: boolean } = {}): PastSession {
      if (!store.list(key)[n - 1]) throw new Error(`No session #${n}. /sessions lists them.`)
      leave(key, opts)
      return store.resume(key, n)
    },

    list(key: string): PastSession[] {
      return store.list(key)
    },

    /** `default` clears the session's model. Throws on a model not in MODELS. */
    setModel(key: string, model: string): void {
      if (model === 'default') return void models.delete(key)
      if (!MODELS.includes(model)) throw new Error(`Unknown model ${model}. Pick one of: ${MODELS.join(', ')}, default.`)
      models.set(key, model)
    },

    model(key: string): string | undefined {
      return models.get(key)
    },

    allow(key: string, rule: string): void {
      const rules = allowed.get(key) ?? new Set()
      allowed.set(key, rules.add(rule))
    },

    /** Rules allowed for the key's current session. */
    allowed(key: string): string[] {
      return [...allowed.get(key) ?? []]
    },

    /** Adds a finished turn's cost to its Claude Code session. */
    recordTurn(sessionId: string, costUsd: number): void {
      const s = stats.get(sessionId) ?? { turns: 0, costUsd: 0 }
      stats.set(sessionId, { turns: s.turns + 1, costUsd: s.costUsd + costUsd })
    },

    stats(key: string): TurnStats | undefined {
      const id = store.current(key)
      return id ? stats.get(id) : undefined
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

/** Cost line of `/status`: since the daemon started, Claude Code's notional API price (the subscription pays). */
export function formatCost(s: TurnStats | undefined): string {
  if (!s) return 'No turns in this session since the daemon started.'
  return `This session: ${s.turns} turn${s.turns === 1 ? '' : 's'}, $${s.costUsd.toFixed(2)} at API prices (covered by the subscription).`
}

/** `/status` and `session_status`: the key's session, model, running state and cost. */
export function formatStatus(o: { session?: string; model?: string; policyModel?: string; running: boolean; stats?: TurnStats }): string {
  const model = o.model ? `${o.model} (this session)` : o.policyModel ? `${o.policyModel} (policy)` : 'default'
  return [
    `Session: ${o.session ?? 'none yet; the next message starts one'}`,
    `Model: ${model}`,
    `Turn: ${o.running ? 'running' : 'idle'}`,
    formatCost(o.stats),
  ].join('\n')
}
