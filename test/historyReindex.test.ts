import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openHistoryDb } from '../history/db'
import { indexFile, scan } from '../history/indexer'
import { reindex } from '../history/reindex'
import { search } from '../history/search'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-reidx-'))
  const projects = join(dir, 'projects')
  mkdirSync(join(projects, 'p'), { recursive: true })
  copyFileSync(join(import.meta.dir, 'fixtures/history/daemon.jsonl'), join(projects, 'p', '11111111-2222-3333-4444-555555555555.jsonl'))
  copyFileSync(join(import.meta.dir, 'fixtures/history/cli.jsonl'), join(projects, 'p', '66666666-7777-8888-9999-000000000000.jsonl'))
  return { dbPath: join(dir, 'history.db'), projects }
}
const results = (db: ReturnType<typeof openHistoryDb>) =>
  ['pnpm', 'deploy ship', 'package manager'].map(q => search(db, q, { scope: { all: true } }).map(({ score, ...h }) => h))

test('AC4: deleting history.db and reindexing gives identical search results', async () => {
  const { dbPath, projects } = setup()
  let db = openHistoryDb(dbPath)
  await scan(db, projects)
  const before = results(db)
  db.close()
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true })
  db = openHistoryDb(dbPath)
  await reindex(db, projects)
  expect(results(db)).toEqual(before)
  expect(before[0].length).toBeGreaterThan(0)
})

test('reindex in place over a live index does not duplicate', async () => {
  const { dbPath, projects } = setup()
  const db = openHistoryDb(dbPath)
  await scan(db, projects)
  const before = results(db)
  await reindex(db, projects)
  expect(results(db)).toEqual(before)
})

test('two indexers on the same file never insert a chunk twice', async () => {
  const { dbPath, projects } = setup()
  const a = openHistoryDb(dbPath), b = openHistoryDb(dbPath)
  const file = join(projects, 'p', '11111111-2222-3333-4444-555555555555.jsonl')
  const [x, y] = await Promise.all([indexFile(a, file), indexFile(b, file)])
  expect(x + y).toBe(4)
  expect(a.query('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 4 })
})
