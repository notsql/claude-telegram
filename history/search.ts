/**
 * History search (005 FR5, FR6). The query is reduced to quoted terms joined
 * with OR, so FTS syntax in user text can't break or widen it; bm25 ranks.
 * Scope is applied in SQL from the caller's `historyScope`: `chat` passes the
 * session key's own Claude Code session ids (current and archived, from
 * sessions.json), so the model never picks its scope.
 */

import type { Database } from 'bun:sqlite'

export type Scope = { all: true } | { sessionIds: string[] }

export type Hit = {
  sessionId: string
  role: string
  ts: number
  title: string | null
  project: string | null
  tgChat: string | null
  tgThread: string | null
  tgMsg: string | null
  snippet: string
  /** bm25: lower is better. */
  score: number
}

const STOPWORDS = new Set(('a an and are as at be but by did do does for from had has have how i in is it its me my of on or ' +
  'so that the their them then there they this to was we were what when where which who why will with you your about ' +
  'can could should would just our us may might must also any some all not no yes ok okay please').split(' '))

/** User text → FTS5 MATCH expression, or undefined when nothing searchable is left. */
export function toMatch(query: string): string | undefined {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])]
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
  return terms.length ? terms.map(t => `"${t}"`).join(' OR ') : undefined
}

export type SearchOpts = { scope: Scope; since?: number; limit?: number; excludeSessionId?: string }

export function search(db: Database, query: string, { scope, since, limit = 10, excludeSessionId }: SearchOpts): Hit[] {
  const match = toMatch(query)
  if (!match) return []
  const where = ['messages_fts MATCH ?']
  const params: (string | number)[] = [match]
  if ('sessionIds' in scope) {
    if (!scope.sessionIds.length) return []
    where.push(`m.session_id IN (${scope.sessionIds.map(() => '?').join(',')})`)
    params.push(...scope.sessionIds)
  }
  if (since != null) { where.push('m.ts >= ?'); params.push(since) }
  if (excludeSessionId) { where.push('m.session_id != ?'); params.push(excludeSessionId) }
  params.push(limit)
  return db.query(`
    SELECT m.session_id AS sessionId, m.role, m.ts, s.title, s.project,
           m.tg_chat AS tgChat, m.tg_thread AS tgThread, m.tg_msg AS tgMsg,
           snippet(messages_fts, 0, '[', ']', '…', 16) AS snippet,
           bm25(messages_fts) AS score
    FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
    LEFT JOIN sessions s ON s.session_id = m.session_id
    WHERE ${where.join(' AND ')}
    ORDER BY score LIMIT ?`).all(...params) as Hit[]
}
