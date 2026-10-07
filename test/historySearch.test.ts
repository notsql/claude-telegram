import { expect, test } from 'bun:test'
import { openHistoryDb } from '../history/db'
import { search, toMatch } from '../history/search'

function seed() {
  const db = openHistoryDb(':memory:')
  const add = (session: string, ts: number, text: string) =>
    db.run('INSERT INTO messages (session_id, role, ts, text) VALUES (?, ?, ?, ?)', [session, 'user', ts, text])
  db.run("INSERT INTO sessions (session_id, title) VALUES ('dm1', 'Postgres plan'), ('grp1', 'Topic chat')")
  add('dm1', 100, 'We decided the postgres migration runs on Sunday with pg_dump')
  add('dm1', 200, 'unrelated lunch talk')
  add('grp1', 300, 'the group likes the migration idea')
  add('cli1', 400, 'postgres tuning in the terminal')
  return db
}

test('toMatch quotes terms, drops stopwords, and neutralises FTS syntax', () => {
  expect(toMatch('What did we decide about the Postgres migration?')).toBe('"decide" OR "postgres" OR "migration"')
  expect(toMatch('NEAR(a b) OR "x" * col:y -z')).toBe('"near" OR "col"')
  expect(toMatch('the a ?')).toBeUndefined()
})

test('ranks with bm25 and returns title and snippet', () => {
  const hits = search(seed(), 'what did we decide about the postgres migration', { scope: { all: true } })
  expect(hits[0]).toMatchObject({ sessionId: 'dm1', title: 'Postgres plan', ts: 100 })
  expect(hits[0].snippet).toContain('[postgres] [migration]')
  expect(hits.map(h => h.sessionId).sort()).toEqual(['cli1', 'dm1', 'grp1'])
})

test('AC2: chat scope only sees its own sessions', () => {
  const db = seed()
  expect(search(db, 'postgres migration', { scope: { sessionIds: ['grp1'] } }).map(h => h.sessionId)).toEqual(['grp1'])
  expect(search(db, 'postgres', { scope: { sessionIds: ['grp1'] } })).toEqual([])
  expect(search(db, 'postgres', { scope: { sessionIds: [] } })).toEqual([])
})

test('since, limit and excludeSessionId filter', () => {
  const db = seed()
  expect(search(db, 'postgres migration', { scope: { all: true }, since: 250 }).map(h => h.sessionId).sort()).toEqual(['cli1', 'grp1'])
  expect(search(db, 'postgres migration', { scope: { all: true }, limit: 1 })).toHaveLength(1)
  expect(search(db, 'postgres', { scope: { all: true }, excludeSessionId: 'dm1' }).map(h => h.sessionId)).toEqual(['cli1'])
})
