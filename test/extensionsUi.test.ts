import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { defaultAccess } from '../access.ts'
import { mergeSettings } from '../agent/runner.ts'
import { policyArgs, policySettings } from '../policy/args.ts'
import { createLoadedCache, mcpPrefix } from '../agent/loaded.ts'
import { installedPlugins } from '../skills/plugins.ts'
import { EXTENSIONS_CALLBACK, extensionsView, mcpSwitchesView, pluginSwitchesView, prettyName, skillOn, skillSwitchesView, toggleMcpServer, toggleSkill, togglePlugin } from '../telegram/extensionsUi.ts'

const data = (v: { keyboard: { inline_keyboard: { callback_data?: string }[][] } }) => v.keyboard.inline_keyboard.flat().map(b => b.callback_data!)
const skills = [{ name: 'deploy', command: 'deploy' }, { name: 'tg-notes', command: 'tg_notes' }, { name: 'figma:render', command: 'figma_render' }]
const lsp = { id: 'typescript-lsp@claude-plugins-official', name: 'typescript-lsp', on: true }
const figma = { id: 'figma@claude-plugins-official', name: 'figma', on: false }

test('views list own skills and plugins with their state; callbacks round-trip', () => {
  const p = { disabledSkills: ['deploy'], plugins: { [figma.id]: true } }
  expect(extensionsView(p, skills, [lsp, figma], []).text).toContain('Skills: 1 of 2 on')
  expect(extensionsView(p, skills, [lsp, figma], []).text).toContain('Plugins: 2 of 2 on')
  const s = skillSwitchesView(p, skills)
  expect(s.keyboard.inline_keyboard[0]!.map(b => b.text)).toEqual(['🚫 deploy', '✅ tg-notes'])
  const all = [...data(s), ...data(pluginSwitchesView(p, [lsp, figma])), ...data(extensionsView(p, skills, [], [])), ...data(mcpSwitchesView(p, [{ name: 'claude.ai Notion' }]))].filter(d => d !== 'pol:m')
  expect(all).toContain('ext:u:figma@claude-plugins-official')
  for (const d of all) expect(EXTENSIONS_CALLBACK.test(d)).toBe(true)
})

test('toggles store only what differs from the installed state, and become settings', () => {
  const a = defaultAccess()
  expect(toggleSkill(a, '5', 'deploy')).toBe(false)
  expect(togglePlugin(a, '5', lsp)).toBe(false)
  expect(policySettings(a.chats!['5']!.policy!)).toEqual({ skillOverrides: { deploy: 'off' }, enabledPlugins: { [lsp.id]: false } })
  expect(toggleSkill(a, '5', 'deploy')).toBe(true)
  expect(togglePlugin(a, '5', lsp)).toBe(true)
  expect(a.chats!['5']!.policy).toEqual({})
  expect(policySettings({})).toBeUndefined()
})

test('installedPlugins: user installs, project installs under cwd, enabled state from settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugins-'))
  const cwd = join(dir, 'proj')
  mkdirSync(join(dir, 'plugins'), { recursive: true })
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
    'b@m': [{ scope: 'user' }], 'a@m': [{ scope: 'project', projectPath: cwd }], 'c@m': [{ scope: 'project', projectPath: '/elsewhere' }],
  } }))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'b@m': true, 'a@m': true } }))
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'a@m': false } }))
  expect(installedPlugins(dir, cwd)).toEqual([{ id: 'a@m', name: 'a', on: false }, { id: 'b@m', name: 'b', on: true }])
})

test('mergeSettings keeps the hook file, merges plugin switches, and the channel plugin stays off', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'hs-')), 'hook-settings.json')
  writeFileSync(f, JSON.stringify({ enabledPlugins: { 'telegram@m': false }, hooks: { Stop: [] } }))
  expect(JSON.parse(mergeSettings(f, { skillOverrides: { x: 'off' }, enabledPlugins: { 'telegram@m': true, 'lsp@m': false } }))).toEqual({
    enabledPlugins: { 'telegram@m': false, 'lsp@m': false }, hooks: { Stop: [] }, skillOverrides: { x: 'off' },
  })
})

test('skillOn: own skills by disabledSkills, plugin skills by their plugin', () => {
  const p = { disabledSkills: ['deploy'], plugins: { [lsp.id]: false } }
  expect(skillOn(p, 'deploy', [lsp, figma])).toBe(false)
  expect(skillOn(p, 'notes', [lsp, figma])).toBe(true)
  expect(skillOn(p, 'typescript-lsp:check', [lsp, figma])).toBe(false)
  expect(skillOn(p, 'figma:render', [lsp, figma])).toBe(false)
  expect(skillOn(p, 'synced:thing', [lsp, figma])).toBe(true)
})

test('MCP servers switch by tool prefix and become server-level deny rules', () => {
  const a = defaultAccess()
  const notion = { name: 'claude.ai Notion', source: 'claudeai' }
  expect(toggleMcpServer(a, '5', 'claude_ai_Notion')).toBe(false)
  const p = a.chats!['5']!.policy!
  expect(mcpSwitchesView(p, [notion]).text).toContain('🚫 claude.ai Notion (claude.ai connector)')
  expect(extensionsView(p, [], [], [notion, { name: 'safari-mcp' }]).text).toContain('MCP servers: 1 of 2 on')
  const args = policyArgs(p)
  expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(['--disallowedTools', 'mcp__claude_ai_Notion'])
  expect(toggleMcpServer(a, '5', 'claude_ai_Notion')).toBe(true)
  expect(a.chats!['5']!.policy).toEqual({})
})

test('the loaded cache probes a cwd once, then adds what each turn reports', async () => {
  let probes = 0
  const init = (plugins: string[], mcp: string[]) => ({ plugins: plugins.map(source => ({ source })), mcp_servers: mcp.map(name => ({ name, status: 'ok' })) }) as never
  const cache = createLoadedCache(async () => (probes++, init(['a@m'], ['x'])))
  expect(cache.peek('/w')).toEqual({ plugins: [], mcpServers: [] })
  expect(await cache.get('/w')).toEqual({ plugins: ['a@m'], mcpServers: [{ name: 'x' }] })
  cache.record('/w', init(['b@m'], ['y']))
  expect(await cache.get('/w')).toEqual({ plugins: ['a@m', 'b@m'], mcpServers: [{ name: 'x' }, { name: 'y' }] })
  expect(probes).toBe(1)
  expect(mcpPrefix('claude.ai Google Drive')).toBe('claude_ai_Google_Drive')
})

test('plugin names read as words', () => {
  expect(prettyName('cowork-plugin-management')).toBe('Cowork plugin management')
  expect(pluginSwitchesView({}, [{ id: 'my_tool@x', name: 'my_tool', on: true }]).keyboard.inline_keyboard[0]![0]!.text).toBe('✅ My tool')
})
