/**
 * Installed plugins for the `/settings` switches (008 FR19): user-scope
 * installs plus project installs that cover the chat's cwd, each with whether
 * it is on before any chat override. That comes from `enabledPlugins` in the
 * user settings, then the project's `settings.json` and `settings.local.json`.
 */

import { join } from 'path'
import { isInside } from '../policy/args.ts'
import { readJson } from '../util/files.ts'

export type Plugin = { id: string; name: string; on: boolean }

type Installed = { plugins?: Record<string, { scope?: string; projectPath?: string }[]> }


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
