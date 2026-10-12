/**
 * How to run this program again (011 FR4), for the service unit and hooks:
 * the compiled binary runs itself; from source it is `bun <repo>/cli.ts`.
 */

import { dirname, join } from 'path'

const ROOT = dirname(import.meta.dir)

export function selfCommand(args: string[]): string[] {
  if (Bun.isStandaloneExecutable) return [process.execPath, ...args]
  // The PATH symlink, not `process.execPath`: Homebrew resolves that to a
  // versioned Cellar dir that vanishes on `brew upgrade bun`.
  return [Bun.which('bun') ?? process.execPath, join(ROOT, 'cli.ts'), ...args]
}
