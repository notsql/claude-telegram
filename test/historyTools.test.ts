import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openHistoryDb } from '../history/db'
import { createHistoryTools } from '../history/tools'
import { summarizeHits } from '../history/summarize'
import { createSessionStore } from '../sessions/store'

function setup(summarize?: (q: string, n: string) => Promise<string>) {
  const db = openHistoryDb(':memory:')
  const add = (session: string, ts: number, text: string) =>
    db.run("INSERT INTO messages (session_id, role, ts, text) VALUES (?, 'user', ?, ?)", [session, ts, text])
  db.run("INSERT INTO sessions (session_id, title) VALUES ('dm-old', 'Postgres plan')")
  add('dm-old', Date.parse('2026-09-30T10:00:00Z'), 'we decided the postgres migration runs on Sunday')
  add('topic-1', Date.parse('2026-10-01T10:00:00Z'), 'topic talk about postgres backups')
  add('cli-1', Date.parse('2026-10-02T10:00:00Z'), 'terminal postgres tuning')
  const sessions = createSessionStore(join(mkdtempSync(join(tmpdir(), 'tg-hs-')), 'sessions.json'))
  sessions.record('111', 'dm-old', 'postgres?')
  sessions.new('111')
  sessions.record('111', 'dm-new', 'hello')
  sessions.record('-100:7', 'topic-1', 'hi')
  return createHistoryTools({ db, sessions, summarize })
}
const out = (r: any) => r.content[0].text as string

test('session store maps keys to all their session ids and back', () => {
  const s = createSessionStore(join(mkdtempSync(join(tmpdir(), 'tg-hs-')), 'sessions.json'))
  s.record('111', 'a', 'x'); s.new('111'); s.record('111', 'b', 'y')
  expect(s.sessionIds('111')).toEqual(['b', 'a'])
  expect(s.keyOf('a')).toBe('111')
  expect(s.keyOf('zzz')).toBeUndefined()
  expect(s.sessionIds('nope')).toEqual([])
})

test('historyScope all: archived DM session, topic and CLI hits with dates and keys', async () => {
  const t = setup()
  const r = out(await t.call('history_search', { query: 'postgres' }, '111', { historyScope: 'all' }))
  expect(r).toContain('2026-09-30 · 111 · Postgres plan')
  expect(r).toContain('· -100:7 ·')
  expect(r).toContain('· cli ·')
})

test('AC2: historyScope chat only sees the key\'s own sessions, even when asked for all', async () => {
  const t = setup()
  const r = out(await t.call('history_search', { query: 'postgres migration', scope: 'all' }, '-100:7', { historyScope: 'chat' }))
  expect(r).toContain('topic talk')
  expect(r).not.toContain('Sunday')
  expect(r).not.toContain('terminal')
  expect(out(await t.call('history_search', { query: 'postgres' }, '111', { historyScope: 'all' }))).toContain('terminal')
  expect(out(await t.call('history_search', { query: 'postgres', scope: 'chat' }, '111', { historyScope: 'all' }))).not.toContain('terminal')
})

test('historyScope none hides and refuses; unset policy means chat', async () => {
  const t = setup()
  expect(t.list({ historyScope: 'none' })).toEqual([])
  expect((await t.call('history_search', { query: 'postgres' }, '111', { historyScope: 'none' }))?.isError).toBe(true)
  expect(out(await t.call('history_search', { query: 'postgres' }, '-100:7', {}))).not.toContain('cli')
  expect(await t.call('memory_read', {}, '111', {})).toBeUndefined()
})

test('summarize returns a cited answer plus the sources', async () => {
  const t = setup(async (q, numbered) => `answer for ${q} citing [1] from ${numbered.split('\n')[0].slice(4, 14)}`)
  const r = out(await t.call('history_search', { query: 'postgres migration', summarize: true }, '111', { historyScope: 'all' }))
  expect(r).toStartWith('answer for postgres migration citing [1] from 2026-09-30')
  expect(r).toContain('Sources:\n[1]')
})

test('summarizeHits asks for citations and returns the answer', async () => {
  let prompt = ''
  const a = await summarizeHits('q?', '[1] x', async (_agent, input) => { prompt = input; return { answer: 'A [1]' } })
  expect(a).toBe('A [1]')
  expect(prompt).toContain('Cite excerpts as [n]')
  expect(prompt).toContain('Question: q?')
})

test('summarizeSession sends the newest messages in order and returns the summary', async () => {
  const { summarizeSession } = await import('../history/summarize')
  const { openHistoryDb } = await import('../history/db')
  const db = openHistoryDb(':memory:')
  db.run("INSERT INTO messages (session_id, role, text) VALUES ('s', 'user', 'old ' || printf('%.30000c', 'x')), ('s', 'user', 'use pnpm'), ('s', 'assistant', 'ok, pnpm it is')")
  let input = ''
  const r = await summarizeSession(db, 's', async (_a, i) => { input = i; return { summary: 'Uses pnpm.' } })
  expect(r).toBe('Uses pnpm.')
  expect(input).toEndWith('user: use pnpm\nassistant: ok, pnpm it is')
  expect(input).not.toContain('old ')
  expect(await summarizeSession(db, 'none', async () => { throw new Error('not called') })).toBe('')
})
