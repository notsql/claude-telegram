/**
 * `/search <query>` for 008 (005 US4, FR4): top hits with dates and, where the
 * Telegram ids are known, a `t.me/c/…` link to the original message. Same
 * scope rules as `history_search`.
 */

import type { Policy } from '../policy/schema.ts'
import { search, type Hit } from './search.ts'
import { scopeFor, type HistoryDeps } from './tools.ts'

const LIMIT = 5

/**
 * `https://t.me/c/<chat>/[<thread>/]<msg>`. Only supergroups and channels
 * (`-100…` ids) have these links; private chats and basic groups don't.
 */
export function messageLink(h: Pick<Hit, 'tgChat' | 'tgThread' | 'tgMsg'>): string | undefined {
  const m = h.tgChat?.match(/^-100(\d+)$/)
  if (!m || !h.tgMsg) return
  return `https://t.me/c/${m[1]}/${h.tgThread ? `${h.tgThread}/` : ''}${h.tgMsg}`
}

export function searchCommand(deps: Pick<HistoryDeps, 'db' | 'sessions'>, query: string, key: string, policy: Policy): string {
  const scope = scopeFor(policy, key, deps.sessions)
  if (!scope) return 'History search is off in this chat (historyScope: none).'
  query = query.trim()
  if (!query) return 'Usage: /search <words to look for>'
  const hits = search(deps.db, query, { scope, limit: LIMIT })
  if (!hits.length) return `Nothing found for "${query}".`
  return hits.map((h, i) => {
    const date = h.ts ? new Date(h.ts).toISOString().slice(0, 10) : 'undated'
    const link = messageLink(h)
    return `${i + 1}. ${date} · ${h.title ?? (deps.sessions.keyOf(h.sessionId) ? 'Telegram' : 'terminal')}\n` +
      `${h.snippet.replace(/\s+/g, ' ')}${link ? `\n${link}` : ''}`
  }).join('\n\n')
}
