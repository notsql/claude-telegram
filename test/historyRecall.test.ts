import { expect, test } from 'bun:test'
import { openHistoryDb } from '../history/db'
import { recall, withContext } from '../history/recall'

function setup() {
  const db = openHistoryDb(':memory:')
  const add = (session: string, role: string, text: string) =>
    db.run("INSERT INTO messages (session_id, role, ts, text) VALUES (?, ?, ?, ?)", [session, role, Date.parse('2026-09-30T10:00:00Z'), text])
  add('old', 'user', 'we decided the postgres migration runs on Sunday with pg_dump')
  add('old', 'assistant', 'hi there, how can I help')
  add('resumed', 'assistant', 'already talking')
  const sessions = { sessionIds: (k: string) => (k === '111' ? ['old', 'new'] : []), keyOf: (id: string) => (id === 'old' ? '111' : undefined) }
  return { db, sessions }
}
const wrap = (t: string) => `<channel source="telegram" chat_id="111" message_id="5" user="u" user_id="1">${t}</channel>`

test('fresh session referring to earlier work gets a <recalled> block', () => {
  const t0 = performance.now()
  const r = recall(setup(), { session_id: 'new', prompt: wrap('what did we decide about the postgres migration?') }, '111', { historyScope: 'all' })
  expect(performance.now() - t0).toBeLessThan(200)
  expect(r).toStartWith('<recalled')
  expect(r).toContain('2026-09-30 · 111')
  expect(r).toContain('[postgres] [migration]')
})

test('no recall for resumed sessions, weak matches, or historyScope none', () => {
  const d = setup()
  expect(recall(d, { session_id: 'resumed', prompt: 'postgres migration plan' }, '111', { historyScope: 'all' })).toBe('')
  expect(recall(d, { session_id: 'new', prompt: wrap('hi') }, '111', { historyScope: 'all' })).toBe('')
  expect(recall(d, { session_id: 'new', prompt: 'postgres migration' }, '111', { historyScope: 'none' })).toBe('')
  expect(recall(d, { session_id: 'new', prompt: 'postgres migration' }, '-100:7', { historyScope: 'chat' })).toBe('')
  expect(recall(d, {}, '111', { historyScope: 'all' })).toBe('')
})

test('withContext appends to existing memory context', () => {
  expect(withContext({}, 'UserPromptSubmit', '')).toEqual({})
  expect(withContext({}, 'UserPromptSubmit', 'R')).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'R' } })
  expect(withContext({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'M' } }, 'UserPromptSubmit', 'R').hookSpecificOutput?.additionalContext).toBe('M\n\nR')
})
