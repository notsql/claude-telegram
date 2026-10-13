import { expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as access from '../access.ts'
import { loadSources, loadTarget, saveSources, type Source } from '../watch/registry.ts'
import { insertItem, openInboxDb, type Item } from '../watch/store.ts'
import { loadExamples } from '../watch/prefs.ts'

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
  const db = openInboxDb(':memory:')
  registerSources(bot, { stateDir, db, live: { start: s => void live.push(`start:${s.id}`), stop: id => void live.push(`stop:${id}`) }, which: bin => (bin === 'gh' ? '/opt/homebrew/bin/gh' : null) })
  const edits: { text: string; extra: any }[] = []
  const ctx = (from = 42, type = 'private', data?: string) => ({
    from: { id: from }, chat: { id: from, type },
    answerCallbackQuery: async () => {},
    editMessageText: async (text: string, extra: any) => void edits.push({ text, extra }),
    callbackQuery: data && { data, message: { message_id: 1, chat: type === 'private' ? { id: from, type } : { id: -100, type, title: 'Family' } } },
    match: undefined as any,
  })
  const tap = async (data: string, type = 'private') => {
    const [re, fn] = callbacks.find(([re]) => re.test(data))!
    const c = ctx(42, type, data)
    c.match = data.match(re)
    await fn(c)
  }
  return { stateDir, db, edits, ctx, tap, live, callbacks }
}

const cbs = (e: { extra: any }) => e.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)

test('Settings → Sources lists sources as buttons; a source opens its page with Pause/Resume that act live', async () => {
  const s = setup()
  saveSources(s.stateDir, [src('wa', { lastItemAt: Date.now() - 5 * 60_000 }), src('gh', { status: 'error', errors: 2 }), src('mail', { enabled: false, status: 'paused' })])
  await s.tap('src:m')
  const r = s.edits[0]!
  expect(r.extra.parse_mode).toBeUndefined()
  expect(r.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.text)).toEqual(['✅ WA', '⚠️ GH', '⏸ MAIL', '➕ Add source', '📍 Send updates here', '🎯 Tune what gets flagged (0)', '« Back', '✕ Close'])
  expect(cbs(r)).toEqual(['src:s:wa', 'src:s:gh', 'src:s:mail', 'src:a', 'src:here', 'src:t', 'pol:m', 'ui:close'])

  await s.tap('src:s:wa')
  expect(s.edits.at(-1)!.text).toBe('✅ WA\n\nWatching (stream)\nLast item 5m ago')
  expect(cbs(s.edits.at(-1)!)).toEqual(['src:pause:wa', 'src:m', 'ui:close'])
  await s.tap('src:s:gh')
  expect(s.edits.at(-1)!.text).toBe('⚠️ GH\n\nFailing (stream)\nNo items yet\n2 errors')

  await s.tap('src:pause:wa')
  expect(s.edits.at(-1)!.text).toContain('Paused (stream)')
  expect(cbs(s.edits.at(-1)!)).toEqual(['src:resume:wa', 'src:m', 'ui:close'])
  await s.tap('src:resume:mail')
  const byId = Object.fromEntries(loadSources(s.stateDir).map(x => [x.id, x]))
  expect(byId.wa).toMatchObject({ enabled: false, status: 'paused' })
  expect(byId.mail).toMatchObject({ enabled: true, status: 'ok' })
  expect(s.live).toEqual(['stop:wa', 'start:mail'])
})

test('➕ Add source lists built-ins not added yet; picking an installed one adds and starts it; a missing CLI is not added', async () => {
  const s = setup()
  await s.tap('src:a')
  expect(cbs(s.edits.at(-1)!)).toEqual(['src:add:whatsapp', 'src:add:telegram-account', 'src:add:github', 'src:add:calendar', 'src:m', 'ui:close'])
  await s.tap('src:add:github')
  expect(loadSources(s.stateDir).map(x => [x.id, (x.config.command as string[])[0]])).toEqual([['github', '/opt/homebrew/bin/gh']])
  expect(s.live).toEqual(['start:github'])
  expect(cbs(s.edits.at(-1)!)).toEqual(['src:s:github', 'src:a', 'src:here', 'src:t', 'pol:m', 'ui:close'])
  await s.tap('src:a')
  expect(cbs(s.edits.at(-1)!)).not.toContain('src:add:github')
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

test('📍 Send updates here saves the chat as the delivery target', async () => {
  const s = setup()
  await s.tap('src:m', 'supergroup')
  expect(s.edits.at(-1)!.text).toContain('sent to your DM')
  await s.tap('src:here', 'supergroup')
  expect(loadTarget(s.stateDir)).toEqual({ key: '-100', title: 'Family' })
  expect(s.edits.at(-1)!.text).toContain('sent to this chat')
  expect(cbs(s.edits.at(-1)!)).not.toContain('src:here')
  expect(cbs(s.edits.at(-1)!)).not.toContain('src:t')
  await s.tap('src:m')
  expect(s.edits.at(-1)!.text).toContain('sent to Family')
  expect(cbs(s.edits.at(-1)!)).toContain('src:here')
})

test('🎯 Tune rates real messages one at a time, flagged first, and saves the verdicts (DM only)', async () => {
  const s = setup()
  const msg = (n: number, text: string, label: string | null, over: Partial<Item> = {}) => {
    const id = insertItem(s.db, { source: 'whatsapp', extId: `m${n}`, ts: n, from: { id: 'b', name: 'Boss' }, chat: { id: 'c', name: 'C', isGroup: false }, text, toMe: true, fromMe: false, ...over })!
    s.db.query('UPDATE items SET label = ? WHERE id = ?').run(label, id)
    return id
  }
  const fyi = msg(1, 'the weather is nice today', 'fyi')
  const act = msg(2, 'please pay the electricity bill', 'action')
  msg(3, 'ok', 'fyi')
  msg(4, 'buy me a coffee on the way please', 'noise')
  msg(5, 'I will send the slides tomorrow', 'fyi', { fromMe: true })

  await s.tap('src:t', 'supergroup')
  expect(s.edits).toHaveLength(0)

  await s.tap('src:t')
  expect(s.edits.at(-1)!.text).toContain('please pay the electricity bill')
  expect(cbs(s.edits.at(-1)!)).toEqual([`src:t:y-${act}`, `src:t:n-${act}`, `src:t:s-${act}`, 'src:m', 'ui:close'])
  await s.tap(`src:t:y-${act}`)
  expect(s.edits.at(-1)!.text).toContain('the weather is nice today')
  await s.tap(`src:t:n-${fyi}`)
  expect(s.edits.at(-1)!.text).toContain('Nothing new to rate. 2 answers saved.')
  expect(loadExamples(s.stateDir).map(e => [e.itemId, e.want])).toEqual([[act, true], [fyi, false]])
})
