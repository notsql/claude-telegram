import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openInboxDb, type Item } from '../watch/store'
import { loadSources, saveSources, setEnabled, type Source } from '../watch/registry'
import { createSupervisor, type Child, type Spawner } from '../watch/supervisor'
import { createWatchTools } from '../watch/tools'
import { findBin } from '../watch/onboard'
import { createHealth, ERROR_THRESHOLD } from '../watch/health'

const OWNER = '42'

function setup(which: (bin: string) => string | null = () => null) {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-onboard-'))
  const cards: { chatId: string; text: string; extra: any }[] = []
  const polls: string[][] = []
  const items: Item[] = []
  const spawned: string[][] = []
  const kills: string[][] = []
  const sup = createSupervisor({
    stateDir, sources: [], log: () => {}, onPayload: () => {}, onItem: (_s, i) => items.push(i),
    runPoller: async (_input, schema, tools) => {
      polls.push(tools)
      return schema.parse({ items: [{ id: 'm1', ts: '2026-10-12T09:00:00Z', title: 'Invoice due', from: 'Pat' }], cursor: '2026-10-12T09:00:00Z' })
    },
    // A long-running child that exits only when killed.
    spawn: (cmd => {
      spawned.push(cmd)
      let done!: (n: number) => void
      return { pid: 1, stdout: null, exited: new Promise<number>(r => { done = r }), kill: () => { kills.push(cmd); done(0) } } satisfies Child
    }) as Spawner,
    sleep: () => new Promise(() => {}),
  })
  void sup.start(9000)
  const tools = createWatchTools({
    db: openInboxDb(':memory:'), stateDir, which,
    api: { async sendMessage(chatId, text, extra) { cards.push({ chatId, text, extra }) } },
    isOwnerDm: key => key === OWNER,
    spawn: async () => ({ ok: true }),
    live: { start: s => sup.startSource(s), stop: id => sup.stopSource(id) },
  })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await tools.call(name, args, OWNER))!
    return { text: r.content.map(c => c.text).join('\n'), isError: !!r.isError }
  }
  return { stateDir, cards, polls, items, spawned, kills, sup, tools, call }
}

const tick = () => new Promise(r => setTimeout(r, 0))

test('AC6: "watch my Outlook" → one Add card → source saved and producing items live', async () => {
  const s = setup()
  const r = await s.call('source_add', { title: 'Outlook', kind: 'agent-poll', connector: 'Microsoft Outlook' })
  expect(r.isError).toBe(false)
  expect(s.cards).toHaveLength(1)
  expect(s.cards[0]!.chatId).toBe(OWNER)
  expect(s.cards[0]!.text).toContain('Connector: Microsoft Outlook')
  expect(loadSources(s.stateDir)).toEqual([])
  expect(s.tools.addTap('add', 1)).toBe('✅ Added outlook')
  expect(s.tools.addTap('add', 1)).toBe('No longer available.')
  await tick()
  expect(loadSources(s.stateDir)[0]).toMatchObject({ id: 'outlook', kind: 'agent-poll', enabled: true })
  expect(s.polls).toEqual([['mcp__claude_ai_Microsoft_Outlook']])
  expect(s.items.map(i => [i.source, i.text])).toEqual([['outlook', 'Invoice due']])
})

test('Cancel adds nothing; a duplicate id is refused', async () => {
  const s = setup()
  await s.call('source_add', { builtin: 'calendar' })
  expect(s.tools.addTap('cancel', 1)).toBe('❌ Cancelled')
  expect(loadSources(s.stateDir)).toEqual([])
  await s.call('source_add', { builtin: 'calendar' })
  s.tools.addTap('add', 2)
  expect((await s.call('source_add', { builtin: 'calendar' })).text).toContain('already exists')
})

test('missing CLI hands off to capability_request; once installed the command is absolute', async () => {
  let installed = false
  const s = setup(bin => installed && bin === 'wacli' ? '/opt/homebrew/bin/wacli' : null)
  const miss = await s.call('source_add', { builtin: 'whatsapp' })
  expect(miss.isError).toBe(true)
  expect(miss.text).toContain('capability_request')
  expect(s.cards).toEqual([])
  installed = true
  expect((await s.call('source_add', { builtin: 'whatsapp' })).isError).toBe(false)
  expect(s.cards[0]!.text).toContain('Command: /opt/homebrew/bin/wacli sync --follow')
  s.tools.addTap('add', 1)
  expect(s.spawned[0]![0]).toBe('/opt/homebrew/bin/wacli')
  expect(s.spawned[0]).toContain('http://127.0.0.1:9000/ingest/whatsapp')
  expect(s.sup.secretOf('whatsapp')).toMatch(/^[0-9a-f]{64}$/)
})

test('custom commands need an adapter', async () => {
  const s = setup(() => '/usr/bin/x')
  expect((await s.call('source_add', { title: 'Mail', kind: 'stream', command: ['mailwatch'] })).text).toContain('no stream adapter')
  expect((await s.call('source_add', { title: 'TG', kind: 'stream', command: ['tgcli', 'watch', '--output', 'json'] })).isError).toBe(false)
  expect(s.cards[0]!.text).toContain('Command: /usr/bin/x watch')
})

