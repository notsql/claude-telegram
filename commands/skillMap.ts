/**
 * Skill discovery and Telegram command names (008 FR4). Skills are read from
 * SKILL.md frontmatter (name, description, user-invocable); each original
 * name gets a `[a-z0-9_]{1,32}` command, deduplicated with `_2`, `_3`…
 * Assignments persist in `commands.json` so a command stays stable.
 */

import { Glob } from 'bun'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, sep } from 'path'

export type Skill = { name: string; description: string; path: string }

const MAX = 32

/** `deploy-blog` → `deploy_blog`, `telegram:access` → `telegram_access`. */
export function normalise(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return (n || 'skill').slice(0, MAX)
}

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out: Record<string, string> = {}
  for (const line of m?.[1].split(/\r?\n/) ?? []) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function scan(root: string, pattern: string, prefix: (path: string) => string): Skill[] {
  if (!existsSync(root)) return []
  const skills: Skill[] = []
  for (const rel of new Glob(pattern).scanSync({ cwd: root, followSymlinks: true })) {
    const path = join(root, rel)
    let fm: Record<string, string>
    try { fm = frontmatter(readFileSync(path, 'utf8')) } catch { continue }
    if (fm['user-invocable'] === 'false') continue
    const name = fm.name || dirname(rel).split(sep).pop()!
    skills.push({ name: prefix(rel) + name, description: (fm.description ?? '').slice(0, 256), path })
  }
  return skills
}

/**
 * User skills, project skills for each chat cwd, and plugin skills
 * (`plugin:skill`, from `plugins/cache/<marketplace>/<plugin>/<version>/skills/`).
 * First occurrence of a name wins.
 */
export function discoverSkills(claudeDir: string, cwds: string[]): Skill[] {
  const none = () => ''
  const all = [
    ...scan(join(claudeDir, 'skills'), '*/SKILL.md', none),
    ...cwds.flatMap(cwd => scan(join(cwd, '.claude', 'skills'), '*/SKILL.md', none)),
    ...scan(join(claudeDir, 'plugins', 'cache'), '*/*/*/skills/*/SKILL.md', rel => rel.split(sep)[1] + ':'),
  ]
  const seen = new Set<string>()
  return all.filter(s => !seen.has(s.name) && seen.add(s.name))
}

export type CommandTable = Record<string, string>

export function loadTable(file: string): CommandTable {
  try { return JSON.parse(readFileSync(file, 'utf8')).skills ?? {} } catch { return {} }
}

/**
 * Give every name a command, keeping existing assignments. `reserved` holds
 * built-in command names a skill must not take. Returns the updated table.
 */
export function assign(table: CommandTable, names: string[], reserved: Iterable<string> = []): CommandTable {
  const out = { ...table }
  const taken = new Set([...reserved, ...Object.values(out)])
  for (const name of [...names].sort()) {
    if (out[name]) continue
    const base = normalise(name)
    let cmd = base
    for (let i = 2; taken.has(cmd); i++) cmd = base.slice(0, MAX - `_${i}`.length) + `_${i}`
    out[name] = cmd
    taken.add(cmd)
  }
  return out
}

export function saveTable(file: string, table: CommandTable): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ skills: table }, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
