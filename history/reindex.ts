#!/usr/bin/env bun
/**
 * `bun run reindex` (005 FR8): the index is a derived cache, so clear it and
 * rebuild from the transcripts. Safe while the daemon runs: both index under
 * the offset check in indexer.ts, so no chunk is inserted twice.
 */

import { join } from 'path'
import { STATE_DIR } from '../access.ts'
import { claudeDir } from '../memory/paths.ts'
import { openHistoryDb } from './db.ts'
import { scan } from './indexer.ts'
import type { Database } from 'bun:sqlite'

export async function reindex(db: Database, projectsDir: string, log: (msg: string) => void = () => {}): Promise<void> {
  db.transaction(() => db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM files;')).immediate()
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')")
  await scan(db, projectsDir, log)
}

if (import.meta.main) {
  const db = openHistoryDb(join(STATE_DIR, 'history.db'))
  const t = performance.now()
  await reindex(db, join(claudeDir(), 'projects'), console.log)
  const { n } = db.query('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
  console.log(`reindexed ${n} messages in ${Math.round(performance.now() - t)}ms`)
}
