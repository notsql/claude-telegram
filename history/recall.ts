/**
 * Auto-recall for the `UserPromptSubmit` hook (005 FR7). On the first prompt
 * of a fresh or rotated session (no assistant rows indexed for it yet), run a
 * local FTS search on the prompt (no model call) and, when the top hit is a
 * real match, return up to ~1k tokens of `<recalled>` snippets.
 *
 * The threshold is on matched terms, not bm25: scores shift with corpus size
 * and a lone common word ("hi") still scores well, so a hit counts only when
 * it matches at least two distinct query terms.
 */

import type { Database } from 'bun:sqlite'
import type { Policy } from '../policy/schema.ts'
import { unwrapInbound } from './parse.ts'
import { search, type Hit } from './search.ts'
import { formatHits, scopeFor, type HistoryDeps } from './tools.ts'

const MAX_CHARS = 4000
const MIN_TERMS = 2
const LIMIT = 5

const termsMatched = (h: Hit) => new Set([...h.snippet.matchAll(/\[([^\]]+)\]/g)].map(m => m[1].toLowerCase())).size

function isFresh(db: Database, sessionId: string): boolean {
  return !db.query("SELECT 1 FROM messages WHERE session_id = ? AND role = 'assistant' LIMIT 1").get(sessionId)
}

/** The `<recalled>` block for this prompt, or '' when nothing qualifies. */
export function recall(deps: Pick<HistoryDeps, 'db' | 'sessions'>, payload: Record<string, unknown>, key: string, policy: Policy): string {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  const prompt = typeof payload.prompt === 'string' ? unwrapInbound(payload.prompt).text : ''
  if (!sessionId || !prompt || !isFresh(deps.db, sessionId)) return ''
  const scope = scopeFor(policy, key, deps.sessions)
  if (!scope) return ''
  const hits = search(deps.db, prompt, { scope, limit: LIMIT, excludeSessionId: sessionId })
  if (!hits.length || termsMatched(hits[0]) < MIN_TERMS) return ''
  let body = formatHits(hits.filter(termsMatched), id => deps.sessions.keyOf(id))
  if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS - 1) + '…'
  return `<recalled note="Excerpts from earlier sessions that may relate to this message; history_search has more.">\n${body}\n</recalled>`
}

type HookOutput = { hookSpecificOutput?: { hookEventName: string; additionalContext: string } }

/** Appends `ctx` to a hook output's `additionalContext`. */
export function withContext(out: HookOutput, event: string, ctx: string): HookOutput {
  if (!ctx) return out
  const prev = out.hookSpecificOutput?.additionalContext
  return { ...out, hookSpecificOutput: { hookEventName: event, additionalContext: prev ? `${prev}\n\n${ctx}` : ctx } }
}
