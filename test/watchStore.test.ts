import { expect, test } from 'bun:test'
import { mkdtempSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { inboxPath, insertItem, openInboxDb, type Item } from '../watch/store'

const item = (extId: string, text = 'urgent: call me'): Item => ({
  source: 'whatsapp', extId, ts: 1, from: { id: 'u1', name: 'Alice' }, chat: { id: 'c1', name: 'Family', isGroup: true },
  text, toMe: true, fromMe: false,
})

test('inserting the same item twice keeps one row', () => {
  const db = openInboxDb(':memory:')
  expect(insertItem(db, item('m1'))).toBeNumber()
  expect(insertItem(db, item('m1', 'changed'))).toBeNull()
  expect(db.query("SELECT text FROM items WHERE source = 'whatsapp'").all()).toEqual([{ text: 'urgent: call me' }])
  expect(insertItem(db, { ...item('m1'), source: 'github' })).toBeNumber()
})

test('FTS finds items by text, sender and chat', () => {
  const db = openInboxDb(':memory:')
  insertItem(db, item('m1', 'meeting tomorrow'))
  const q = (m: string) => db.query('SELECT i.ext_id FROM items_fts f JOIN items i ON i.id = f.rowid WHERE items_fts MATCH ?').all(m)
  expect(q('meetings')).toEqual([{ ext_id: 'm1' }])
  expect(q('alice')).toHaveLength(1)
  expect(q('family')).toHaveLength(1)
  db.run('DELETE FROM items')
  expect(q('meeting')).toEqual([])
})

test('loops table, file mode 0600, dedupe survives reopen', () => {
  const path = inboxPath(mkdtempSync(join(tmpdir(), 'tg-inbox-')))
  const db = openInboxDb(path)
  const id = insertItem(db, item('m1'))
  db.run("INSERT INTO loops (item_id, kind, summary, opened_at) VALUES (?, 'awaiting_me', 'reply', 1)", [id])
  expect(db.query('SELECT COUNT(*) AS n FROM loops').get()).toEqual({ n: 1 })
  expect(statSync(path).mode & 0o777).toBe(0o600)
  db.close()
  expect(insertItem(openInboxDb(path), item('m1'))).toBeNull()
})
