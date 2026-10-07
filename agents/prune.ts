/**
 * Weekly agent maintenance (009 plan Risks, FR12), run from the 007 system
 * jobs. Learned agents unused for STALE_DAYS are proposed for archiving to
 * `<dir>/.archive/`; "unused" goes by `agents-usage.json` (T906), else the
 * file's mtime. Shipped agents (`assets/agents`) are never proposed. Eval runs
 * need the `skill-creator` plugin, detected from the installed plugins list.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { ASSETS_DIR } from './install.ts'
import { MARKER } from './tools.ts'
import { AGENT_NAME } from './validate.ts'
import type { AgentUsage } from './usage.ts'

export const STALE_DAYS = 60
/** Runs an agent or skill needs before it is worth evaluating. */
export const EVAL_MIN_RUNS = 5
const DAY_MS = 24 * 60 * 60 * 1000

/** Learned agents in `dir` not used for `days`, oldest first. */
export function staleAgents(dir: string, usage: Record<string, AgentUsage>, now = Date.now(), days = STALE_DAYS, assets = ASSETS_DIR): string[] {
  if (!existsSync(dir)) return []
  const shipped = new Set(existsSync(join(assets, 'agents')) ? readdirSync(join(assets, 'agents')) : [])
  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && !shipped.has(f))
    .map(f => ({ f, text: readFileSync(join(dir, f), 'utf8') }))
    .filter(a => MARKER.exec(a.text)?.[1] === 'tg')
    .map(a => {
      const name = a.text.match(/^name:\s*(.+?)\s*$/m)?.[1] ?? a.f.replace(/\.md$/, '')
      const used = Date.parse(usage[name]?.last_used ?? '')
      return { name, at: Number.isFinite(used) ? used : statSync(join(dir, a.f)).mtimeMs }
    })
    .filter(a => now - a.at > days * DAY_MS)
    .sort((a, b) => a.at - b.at)
    .map(a => a.name)
}

/** Moves `<dir>/<name>.md` to `<dir>/.archive/`. */
export function archiveAgent(dir: string, name: string): void {
  const file = join(dir, `${name}.md`)
  if (!AGENT_NAME.test(name) || !existsSync(file)) throw new Error(`No agent named ${name}.`)
  mkdirSync(join(dir, '.archive'), { recursive: true })
  renameSync(file, join(dir, '.archive', `${name}.md`))
}

/** Whether a `skill-creator` plugin is installed (any marketplace). */
export function skillCreatorInstalled(claudeDir: string): boolean {
  try {
    const plugins = JSON.parse(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins ?? {}
    return Object.keys(plugins).some(k => k.split('@')[0] === 'skill-creator')
  } catch { return false }
}

/** tg agents and skills with at least `min` runs, for the eval pass. */
export function evalTargets(agents: Record<string, { count: number }>, skills: Record<string, { count: number }>, min = EVAL_MIN_RUNS) {
  const pick = (u: Record<string, { count: number }>) => Object.entries(u).filter(([, v]) => v.count >= min).map(([k]) => k).sort()
  return { agents: pick(agents).filter(n => n.startsWith('tg-')), skills: pick(skills) }
}
