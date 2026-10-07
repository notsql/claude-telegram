import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createMemoryStore, parse } from '../memory/store'
import { projectDirName } from '../memory/paths'
import { refusal, slug } from '../memory/guard'

const fresh = () => createMemoryStore(mkdtempSync(join(tmpdir(), 'tg-mem-')))
const pnpm = { type: 'feedback' as const, name: 'Prefers pnpm', description: 'User uses pnpm, not npm', body: 'Use pnpm.' }

test('create writes the file with frontmatter and an index line', () => {
  const s = fresh()
  const r = s.write({ ...pnpm, metadata: { session_key: '-100:7', source: 'telegram' } })
  expect(r.op).toBe('create')
  expect(r.entry).toMatchObject({ name: 'prefers-pnpm', type: 'feedback', metadata: { session_key: '-100:7', source: 'telegram' } })
  expect(readFileSync(join(s.dir, 'prefers-pnpm.md'), 'utf8')).toContain('metadata:\n  type: feedback\n  session_key: "-100:7"')
  expect(s.index()).toBe('- [prefers-pnpm](prefers-pnpm.md) — User uses pnpm, not npm\n')
})

test('update replaces the index line, keeps one entry and backs up the old version', () => {
  const s = fresh()
  s.write(pnpm)
  const r = s.write({ ...pnpm, description: 'Always pnpm for JS' })
  expect(r.op).toBe('update')
  expect(readFileSync(r.backup!, 'utf8')).toContain('User uses pnpm, not npm')
  expect(s.index()).toBe('- [prefers-pnpm](prefers-pnpm.md) — Always pnpm for JS\n')
  expect(s.list()).toHaveLength(1)
})

test('delete removes the file and only its index line', () => {
  const s = fresh()
  writeFileSync(join(s.dir, 'MEMORY.md'), '- [Other](other.md) — native entry\n')
  s.write(pnpm)
  expect(s.delete('prefers-pnpm')).toBeDefined()
  expect(existsSync(join(s.dir, 'prefers-pnpm.md'))).toBe(false)
  expect(s.index()).toBe('- [Other](other.md) — native entry\n')
  expect(s.delete('prefers-pnpm')).toBeUndefined()
})

test('restore undoes a create, an update and a delete', () => {
  const s = fresh()
  s.write(pnpm)
  s.restore('prefers-pnpm', undefined)
  expect(s.list()).toHaveLength(0)
  expect(s.index()).toBe('')

  s.write(pnpm)
  const upd = s.write({ ...pnpm, description: 'changed' })
  s.restore('prefers-pnpm', upd.backup)
  expect(s.read('prefers-pnpm')!.description).toBe('User uses pnpm, not npm')

  const del = s.delete('prefers-pnpm')!
  s.restore('prefers-pnpm', del.backup)
  expect(s.index()).toContain('prefers-pnpm.md')
})

test('reads native files with a top-level type, and searches by keyword', () => {
  const s = fresh()
  writeFileSync(join(s.dir, 'tz.md'), '---\nname: tz\ndescription: "Timezone: Singapore"\ntype: user\n---\nUTC+8\n')
  s.write(pnpm)
  expect(s.read('tz')).toMatchObject({ type: 'user', description: 'Timezone: Singapore' })
  expect(s.search('which timezone singapore').map(e => e.name)).toEqual(['tz'])
  expect(s.search('pnpm').map(e => e.name)).toEqual(['prefers-pnpm'])
})

test('frontmatter round-trips quoted values', () => {
  expect(parse('---\nname: x\ndescription: "a: b"\nmetadata:\n  type: user\n---\nbody')).toMatchObject({ description: 'a: b', type: 'user', body: 'body' })
})

test('project dir name replaces every non-alphanumeric char (T401)', () => {
  expect(projectDirName('/no/such/dir.x_y')).toBe('-no-such-dir-x-y')
})

describe('guard (AC7)', () => {
  test('refuses secrets', () => {
    expect(refusal('remember my API key sk-ant-api03-abcdefghijklmnop1234')).toContain('API key')
    expect(refusal('bot token 123456789:AAHfakefakefakefakefakefakefakefake1')).toContain('Telegram')
    expect(refusal('password: hunter2hunter')).toContain('credential')
    expect(refusal('User prefers pnpm over npm')).toBeNull()
    expect(() => fresh().write({ ...pnpm, body: 'key is sk-abcdefghijklmnopqrstuv' })).toThrow('secrets are never saved')
  })

  test('caps file size and slugs names', () => {
    expect(refusal('x'.repeat(3000))).toContain('2048-byte limit')
    expect(slug('  Prefers PNPM! / over npm ')).toBe('prefers-pnpm-over-npm')
    expect(slug('../../etc')).toBe('etc')
  })
})
