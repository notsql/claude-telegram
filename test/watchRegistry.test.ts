import { expect, test } from 'bun:test'
import { mkdtempSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadSources, recordError, recordItem, saveSources, setCursor, setEnabled, sourcesPath, type Source } from '../watch/registry'

const src = (id: string): Source => ({
  id, title: id, kind: 'stream', enabled: true, config: { command: ['tgcli', 'watch', '--json'] },
  cursor: null, status: 'ok', lastItemAt: null, errors: 0,
})
const dir = () => mkdtempSync(join(tmpdir(), 'tg-watch-'))

test('missing file is empty; save round-trips with mode 0600', () => {
  const d = dir()
  expect(loadSources(d)).toEqual([])
  saveSources(d, [src('a')])
  expect(loadSources(d)).toEqual([src('a')])
  expect(statSync(sourcesPath(d)).mode & 0o777).toBe(0o600)
})

test('invalid file or duplicate ids throw', () => {
  const d = dir()
  writeFileSync(sourcesPath(d), '{"sources":[{"id":"x"}]}')
  expect(() => loadSources(d)).toThrow()
  expect(() => saveSources(d, [src('a'), src('a')])).toThrow('duplicate')
})

test('pause/enable, cursor, health counters', () => {
  const d = dir()
  saveSources(d, [src('a'), src('b')])
  expect(setEnabled(d, 'a', false)).toMatchObject({ enabled: false, status: 'paused' })
  expect(setCursor(d, 'a', 'c1').cursor).toBe('c1')
  expect(setEnabled(d, 'a', true)).toMatchObject({ enabled: true, status: 'ok', cursor: 'c1' })
  recordError(d, 'b')
  expect(recordError(d, 'b')).toMatchObject({ errors: 2, status: 'error' })
  expect(recordItem(d, 'b', 123)).toMatchObject({ errors: 0, status: 'ok', lastItemAt: 123 })
  expect(() => setCursor(d, 'zz', null)).toThrow('unknown source')
  expect(loadSources(d).map(s => s.id)).toEqual(['a', 'b'])
})
