import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSessionStore } from '../sessions/store'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sessions-')), 'sessions.json')

describe('session store (FR2, FR9)', () => {
  test('record sets the current session and persists it', () => {
    const file = tmpFile()
    const store = createSessionStore(file, () => 1000)
    expect(store.current('1')).toBeUndefined()
    store.record('1', 'aaa', 'hello there')
    expect(createSessionStore(file).current('1')).toBe('aaa')
    expect(JSON.parse(readFileSync(file, 'utf8'))['1']).toEqual({
      sessionId: 'aaa', startedAt: 1000, title: 'hello there', history: [], lastActive: 1000,
    })
  })

  test('a new id from resume replaces the current one and keeps its title', () => {
    const store = createSessionStore(tmpFile())
    store.record('1', 'aaa', 'first')
    store.record('1', 'bbb', 'second')
    expect(store.current('1')).toBe('bbb')
    expect(store.list('1')).toEqual([])
    store.new('1')
    expect(store.list('1')[0]).toMatchObject({ sessionId: 'bbb', title: 'first' })
  })

  test('titles are flattened and truncated', () => {
    const store = createSessionStore(tmpFile())
    store.record('1', 'aaa', 'line one\n\nline two ' + 'x'.repeat(100))
    store.new('1')
    const { title } = store.list('1')[0]
    expect(title.length).toBe(60)
    expect(title.startsWith('line one line two x')).toBe(true)
    expect(title.endsWith('…')).toBe(true)
  })

  test('new archives the current session; resume 1 restores it', () => {
    const store = createSessionStore(tmpFile())
    store.record('1', 'old', 'old question')
    store.new('1')
    expect(store.current('1')).toBeUndefined()
    store.record('1', 'fresh', 'fresh question')

    const picked = store.resume('1', 1)
    expect(picked.sessionId).toBe('old')
    expect(store.current('1')).toBe('old')
    expect(store.list('1').map(s => s.sessionId)).toEqual(['fresh'])
  })

  test('new with no current session leaves history unchanged', () => {
    const store = createSessionStore(tmpFile())
    store.new('1')
    expect(store.list('1')).toEqual([])
  })

  test('resume rejects out-of-range numbers', () => {
    const store = createSessionStore(tmpFile())
    store.record('1', 'a', 'q')
    store.new('1')
    expect(() => store.resume('1', 0)).toThrow()
    expect(() => store.resume('1', 2)).toThrow()
    expect(() => store.resume('1', 1.5)).toThrow()
  })

  test('keys are independent', () => {
    const store = createSessionStore(tmpFile())
    store.record('-100:1', 'topic1', 'q')
    store.record('-100:2', 'topic2', 'q')
    expect(store.current('-100:1')).toBe('topic1')
    expect(store.current('-100:2')).toBe('topic2')
  })

  test('a corrupt file is moved aside', () => {
    const file = tmpFile()
    writeFileSync(file, '{not json')
    const store = createSessionStore(file)
    expect(store.current('1')).toBeUndefined()
    expect(existsSync(file)).toBe(false)
  })

  test('the file survives kill -9 mid-write', async () => {
    const file = tmpFile()
    createSessionStore(file).record('1', 'before', 'q')
    // The child writes half of the next save, then SIGKILLs itself.
    const script = `
      import { mock } from 'bun:test'
      import * as fs from 'fs'
      const realWrite = fs.writeFileSync
      mock.module('fs', () => ({
        ...fs,
        writeFileSync: (path, data, opts) => {
          realWrite(path, String(data).slice(0, data.length >> 1), opts)
          process.kill(process.pid, 'SIGKILL')
        },
      }))
      const { createSessionStore } = await import(${JSON.stringify(join(import.meta.dir, '../sessions/store.ts'))})
      createSessionStore(${JSON.stringify(file)}).record('1', 'after', 'q')
    `
    const child = Bun.spawn(['bun', '-e', script])
    expect(await child.exited).not.toBe(0)
    expect(child.signalCode).toBe('SIGKILL')
    expect(createSessionStore(file).current('1')).toBe('before')
  })
})
