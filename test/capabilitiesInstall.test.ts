import { describe, expect, test } from 'bun:test'
import { buildCommands, type Candidate } from '../capabilities/templates.ts'
import { bunSpawner, runArgv, type Spawner } from '../capabilities/install.ts'

describe('templates', () => {
  test('each install pairs with its uninstall', () => {
    expect(buildCommands({ kind: 'brew', name: 'imagemagick' })).toEqual({
      install: ['brew', 'install', 'imagemagick'], uninstall: ['brew', 'uninstall', 'imagemagick'] })
    expect(buildCommands({ kind: 'brew', name: 'homebrew/core/node@20' }).install).toEqual(['brew', 'install', 'homebrew/core/node@20'])
    expect(buildCommands({ kind: 'brew-cask', name: 'firefox' })).toEqual({
      install: ['brew', 'install', '--cask', 'firefox'], uninstall: ['brew', 'uninstall', '--cask', 'firefox'] })
    expect(buildCommands({ kind: 'npm', name: '@scope/pkg' })).toEqual({
      install: ['npm', 'i', '-g', '@scope/pkg'], uninstall: ['npm', 'rm', '-g', '@scope/pkg'] })
    expect(buildCommands({ kind: 'uv', name: 'Ruff' })).toEqual({
      install: ['uv', 'tool', 'install', 'Ruff'], uninstall: ['uv', 'tool', 'uninstall', 'Ruff'] })
    expect(buildCommands({ kind: 'pipx', name: 'yt-dlp' })).toEqual({
      install: ['pipx', 'install', 'yt-dlp'], uninstall: ['pipx', 'uninstall', 'yt-dlp'] })
    expect(buildCommands({ kind: 'plugin', name: 'foo@market' })).toEqual({
      install: ['claude', 'plugin', 'install', 'foo@market'], uninstall: ['claude', 'plugin', 'uninstall', 'foo@market'] })
    expect(buildCommands({ kind: 'mcp', name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp' })).toEqual({
      install: ['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'notion', 'https://mcp.notion.com/mcp'],
      uninstall: ['claude', 'mcp', 'remove', '--scope', 'user', 'notion'] })
    expect(buildCommands({ kind: 'mcp', name: 'fs', transport: 'stdio', command: ['npx', '-y', 'srv'] }).install)
      .toEqual(['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'fs', '--', 'npx', '-y', 'srv'])
    expect(buildCommands({ kind: 'exact', name: 'x', argv: ['/bin/echo', 'a; b'] })).toEqual({ install: ['/bin/echo', 'a; b'], uninstall: null })
  })

  test('AC4: injected names fail validation', () => {
    const bad = ['x; rm -rf ~', 'foo; rm -rf ~', '--force', '-g', 'a b', 'a|b', '$(id)', '`id`', 'a&&b', 'a\nb', '../etc', '']
    for (const name of bad)
      for (const kind of ['brew', 'brew-cask', 'npm', 'uv', 'pipx', 'plugin'] as const)
        expect(() => buildCommands({ kind, name })).toThrow()
    expect(() => buildCommands({ kind: 'mcp', name: 'x; rm -rf ~', transport: 'http', url: 'https://a.b' })).toThrow()
    expect(() => buildCommands({ kind: 'mcp', name: '--scope', transport: 'http', url: 'https://a.b' })).toThrow()
    expect(() => buildCommands({ kind: 'plugin', name: 'noat' })).toThrow()
    expect(() => buildCommands({ kind: 'brew', name: 'x'.repeat(81) })).toThrow()
  })

  test('mcp url must be https; transport and argv are checked', () => {
    expect(() => buildCommands({ kind: 'mcp', name: 'a', transport: 'http', url: 'http://a.b' })).toThrow()
    expect(() => buildCommands({ kind: 'mcp', name: 'a', transport: 'http', url: 'not a url' })).toThrow()
    expect(() => buildCommands({ kind: 'mcp', name: 'a', transport: 'stdio', command: [] })).toThrow()
    expect(() => buildCommands({ kind: 'mcp', name: 'a', transport: 'sse', url: 'https://a.b' } as unknown as Candidate)).toThrow()
    expect(() => buildCommands({ kind: 'exact', name: 'x', argv: [] })).toThrow()
    expect(() => buildCommands({ kind: 'shell', name: 'x' } as unknown as Candidate)).toThrow()
  })
})

describe('runArgv', () => {
  test('passes argv straight to the spawner with the timeout', async () => {
    const calls: [string[], number][] = []
    const spawn: Spawner = async (argv, t) => { calls.push([argv, t]); return { code: 0, stdout: 'ok\n', stderr: 'warn\n', timedOut: false } }
    const r = await runArgv(['brew', 'install', 'jq'], { spawn, timeoutMs: 1234 })
    expect(calls).toEqual([[['brew', 'install', 'jq'], 1234]])
    expect(r).toEqual({ ok: true, code: 0, timedOut: false, output: 'ok\nwarn' })
  })

  test('nonzero exit, timeout and spawn errors fail', async () => {
    expect((await runArgv(['x'], { spawn: async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false }) })).ok).toBe(false)
    expect(await runArgv(['x'], { spawn: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }) }))
      .toEqual({ ok: false, code: null, timedOut: true, output: '' })
    const r = await runArgv(['x'], { spawn: async () => { throw new Error('ENOENT') } })
    expect(r).toEqual({ ok: false, code: null, timedOut: false, output: 'ENOENT' })
  })

  test('real spawner uses no shell and enforces timeout (harmless commands only)', async () => {
    const r = await bunSpawner(['/bin/echo', 'a; echo injected'], 5000)
    expect(r.stdout).toBe('a; echo injected\n')
    const slow = await bunSpawner(['/bin/sleep', '5'], 100)
    expect(slow.timedOut).toBe(true)
  })
})
