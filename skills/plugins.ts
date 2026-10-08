/**
 * Installed plugins for the `/settings` switches (008 FR19): user-scope
 * installs plus project installs that cover the chat's cwd, each with whether
 * it is on before any chat override. That comes from `enabledPlugins` in the
 * user settings, then the project's `settings.json` and `settings.local.json`.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { isInside } from '../policy/args.ts'

export type Plugin = { id: string; name: string; on: boolean }

type Installed = { plugins?: Record<string, { scope?: string; projectPath?: string }[]> }

const readJson = <T,>(path: string): T | undefined => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : undefined
  } catch {
    return undefined
  }
}

export function installedPlugins(claudeDir: string, cwd: string): Plugin[] {
  const installed = readJson<Installed>(join(claudeDir, 'plugins', 'installed_plugins.json'))?.plugins ?? {}
  const enabled: Record<string, boolean> = {}
  for (const f of [join(claudeDir, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')]) {
    Object.assign(enabled, readJson<{ enabledPlugins?: Record<string, boolean> }>(f)?.enabledPlugins)
  }
  return Object.entries(installed)
    .filter(([, installs]) => installs.some(i => i.scope === 'user' || (i.projectPath && isInside(cwd, i.projectPath))))
    .map(([id]) => ({ id, name: id.split('@')[0]!, on: enabled[id] === true }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
