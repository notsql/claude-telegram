/**
 * The plugin catalog for 🛒 Browse plugins (008 FR21): every plugin listed by
 * the marketplaces already added (`known_marketplaces.json`), and the
 * `claude plugin` calls that install, update and uninstall them.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export type CatalogEntry = {
  id: string
  name: string
  marketplace: string
  description: string
  category: string
  author?: string
  homepage?: string
}

type Listed = { name: string; description?: string; category?: string; author?: string | { name?: string }; homepage?: string }

const readJson = <T,>(path: string): T | undefined => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : undefined
  } catch {
    return undefined
  }
}

export function catalog(claudeDir: string): CatalogEntry[] {
  const known = readJson<Record<string, { installLocation?: string }>>(join(claudeDir, 'plugins', 'known_marketplaces.json')) ?? {}
  return Object.entries(known).flatMap(([marketplace, m]) => {
    const listed = m.installLocation ? readJson<{ plugins?: Listed[] }>(join(m.installLocation, '.claude-plugin', 'marketplace.json'))?.plugins ?? [] : []
    return listed.map(p => ({
      id: `${p.name}@${marketplace}`,
      name: p.name,
      marketplace,
      description: p.description ?? '',
      category: p.category ?? 'other',
      ...(typeof p.author === 'string' ? { author: p.author } : p.author?.name && { author: p.author.name }),
      ...(p.homepage && { homepage: p.homepage }),
    }))
  }).sort((a, b) => a.name.localeCompare(b.name))
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  // T003: inherited Claude Code env makes the child reuse the parent's session.
  const { CLAUDECODE, CLAUDE_CODE_SESSION_ID, ...env } = process.env
  const child = Bun.spawn(['claude', 'plugin', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env, timeout: 180_000 })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, out: out.trim() || err.trim() }
}

/** `claude plugin <verb> <id> --json` at user scope. Never passes `-y`: a marketplace-declared command needs a person at the terminal. */
export async function pluginAction(verb: 'install' | 'update' | 'uninstall' | 'disable', id: string): Promise<{ ok: boolean; message: string }> {
  const { code, out } = await run([verb, id, '--scope', 'user', '--json'])
  let res: { message?: string; shownCommand?: unknown } = {}
  try {
    res = JSON.parse(out.split('\n')[0]!)
  } catch {}
  const message = res.message ?? (code ? out : '')
  return { ok: code === 0, message: res.shownCommand ? `${message}\n\nIt needs a command confirmed, so install it from the terminal with /plugin.`.trim() : message }
}

/** `claude plugin details`: what an installed plugin adds and its token cost. */
export const pluginDetails = async (id: string) => (await run(['details', id])).out
