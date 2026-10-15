import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { browserArgv, browserUrl } from '../browser/server'
import { SIGNIN_CALLBACK, signinUrl, signinView } from '../browser/signin'
import { policyView } from '../telegram/policyUi'
import { turnArgv } from '../agent/runner'

describe('shared browser (015 T1501)', () => {
  test('argv: pinned package under Bun, bound to 127.0.0.1, persistent WebKit profile shared by clients', () => {
    const argv = browserArgv(4321, '/state/browser')
    expect(argv.slice(1, 4)).toEqual(['x', '--bun', '@playwright/mcp@0.0.83'])
    const flag = (f: string) => argv[argv.indexOf(f) + 1]
    expect(flag('--host')).toBe('127.0.0.1')
    expect(flag('--allowed-hosts')).toBe('127.0.0.1:4321')
    expect(flag('--port')).toBe('4321')
    expect(flag('--browser')).toBe('webkit')
    expect(flag('--user-data-dir')).toBe('/state/browser/profile')
    expect(argv).toContain('--shared-browser-context')
    expect(flag('--viewport-size')).toBe('960x720')
    expect(argv).not.toContain('--headless')
    expect(argv).not.toContain('--isolated')
  })

  const opts = { settingsFile: '/s.json', mcpPort: 1, mcpToken: 't', hookToken: 'h', cwd: '/', maxTurns: 5, policyArgs: [] }
  const servers = (o: object) => { const a = turnArgv('k', 'hi', { ...opts, ...o }); return JSON.parse(a[a.indexOf('--mcp-config') + 1]).mcpServers }

  test('turns get the browser server only when it runs (FR2, AC4)', () => {
    expect(Object.keys(servers({}))).toEqual(['tg'])
    expect(servers({ browserPort: 4321 }).browser).toEqual({ type: 'http', url: browserUrl(4321) })
  })
})

describe('🌐 Browser sign-in (015 T1502, T1504)', () => {
  test('adds https:// to a bare host and keeps http(s) URLs', () => {
    expect(signinUrl('portal.spgroup.com.sg')).toBe('https://portal.spgroup.com.sg/')
    expect(signinUrl(' https://example.com/login?x=1 ')).toBe('https://example.com/login?x=1')
    expect(signinUrl('http://intranet.local')).toBe('http://intranet.local/')
  })

  test('a ⚙️ Settings page, shown only when the browser runs; its buttons round-trip', () => {
    const data = (o: { signin?: boolean }) => policyView('5', {}, o).keyboard.inline_keyboard.flat().map(b => 'callback_data' in b ? b.callback_data : '')
    expect(data({ signin: true })).toContain('web:m')
    expect(data({})).not.toContain('web:m')
    const page = signinView().keyboard.inline_keyboard.flat().map(b => 'callback_data' in b ? b.callback_data! : '')
    expect(page).toEqual(['web:a', 'pol:m'])
    for (const d of page.filter(d => d.startsWith('web:'))) expect(SIGNIN_CALLBACK.test(d)).toBe(true)
  })

  test('rejects empty input, other schemes and text with spaces', () => {
    for (const bad of ['', '   ', 'file:///etc/passwd', 'javascript://x', 'two words', 'https://'])
      expect(signinUrl(bad)).toBeNull()
  })
})

test('ladder: login sites use the shared browser and hand the sign-in to the owner (015 T1503)', () => {
  const skill = readFileSync(join(import.meta.dir, '..', 'assets', 'skills', 'tg-capability-ladder', 'SKILL.md'), 'utf8')
  expect(skill).toContain('mcp__browser__')
  expect(skill).toContain('🌐 Browser sign-in')
  expect(skill).toMatch(/never ask for a password/i)
})
