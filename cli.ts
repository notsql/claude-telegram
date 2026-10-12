#!/usr/bin/env bun
/**
 * Single entry point (011 FR1): `tgc <command>`, also the `bun build --compile`
 * entry. Only the entry sees `import.meta.main`, so commands call the scripts'
 * exported `main()` rather than their own guards. Handlers import lazily so
 * `help` never loads the daemon.
 */

import pkg from './package.json' with { type: 'json' }

type Command = { usage: string; run: (args: string[]) => Promise<unknown> }

export const commands: Record<string, Command> = {
  start: { usage: 'start              run the daemon', run: () => import('./daemon.ts') },
  reindex: { usage: 'reindex            rebuild the history index', run: async () => (await import('./history/reindex.ts')).main() },
  memory: { usage: 'memory <args…>     memory bridge (status, hook, import, …)', run: async args => (await import('./memory/bridge.ts')).main(args) },
}

export const usage = () =>
  `usage: tgc <command>\n\n${Object.values(commands).map(c => `  ${c.usage}`).join('\n')}\n  help               show this text\n  --version          print the version\n`

/** Returns the exit code; `start` keeps running on its own after this. */
export async function run(argv: string[], table = commands): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(usage())
    return 0
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${pkg.version}\n`)
    return 0
  }
  const c = table[cmd]
  if (!c) {
    process.stderr.write(`unknown command: ${cmd}\n${usage()}`)
    return 2
  }
  await c.run(rest)
  return 0
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2))
}
