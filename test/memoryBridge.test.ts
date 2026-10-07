import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bridgePaths, hookEnabled, importEnabled, sessionStartOutput, setHook, setImport } from '../memory/bridge'
import { createMemoryStore } from '../memory/store'
import { userDir } from '../memory/paths'

const setup = () => {
  const base = mkdtempSync(join(tmpdir(), 'tg-cfg-'))
  return bridgePaths('/mem/root', base)
}

test('(a) the import is added once and removed without touching the rest (FR10)', () => {
  const p = setup()
  writeFileSync(p.claudeMd, '# Mine\n\nKeep this.\n')
  setImport(p, true)
  setImport(p, true)
  expect(readFileSync(p.claudeMd, 'utf8')).toBe('# Mine\n\nKeep this.\n\n@/mem/root/MEMORY.md\n')
  expect(importEnabled(p)).toBe(true)
  expect(readFileSync(`${p.claudeMd}.bak`, 'utf8')).toContain('@/mem/root/MEMORY.md')
  setImport(p, false)
  expect(readFileSync(p.claudeMd, 'utf8')).toBe('# Mine\n\nKeep this.\n')
  expect(importEnabled(p)).toBe(false)
})

test('(b) the hook joins existing SessionStart hooks and is removed cleanly', () => {
  const p = setup()
  const theirs = { hooks: [{ type: 'command', command: 'echo hi' }] }
  writeFileSync(p.settings, JSON.stringify({ model: 'opus', hooks: { SessionStart: [theirs] } }))
  setHook(p, true)
  setHook(p, true)
  const on = JSON.parse(readFileSync(p.settings, 'utf8'))
  expect(on.hooks.SessionStart).toHaveLength(2)
  expect(on.hooks.SessionStart[1].hooks[0].command).toEndWith('bridge.ts" session-start')
  expect(hookEnabled(p)).toBe(true)
  setHook(p, false)
  expect(JSON.parse(readFileSync(p.settings, 'utf8'))).toEqual({ model: 'opus', hooks: { SessionStart: [theirs] } })
})

test('the terminal hook prints the owners\' user model, but nothing in daemon turns', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-mem-'))
  createMemoryStore(userDir(root, '42')).write({ type: 'user', name: 'name', description: 'Preferred name', body: 'Kai' })
  const out = sessionStartOutput(root, ['42', '7'], {}) as any
  expect(out.hookSpecificOutput.additionalContext).toBe('<user_model user_id="42">\n- Preferred name: Kai\n</user_model>')
  expect(sessionStartOutput(root, ['42'], { TG_SESSION_KEY: '1' })).toEqual({})
})
