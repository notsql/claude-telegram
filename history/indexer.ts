/**
 * Transcript indexer (005 FR3, FR9). Tails `<projects>/<dir>/<sessionId>.jsonl`
 * from the byte offset stored in `files`, so restarts only read new content.
 * Each chunk's rows and its new offset commit in one transaction, so a kill
 * mid-index never duplicates rows (AC3). The transaction is IMMEDIATE and
 * first checks the stored offset is still the one this pass read from, so a
 * concurrent indexer (the daemon during `reindex`) can't insert a chunk twice.
 * Only complete lines are consumed.
 * Subagent transcripts (`<sessionId>/subagents/`) are not indexed.
 *
 * Runs on `fs.watch` events (debounced) with a 60s poll as the fallback for
 * platforms or filesystems where watching misses changes.
 */

import type { Database } from 'bun:sqlite'
import { Glob } from 'bun'
import { closeSync, existsSync, openSync, readSync, statSync, watch } from 'fs'
import { basename, dirname, join } from 'path'
import { parseLine } from './parse.ts'

const CHUNK_BYTES = 1 << 20
const POLL_MS = 60_000
const DEBOUNCE_MS = 1_000

const storedOffset = (db: Database, path: string) =>
  (db.query('SELECT offset FROM files WHERE path = ?').get(path) as { offset: number } | null)?.offset ?? 0
const sessionIdOf = (path: string) => basename(path, '.jsonl')
const yieldLoop = () => new Promise(r => setTimeout(r, 0))

function dropFile(db: Database, path: string): void {
  const id = sessionIdOf(path)
  db.transaction(() => {
    db.run('DELETE FROM messages WHERE session_id = ?', [id])
    db.run('DELETE FROM sessions WHERE session_id = ?', [id])
    db.run('DELETE FROM files WHERE path = ?', [path])
  })()
}

/** Index one file from its stored offset. Yields between chunks. Returns rows added. */
export async function indexFile(db: Database, path: string): Promise<number> {
  let size: number, mtime: number
  try { ({ size, mtimeMs: mtime } = statSync(path)) } catch { return 0 }
  let offset = storedOffset(db, path)
  // Rewritten or truncated: start over.
  if (size < offset) { dropFile(db, path); offset = 0 }
  if (size === offset) return 0

  const project = basename(dirname(path))
  const insertMsg = db.prepare('INSERT INTO messages (session_id, role, ts, tg_chat, tg_thread, tg_msg, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const upsertSession = db.prepare(
    `INSERT INTO sessions (session_id, project, started_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET started_at = COALESCE(MIN(sessions.started_at, excluded.started_at), sessions.started_at, excluded.started_at)`)
  const setTitle = db.prepare(
    `INSERT INTO sessions (session_id, project, title) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET title = excluded.title`)
  const setOffset = db.prepare(
    `INSERT INTO files (path, offset, mtime) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, mtime = excluded.mtime`)

  let added = 0
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(CHUNK_BYTES)
    while (offset < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK_BYTES, size - offset), offset)
      let end = buf.lastIndexOf(0x0a, n - 1) + 1
      if (end === 0) {
        if (n < CHUNK_BYTES) break // trailing partial line: wait for the rest
        end = n // one line longer than a chunk: skip it
      }
      const lines = buf.toString('utf8', 0, end).split('\n')
      const rows = db.transaction(() => {
        if (storedOffset(db, path) !== offset) return -1 // another indexer moved on
        let n = 0
        for (const line of lines) {
          const p = parseLine(line)
          if (!p) continue
          if (p.kind === 'title') { setTitle.run(p.sessionId, project, p.title); continue }
          upsertSession.run(p.sessionId, project, p.ts || null)
          insertMsg.run(p.sessionId, p.role, p.ts, p.tg?.chat ?? null, p.tg?.thread ?? null, p.tg?.msg ?? null, p.text)
          n++
        }
        setOffset.run(path, offset + end, mtime)
        return n
      }).immediate()
      if (rows < 0) break
      added += rows
      offset += end
      await yieldLoop()
    }
  } finally {
    closeSync(fd)
  }
  return added
}

/** One pass: index new content in every transcript, drop rows of deleted ones. */
export async function scan(db: Database, projectsDir: string, log: (msg: string) => void = () => {}): Promise<void> {
  const present = new Set(
    existsSync(projectsDir)
      ? [...new Glob('*/*.jsonl').scanSync({ cwd: projectsDir })].map(rel => join(projectsDir, rel))
      : [])
  for (const { path } of db.query('SELECT path FROM files').all() as { path: string }[])
    if (!present.has(path)) dropFile(db, path)
  let added = 0
  for (const path of present) added += await indexFile(db, path)
  if (added) log(`history: indexed ${added} messages`)
}

/** Scan now, then on watch events (debounced) and every 60s. Returns stop(). */
export function startIndexer(db: Database, projectsDir: string, log: (msg: string) => void): () => void {
  let running: Promise<void> | undefined
  let again = false
  const run = () => {
    if (running) { again = true; return }
    running = scan(db, projectsDir, log)
      .catch(err => log(`history: scan failed: ${err}`))
      .finally(() => { running = undefined; if (again) { again = false; run() } })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = () => { clearTimeout(timer); timer = setTimeout(run, DEBOUNCE_MS) }
  let watcher: ReturnType<typeof watch> | undefined
  try {
    watcher = watch(projectsDir, { recursive: true }, (_e, file) => { if (file?.endsWith('.jsonl')) debounced() })
  } catch (err) {
    log(`history: watch unavailable, polling only: ${err}`)
  }
  const poll = setInterval(run, POLL_MS)
  run()
  return () => { watcher?.close(); clearInterval(poll); clearTimeout(timer) }
}
