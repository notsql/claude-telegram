import { expect, test } from 'bun:test'
import { openHistoryDb } from '../history/db'
import { messageLink, searchCommand } from '../history/commands'

function deps() {
  const db = openHistoryDb(':memory:')
  db.run(`INSERT INTO messages (session_id, role, ts, tg_chat, tg_thread, tg_msg, text) VALUES
    ('t1', 'user', ${Date.parse('2026-10-01T00:00:00Z')}, '-1001234567890', '7', '42', 'postgres migration on Sunday'),
    ('d1', 'user', ${Date.parse('2026-10-02T00:00:00Z')}, '111', NULL, '9', 'postgres in the DM')`)
  db.run("INSERT INTO sessions (session_id, title) VALUES ('t1', 'Migration topic')")
  const sessions = { sessionIds: (k: string) => ({ '-100:7': ['t1'], '111': ['d1'] } as Record<string, string[]>)[k] ?? [], keyOf: (id: string) => (id === 'd1' ? '111' : '-100:7') }
  return { db, sessions }
}

test('AC5: /search hits link to the original Telegram message', () => {
  const r = searchCommand(deps(), 'postgres migration', '-100:7', { historyScope: 'chat' })
  expect(r).toBe('1. 2026-10-01 · Migration topic\n[postgres] [migration] on Sunday\nhttps://t.me/c/1234567890/7/42')
})

test('links only for supergroups; scope, usage and off messages', () => {
  expect(messageLink({ tgChat: '-1001234567890', tgThread: null, tgMsg: '5' })).toBe('https://t.me/c/1234567890/5')
  expect(messageLink({ tgChat: '111', tgThread: null, tgMsg: '9' })).toBeUndefined()
  expect(messageLink({ tgChat: null, tgThread: null, tgMsg: null })).toBeUndefined()
  const d = deps()
  expect(searchCommand(d, 'postgres', '111', { historyScope: 'all' })).toContain('2026-10-02 · Telegram\n[postgres] in the DM')
  expect(searchCommand(d, 'postgres', '111', { historyScope: 'chat' })).not.toContain('Sunday')
  expect(searchCommand(d, '  ', '111', { historyScope: 'all' })).toStartWith('Usage')
  expect(searchCommand(d, 'postgres', '111', { historyScope: 'none' })).toContain('off')
  expect(searchCommand(d, 'kubernetes', '111', { historyScope: 'all' })).toBe('Nothing found for "kubernetes".')
})
