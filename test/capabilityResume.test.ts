import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Api } from 'grammy'
import { createCapabilityRequests, type CapabilityRequest } from '../capabilities/request.ts'
import type { InstallResult } from '../capabilities/install.ts'
import { createResumer, resumeText } from '../capabilities/resume.ts'
import { defaultPolicy } from '../policy/schema.ts'

const OWNER = '111'
const ORIGIN = '-100500:7'

let sent: { chat: string; text: string; buttons: string[] }[]
let runs: { key: string; text: string }[]
let installs: string[][]
let gen: Record<string, number>

const api = {
  sendMessage: async (chat: string, text: string, extra?: { reply_markup?: { inline_keyboard: { callback_data: string }[][] } }) => {
    sent.push({ chat, text, buttons: extra?.reply_markup?.inline_keyboard.flat().map(b => b.callback_data) ?? [] })
    return { message_id: sent.length }
  },
  editMessageText: async () => true,
} as unknown as Api

function setup(result: InstallResult = { ok: true, code: 0, timedOut: false, output: '' }) {
  const resumer = createResumer({ api, owners: () => [OWNER], generation: k => gen[k] ?? 0, run: (key, text) => { runs.push({ key, text }) } })
  const requests = createCapabilityRequests({
    api, stateDir: mkdtempSync(join(tmpdir(), 'cap-resume-')),
    owners: () => [OWNER],
    sender: () => OWNER,
    // Stub: never installs anything real.
    install: async argv => { installs.push(argv); return result },
    generation: k => gen[k] ?? 0,
    onInstalled: (origin, req) => resumer.installed(origin, req.candidate.name, req.resume, req.candidate.auth),
  })
  return { resumer, requests }
}

const cli: CapabilityRequest = { candidate: { kind: 'brew', name: 'imagemagick', tier: 'T1', source: 'homebrew/core' }, reason: 'heic', resume: 'convert photo.heic to jpg' }
const oauth: CapabilityRequest = {
  candidate: { kind: 'mcp', name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', tier: 'T2', source: 'registry', auth: 'claude mcp login linear' },
  reason: 'read issues', resume: 'summarise my open issues',
}
const flush = () => new Promise(r => setTimeout(r, 0))
const cardId = () => sent[0]!.buttons[0]!.split(':')[2]!
const doneId = () => sent[1]!.buttons[0]!.match(/^cap:done:([0-9a-f]+)$/)![1]!

beforeEach(() => { sent = []; runs = []; installs = []; gen = {} })

test('FR8: after a stubbed install without auth, the origin session gets the continue turn', async () => {
  const { requests } = setup()
  await requests.request(ORIGIN, defaultPolicy('private'), cli)
  await requests.decide(cardId(), 'install', OWNER)
  await flush()
  expect(installs).toEqual([['brew', 'install', 'imagemagick']])
  expect(runs).toEqual([{ key: ORIGIN, text: 'capability imagemagick is ready; continue the task: convert photo.heic to jpg' }])
})

test('AC5: an OAuth MCP server sends login instructions and does not resume until Done', async () => {
  const { requests, resumer } = setup()
  await requests.request(ORIGIN, defaultPolicy('private'), oauth)
  await requests.decide(cardId(), 'install', OWNER)
  await flush()
  expect(runs).toHaveLength(0)
  expect(sent[1]!.chat).toBe(OWNER)
  expect(sent[1]!.text).toContain('claude mcp login linear')
  expect(sent[1]!.buttons).toHaveLength(1)
  const id = doneId()
  expect(resumer.done(id)).toBe(true)
  expect(runs).toEqual([{ key: ORIGIN, text: resumeText('linear', 'summarise my open issues') }])
  expect(resumer.done(id)).toBeUndefined()
  expect(runs).toHaveLength(1)
})

test('a failed install starts no resume turn', async () => {
  const { requests } = setup({ ok: false, code: 1, timedOut: false, output: 'nope' })
  await requests.request(ORIGIN, defaultPolicy('private'), cli)
  await requests.decide(cardId(), 'install', OWNER)
  await flush()
  expect(runs).toHaveLength(0)
})

test('the resume turn is dropped if the origin session was reset meanwhile', async () => {
  const { requests, resumer } = setup()
  await requests.request(ORIGIN, defaultPolicy('private'), cli)
  gen[ORIGIN] = 1
  await requests.decide(cardId(), 'install', OWNER)
  await flush()
  expect(runs).toHaveLength(0)

  gen = {}; sent = []
  await requests.request(ORIGIN, defaultPolicy('private'), oauth)
  await requests.decide(cardId(), 'install', OWNER)
  await flush()
  gen[ORIGIN] = 1
  expect(resumer.done(doneId())).toBe(false)
  expect(runs).toHaveLength(0)
})
