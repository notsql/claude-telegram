/**
 * History index (005 plan, "Schema"): bun:sqlite with an external-content
 * FTS5 table kept in sync by triggers. Migrations are ordered and tracked in
 * `PRAGMA user_version`; append new ones, never edit old ones.
 */

import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const MIGRATIONS = [
  `CREATE TABLE files    (path TEXT PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0, mtime INTEGER);
   CREATE TABLE sessions (session_id TEXT PRIMARY KEY, session_key TEXT, origin TEXT, project TEXT, title TEXT, started_at INTEGER);
   CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, ts INTEGER, tg_chat TEXT, tg_thread TEXT, tg_msg TEXT, text TEXT NOT NULL);
   CREATE INDEX idx_messages_session ON messages(session_id);
   CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');
   CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
     INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
   END;
   CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
   END;
   CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
     INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
   END;`,
]

export function openHistoryDb(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  // Transcript text: owner-only, like the other state files.
  if (path !== ':memory:') chmodSync(path, 0o600)
  db.exec('PRAGMA journal_mode = WAL')
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })()
  }
  return db
}
