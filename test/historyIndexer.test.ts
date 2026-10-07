import { expect, test } from 'bun:test'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openHistoryDb } from '../history/db'
import { indexFile, scan } from '../history/indexer'

const FIXTURE = join(import.meta.dir, 'fixtures/history/daemon.jsonl')
const S = '11111111-2222-3333-4444-555555555555'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-idx-'))
  const projects = join(dir, 'projects')
  mkdirSync(join(projects, '-home-u-workspace'), { recursive: true })
  return { dbPath: join(dir, 'history.db'), projects, file: join(projects, '-home-u-workspace', `${S}.jsonl`) }
}
const count = (db: ReturnType<typeof openHistoryDb>) => (db.query('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n

test('indexes messages, session title and Telegram ids', async () => {
  const { dbPath, projects, file } = setup()
  copyFileSync(FIXTURE, file)
  const db = openHistoryDb(dbPath)
  await scan(db, projects)
  expect(count(db)).toBe(4)
  expect(db.query('SELECT title, project FROM sessions').get()).toEqual({ title: 'Package manager question', project: '-home-u-workspace' })
  expect(db.query("SELECT tg_chat, tg_thread, tg_msg FROM messages WHERE role = 'user'").get()).toEqual({ tg_chat: '-1001234567890', tg_thread: '7', tg_msg: '42' })
})

test('AC3: restart after partial indexing does not duplicate rows', async () => {
  const { dbPath, projects, file } = setup()
  const lines = readFileSync(FIXTURE, 'utf8').split('\n')
  // First run sees half the file plus a partial line, as if killed mid-write.
  writeFileSync(file, lines.slice(0, 5).join('\n') + '\n' + lines[5].slice(0, 30))
  let db = openHistoryDb(dbPath)
  await scan(db, projects)
  const first = count(db)
  db.close()
  writeFileSync(file, lines.join('\n'))
  db = openHistoryDb(dbPath)
  await scan(db, projects)
  await scan(db, projects)
  expect(first).toBe(2)
  expect(count(db)).toBe(4)
})

test('appends are read from the stored offset only', async () => {
  const { dbPath, file } = setup()
  copyFileSync(FIXTURE, file)
  const db = openHistoryDb(dbPath)
  expect(await indexFile(db, file)).toBe(4)
  expect(await indexFile(db, file)).toBe(0)
  appendFileSync(file, JSON.stringify({ type: 'user', sessionId: S, timestamp: '2026-10-07T03:00:00Z', message: { content: 'later' } }) + '\n')
  expect(await indexFile(db, file)).toBe(1)
})

test('FR9: deleted transcripts lose their rows; truncated ones are re-read', async () => {
  const { dbPath, projects, file } = setup()
  copyFileSync(FIXTURE, file)
  const db = openHistoryDb(dbPath)
  await scan(db, projects)
  writeFileSync(file, readFileSync(FIXTURE, 'utf8').split('\n').slice(0, 2).join('\n') + '\n')
  await scan(db, projects)
  expect(count(db)).toBe(1)
  rmSync(file)
  await scan(db, projects)
  expect(count(db)).toBe(0)
  expect(db.query('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 })
  expect(db.query("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'pnpm'").get()).toEqual({ n: 0 })
})