test('pause, resume and remove take effect in the running supervisor', async () => {
  const s = setup(() => '/bin/tgcli')
  await s.call('source_add', { builtin: 'telegram-account' })
  s.tools.addTap('add', 1)
  expect(s.spawned).toHaveLength(1)
  await s.call('source_pause', { id: 'telegram-account' })
  expect(s.kills).toHaveLength(1)
  await s.call('source_resume', { id: 'telegram-account' })
  expect(s.spawned).toHaveLength(2)
  expect((await s.call('source_remove', { id: 'telegram-account' })).text).toBe('telegram-account removed')
  expect(s.kills).toHaveLength(2)
  expect(loadSources(s.stateDir)).toEqual([])
  expect((await s.call('source_remove', { id: 'telegram-account' })).isError).toBe(true)
})

const wa = (over: Partial<Source> = {}): Source => ({
  id: 'whatsapp', title: 'WhatsApp', kind: 'webhook', enabled: true, config: { command: ['/bin/wacli', 'sync'] },
  cursor: null, status: 'ok', lastItemAt: null, errors: 0, ...over,
})

function health(stateDir: string, now: () => number) {
  const notices: { chatId: string; text: string; extra: any }[] = []
  const fixes: string[] = []
  const paused: string[] = []
  const h = createHealth({
    stateDir, target: () => ({ chatId: '-100', threadId: 7 }), log: () => {}, now,
    api: { async sendMessage(chatId, text, extra) { notices.push({ chatId, text, extra }) } },
    fix: p => fixes.push(p),
    pause: id => { setEnabled(stateDir, id, false); paused.push(id) },
  })
  return { h, notices, fixes, paused }
}

test('AC7: a source that keeps failing posts exactly one Fix notice', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-health-'))
  const sources = [wa()]
  saveSources(stateDir, sources)
  // wacli with killed auth: every start exits at once.
  let sleeps = 0
  let sup: ReturnType<typeof createSupervisor>
  sup = createSupervisor({
    stateDir, sources, log: () => {}, onPayload: () => {}, now: () => 0,
    spawn: () => ({ pid: 1, stdout: null, exited: Promise.resolve(1), kill: () => {} }),
    sleep: async () => { if (++sleeps === ERROR_THRESHOLD + 2) sup.stop() },
  })
  const { h, notices, fixes, paused } = health(stateDir, () => 0)
  await h.check()
  expect(notices).toEqual([])
  await sup.start(1)
  for (let i = 0; i < 3; i++) await h.check()
  expect(notices).toHaveLength(1)
  expect(notices[0]!.chatId).toBe('-100')
  expect(notices[0]!.extra.message_thread_id).toBe(7)
  expect(notices[0]!.text).toContain('failed 7 times in a row')
  expect(notices[0]!.extra.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual(['wsh:fix:whatsapp', 'wsh:pause:whatsapp'])

  expect(h.tap('fix', 'whatsapp')).toBe('🔧 Diagnosing…')
  expect(fixes[0]).toContain('"whatsapp"')
  expect(fixes[0]).toContain('tg-capability-ladder')
  expect(h.tap('pause', 'whatsapp')).toBe('⏸ Paused')
  expect(paused).toEqual(['whatsapp'])
  expect(loadSources(stateDir)[0]!.enabled).toBe(false)
  await h.check()
  expect(notices).toHaveLength(1)
})

test('silence past expectSilenceMaxSec posts one notice; an item clears it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-health-'))
  saveSources(stateDir, [wa({ config: { command: ['/bin/wacli'], expectSilenceMaxSec: 3600 }, lastItemAt: 0 })])
  let t = 0
  const { h, notices } = health(stateDir, () => t)
  t = 3600_000
  await h.check()
  expect(notices).toEqual([])
  t = 3600_001
  await h.check()
  await h.check()
  expect(notices).toHaveLength(1)
  expect(notices[0]!.text).toContain('silent for over 60 min')
  saveSources(stateDir, [wa({ config: { command: ['/bin/wacli'], expectSilenceMaxSec: 3600 }, lastItemAt: t })])
  await h.check()
  t += 3600_001
  await h.check()
  expect(notices).toHaveLength(2)
})

test('findBin also looks in the user bin dirs launchd leaves off PATH', () => {
  const home = mkdtempSync(join(tmpdir(), 'tg-home-'))
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  writeFileSync(join(home, '.local/bin/tgcli'), '#!/bin/sh\n', { mode: 0o755 })
  const { HOME, PATH } = process.env
  process.env.HOME = home
  process.env.PATH = '/usr/bin:/bin'
  try {
    expect(findBin('tgcli')).toBe(join(home, '.local/bin/tgcli'))
    expect(findBin('no-such-cli-xyz')).toBeNull()
  } finally {
    process.env.HOME = HOME
    process.env.PATH = PATH
  }
})
