/**
 * Inbox store (013 FR2, plan "Data"): `inbox.db` via bun:sqlite with an
 * external-content FTS5 table kept in sync by triggers. Items dedupe on
 * (source, ext_id). Migrations are tracked in `PRAGMA user_version`; append
 * new ones, never edit old ones.
 */

import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

const MIGRATIONS = [
  `CREATE TABLE items (
     id INTEGER PRIMARY KEY, source TEXT NOT NULL, ext_id TEXT NOT NULL, ts INTEGER NOT NULL,
     from_id TEXT, from_name TEXT, chat_id TEXT, chat_name TEXT, is_group INTEGER NOT NULL DEFAULT 0,
     text TEXT NOT NULL, url TEXT, to_me INTEGER NOT NULL DEFAULT 0, from_me INTEGER NOT NULL DEFAULT 0,
     thread_id TEXT, label TEXT, reason TEXT, status TEXT NOT NULL DEFAULT 'new', snooze_until INTEGER,
     UNIQUE(source, ext_id));
   CREATE VIRTUAL TABLE items_fts USING fts5(text, from_name, chat_name, content='items', content_rowid='id', tokenize='porter unicode61');
   CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
     INSERT INTO items_fts(rowid, text, from_name, chat_name) VALUES (new.id, new.text, new.from_name, new.chat_name);
   END;
   CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
     INSERT INTO items_fts(items_fts, rowid, text, from_name, chat_name) VALUES ('delete', old.id, old.text, old.from_name, old.chat_name);
   END;
   CREATE TRIGGER items_au AFTER UPDATE OF text, from_name, chat_name ON items BEGIN
     INSERT INTO items_fts(items_fts, rowid, text, from_name, chat_name) VALUES ('delete', old.id, old.text, old.from_name, old.chat_name);
     INSERT INTO items_fts(rowid, text, from_name, chat_name) VALUES (new.id, new.text, new.from_name, new.chat_name);
   END;
   CREATE TABLE loops (
     id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), kind TEXT NOT NULL,
     summary TEXT NOT NULL, due INTEGER, opened_at INTEGER NOT NULL, closed_at INTEGER);`,
]

/** FR2 normalised item. */
export type Item = {
  source: string
  extId: string
  ts: number
  from: { id: string; name: string }
  chat: { id: string; name: string; isGroup: boolean }
  text: string
  url?: string
  toMe: boolean
  fromMe: boolean
  threadId?: string
}

export const inboxPath = (stateDir: string) => join(stateDir, 'inbox.db')

export function openInboxDb(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  // Messages from every watched account: owner-only.
  if (path !== ':memory:') chmodSync(path, 0o600)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000')
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })()
  }
  return db
}

/** Inserts `item`; returns its row id, or null when (source, extId) is already stored. */
export function insertItem(db: Database, item: Item): number | null {
  const row = db.query(
    `INSERT INTO items (source, ext_id, ts, from_id, from_name, chat_id, chat_name, is_group, text, url, to_me, from_me, thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, ext_id) DO NOTHING RETURNING id`,
  ).get(
    item.source, item.extId, item.ts, item.from.id, item.from.name, item.chat.id, item.chat.name,
    item.chat.isGroup ? 1 : 0, item.text, item.url ?? null, item.toMe ? 1 : 0, item.fromMe ? 1 : 0, item.threadId ?? null,
  ) as { id: number } | null
  return row?.id ?? null
}
