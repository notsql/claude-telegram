import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { browserArgv, browserUrl } from '../browser/server'
import { SIGNIN_CALLBACK, signinUrl, signinView } from '../browser/signin'
import { policyView } from '../telegram/policyUi'
import { continueText, createHandoffs } from '../browser/handoff'
import { turnArgv } from '../agent/runner'

describe('shared browser (015 T1501)', () => {
  test('argv: pinned package under Bun, bound to 127.0.0.1, persistent WebKit profile shared by clients', () => {
    const argv = browserArgv(4321, '/state/browser')
    expect(argv.slice(1, 4)).toEqual(['x', '--bun', '@playwright/mcp@0.0.83'])
    const flag = (f: string) => argv[argv.indexOf(f) + 1]
    expect(flag('--host')).toBe('127.0.0.1')
    expect(flag('--allowed-hosts')).toBe('127.0.0.1:4321')
    expect(flag('--port')).toBe('4321')
    expect(flag('--browser')).toBe('webkit')
    expect(flag('--user-data-dir')).toBe('/state/browser/profile')
    expect(argv).toContain('--shared-browser-context')
    expect(flag('--viewport-size')).toBe('960x720')
    expect(argv).not.toContain('--headless')
    expect(argv).not.toContain('--isolated')
  })

  const opts = { settingsFile: '/s.json', mcpPort: 1, mcpToken: 't', hookToken: 'h', cwd: '/', maxTurns: 5, policyArgs: [] }
  const servers = (o: object) => { const a = turnArgv('k', { ...opts, ...o }); return JSON.parse(a[a.indexOf('--mcp-config') + 1]).mcpServers }

  test('turns get the browser server only when it runs (FR2, AC4)', () => {
    expect(Object.keys(servers({}))).toEqual(['tg'])
    expect(servers({ browserPort: 4321 }).browser).toEqual({ type: 'http', url: browserUrl(4321) })
  })
})

describe('🌐 Browser sign-in (015 T1502, T1504)', () => {
  test('adds https:// to a bare host and keeps http(s) URLs', () => {
    expect(signinUrl('portal.spgroup.com.sg')).toBe('https://portal.spgroup.com.sg/')
    expect(signinUrl(' https://example.com/login?x=1 ')).toBe('https://example.com/login?x=1')
    expect(signinUrl('http://intranet.local')).toBe('http://intranet.local/')
  })

  test('a ⚙️ Settings page, shown only when the browser runs; its buttons round-trip', () => {
    const data = (o: { signin?: boolean }) => policyView('5', {}, o).keyboard.inline_keyboard.flat().map(b => 'callback_data' in b ? b.callback_data : '')
    expect(data({ signin: true })).toContain('web:m')
    expect(data({})).not.toContain('web:m')
    const page = signinView().keyboard.inline_keyboard.flat().map(b => 'callback_data' in b ? b.callback_data! : '')
    expect(page).toEqual(['web:a', 'pol:m'])
    for (const d of page.filter(d => d.startsWith('web:'))) expect(SIGNIN_CALLBACK.test(d)).toBe(true)
  })

  test('rejects empty input, other schemes and text with spaces', () => {
    for (const bad of ['', '   ', 'file:///etc/passwd', 'javascript://x', 'two words', 'https://'])
      expect(signinUrl(bad)).toBeNull()
  })
})

test('ladder: login sites use the shared browser and hand the sign-in to the owner (015 T1503)', () => {
  const skill = readFileSync(join(import.meta.dir, '..', 'assets', 'skills', 'tg-capability-ladder', 'SKILL.md'), 'utf8')
  expect(skill).toContain('mcp__browser__')
  expect(skill).toContain('browser_signin')
  expect(skill).toMatch(/never ask for a password/i)
})

describe('browser_signin handoff (015 T1505)', () => {
  const setup = (gen = { n: 0 }) => {
    const sent: { chatId: unknown; text: string; markup: any }[] = [], opened: string[] = [], runs: [string, string][] = []
    const api = { sendMessage: async (chatId: unknown, text: string, extra: any) => { sent.push({ chatId, text, markup: extra.reply_markup }); return { message_id: 1, chat: { id: chatId } } } } as any
    const h = createHandoffs({ api, open: async u => { opened.push(u) }, generation: () => gen.n, run: (k, t) => runs.push([k, t]) })
    return { h, sent, opened, runs, gen }
  }
  const idOf = (markup: any) => markup.inline_keyboard[0][0].callback_data.split(':')[2]

  test('opens the site, posts the card in the calling chat (a group topic too), and Signed in resumes there', async () => {
    const { h, sent, opened, runs } = setup()
    const r = await h.call('browser_signin', { url: 'portal.spgroup.com.sg/login', reason: 'read your SP bill', resume: 'read the latest bill' }, '-100123:7')
    expect(r!.isError).toBeUndefined()
    expect(opened).toEqual(['https://portal.spgroup.com.sg/login'])
    expect(sent[0]!.chatId).toBe('-100123')
    expect(sent[0]!.text).toContain('To read your SP bill, I need you signed in to portal.spgroup.com.sg')
    const id = idOf(sent[0]!.markup)
    expect(SIGNIN_CALLBACK.test(`web:d:${id}`) && SIGNIN_CALLBACK.test(`web:s:${id}`)).toBe(true)
    expect(h.done(id)).toBe(true)
    expect(runs).toEqual([['-100123:7', continueText('portal.spgroup.com.sg', 'read the latest bill')]])
    expect(h.done(id)).toBeUndefined()
  })

  test('a reset session drops the resume; Skip never resumes; bad urls are refused', async () => {
    const { h, sent, runs, gen } = setup()
    await h.call('browser_signin', { url: 'https://a.com', reason: 'x', resume: 'y' }, '5')
    gen.n = 1
    expect(h.done(idOf(sent[0]!.markup))).toBe(false)
    await h.call('browser_signin', { url: 'https://b.com', reason: 'x', resume: 'y' }, '5')
    const id = idOf(sent[1]!.markup)
    expect(h.skip(id)).toBe(true)
    expect(h.done(id)).toBeUndefined()
    expect(runs).toEqual([])
    expect((await h.call('browser_signin', { url: 'file:///etc/passwd', reason: 'x', resume: 'y' }, '5'))!.isError).toBe(true)
    expect(await h.call('memory_read', {}, '5')).toBeUndefined()
  })

  test('the ladder tells the agent to call it unprompted', () => {
    const skill = readFileSync(join(import.meta.dir, '..', 'assets', 'skills', 'tg-capability-ladder', 'SKILL.md'), 'utf8')
    expect(skill).toContain('browser_signin')
    expect(skill).toMatch(/Don't wait to be told/)
  })
})
