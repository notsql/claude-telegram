/**
 * What a chat can use (008 FR4, FR19): skills found on disk, named for
 * Telegram and narrowed to the ones turns report loaded, and the plugins and
 * MCP servers that turns in a cwd load. Feeds /skills, /settings and the
 * skill-command router.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { createLoadedCache, probeInit, type Loaded } from '../agent/loaded.ts'
import type { InitEvent } from '../agent/stream.ts'
import { loadAccess } from '../access.ts'
import { assign, discoverSkills, loadTable, saveTable } from '../commands/skillMap.ts'
import { CHANNEL_PLUGIN } from '../hooks/settings.ts'
import { claudeDir } from '../memory/paths.ts'
import { expandPath } from '../policy/args.ts'
import { policyOf } from '../policy/resolve.ts'
import type { Policy } from '../policy/schema.ts'
import { skillOn } from '../telegram/extensionsUi.ts'
import type { SkillEntry } from './commands.ts'
import { installedPlugins, type Plugin } from './plugins.ts'

export type DiscoveryOpts = {
  /** The workspace cwd for chats without their own. */
  defaultCwd: string
  /** Stable skill → Telegram command assignments. */
  commandsFile: string
  /** The hook settings a probe turn runs with. */
  settingsFile: string
  /** Built-in command names a skill must not take. */
  reserved: () => Iterable<string>
  usage: () => Record<string, { count: number }>
}

export function createDiscovery(opts: DiscoveryOpts) {
  const loadedSkills = new Set<string>()
  const loaded = createLoadedCache(cwd => probeInit(cwd, opts.settingsFile))
  const cwdOf = (p: Policy) => p.cwd ? expandPath(p.cwd, homedir()) : opts.defaultCwd

  function discovered() {
    const chats = Object.values(loadAccess().chats ?? {})
    const cwds = new Set([opts.defaultCwd, ...chats.flatMap(c => c.policy?.cwd ? [expandPath(c.policy.cwd, homedir())] : [])])
    return discoverSkills(claudeDir(), [...cwds]).filter(s => !loadedSkills.size || loadedSkills.has(s.name))
  }

  function skills(): SkillEntry[] {
    const found = discovered()
    const table = assign(loadTable(opts.commandsFile), found.map(s => s.name), opts.reserved())
    saveTable(opts.commandsFile, table)
    const usage = opts.usage()
    return found.map(s => ({ name: s.name, command: table[s.name]!, description: s.description, uses: usage[s.name]?.count ?? 0 }))
  }

  /** Installed plugins plus any a turn loaded that aren't installed (synced ones); never the channel plugin or Claude Code's built-ins. */
  function plugins(cwd: string, seen: Loaded): Plugin[] {
    const installed = installedPlugins(claudeDir(), cwd)
    const extra = seen.plugins
      .filter(id => !id.endsWith('@builtin') && !installed.some(x => x.id === id))
      .map(id => ({ id, name: id.split('@')[0]!, on: true }))
    return [...installed, ...extra].filter(x => x.id !== CHANNEL_PLUGIN).sort((a, b) => a.name.localeCompare(b.name))
  }

  return {
    cwdOf,
    loaded,
    skills,
    plugins,
    /** The skills on in this chat or topic; switched-off ones are hidden and refused. */
    skillsHere(key: string): SkillEntry[] {
      const p = policyOf(key)
      const on = plugins(cwdOf(p), loaded.peek(cwdOf(p)))
      return skills().filter(s => skillOn(p, s.name, on))
    },
    readSkill(name: string): string | undefined {
      const path = discovered().find(s => s.name === name)?.path
      try { return path ? readFileSync(path, 'utf8') : undefined } catch { return undefined }
    },
    /** Records what a turn loaded; true when it reported skills not seen before, so the menus need a refresh. */
    record(cwd: string, init: InitEvent): boolean {
      loaded.record(cwd, init)
      const fresh = init.skills?.filter(n => !loadedSkills.has(n)) ?? []
      for (const n of fresh) loadedSkills.add(n)
      return fresh.length > 0
    },
  }
}

export type Discovery = ReturnType<typeof createDiscovery>
