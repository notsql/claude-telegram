import { expect, test } from 'bun:test'
import { mkdtempSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openHistoryDb } from '../history/db'

const match = (db: ReturnType<typeof openHistoryDb>, q: string) =>
  db.query('SELECT m.text FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts)').all(q)

test('insert a row and find it with FTS (porter stemming)', () => {
  const db = openHistoryDb(':memory:')
  db.run("INSERT INTO messages (session_id, role, ts, text) VALUES ('s1', 'user', 1, 'we are deploying the blog with pnpm')")
  expect(match(db, 'deploy')).toEqual([{ text: 'we are deploying the blog with pnpm' }])
  expect(match(db, 'npm')).toEqual([])
})

test('triggers keep FTS in sync on update and delete', () => {
  const db = openHistoryDb(':memory:')
  const { id } = db.query("INSERT INTO messages (session_id, role, text) VALUES ('s1', 'assistant', 'old words') RETURNING id").get() as { id: number }
  db.run('UPDATE messages SET text = ? WHERE id = ?', ['new words', id])
  expect(match(db, 'old')).toEqual([])
  expect(match(db, 'new')).toHaveLength(1)
  db.run('DELETE FROM messages WHERE id = ?', [id])
  expect(match(db, 'new')).toEqual([])
})

test('reopening a file db keeps data and does not re-run migrations', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tg-hist-')), 'sub', 'history.db')
  const a = openHistoryDb(path)
  a.run("INSERT INTO messages (session_id, role, text) VALUES ('s1', 'user', 'persisted')")
  a.close()
  const b = openHistoryDb(path)
  expect((b.query('PRAGMA user_version').get() as any).user_version).toBe(1)
  expect(match(b, 'persisted')).toHaveLength(1)
})

test('the db file is owner-only', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tg-hist-')), 'history.db')
  openHistoryDb(path).close()
  expect(statSync(path).mode & 0o777).toBe(0o600)
})
