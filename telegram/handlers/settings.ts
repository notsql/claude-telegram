/**
 * /settings (003 T309, 008 FR15): owner-only settings for this chat, with
 * pages for each setting and 🔐 Permissions; 🤖 Agent (008 FR20, 009 FR3);
 * 🧩 Skills, plugins & MCP switches (008 FR19); 🛒 Browse plugins (008 FR21).
 */

import type { Bot } from 'grammy'
import type { InlineKeyboardMarkup } from 'grammy/types'
import { loadAccess, saveAccess } from '../../access.ts'
import { mcpPrefix } from '../../agent/loaded.ts'
import { availableAgents, chatAgents, setPolicyAgent } from '../../agents/available.ts'
import type { Command } from '../../commands/registry.ts'
import { claudeDir } from '../../memory/paths.ts'
import type { createAudit } from '../../policy/audit.ts'
import { policyKey, policyOf, removeAlwaysAllow } from '../../policy/resolve.ts'
import { sessionKey } from '../../sessions/key.ts'
import { catalog, pluginAction, pluginDetails } from '../../skills/catalog.ts'
import type { Discovery } from '../../skills/discovery.ts'
import { installedPlugins } from '../../skills/plugins.ts'
import { AGENT_CALLBACK, agentView } from '../agentUi.ts'
import { withClose } from '../close.ts'
import { EXTENSIONS_CALLBACK, extensionsView, mcpSwitchesView, pluginSwitchesView, prettyName, skillSwitchesView, toggleMcpServer, togglePlugin, toggleSkill } from '../extensionsUi.ts'
import { alwaysRuleAt, applyPolicyEdit, bypassConfirmView, EDITABLE, fieldView, label, permissionsView, POLICY_CALLBACK, policyView, resetPolicy, resetView, ruleLabel, rulesView, ruleView, type EditableField } from '../policyUi.ts'
import { STORE_CALLBACK, categoriesView, confirmView, listView, pluginView, resultView } from '../storeUi.ts'
import { answer, isOwner, keyOf, ownerOnly } from './ui.ts'

type View = { text: string; keyboard: InlineKeyboardMarkup }

export type SettingsDeps = {
  discovery: Discovery
  audit: ReturnType<typeof createAudit>
  /** The `/` menus depend on settings; refresh them after a change. */
  refreshMenu: () => void
  /** 013: show 📡 Sources when watching is on. */
  sources: boolean
}

