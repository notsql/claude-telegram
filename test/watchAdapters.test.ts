import { expect, test } from 'bun:test'
import { tgcliItem } from '../watch/adapters/tgcli'
import { wacliItem } from '../watch/adapters/wacli'

// Recorded from source, not a live capture: gotd/cli v0.11.0 cmd/tg/watch.go
// (`tgcli watch --output json`, one line per message; `account` only with --account all).
const tgDm = { peer: { id: 777, type: 'user', name: 'Alex Tan', username: 'alext' }, message: { id: 42, date: 1760000000, out: false, text: 'can you send the deck?' } }
const tgGroup = {
  peer: { id: 1001, type: 'channel', name: 'Team' },
  message: { id: 9, date: 1760000001, out: false, from: { id: 5, type: 'user', name: 'Bo' }, media: 'photo', reply_to: 7 },
}

test('tgcli: DM maps to a toMe item keyed on chat + message id', () => {
  expect(tgcliItem('telegram-account', tgDm)).toEqual({
    source: 'telegram-account', extId: 'user:777:42', ts: 1760000000000,
    from: { id: 'user:777', name: 'Alex Tan' }, chat: { id: 'user:777', name: 'Alex Tan', isGroup: false },
    text: 'can you send the deck?', url: 'https://t.me/alext/42', toMe: true, fromMe: false, threadId: undefined,
  })
})

test('tgcli: group media message uses message.from and a media placeholder', () => {
  const item = tgcliItem('tg', tgGroup)!
  expect(item.from).toEqual({ id: 'user:5', name: 'Bo' })
  expect(item.chat).toEqual({ id: 'channel:1001', name: 'Team', isGroup: true })
  expect(item.text).toBe('[photo]')
  expect(item.toMe).toBe(false)
  expect(item.threadId).toBe('7')
})

test('tgcli: outgoing is fromMe; malformed or empty lines are dropped', () => {
  const out = tgcliItem('tg', { ...tgDm, message: { ...tgDm.message, out: true } })!
  expect([out.fromMe, out.toMe, out.from.id]).toEqual([true, false, 'me'])
  expect(tgcliItem('tg', { hello: 1 })).toBeNull()
  expect(tgcliItem('tg', { ...tgDm, message: { id: 1, date: 1, out: false } })).toBeNull()
})

// wacli 0.20.0 docs/sync.md "Webhook payloads" (+ PushName/ReplyToID from wa.ParsedMessage).
const waDm = { Chat: '15551234567@s.whatsapp.net', ID: '3EB0AA', SenderJID: '15551234567@s.whatsapp.net', Timestamp: '2026-07-25T10:00:00Z', FromMe: false, Text: 'hi', PushName: 'Alice', ChatName: 'Alice', Media: null }

test('wacli: DM message maps to a toMe item', () => {
  expect(wacliItem('whatsapp', waDm)).toEqual({
    source: 'whatsapp', extId: '15551234567@s.whatsapp.net:3EB0AA', ts: Date.parse('2026-07-25T10:00:00Z'),
    from: { id: '15551234567@s.whatsapp.net', name: 'Alice' }, chat: { id: '15551234567@s.whatsapp.net', name: 'Alice', isGroup: false },
    text: 'hi', toMe: true, fromMe: false, threadId: undefined,
  })
})

test('wacli: group media caption, sender without push name, own message', () => {
  const g = wacliItem('whatsapp', { ...waDm, Chat: '120363000000000000@g.us', ChatName: 'Family', PushName: '', Text: '', Media: { Type: 'image', Caption: 'look' }, ReplyToID: 'X1' })!
  expect(g.chat).toEqual({ id: '120363000000000000@g.us', name: 'Family', isGroup: true })
  expect(g.from.name).toBe('15551234567')
  expect([g.text, g.toMe, g.threadId]).toEqual(['look', false, 'X1'])
  expect(wacliItem('whatsapp', { ...waDm, FromMe: true })!.fromMe).toBe(true)
})

test('wacli: receipts, presence and empty payloads are skipped', () => {
  expect(wacliItem('whatsapp', { EventType: 'receipt', Chat: 'x@g.us', Sender: 'y', MessageIDs: ['a'], Timestamp: '2026-07-25T10:00:01Z', Type: 'delivered', IsFromMe: false })).toBeNull()
  expect(wacliItem('whatsapp', { EventType: 'chat_presence', Chat: 'x', Sender: 'y', State: 'composing', Media: '' })).toBeNull()
  expect(wacliItem('whatsapp', { ...waDm, Text: '' })).toBeNull()
})
