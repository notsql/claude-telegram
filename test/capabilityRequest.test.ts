import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Api } from 'grammy'
import { createCapabilityRequests, type CapabilityRequest } from '../capabilities/request.ts'
import { createCapabilityTools } from '../capabilities/tools.ts'
import { loadLedger, SKIP_MS } from '../capabilities/ledger.ts'
import { defaultPolicy } from '../policy/schema.ts'

const OWNER = '111'
const OTHER = '222'
const GROUP = '-100500'

let stateDir: string
let sent: { chat: string; text: string; buttons: string[] }[]
let installs: string[][]
let clock: number
let sender: Record<string, string>

const api = {
  sendMessage: async (chat: string, text: string, extra: { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }) => {
    sent.push({ chat, text, buttons: extra.reply_markup?.inline_keyboard.flat().map(b => b.callback_data) ?? [] })
    return { message_id: sent.length }
  },
  editMessageText: async () => true,
} as unknown as Api

const make = (timeoutMs?: number) => createCapabilityRequests({
  api, stateDir,
  owners: () => [OWNER],
  sender: key => sender[key],
  // Stub: never installs anything real.
  install: async argv => { installs.push(argv); return { ok: true, code: 0, timedOut: false, output: '' } },
  now: () => clock,
  timeoutMs,
})

const req: CapabilityRequest = {
  candidate: { kind: 'brew', name: 'imagemagick', tier: 'T1', source: 'homebrew/core' },
  reason: 'convert heic to jpg',
  resume: 'convert photo.heic',
}
const idOf = (i = sent.length - 1) => sent[i]!.buttons[0]!.split(':')[2]!

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'cap-'))
  sent = []; installs = []; clock = 1_000_000
  sender = { [OWNER]: OWNER, [GROUP]: OWNER }
})

test('AC2: Install runs the template once; a second request for the same package gets no card', async () => {
  const r = make()
  const first = await r.request(OWNER, defaultPolicy('private'), req)
  expect(first.ok).toBe(true)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.chat).toBe(OWNER)
  expect(sent[0]!.buttons).toEqual([`cap:install:${idOf()}`, `cap:details:${idOf()}`, `cap:skip:${idOf()}`])
  expect((await r.decide(idOf(), 'install', OWNER))!.ok).toBe(true)
  expect(installs).toEqual([['brew', 'install', 'imagemagick']])
  expect(loadLedger(stateDir)[0]).toMatchObject({ id: 'cli:imagemagick', status: 'installed', approvedBy: OWNER, tier: 'T1' })

  const again = await r.request(OWNER, defaultPolicy('private'), req)
  expect(again.text).toContain('already installed')
  expect(sent).toHaveLength(1)
  expect(await r.decide(idOf(), 'install', OWNER)).toBeUndefined()
  expect(installs).toHaveLength(1)
})

test('AC2: Skip suppresses the card for 30 days, then it can be asked again', async () => {
  const r = make()
  await r.request(OWNER, defaultPolicy('private'), req)
  await r.decide(idOf(), 'skip', OWNER)
  expect(installs).toHaveLength(0)
  expect(loadLedger(stateDir)[0]).toMatchObject({ status: 'skipped', skippedUntil: clock + SKIP_MS })
  clock += SKIP_MS - 1
  expect((await r.request(OWNER, defaultPolicy('private'), req)).ok).toBe(false)
  expect(sent).toHaveLength(1)
  clock += 2
  expect((await r.request(OWNER, defaultPolicy('private'), req)).ok).toBe(true)
  expect(sent).toHaveLength(2)
})

test('no answer before the timeout is a Skip', async () => {
  const r = make(5)
  await r.request(OWNER, defaultPolicy('private'), req)
  await Bun.sleep(20)
  expect(loadLedger(stateDir)[0]).toMatchObject({ status: 'skipped', skippedUntil: clock + SKIP_MS })
  expect(await r.decide(idOf(), 'install', OWNER)).toBeUndefined()
  expect(installs).toHaveLength(0)
})

test('AC8: a group with default policy gets no card and the tool is hidden', async () => {
  const r = make()
  const tools = createCapabilityTools(r)
  expect(tools.list(defaultPolicy('group'))).toEqual([])
  const out = await tools.call('capability_request', req as unknown as Record<string, unknown>, GROUP, defaultPolicy('group'))
  expect(out!.isError).toBe(true)
  expect(sent).toHaveLength(0)
})

test('AC8: in a group that allows it, the card goes to the owner DM only when the owner asked', async () => {
  const r = make()
  const policy = { ...defaultPolicy('group'), capabilityAcquisition: 'ask' as const }
  sender[GROUP] = OTHER
  expect((await r.request(GROUP, policy, req)).ok).toBe(false)
  expect(sent).toHaveLength(0)
  sender[GROUP] = OWNER
  expect((await r.request(GROUP, policy, req)).ok).toBe(true)
  expect(sent.map(s => s.chat)).toEqual([OWNER])
})

test('an injected name is rejected before any card or install', async () => {
  const r = make()
  const bad = { ...req, candidate: { ...req.candidate, name: 'x; rm -rf ~' } }
  expect((await r.request(OWNER, defaultPolicy('private'), bad)).text).toContain('Rejected')
  expect(sent).toHaveLength(0)
})

test('mcp and plugin keep their ledger kind; T3 card shows the exact command', async () => {
  const r = make()
  await r.request(OWNER, defaultPolicy('private'), { ...req, candidate: { kind: 'exact', name: 'tool', argv: ['/opt/x/install', '--y'], tier: 'T3', source: 'github.com/x' } })
  expect(sent[0]!.text).toContain('Command: /opt/x/install --y')
  await r.request(OWNER, defaultPolicy('private'), { ...req, candidate: { kind: 'mcp', name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', tier: 'T1', source: 'registry' } })
  await r.decide(idOf(), 'install', OWNER)
  expect(loadLedger(stateDir).map(c => c.id)).toEqual(['mcp:notion'])
})
