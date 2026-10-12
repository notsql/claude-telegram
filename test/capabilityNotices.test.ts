import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Api } from 'grammy'
import { createCapabilityNotices } from '../capabilities/notices.ts'
import { createCapabilityRequests, type CapabilityRequest } from '../capabilities/request.ts'
import { linkSkill, loadLedger, unlearned, useSkillName, type Capability } from '../capabilities/ledger.ts'
import { createSkillNotices } from '../skills/notices.ts'
import { skillsContext } from '../reflection/prompt.ts'
import { defaultPolicy } from '../policy/schema.ts'

const OWNER = '111'
let stateDir: string
let sent: { chat: string; text: string; buttons: string[] }[]
let runs: string[][]
let archived: string[]
let uninstallOk: boolean

const api = {
  sendMessage: async (chat: string, text: string, extra: { reply_markup?: { inline_keyboard: { callback_data: string }[][] } } = {}) => {
    sent.push({ chat, text, buttons: extra.reply_markup?.inline_keyboard.flat().map(b => b.callback_data) ?? [] })
    return { message_id: sent.length }
  },
  editMessageText: async () => true,
} as unknown as Api

// Stubs: nothing real is ever installed or uninstalled.
const run = async (argv: string[]) => { runs.push(argv); return { ok: argv[1] === 'install' || uninstallOk, code: 0, timedOut: false, output: '' } }
const notices = () => createCapabilityNotices({ api, stateDir, uninstall: run, archiveSkill: n => { archived.push(n) } })

const req: CapabilityRequest = {
  candidate: { kind: 'brew', name: 'imagemagick', tier: 'T1', source: 'homebrew/core' },
  reason: 'convert heic to jpg',
  resume: 'convert photo.heic',
}

async function install(n: ReturnType<typeof notices>): Promise<Capability> {
  let entry: Capability | undefined
  const r = createCapabilityRequests({
    api, stateDir, owners: () => [OWNER], sender: () => OWNER, install: run, generation: () => 0,
    onInstalled: (_o, _r, e) => { entry = e; return n.notify(OWNER, e) },
  })
  await r.request(OWNER, defaultPolicy('private'), req)
  await r.decide(sent.at(-1)!.buttons[0]!.split(':')[2]!, 'install', OWNER)
  await Bun.sleep(0)
  return entry!
}

const undoId = () => sent.at(-1)!.buttons[0]!.split(':')[2]!

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'capn-'))
  sent = []; runs = []; archived = []; uninstallOk = true
})

test('AC7: Undo runs the paired uninstall, archives the skill, and /caps shows uninstalled', async () => {
  const n = notices()
  const entry = await install(n)
  expect(entry.uninstall).toEqual(['brew', 'uninstall', 'imagemagick'])
  expect(sent.at(-1)!.text).toContain('🧩 Installed imagemagick')
  expect(sent.at(-1)!.chat).toBe(OWNER)
  expect(linkSkill(stateDir, 'use-imagemagick')).toBe(true)

  expect(await n.undo(undoId())).toBe('↩️ Uninstalled imagemagick; archived skill use-imagemagick')
  expect(runs.at(-1)).toEqual(['brew', 'uninstall', 'imagemagick'])
  expect(archived).toEqual(['use-imagemagick'])
  expect(loadLedger(stateDir)[0]!.status).toBe('uninstalled')
  expect(n.list().text).toContain('imagemagick (cli, T1): uninstalled')
  expect(n.list().keyboard).toBeUndefined()
})

test('Undo runs once; a failed uninstall leaves it installed and retryable', async () => {
  const n = notices()
  await install(n)
  const id = undoId()
  uninstallOk = false
  expect(await n.undo(id)).toStartWith('❌ Uninstall failed')
  expect(loadLedger(stateDir)[0]!.status).toBe('installed')
  uninstallOk = true
  expect(await n.undo(id)).toBe('↩️ Uninstalled imagemagick')
  expect(await n.undo(id)).toBeUndefined()
  expect(archived).toEqual([])
})

test('/caps lists installed entries with how and when, and an Uninstall button', async () => {
  const n = notices()
  expect(n.list().text).toBe('No capabilities acquired yet.')
  await install(n)
  const v = n.list()
  expect(v.text).toMatch(/imagemagick \(cli, T1\): installed, installed \d{4}-\d\d-\d\d via brew install imagemagick/)
  const cb = v.keyboard!.inline_keyboard[0]![0]!.callback_data
  expect(await n.undo(cb.split(':')[2]!)).toBe('↩️ Uninstalled imagemagick')
})

test('FR9: skill names, reflection context and linking on a learned skill', async () => {
  expect(useSkillName({ name: '@scope/Some.Tool' })).toBe('use-scope-some-tool')
  expect(useSkillName({ name: 'x'.repeat(80) })).toHaveLength(48)
  await install(notices())
  const pending = unlearned(loadLedger(stateDir)).map(c => `${useSkillName(c)}: ${c.kind} ${c.name}`)
  expect(skillsContext([], 1, [], [], pending)).toContain('- use-imagemagick: cli imagemagick')
  expect(skillsContext([], 1, [])).not.toContain('Newly installed')

  const learned: string[] = []
  const sn = createSkillNotices(api, name => { learned.push(name); linkSkill(stateDir, name) })
  await sn.notify(OWNER, { verb: 'Learned', name: 'use-imagemagick', version: 1, store: {} as never, undo: () => {} })
  await sn.notify(OWNER, { verb: 'Updated', name: 'other', version: 2, store: {} as never, undo: () => {} })
  expect(learned).toEqual(['use-imagemagick'])
  expect(loadLedger(stateDir)[0]!.skill).toBe('use-imagemagick')
  expect(unlearned(loadLedger(stateDir))).toEqual([])
})
