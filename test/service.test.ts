import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render, servicePath } from '../service/install'

const vars = {
  LABEL: 'com.claude.telegram', ROOT: '/r', BUN: '/b/bun', DAEMON: '/r/daemon.ts',
  PATH: '/c:/b', STATE_DIR: '/s', LOG_DIR: '/s/logs',
}
const tmpl = (n: string) => readFileSync(join(import.meta.dir, '..', 'service', n), 'utf8')

describe('service install', () => {
  test('servicePath puts claude and bun dirs first without duplicates', () => {
    expect(servicePath('/usr/local/bin/claude', '/home/u/.bun/bin/bun'))
      .toBe('/usr/local/bin:/home/u/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin')
  })

  test('templates render every placeholder', () => {
    for (const n of ['launchd.plist.tmpl', 'systemd.service.tmpl']) {
      const out = render(tmpl(n), vars)
      expect(out).not.toContain('{{')
      expect(out).toContain('/s/logs/daemon.err.log')
      expect(out).toContain('/c:/b')
    }
  })

  test('render rejects unknown variables', () => {
    expect(() => render('{{NOPE}}', vars)).toThrow('NOPE')
  })
})
