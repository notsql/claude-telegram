import { describe, expect, test } from 'bun:test'
import { browserArgv, browserUrl } from '../browser/server'
import { signinUrl } from '../browser/signin'
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

describe('/signin (015 T1502)', () => {
  test('adds https:// to a bare host and keeps http(s) URLs', () => {
    expect(signinUrl('portal.spgroup.com.sg')).toBe('https://portal.spgroup.com.sg/')
    expect(signinUrl(' https://example.com/login?x=1 ')).toBe('https://example.com/login?x=1')
    expect(signinUrl('http://intranet.local')).toBe('http://intranet.local/')
  })

  test('rejects empty input, other schemes and text with spaces', () => {
    for (const bad of ['', '   ', 'file:///etc/passwd', 'javascript://x', 'two words', 'https://'])
      expect(signinUrl(bad)).toBeNull()
  })
})
