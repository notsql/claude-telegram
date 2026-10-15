import { expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as access from '../access.ts'
import { saveSources, type Source } from '../watch/registry.ts'
import { DEFAULT_PREFS, loadDigestPrefs } from '../watch/digestPrefs.ts'
import { openInboxDb } from '../watch/store.ts'
import { createWatchTools } from '../watch/tools.ts'

// Another test mocks access.ts module-wide, so pin the owner the same way.
mock.module('../access.ts', () => ({ ...access, loadAccess: () => ({ ...access.defaultAccess(), allowFrom: ['42'] }) }))
const { registerDigest, SETUP_INTRO } = await import('../telegram/handlers/digest.ts')

const src = (id: string): Source => ({ id, title: id.toUpperCase(), kind: 'stream', enabled: true, config: {}, cursor: null, status: 'ok', lastItemAt: null, errors: 0 })

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-digestui-'))
  const callbacks: [RegExp, (ctx: any) => Promise<unknown>][] = []
  const sent: { chatId: string; text: string; extra: any }[] = []
  const bot = { callbackQuery: (re: RegExp, fn: any) => callbacks.push([re, fn]), api: { sendMessage: async (chatId: string, text: string, extra: any) => { sent.push({ chatId, text, extra }); return { chat: { id: Number(chatId) }, message_id: 60 } } } } as any
  let reloads = 0
  const ui = registerDigest(bot, { stateDir, owner: () => '42', reload: () => void reloads++ })
  const edits: { text: string; extra: any }[] = []
  const tap = async (data: string) => {
    const [re, fn] = callbacks.find(([re]) => re.test(data))!
    await fn({
      from: { id: 42 }, chat: { id: 42, type: 'private' }, match: data.match(re),
      answerCallbackQuery: async () => {},
      editMessageText: async (text: string, extra: any) => void edits.push({ text, extra }),
      callbackQuery: { data, message: { message_id: 1, chat: { id: 42, type: 'private' } } },
    })
  }
  return { stateDir, sent, edits, tap, ui, reloads: () => reloads }
}

const texts = (e: { extra: any }) => e.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.text)

test('the setup message goes to the owner DM once and saves the defaults', async () => {
  const s = setup()
  await s.ui.offer()
  await s.ui.offer()
  expect(s.sent).toHaveLength(1)
  expect(s.sent[0]!.chatId).toBe('42')
  expect(s.sent[0]!.text).toBe(`${SETUP_INTRO}\n\nNow: 08:30 and 18:30, every day`)
  expect(texts(s.sent[0]!)).toEqual(['● ☀️🌙 Morning and evening', '☀️ Morning only', '🌙 Evening only', '🔕 No digest', '🕐 Custom times…', '● 📅 Every day', '💼 Weekdays only', 'Next: what to include »', '✕ Close'])
  expect(loadDigestPrefs(s.stateDir)).toEqual(DEFAULT_PREFS)
})

test('When: presets, weekdays and custom times save and reschedule', async () => {
  const s = setup()
  await s.tap('dg:p:pm')
  await s.tap('dg:d:wk')
  expect(s.edits.at(-1)!.text).toBe('🗞 Digest · When\n\nNow: 18:30, weekdays only')
  expect(s.reloads()).toBe(2)
  await s.tap('dg:h')
  expect(texts(s.edits.at(-1)!).slice(0, 6)).toEqual(['06', '07', '08', '09', '10', '11'])
  await s.tap('dg:h:07')
  expect(texts(s.edits.at(-1)!)).toEqual(['07:00', '07:15', '07:30', '07:45', '« Back', '✕ Close'])
  await s.tap('dg:a:0745')
  expect(texts(s.edits.at(-1)!)).toEqual(['🕐 07:45  ✕', '🕐 18:30  ✕', '+ Add a time', '« Back', '✕ Close'])
  await s.tap('dg:x:1830')
  expect(loadDigestPrefs(s.stateDir)!.times).toEqual(['07:45'])
  await s.tap('dg:f')
  expect(texts(s.edits.at(-1)!)[4]).toBe('● 🕐 Custom times…')
})

test('What: sections and sources toggle, and the page shows the result', async () => {
  const s = setup()
  saveSources(s.stateDir, [src('wa'), src('gh')])
  await s.tap('dg:c')
  expect(texts(s.edits.at(-1)!)).toEqual(['✅ 📬 Waiting on you', '✅ 📰 FYI updates', '✅ 🤝 Things I promised', '✅ 📡 WA', '✅ 📡 GH', '✏️ Add a note…', '✓ Done', '✕ Close'])
  await s.tap('dg:w:fyi')
  await s.tap('dg:s:gh')
  expect(texts(s.edits.at(-1)!).slice(1, 5)).toEqual(['⬜ 📰 FYI updates', '✅ 🤝 Things I promised', '✅ 📡 WA', '⬜ 📡 GH'])
  await s.tap('dg:m')
  expect(s.edits.at(-1)!.text).toBe('🗞 Digest\n\nWhen: 08:30 and 18:30, every day\nIncludes: 📬 Waiting on you, 🤝 Things I promised\nSources: all but GH')
  expect(s.reloads()).toBe(0)
})

test('✏️ Add a note asks for a reply and saves it; - clears it', async () => {
  const s = setup()
  await s.tap('dg:n')
  expect(s.sent[0]!.extra.reply_markup.force_reply).toBe(true)
  const replies: string[] = []
  const reply = (text: string) => ({ from: { id: 42 }, chat: { id: 42, type: 'private' }, message: { text, reply_to_message: { message_id: 60 } }, reply: async (t: string) => void replies.push(t) }) as any
  expect(await s.ui.noteReply(reply('skip crypto'))).toBe(true)
  expect(loadDigestPrefs(s.stateDir)!.note).toBe('skip crypto')
  expect(replies[0]).toContain('Your note: skip crypto')
  expect(await s.ui.noteReply(reply('again'))).toBe(false)
})

test('digest_settings reads and changes the prefs, rejecting bad times; an agent-added source offers the setup', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-digesttool-'))
  const cards: string[] = []
  let changed = 0
  let added = 0
  const tools = createWatchTools({
    db: openInboxDb(':memory:'), stateDir, which: () => '/usr/bin/gh',
    api: { async sendMessage(_c, text) { cards.push(text) } },
    isOwnerDm: key => key === '42', spawn: async () => ({ ok: true }),
    added: () => void added++, digestChanged: () => void changed++,
  })
  expect((await tools.call('digest_settings', {}, '42'))!.content[0]!.text).toStartWith('When: 08:30 and 18:30, every day')
  const r = await tools.call('digest_settings', { times: ['07:00'], weekdays: true, fyi: false }, '42')
  expect(r!.content[0]!.text).toStartWith('When: 07:00, weekdays only')
  expect(loadDigestPrefs(stateDir)).toMatchObject({ times: ['07:00'], weekdays: true, fyi: false, waiting: true })
  expect(changed).toBe(1)
  expect((await tools.call('digest_settings', { times: ['7am'] }, '42'))!.isError).toBe(true)
  expect((await tools.call('digest_settings', {}, '99'))!.isError).toBe(true)
  await tools.call('source_add', { builtin: 'github' }, '42')
  tools.addTap('add', 1)
  expect(added).toBe(1)
})
