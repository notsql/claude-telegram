import { describe, expect, test } from 'bun:test'
import { parseLaunchctlPrint, render, renderUnit, servicePath } from '../service/install'

const u = {
  cmd: ['/Users/a b/bin/tgc', 'start'], claude: '/opt/homebrew/bin/claude',
  stateDir: '/s t', logDir: '/s t/logs',
}

describe('service install', () => {
  test('servicePath puts claude and self dirs first without duplicates', () => {
    expect(servicePath('/usr/local/bin/claude', '/home/u/.bun/bin/bun'))
      .toBe('/usr/local/bin:/home/u/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin')
  })

  test('launchd unit runs the self command, one <string> per arg (FR4)', () => {
    const out = renderUnit('launchd', { ...u, cmd: ['/Users/a & b/tgc', 'start'] })
    expect(out).not.toContain('{{')
    expect(out).toContain('<array>\n    <string>/Users/a &amp; b/tgc</string>\n    <string>start</string>\n  </array>')
    expect(out).toContain('<key>WorkingDirectory</key><string>/s t</string>')
    expect(out).toContain('<string>/opt/homebrew/bin:/Users/a &amp; b:/usr/local/bin:/usr/bin:/bin</string>')
    expect(out).toContain('/s t/logs/daemon.err.log')
  })

  test('systemd unit quotes each arg and escapes specifiers', () => {
    const out = renderUnit('systemd', { ...u, cmd: ['/Users/a b/100%/bun', '/r/cli.ts', 'start'] })
    expect(out).not.toContain('{{')
    expect(out).toContain('ExecStart="/Users/a b/100%%/bun" "/r/cli.ts" "start"\n')
    expect(out).toContain('WorkingDirectory=/s t\n')
    expect(out).toContain('Environment="PATH=/opt/homebrew/bin:/Users/a b/100%%:/usr/local/bin:/usr/bin:/bin"')
  })

  test('systemd escapes $ in ExecStart only', () => {
    const out = renderUnit('systemd', { ...u, cmd: ['/x/$y/tgc', 'start'] })
    expect(out).toContain('ExecStart="/x/$$y/tgc" "start"\n')
    expect(out).toContain('Environment="PATH=/opt/homebrew/bin:/x/$y:/usr/local/bin:/usr/bin:/bin"')
  })

  test('render rejects unknown variables', () => {
    expect(() => render('{{NOPE}}', {})).toThrow('NOPE')
  })

  test('parseLaunchctlPrint reads the top-level state and pid', () => {
    const running = 'gui/501/x = {\n\tactive count = 1\n\tstate = running\n\n\tpid = 36322\n\tendpoints = {\n\t\t"a" = {\n\t\t\tstate = active\n'
    expect(parseLaunchctlPrint(running)).toEqual({ running: true, pid: 36322 })
    expect(parseLaunchctlPrint('gui/501/x = {\n\tstate = not running\n\t\tstate = active\n')).toEqual({ running: false })
  })
})
