/**
 * `history_search` on the daemon MCP server (005 FR5, FR6). Scope comes from
 * the session's `historyScope`: `none` hides and refuses the tool, `chat`
 * limits it to the key's own sessions even if the model asks for `all`.
 */

import type { Database } from 'bun:sqlite'
import type { Policy } from '../policy/schema.ts'
import type { SessionStore } from '../sessions/store.ts'
import type { ToolResult } from '../memory/tools.ts'
import { search, type Hit, type Scope } from './search.ts'
import { summarizeHits } from './summarize.ts'

const TOOL = {
  name: 'history_search',
  description: 'Full-text search over past conversations (earlier sessions in this chat, and terminal sessions when allowed). ' +
    'Use when the user refers to earlier work or decisions you no longer have in context. Returns dated excerpts; set summarize for a cited answer.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords, e.g. "postgres migration decision"' },
      scope: { type: 'string', enum: ['chat', 'all'], description: 'chat: this chat only. all: every session the policy allows (default)' },
      since: { type: 'string', description: 'ISO date; only hits on or after it' },
      limit: { type: 'number', description: 'Max hits, default 8, at most 25' },
      summarize: { type: 'boolean', description: 'Condense the hits into an answer with citations' },
    },
    required: ['query'],
  },
}

const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) })
const day = (ts: number) => (ts ? new Date(ts).toISOString().slice(0, 10) : 'undated')

export type HistoryDeps = {
  db: Database
  sessions: Pick<SessionStore, 'sessionIds' | 'keyOf'>
  summarize?: (question: string, numbered: string) => Promise<string>
}

/** The scope a session may search, or undefined when history is off. Unset policy means `chat`. */
export function scopeFor(policy: Policy, key: string, sessions: HistoryDeps['sessions'], asked?: 'chat' | 'all'): Scope | undefined {
  const allowed = policy.historyScope ?? 'chat'
  if (allowed === 'none') return
  return allowed === 'all' && asked !== 'chat' ? { all: true } : { sessionIds: sessions.sessionIds(key) }
}

export function formatHits(hits: Hit[], keyOf: (sessionId: string) => string | undefined): string {
  return hits.map((h, i) =>
    `[${i + 1}] ${day(h.ts)} · ${keyOf(h.sessionId) ?? 'cli'} · ${h.title ?? 'untitled'} (${h.role})\n    ${h.snippet.replace(/\s+/g, ' ')}`,
  ).join('\n')
}

export function createHistoryTools({ db, sessions, summarize = summarizeHits }: HistoryDeps) {
  return {
    list(policy: Policy) {
      return (policy.historyScope ?? 'chat') === 'none' ? [] : [TOOL]
    },

    /** Undefined when `name` is not a history tool. */
    async call(name: string, args: Record<string, unknown>, key: string, policy: Policy): Promise<ToolResult | undefined> {
      if (name !== TOOL.name) return undefined
      const scope = scopeFor(policy, key, sessions, args.scope === 'chat' ? 'chat' : 'all')
      if (!scope) return text('history search is turned off for this chat (historyScope: none)', true)
      const query = String(args.query ?? '')
      const since = typeof args.since === 'string' ? Date.parse(args.since) : NaN
      const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 25)
      try {
        const hits = search(db, query, { scope, limit, ...(Number.isFinite(since) && { since }) })
        if (!hits.length) return text('no matches')
        const numbered = formatHits(hits, id => sessions.keyOf(id))
        if (args.summarize !== true) return text(numbered)
        return text(`${await summarize(query, numbered)}\n\nSources:\n${numbered}`)
      } catch (err) {
        return text(`history_search failed: ${err instanceof Error ? err.message : err}`, true)
      }
    },
  }
}

export type HistoryTools = ReturnType<typeof createHistoryTools>
