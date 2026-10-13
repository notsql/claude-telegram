import { expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as access from '../access.ts'
import { loadSources, saveSources, type Source } from '../watch/registry.ts'

// Another test mocks access.ts module-wide, so pin the owner the same way.
mock.module('../access.ts', () => ({ ...access, loadAccess: () => ({ ...access.defaultAccess(), allowFrom: ['42'] }) }))
const { registerSources } = await import('../telegram/handlers/sources.ts')

const src = (id: string, over: Partial<Source> = {}): Source => ({
  id, title: id.toUpperCase(), kind: 'stream', enabled: true, config: {}, cursor: null, status: 'ok', lastItemAt: null, errors: 0, ...over,
})
function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-sources-'))
  const callbacks: [RegExp, (ctx: any) => Promise<unknown>][] = []
  const bot = { callbackQuery: (re: RegExp, fn: any) => callbacks.push([re, fn]) } as any
  const live: string[] = []
  registerSources(bot, { stateDir, live: { start: s => void live.push(`start:${s.id}`), stop: id => void live.push(`stop:${id}`) }, which: bin => (bin === 'gh' ? '/opt/homebrew/bin/gh' : null) })
  const edits: { text: string; extra: any }[] = []
  const ctx = (from = 42, type = 'private', data?: string) => ({
    from: { id: from }, chat: { id: from, type },
    answerCallbackQuery: async () => {},
    editMessageText: async (text: string, extra: any) => void edits.push({ text, extra }),
    callbackQuery: data && { data },
    match: undefined as any,
  })
  const tap = async (data: string) => {
    const [re, fn] = callbacks.find(([re]) => re.test(data))!
    const c = ctx(42, 'private', data)
    c.match = data.match(re)
    await fn(c)
  }
  return { stateDir, edits, ctx, tap, live, callbacks }
}

test('Settings → Sources lists status, last item and errors, with Pause/Resume that act live', async () => {
  const s = setup()
  saveSources(s.stateDir, [src('wa', { lastItemAt: Date.now() - 5 * 60_000 }), src('gh', { status: 'error', errors: 2 }), src('mail', { enabled: false, status: 'paused' })])
  await s.tap('src:m')
  const r = s.edits[0]!
  expect(r.text).toContain('✅ WA (wa, stream): last item 5m ago')
  expect(r.text).toContain('⚠️ GH (gh, stream): no items yet, 2 errors')
  expect(r.text).toContain('⏸ MAIL')
  expect(r.extra.parse_mode).toBeUndefined()
  const cbs = r.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)
  expect(cbs).toEqual(['src:pause:wa', 'src:pause:gh', 'src:resume:mail', 'src:add:whatsapp', 'src:add:telegram-account', 'src:add:github', 'src:add:calendar', 'pol:m', 'ui:close'])

  await s.tap('src:pause:wa')
  await s.tap('src:resume:mail')
  const byId = Object.fromEntries(loadSources(s.stateDir).map(x => [x.id, x]))
  expect(byId.wa).toMatchObject({ enabled: false, status: 'paused' })
  expect(byId.mail).toMatchObject({ enabled: true, status: 'ok' })
  expect(s.live).toEqual(['stop:wa', 'start:mail'])
})

test('Settings → Sources ➕ adds an installed built-in and starts it; a missing CLI is not added', async () => {
  const s = setup()
  await s.tap('src:add:github')
  expect(loadSources(s.stateDir).map(x => [x.id, (x.config.command as string[])[0]])).toEqual([['github', '/opt/homebrew/bin/gh']])
  expect(s.live).toEqual(['start:github'])
  expect(s.edits.at(-1)!.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)).not.toContain('src:add:github')
  await s.tap('src:add:whatsapp')
  expect(loadSources(s.stateDir).map(x => x.id)).toEqual(['github'])
})

test('Sources is owner only, and works in a group', async () => {
  const s = setup()
  const [re, fn] = s.callbacks.find(([re]) => re.test('src:add:github'))!
  for (const [from, type] of [[7, 'private'], [42, 'supergroup']] as const) {
    const c = s.ctx(from, type, 'src:add:github'); c.match = 'src:add:github'.match(re)
    await fn(c)
  }
  expect(loadSources(s.stateDir).map(x => x.id)).toEqual(['github'])
})