export function registerSettings(bot: Bot, { discovery, audit, refreshMenu, sources }: SettingsDeps): Command {
  bot.callbackQuery(POLICY_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    if (!isOwner(ctx) || !msg) return ownerOnly(ctx)
    const here = keyOf(msg)
    const key = policyKey(here)
    const [, action, a, b] = ctx.match as unknown as [string, 'm' | 'p' | 'f' | 's' | 'c' | 'r' | 'x' | 'z' | 'y' | 'b', string?, string?]
    const show = (r: View) => ctx.editMessageText(r.text, { reply_markup: withClose(r.keyboard) }).catch(() => {})
    const user = String(ctx.from.id)
    const home = () => policyView(key, policyOf(here), { sources })
    switch (action) {
      case 's': {
        const access = loadAccess()
        try {
          const stored = applyPolicyEdit(access, key, a!, b!)
          saveAccess(access)
          audit({ event: 'policy', key, user, field: a!, value: stored ?? 'default' })
          refreshMenu()
        } catch (err) {
          return answer(ctx, (err as Error).message)
        }
        void answer(ctx, `${label(a!)}: ${label(b!)}`)
        return void await show(a === 'permissionMode' ? permissionsView(policyOf(here)) : home())
      }
      case 'x': {
        const access = loadAccess()
        const rule = alwaysRuleAt(policyOf(key), Number(a))
        if (!rule || !removeAlwaysAllow(access, key, rule)) return answer(ctx, 'That rule is gone.')
        saveAccess(access)
        audit({ event: 'policy', key, user, field: 'alwaysAllow', value: `-${rule}` })
        void answer(ctx, `🗑 Removed ${ruleLabel(rule)}`)
        return void await show(rulesView(policyOf(here), 2, Math.floor(Number(a) / 8)))
      }
      case 'y': {
        const access = loadAccess()
        resetPolicy(access, key)
        if (here !== key) resetPolicy(access, here)
        saveAccess(access)
        audit({ event: 'policy', key, user, field: '*', value: 'default' })
        refreshMenu()
        void answer(ctx, '↺ Settings reset')
        return void await show(home())
      }
    }
    await answer(ctx)
    const p = policyOf(here)
    if (action === 'm') return void await show(home())
    if (action === 'b') return void await show(bypassConfirmView())
    if (action === 'p') return void await show(permissionsView(p))
    if (action === 'c') return void await show(rulesView(p, Number(a), Number(b ?? 0)))
    if (action === 'r') return void await show(ruleView(p, Number(a), Number(b)))
    if (action === 'z') return void await show(resetView())
    if (a && a in EDITABLE) await show(fieldView(a as EditableField, p))
  })

  // Set on the session key, so a forum topic can run as its own agent (009 US3).
  bot.callbackQuery(AGENT_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    if (!isOwner(ctx) || !msg) return ownerOnly(ctx)
    const here = keyOf(msg)
    const [, action, name] = ctx.match as unknown as [string, 'm' | 'u', string]
    const cwd = discovery.cwdOf(policyOf(here))
    if (action === 'u') {
      const access = loadAccess()
      try {
        setPolicyAgent(access, here, name || undefined, availableAgents(claudeDir(), cwd))
      } catch (err) {
        return answer(ctx, (err as Error).message)
      }
      saveAccess(access)
      audit({ event: 'policy', key: here, user: String(ctx.from.id), field: 'agent', value: name || 'default' })
      void answer(ctx, `🤖 ${name || 'Default assistant'}`)
    } else await answer(ctx)
    const r = agentView(policyOf(here).agent, chatAgents(claudeDir(), cwd))
    await ctx.editMessageText(r.text, { reply_markup: withClose(r.keyboard) }).catch(() => {})
  })

  // Switched per chat and passed to turns as settings.
  bot.callbackQuery(EXTENSIONS_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    if (!isOwner(ctx) || !msg) return ownerOnly(ctx)
    const key = policyKey(keyOf(msg))
    const [, action, a, b] = ctx.match as unknown as [string, 'm' | 's' | 't' | 'p' | 'u' | 'c' | 'v', string?, string?]
    const show = (r: View) => ctx.editMessageText(r.text, { reply_markup: withClose(r.keyboard) }).catch(() => {})
    const p = policyOf(key)
    const cwd = discovery.cwdOf(p)
    // The first open in a cwd with no turn yet probes it (a few seconds).
    const toggles = action === 't' || action === 'u' || action === 'v'
    if (!toggles) void answer(ctx)
    const seen = await discovery.loaded.get(cwd)
    const plugins = discovery.plugins(cwd, seen)
    const servers = seen.mcpServers.filter(x => x.name !== 'tg')
    const skills = discovery.skills()
    if (toggles) {
      const skill = action === 't' ? skills.find(x => x.command === a) : undefined
      const plugin = action === 'u' ? plugins.find(x => x.id === a) : undefined
      const server = action === 'v' ? servers.find(x => mcpPrefix(x.name) === a) : undefined
      const name = skill?.name ?? (plugin && prettyName(plugin.name)) ?? server?.name
      if (!name) return answer(ctx, 'That one is gone.')
      const access = loadAccess()
      const on = skill ? toggleSkill(access, key, skill.name) : plugin ? togglePlugin(access, key, plugin) : toggleMcpServer(access, key, a!)
      saveAccess(access)
      const field = skill ? 'disabledSkills' : plugin ? 'plugins' : 'disabledMcpServers'
      audit({ event: 'policy', key, user: String(ctx.from.id), field, value: `${on ? '+' : '-'}${skill?.name ?? plugin?.id ?? a}` })
      void answer(ctx, `${on ? '✅' : '🚫'} ${name} ${on ? 'on' : 'off'} here`)
      const now = policyOf(key)
      return void await show(skill ? skillSwitchesView(now, skills, Number(b ?? 0)) : plugin ? pluginSwitchesView(now, plugins) : mcpSwitchesView(now, servers))
    }
    if (action === 'm') return void await show(extensionsView(p, skills, plugins, servers))
    if (action === 's') return void await show(skillSwitchesView(p, skills, Number(a ?? 0)))
    if (action === 'c') return void await show(mcpSwitchesView(p, servers))
    await show(pluginSwitchesView(p, plugins))
  })

  // Owner only, in DMs and groups: installing runs the plugin's code here.
  bot.callbackQuery(STORE_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    if (!isOwner(ctx) || !msg) return ownerOnly(ctx)
    const key = policyKey(keyOf(msg))
    const [, action, a, b] = ctx.match as unknown as [string, 'c' | 'l' | 'd' | 'i' | 'I' | 'r' | 'R' | 'u', string?, string?]
    const show = (r: View) =>
      ctx.editMessageText(r.text, { reply_markup: withClose(r.keyboard), link_preview_options: { is_disabled: true } }).catch(() => {})
    const entries = catalog(claudeDir())
    const installed = new Set(installedPlugins(claudeDir(), discovery.cwdOf(policyOf(key))).map(x => x.id))
    if (action === 'c') return void await Promise.all([answer(ctx), show(categoriesView(entries))])
    if (action === 'l') return void await Promise.all([answer(ctx), show(listView(entries, a!, Number(b ?? 0), installed))])
    const entry = entries.find(e => e.id === a)
    if (!entry) return answer(ctx, 'That plugin is gone.')
    void answer(ctx)
    if (action === 'd') return void await show(pluginView(entry, installed.has(entry.id)))
    if (action === 'i' || action === 'r') return void await show(confirmView(entry, action))
    const verb = ({ I: 'install', u: 'update', R: 'uninstall' } as const)[action]
    await show({ text: `⏳ Running ${verb} for ${entry.name}…`, keyboard: { inline_keyboard: [] } })
    const r = await pluginAction(verb, entry.id)
    audit({ event: 'plugin', key, user: String(ctx.from.id), action: verb, plugin: entry.id, ok: r.ok })
    if (!r.ok) return void await show(resultView(entry, `⚠️ Couldn't ${verb} ${entry.name}.\n\n${r.message}`))
    const access = loadAccess()
    if (verb === 'install') {
      // Off in user settings, so the terminal and other chats are unaffected; on here.
      await pluginAction('disable', entry.id)
      if (access.chats?.[key]?.policy?.plugins?.[entry.id] !== true) togglePlugin(access, key, { id: entry.id, name: entry.name, on: false })
    }
    if (verb === 'uninstall') {
      for (const chat of Object.values(access.chats ?? {})) {
        const plugins = chat.policy?.plugins
        if (!plugins || !(entry.id in plugins)) continue
        delete plugins[entry.id]
        if (!Object.keys(plugins).length) delete chat.policy!.plugins
      }
    }
    saveAccess(access)
    const text = verb === 'install' ? `✅ Installed ${entry.name}, on in this chat only. It loads from your next message.\n\n${await pluginDetails(entry.id)}`
      : verb === 'update' ? `✅ ${r.message || `Updated ${entry.name}.`} It loads from your next message.`
      : `🗑 Uninstalled ${entry.name}.`
    await show(resultView(entry, text))
  })

  return { name: 'settings', description: "This chat's settings and permissions", menu: ['private', 'group'], requiresApprover: true, handler: async ctx => {
    if (!isOwner(ctx)) return
    const here = sessionKey(ctx.msg!)
    const r = policyView(policyKey(here), policyOf(here), { sources })
    await ctx.reply(r.text, { reply_markup: withClose(r.keyboard) })
  } }
}
