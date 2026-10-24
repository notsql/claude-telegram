import { expect, test } from 'bun:test'
import { tgcliChats, tgcliItem } from '../watch/adapters/tgcli'
import { wacliItem } from '../watch/adapters/wacli'
import { githubCommand, githubItems } from '../watch/adapters/github'

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
    text: 'can you send the deck?', url: 'https://t.me/alext/42', toMe: true, fromMe: false,
  })
})

test('tgcli: group media message uses message.from and a media placeholder', () => {
  const item = tgcliItem('tg', tgGroup)!
  expect(item.from).toEqual({ id: 'user:5', name: 'Bo' })
  expect(item.chat).toEqual({ id: 'channel:1001', name: 'Team', isGroup: true })
  expect(item.text).toBe('[photo]')
  expect(item.toMe).toBe(false)
  // A quote is not a thread: the whole chat is one conversation.
  expect(item.threadId).toBeUndefined()
})

test('tgcli: outgoing is fromMe; malformed or empty lines are dropped', () => {
  const out = tgcliItem('tg', { ...tgDm, message: { ...tgDm.message, out: true } })!
  expect([out.fromMe, out.toMe, out.from.id]).toEqual([true, false, 'me'])
  expect(tgcliItem('tg', { hello: 1 })).toBeNull()
  expect(tgcliItem('tg', { ...tgDm, message: { id: 1, date: 1, out: false } })).toBeNull()
})

test('tgcli: chats list maps chat ids to names, skipping unnamed peers', () => {
  const out = JSON.stringify({ schema: 1, data: { chats: [
    { peer: { id: 916208524, type: 'user', name: 'Jaimin - Ellipsis', username: 'JaiminOng' } },
    { peer: { id: 1001, type: 'channel', name: 'Team' } },
    { peer: { id: 3, type: 'user' } },
  ] } })
  expect([...tgcliChats(out)]).toEqual([['user:916208524', 'Jaimin - Ellipsis'], ['channel:1001', 'Team']])
})

// wacli 0.20.0 docs/sync.md "Webhook payloads" (+ PushName/ReplyToID from wa.ParsedMessage).
const waDm = { Chat: '15551234567@s.whatsapp.net', ID: '3EB0AA', SenderJID: '15551234567@s.whatsapp.net', Timestamp: '2026-07-25T10:00:00Z', FromMe: false, Text: 'hi', PushName: 'Alice', ChatName: 'Alice', Media: null }

test('wacli: DM message maps to a toMe item', () => {
  expect(wacliItem('whatsapp', waDm)).toEqual({
    source: 'whatsapp', extId: '15551234567@s.whatsapp.net:3EB0AA', ts: Date.parse('2026-07-25T10:00:00Z'),
    from: { id: '15551234567@s.whatsapp.net', name: 'Alice' }, chat: { id: '15551234567@s.whatsapp.net', name: 'Alice', isGroup: false },
    text: 'hi', toMe: true, fromMe: false,
  })
})

test('wacli: group media caption, sender without push name, own message', () => {
  const g = wacliItem('whatsapp', { ...waDm, Chat: '120363000000000000@g.us', ChatName: 'Family', PushName: '', Text: '', Media: { Type: 'image', Caption: 'look' }, ReplyToID: 'X1' })!
  expect(g.chat).toEqual({ id: '120363000000000000@g.us', name: 'Family', isGroup: true })
  expect(g.from.name).toBe('15551234567')
  expect([g.text, g.toMe, g.threadId]).toEqual(['look', false, undefined])
  expect(wacliItem('whatsapp', { ...waDm, FromMe: true })!.fromMe).toBe(true)
})

test('wacli: receipts, presence and empty payloads are skipped', () => {
  expect(wacliItem('whatsapp', { EventType: 'receipt', Chat: 'x@g.us', Sender: 'y', MessageIDs: ['a'], Timestamp: '2026-07-25T10:00:01Z', Type: 'delivered', IsFromMe: false })).toBeNull()
  expect(wacliItem('whatsapp', { EventType: 'chat_presence', Chat: 'x', Sender: 'y', State: 'composing', Media: '' })).toBeNull()
  expect(wacliItem('whatsapp', { ...waDm, Text: '' })).toBeNull()
})

// Live capture, sanitized (gh 2.x, `gh api 'notifications?all=true&per_page=1'`, 2026-10-12):
// repository trimmed to the fields read; names and ids replaced.
const ghNote = {
  id: '26257711761', unread: false, reason: 'review_requested', updated_at: '2026-10-12T01:20:54Z', last_read_at: '2026-10-11T11:59:33Z',
  subject: { title: 'feat: ensure at least one admin always exists', url: 'https://api.github.com/repos/acme/app/pulls/20', latest_comment_url: null, type: 'PullRequest' },
  repository: { id: 1, node_id: 'R_x', name: 'app', full_name: 'acme/app', private: true, html_url: 'https://github.com/acme/app' },
  url: 'https://api.github.com/notifications/threads/26257711761', subscription_url: 'https://api.github.com/notifications/threads/26257711761/subscription',
}

test('github: concatenated --paginate pages map to items; cursor is the newest updated_at', () => {
  const later = { ...ghNote, id: '9', reason: 'subscribed', updated_at: '2026-10-12T03:00:00Z', subject: { ...ghNote.subject, url: null, type: 'Release' } }
  const r = githubItems('github', `${JSON.stringify([ghNote])}\n${JSON.stringify([later])}\n`, '2026-10-11T00:00:00Z')
  expect(r.cursor).toBe('2026-10-12T03:00:00Z')
  expect(r.items[0]).toEqual({
    source: 'github', extId: '26257711761:2026-10-12T01:20:54Z', ts: Date.parse('2026-10-12T01:20:54Z'),
    from: { id: 'repo:acme/app', name: 'acme/app' }, chat: { id: 'repo:acme/app', name: 'acme/app', isGroup: true },
    text: 'PullRequest (review_requested): feat: ensure at least one admin always exists', url: 'https://github.com/acme/app/pull/20',
    toMe: true, fromMe: false, threadId: '26257711761',
  })
  expect(r.items[1]).toMatchObject({ toMe: false, url: 'https://github.com/acme/app' })
  expect(githubItems('github', '[]', 'c')).toEqual({ items: [], cursor: 'c' })
  expect(githubItems('github', '', null)).toEqual({ items: [], cursor: null })
})

test('github: the cursor becomes ?since= on the notifications path', () => {
  expect(githubCommand(['gh', 'api', 'notifications', '--paginate'], null)).toEqual(['gh', 'api', 'notifications', '--paginate'])
  expect(githubCommand(['gh', 'api', 'notifications'], '2026-10-12T01:20:54Z')).toEqual(['gh', 'api', 'notifications?since=2026-10-12T01%3A20%3A54Z'])
})
