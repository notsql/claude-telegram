import { expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as access from '../access.ts'
import { loadSources, saveSources, type Source } from '../watch/registry.ts'
import { saveUpdatesTarget } from '../telegram/updates.ts'
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
  const asked: { chatId: string; text: string; extra: any }[] = []
  const bot = { callbackQuery: (re: RegExp, fn: any) => callbacks.push([re, fn]), api: { sendMessage: async (chatId: string, text: string, extra: any) => { asked.push({ chatId, text, extra }); return { chat: { id: Number(chatId) }, message_id: 50 } } } } as any
  const setups: string[][] = []
  const live: string[] = []
  const db = openInboxDb(':memory:')
  const ui = registerSources(bot, { stateDir, db, live: { start: s => void live.push(`start:${s.id}`), stop: id => void live.push(`stop:${id}`) }, which: bin => (bin === 'gh' ? '/opt/homebrew/bin/gh' : null),
    owner: () => '42', setup: (prompt, text) => void setups.push([prompt, text]) })
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
  return { stateDir, db, edits, ctx, tap, live, callbacks, asked, setups, ui }
}

const cbs = (e: { extra: any }) => e.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)

test('Settings → Sources lists sources as buttons; a source opens its page with Pause/Resume that act live', async () => {
  const s = setup()
  saveSources(s.stateDir, [src('wa', { lastItemAt: Date.now() - 5 * 60_000 }), src('gh', { status: 'error', errors: 2 }), src('mail', { enabled: false, status: 'paused' })])
  await s.tap('src:m')
  const r = s.edits[0]!
  expect(r.extra.parse_mode).toBeUndefined()
  expect(r.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.text)).toEqual(['✅ WA', '⚠️ GH', '⏸ MAIL', '+ Add source', '🗞 Digest: 08:30 and 18:30, every day', '🎯 Tune what gets flagged (0)', '« Back', '✕ Close'])
  expect(cbs(r)).toEqual(['src:s:wa', 'src:s:gh', 'src:s:mail', 'src:a', 'dg:m', 'src:t', 'pol:m', 'ui:close'])

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

test('+ Add source: an installed built-in is added and started; one needing a tool starts setup in the DM', async () => {
  const s = setup()
  await s.tap('src:a')
  expect(s.edits.at(-1)!.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.text))
    .toEqual(['🔧 WhatsApp', '🔧 Telegram account', 'GitHub', 'Calendar', '✏️ Something else…', '« Back', '✕ Close'])
  expect(cbs(s.edits.at(-1)!)).toEqual(['src:add:whatsapp', 'src:add:telegram-account', 'src:add:github', 'src:add:calendar', 'src:o', 'src:m', 'ui:close'])
  await s.tap('src:add:github')
  expect(loadSources(s.stateDir).map(x => [x.id, (x.config.command as string[])[0]])).toEqual([['github', '/opt/homebrew/bin/gh']])
  expect(s.live).toEqual(['start:github'])
  expect(cbs(s.edits.at(-1)!)).toEqual(['src:s:github', 'src:a', 'dg:m', 'src:t', 'pol:m', 'ui:close'])
  await s.tap('src:a')
  expect(cbs(s.edits.at(-1)!)).not.toContain('src:add:github')
  await s.tap('src:add:whatsapp')
  expect(loadSources(s.stateDir).map(x => x.id)).toEqual(['github'])
  expect(s.setups).toEqual([['Add the built-in source "whatsapp" with source_add. If its tool is missing, help me install it, then add it.', 'Set up WhatsApp']])
})

test('✏️ Something else asks in the owner DM; the owner\'s reply starts setup', async () => {
  const s = setup()
  await s.tap('src:o', 'supergroup')
  expect(s.asked).toHaveLength(1)
  expect(s.asked[0]!.chatId).toBe('42')
  expect(s.asked[0]!.extra.reply_markup.force_reply).toBe(true)
  const reply = (from: number, text: string, to = 50) => ({ from: { id: from }, chat: { id: 42, type: 'private' }, message: { text, reply_to_message: { message_id: to } } }) as any
  expect(await s.ui.addReply(reply(42, 'hi', 49))).toBe(false)
  expect(await s.ui.addReply(reply(42, 'my Outlook inbox'))).toBe(true)
  expect(s.setups).toEqual([['Watch this as a new source with source_add, installing whatever it needs: my Outlook inbox', 'Add source: my Outlook inbox']])
  expect(await s.ui.addReply(reply(42, 'again'))).toBe(false)
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

test('the Sources page says where updates go, set bot-wide from ⚙️ Settings', async () => {
  const s = setup()
  await s.tap('src:m', 'supergroup')
  expect(s.edits.at(-1)!.text).toContain('sent to your DM (📍 on ⚙️ Settings)')
  expect(cbs(s.edits.at(-1)!)).not.toContain('src:t')
  saveUpdatesTarget(s.stateDir, { key: '-100', title: 'Family' })
  await s.tap('src:m', 'supergroup')
  expect(s.edits.at(-1)!.text).toContain('sent to this chat')
  await s.tap('src:m')
  expect(s.edits.at(-1)!.text).toContain('sent to Family')
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
