import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSessionStore } from '../sessions/store'
import { createSessionLifecycle } from '../sessions/lifecycle'
import { createSessionTools } from '../agent/sessionTools'

test('session tools mirror /new, /resume, /model and /status without interrupting', () => {
  const store = createSessionStore(join(mkdtempSync(join(tmpdir(), 'st-')), 'sessions.json'), () => 0)
  const interrupted: string[] = []
  const lifecycle = createSessionLifecycle(store, k => interrupted.push(k))
  const tools = createSessionTools({ lifecycle, title: k => store.title(k), running: () => true })
  const out = (name: string, args = {}) => tools.call(name, args, '1', {})!.content[0]!.text
  store.record('1', 's1', 'first question')
  expect(out('session_status')).toContain('Session: first question\nModel: default\nTurn: running')
  expect(out('session_set_model', { model: 'opus' })).toContain('opus')
  expect(lifecycle.model('1')).toBe('opus')
  expect(tools.call('session_set_model', { model: 'gpt' }, '1', {})!.isError).toBe(true)
  out('session_new')
  expect(store.current('1')).toBeUndefined()
  expect(out('session_resume')).toContain('1. first question')
  expect(out('session_resume', { n: 1 })).toBe('Done. The next message continues: first question')
  expect(store.current('1')).toBe('s1')
  expect(interrupted).toEqual([])
  expect(tools.call('memory_write', {}, '1', {})).toBeUndefined()
})
