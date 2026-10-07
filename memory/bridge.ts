#!/usr/bin/env bun
/**
 * CLI bridge (004 FR10), opt-in and reversible, run by the owner in a terminal:
 *
 *   bun memory/bridge.ts status
 *   bun memory/bridge.ts enable  [--import] [--hook] [--yes]
 *   bun memory/bridge.ts disable [--import] [--hook] [--yes]
 *
 * (a) `--import` adds `@<memory>/MEMORY.md` to `~/.claude/CLAUDE.md`, so
 *     terminal sessions load the shared index.
 * (b) `--hook` adds a `SessionStart` command hook to `~/.claude/settings.json`
 *     that runs `bridge.ts session-start`, which prints the owners' user
 *     model. It prints nothing inside daemon turns (TG_SESSION_KEY is set),
 *     which inject their own.
 * With neither flag, both. Each change is shown and confirmed first, and the
 * edited file is copied to `<file>.bak` before it is written.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { claudeDir, memoryRoot, userDir } from './paths.ts'
import { createMemoryStore } from './store.ts'

const HOOK_MARK = 'bridge.ts" session-start'

export type BridgePaths = { claudeMd: string; settings: string; root: string; script: string }

export function bridgePaths(root: string, base = claudeDir()): BridgePaths {
  return {
    claudeMd: join(base, 'CLAUDE.md'),
    settings: join(base, 'settings.json'),
    root,
    script: join(import.meta.dir, 'bridge.ts'),
  }
}

const read = (path: string) => { try { return readFileSync(path, 'utf8') } catch { return '' } }
const importLine = (p: BridgePaths) => `@${join(p.root, 'MEMORY.md')}`

function save(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  writeFileSync(path, text)
}

type HookEntry = { hooks?: { type?: string; command?: string }[] }
type Settings = { hooks?: { SessionStart?: HookEntry[] } & Record<string, unknown> } & Record<string, unknown>

const settingsOf = (p: BridgePaths): Settings => JSON.parse(read(p.settings) || '{}')
const isOurs = (e: HookEntry) => !!e.hooks?.some(h => h.command?.includes(HOOK_MARK))

export function importEnabled(p: BridgePaths): boolean {
  return read(p.claudeMd).split('\n').includes(importLine(p))
}

export function hookEnabled(p: BridgePaths): boolean {
  return (settingsOf(p).hooks?.SessionStart ?? []).some(isOurs)
}

export function setImport(p: BridgePaths, on: boolean): void {
  const lines = read(p.claudeMd).split('\n').filter(l => l !== importLine(p))
  while (lines.length && lines.at(-1) === '') lines.pop()
  if (on) lines.push('', importLine(p))
  save(p.claudeMd, lines.join('\n').replace(/^\n+/, '') + '\n')
}

export function setHook(p: BridgePaths, on: boolean): void {
  const s = settingsOf(p)
  const hooks = s.hooks ??= {}
  const entries = (hooks.SessionStart ?? []).filter(e => !isOurs(e))
  if (on) entries.push({ hooks: [{ type: 'command', command: `bun "${p.script}" session-start` }] })
  if (entries.length) hooks.SessionStart = entries
  else delete hooks.SessionStart
  if (!Object.keys(hooks).length) delete s.hooks
  save(p.settings, JSON.stringify(s, null, 2) + '\n')
}

/** `SessionStart` output for terminal sessions: the owners' user model. */
export function sessionStartOutput(root: string, owners: string[], env: Record<string, string | undefined>) {
  if (env.TG_SESSION_KEY) return {}
  const lines: string[] = []
  for (const id of owners) {
    const files = createMemoryStore(userDir(root, id)).list().sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (files.length) lines.push(`<user_model user_id="${id}">`, ...files.map(e => `- ${e.description}: ${e.body}`), '</user_model>')
  }
  return lines.length ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } } : {}
}

/** The daemon's shared root, from the same env and state `.env` the daemon reads. */
async function sharedRoot(): Promise<string> {
  const { STATE_DIR } = await import('../access.ts')
  const env: Record<string, string | undefined> = {}
  for (const line of read(join(STATE_DIR, '.env')).split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) env[m[1]!] = m[2]
  }
  const { loadConfig } = await import('../config.ts')
  return memoryRoot(loadConfig({ ...env, ...process.env }).cwd)
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...flags] = argv
  const root = await sharedRoot()
  if (cmd === 'session-start') {
    const { loadAccess } = await import('../access.ts')
    process.stdout.write(JSON.stringify(sessionStartOutput(root, loadAccess().allowFrom, process.env)))
    return
  }
  const p = bridgePaths(root)
  if (cmd === 'status' || !cmd) {
    console.log(`shared memory: ${root}`)
    console.log(`(a) import in ${p.claudeMd}: ${importEnabled(p) ? 'on' : 'off'}`)
    console.log(`(b) SessionStart hook in ${p.settings}: ${hookEnabled(p) ? 'on' : 'off'}`)
    return
  }
  if (cmd !== 'enable' && cmd !== 'disable') throw new Error(`unknown command ${cmd}; use status, enable or disable`)
  const on = cmd === 'enable'
  const both = !flags.includes('--import') && !flags.includes('--hook')
  const changes: [string, () => void][] = []
  if (both || flags.includes('--import')) changes.push([`${on ? 'add' : 'remove'} "${importLine(p)}" ${on ? 'to' : 'from'} ${p.claudeMd}`, () => setImport(p, on)])
  if (both || flags.includes('--hook')) changes.push([`${on ? 'add' : 'remove'} the memory SessionStart hook ${on ? 'to' : 'from'} ${p.settings}`, () => setHook(p, on)])
  console.log(changes.map(([d]) => `- ${d}`).join('\n'))
  if (!flags.includes('--yes')) {
    const answer = prompt('Apply these changes? A .bak copy of each file is kept. [y/N]')
    if (!/^y(es)?$/i.test(answer?.trim() ?? '')) return console.log('Nothing changed.')
  }
  for (const [, apply] of changes) apply()
  console.log('Done.')
}

if (import.meta.main) await main(process.argv.slice(2))
