/**
 * `/settings` → 🧩 Skills & plugins (008 FR19): turn skills and plugins on or
 * off for this chat only. `ext:m` is the page, `ext:s:<page>` the skills
 * (tap `ext:t:<command>:<page>` to switch one), `ext:p` the plugins (tap
 * `ext:u:<id>`). Plugin skills follow their plugin, so they aren't listed.
 */

import type { InlineKeyboardButton } from 'grammy/types'
import type { Access } from '../access.ts'
import type { Policy } from '../policy/schema.ts'
import type { Plugin } from '../skills/plugins.ts'
import type { PolicyView } from './policyUi.ts'

export const EXTENSIONS_CALLBACK = /^ext:(m|s|t|p|u)(?::([\w@.-]{1,58}))?(?::(\d+))?$/
const PAGE = 12

type Skill = { name: string; command: string }

const button = (text: string, data: string): InlineKeyboardButton => ({ text: text.slice(0, 64), callback_data: data })
const ownSkills = (skills: Skill[]) => skills.filter(s => !s.name.includes(':')).sort((a, b) => a.name.localeCompare(b.name))
const pluginOn = (p: Policy, x: Plugin) => p.plugins?.[x.id] ?? x.on
const skillsOff = (p: Policy, skills: Skill[]) => ownSkills(skills).filter(s => p.disabledSkills?.includes(s.name)).length

export function extensionsView(p: Policy, skills: Skill[], plugins: Plugin[]): PolicyView {
  const on = plugins.filter(x => pluginOn(p, x)).length
  return {
    text: [
      '🧩 Skills & plugins', '',
      'Turn skills and plugins on or off for this chat only. Your terminal and other chats are not affected.', '',
      `Skills: ${ownSkills(skills).length - skillsOff(p, skills)} of ${ownSkills(skills).length} on`,
      `Plugins: ${on} of ${plugins.length} on`,
    ].join('\n'),
    keyboard: { inline_keyboard: [
      [button('🧩 Skills', 'ext:s:0')],
      [button('🔌 Plugins', 'ext:p')],
      [button('« Back', 'pol:m')],
    ] },
  }
}

export function skillSwitchesView(p: Policy, skills: Skill[], page = 0): PolicyView {
  const list = ownSkills(skills)
  const pages = Math.max(1, Math.ceil(list.length / PAGE))
  page = Math.min(Math.max(page, 0), pages - 1)
  const shown = list.slice(page * PAGE, (page + 1) * PAGE)
  const rows: InlineKeyboardButton[][] = []
  for (let i = 0; i < shown.length; i += 2) {
    rows.push(shown.slice(i, i + 2).map(s => button(`${p.disabledSkills?.includes(s.name) ? '🚫' : '✅'} ${s.name}`, `ext:t:${s.command}:${page}`)))
  }
  if (pages > 1) {
    rows.push([
      ...(page > 0 ? [button('« Prev', `ext:s:${page - 1}`)] : []),
      ...(page < pages - 1 ? [button('Next »', `ext:s:${page + 1}`)] : []),
    ])
  }
  rows.push([button('« Back', 'ext:m')])
  return {
    text: list.length
      ? `🧩 Skills here${pages > 1 ? `, page ${page + 1}/${pages}` : ''}. ✅ on, 🚫 off. Tap one to switch it.\n\nSkills from a plugin follow the plugin.`
      : 'No skills to switch. Skills from a plugin follow the plugin.',
    keyboard: { inline_keyboard: rows },
  }
}

export function pluginSwitchesView(p: Policy, plugins: Plugin[]): PolicyView {
  return {
    text: plugins.length
      ? '🔌 Plugins here. ✅ on, 🚫 off. Tap one to switch it for this chat; its skills, agents and tools go with it.'
      : 'No plugins installed. Install them from the terminal with /plugin.',
    keyboard: { inline_keyboard: [
      ...plugins.filter(x => x.id.length <= 58).map(x => [button(`${pluginOn(p, x) ? '✅' : '🚫'} ${x.name}`, `ext:u:${x.id}`)]),
      [button('« Back', 'ext:m')],
    ] },
  }
}

/** Whether a skill is on here: the chat's own skills by `disabledSkills`, plugin skills (`plugin:skill`) by their plugin. */
export function skillOn(p: Policy, name: string, plugins: Plugin[]): boolean {
  const i = name.indexOf(':')
  if (i < 0) return !p.disabledSkills?.includes(name)
  const plugin = plugins.find(x => x.name === name.slice(0, i))
  return !plugin || pluginOn(p, plugin)
}

const policyOf = (access: Access, key: string) => ((access.chats ??= {})[key] ??= {}).policy ??= {}

/** Switches a skill off, or back on, for the key. Mutates `access`; returns whether it is now on. */
export function toggleSkill(access: Access, key: string, name: string): boolean {
  const policy = policyOf(access, key)
  const off = new Set(policy.disabledSkills)
  const on = off.has(name)
  if (on) off.delete(name)
  else off.add(name)
  if (off.size) policy.disabledSkills = [...off].sort()
  else delete policy.disabledSkills
  return on
}

/** Flips a plugin for the key; an override equal to the installed state is dropped. Mutates `access`; returns whether it is now on. */
export function togglePlugin(access: Access, key: string, plugin: Plugin): boolean {
  const policy = policyOf(access, key)
  const on = !(policy.plugins?.[plugin.id] ?? plugin.on)
  const plugins = { ...policy.plugins, [plugin.id]: on }
  if (on === plugin.on) delete plugins[plugin.id]
  if (Object.keys(plugins).length) policy.plugins = plugins
  else delete policy.plugins
  return on
}
