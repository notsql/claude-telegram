import { expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as access from '../access.ts'
import { insertItem, openInboxDb, type Item } from '../watch/store.ts'
import { loadSources, saveSources, type Source } from '../watch/registry.ts'
import { createDeliver } from '../watch/deliver.ts'

// Another test mocks access.ts module-wide, so pin the owner the same way.
mock.module('../access.ts', () => ({ ...access, loadAccess: () => ({ ...access.defaultAccess(), allowFrom: ['42'] }) }))
const { registerWatchCommands } = await import('../telegram/handlers/watch.ts')

const src = (id: string, over: Partial<Source> = {}): Source => ({
  id, title: id.toUpperCase(), kind: 'stream', enabled: true, config: {}, cursor: null, status: 'ok', lastItemAt: null, errors: 0, ...over,
})
const item = (n: number): Item => ({
  source: 'whatsapp', extId: `m${n}`, ts: 1_000 + n, from: { id: 'b', name: 'Boss' },
  chat: { id: 'c', name: 'C', isGroup: false }, text: `<b>hi ${n}</b>`, toMe: true, fromMe: false,
})

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-watchcmd-'))
  const db = openInboxDb(':memory:')
  const callbacks: [RegExp, (ctx: any) => Promise<unknown>][] = []
  const bot = { callbackQuery: (re: RegExp, fn: any) => callbacks.push([re, fn]) } as any
  const live: string[] = []
  const ui = registerWatchCommands(bot, { stateDir, db, live: { start: s => void live.push(`start:${s.id}`), stop: id => void live.push(`stop:${id}`) }, which: bin => (bin === 'gh' ? '/opt/homebrew/bin/gh' : null) })
  const replies: { text: string; extra: any }[] = []
  const edits: { text: string; extra: any }[] = []
  const ctx = (from = 42, type = 'private', data?: string) => ({
    from: { id: from }, chat: { id: from, type },
    reply: async (text: string, extra: any) => void replies.push({ text, extra }),
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
  return { stateDir, db, ui, replies, edits, ctx, tap, live, callbacks }
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

test('Sources and /inbox are owner-DM only', async () => {
  const s = setup()
  await s.ui.inbox.handler(s.ctx(42, 'group') as any, '')
  expect(s.replies).toEqual([])
  expect(s.ui.inbox.menu).toEqual(['private'])
  const [re, fn] = s.callbacks.find(([re]) => re.test('src:add:github'))!
  const c = s.ctx(7, 'private', 'src:add:github'); c.match = 'src:add:github'.match(re)
  await fn(c)
  expect(loadSources(s.stateDir)).toEqual([])
})

test('/inbox shows un-done urgent/action items and open loops as plain text with inb: Done/Snooze', async () => {
  const s = setup()
  const label = (id: number, l: string | null, status = 'new') => s.db.query('UPDATE items SET label = ?, status = ? WHERE id = ?').run(l, status, id)
  const urgent = insertItem(s.db, item(1))!; label(urgent, 'urgent')
  const done = insertItem(s.db, item(2))!; label(done, 'action', 'done')
  const fyi = insertItem(s.db, item(3))!; label(fyi, 'fyi')
  const loop = insertItem(s.db, item(4))!; label(loop, 'fyi')
  s.db.query('INSERT INTO loops (item_id, kind, summary, opened_at) VALUES (?, ?, ?, ?)').run(loop, 'promise', 'send the deck', 1)

  await s.ui.inbox.handler(s.ctx() as any, '')
  expect(s.replies.map(r => r.text)).toEqual([
    'Inbox: 2 open',
    '🔴 whatsapp · Boss\n\n<b>hi 1</b>',
    '🔁 whatsapp · Boss\nLoop: send the deck\n\n<b>hi 4</b>',
  ])
  expect(s.replies.every(r => r.extra?.parse_mode === undefined)).toBe(true)
  expect(s.replies[1]!.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data))
    .toEqual([`inb:snz1:${urgent}`, `inb:snzt:${urgent}`, `inb:done:${urgent}`])

  // Done goes through deliver's tap, which closes the loop too.
  const d = createDeliver({ db: s.db, api: { sendMessage: async () => {} }, owner: '42', vips: [], mute: () => {} })
  expect(d.tap('done', loop)).toBe('✅ Done')
  s.replies.length = 0
  await s.ui.inbox.handler(s.ctx() as any, '')
  expect(s.replies).toHaveLength(2)
  label(urgent, 'urgent', 'done')
  s.replies.length = 0
  await s.ui.inbox.handler(s.ctx() as any, '')
  expect(s.replies[0]!.text).toBe('Inbox clear: nothing urgent, no open loops.')
})
