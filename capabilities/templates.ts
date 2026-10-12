// Installer templates (012 FR6): fixed argv shapes, validated names, paired uninstall.
export type Candidate =
  | { kind: 'brew' | 'brew-cask' | 'npm' | 'uv' | 'pipx' | 'plugin'; name: string }
  | { kind: 'mcp'; name: string; transport: 'http'; url: string }
  | { kind: 'mcp'; name: string; transport: 'stdio'; command: string[] }
  | { kind: 'exact'; name: string; argv: string[]; uninstall?: string[] }

export type Commands = { install: string[]; uninstall: string[] | null }

// Every pattern requires an alphanumeric (or @scope) first char, so `--force`-style argv injection fails.
const BREW = /^[a-z0-9@+][a-z0-9@+._/-]{0,79}$/
const NPM = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const PEP508 = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i
const MCP = /^[a-z0-9][a-z0-9-]{0,47}$/
const PLUGIN = /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/

function check(name: string, re: RegExp, kind: string): void {
  if (typeof name !== 'string' || !re.test(name) || name.includes('..') || (kind === 'npm' && name.length > 214))
    throw new Error(`invalid ${kind} name: ${JSON.stringify(name)}`)
}

function argvOk(argv: unknown): argv is string[] {
  return Array.isArray(argv) && argv.length > 0 && argv.every(a => typeof a === 'string' && a.length > 0 && !a.includes('\0'))
}

/** Validate a candidate and build its install argv plus the matching uninstall argv. Throws on invalid input. */
export function buildCommands(c: Candidate): Commands {
  switch (c.kind) {
    case 'brew':
      check(c.name, BREW, c.kind)
      return { install: ['brew', 'install', c.name], uninstall: ['brew', 'uninstall', c.name] }
    case 'brew-cask':
      check(c.name, BREW, c.kind)
      return { install: ['brew', 'install', '--cask', c.name], uninstall: ['brew', 'uninstall', '--cask', c.name] }
    case 'npm':
      check(c.name, NPM, c.kind)
      return { install: ['npm', 'i', '-g', c.name], uninstall: ['npm', 'rm', '-g', c.name] }
    case 'uv':
      check(c.name, PEP508, c.kind)
      return { install: ['uv', 'tool', 'install', c.name], uninstall: ['uv', 'tool', 'uninstall', c.name] }
    case 'pipx':
      check(c.name, PEP508, c.kind)
      return { install: ['pipx', 'install', c.name], uninstall: ['pipx', 'uninstall', c.name] }
    case 'plugin':
      check(c.name, PLUGIN, c.kind)
      return { install: ['claude', 'plugin', 'install', c.name], uninstall: ['claude', 'plugin', 'uninstall', c.name] }
    case 'mcp': {
      check(c.name, MCP, c.kind)
      const head = ['claude', 'mcp', 'add', '--scope', 'user', '--transport', c.transport, c.name]
      const uninstall = ['claude', 'mcp', 'remove', '--scope', 'user', c.name]
      if (c.transport === 'http') {
        let u: URL
        try { u = new URL(c.url) } catch { throw new Error(`invalid mcp url: ${JSON.stringify(c.url)}`) }
        if (u.protocol !== 'https:') throw new Error(`mcp url must be https: ${JSON.stringify(c.url)}`)
        return { install: [...head, u.href], uninstall }
      }
      if (c.transport === 'stdio') {
        if (!argvOk(c.command)) throw new Error('invalid mcp stdio command')
        return { install: [...head, '--', ...c.command], uninstall }
      }
      throw new Error(`invalid mcp transport: ${JSON.stringify((c as { transport: unknown }).transport)}`)
    }
    case 'exact':
      // T3: the owner approves this argv verbatim; it still runs without a shell.
      if (!argvOk(c.argv)) throw new Error('invalid exact argv')
      if (c.uninstall !== undefined && !argvOk(c.uninstall)) throw new Error('invalid exact uninstall argv')
      return { install: [...c.argv], uninstall: c.uninstall ? [...c.uninstall] : null }
    default:
      throw new Error(`unknown template: ${JSON.stringify((c as { kind: unknown }).kind)}`)
  }
}
