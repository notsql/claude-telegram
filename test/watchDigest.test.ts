import { expect, test } from 'bun:test'
import { openInboxDb, insertItem, type Item } from '../watch/store.ts'
import { runDigest, type DigestApi } from '../watch/digest.ts'

const H = 3_600_000
const T0 = new Date(2026, 9, 12, 8, 0).getTime()

const item = (n: number, over: Partial<Item> = {}): Item => ({
  source: 'whatsapp', extId: `m${n}`, ts: T0,
  from: { id: 'ana', name: 'Ana' }, chat: { id: 'c1', name: 'Ana', isGroup: false },
  text: `hello ${n}`, toMe: true, fromMe: false, ...over,
})

function setup() {
  const db = openInboxDb(':memory:')
  const sent: { chatId: string; text: string; extra: unknown }[] = []
  let fail = false
  const api: DigestApi = { async sendMessage(chatId: string, text: string, ...extra: unknown[]) {
    if (fail) throw new Error('down')
    sent.push({ chatId, text, extra: extra[0] })
  } }
  let t = T0
  const add = (n: number, label: string | null, over: Partial<Item> = {}) => {
    const id = insertItem(db, item(n, over))!
    db.query('UPDATE items SET label = ? WHERE id = ?').run(label, id)
    return id
  }
  const run = () => runDigest({ db, api, to: { chatId: '42' }, title: 'Evening digest', now: () => t })
  const status = (id: number) => (db.query('SELECT status FROM items WHERE id = ?').get(id) as { status: string }).status
  return { db, sent, add, run, status, set: (ms: number) => { t = ms }, fail: (v: boolean) => { fail = v } }
}

test('AC3: an unanswered DM appears under "awaiting me" after 4h and drops off once I reply', async () => {
  const s = setup()
  s.add(1, 'urgent', { text: 'can you call me?' })
  s.set(T0 + 3 * H)
  expect(await s.run()).toBe(false)
  s.set(T0 + 4 * H)
  expect(await s.run()).toBe(true)
  expect(s.sent[0]!.text).toContain('Awaiting me (1)')
  expect(s.sent[0]!.text).toContain('whatsapp · Ana: can you call me?')
  expect(s.sent[0]!.extra).toBeUndefined()
  // A second digest still shows it while unanswered.
  await s.run()
  expect(s.sent[1]!.text).toContain('Awaiting me (1)')
  // I reply from my phone in the same chat.
  s.add(2, null, { fromMe: true, toMe: false, ts: T0 + 5 * H, text: 'sure' })
  s.set(T0 + 10 * H)
  expect(await s.run()).toBe(false)
  expect(s.db.query('SELECT closed_at FROM loops').get()).toEqual({ closed_at: T0 + 10 * H })
})

test('a reply in another chat or before the message does not close the loop; Done does', async () => {
  const s = setup()
  s.add(0, null, { fromMe: true, toMe: false, ts: T0 - H })
  const id = s.add(1, 'action')
  s.add(2, null, { fromMe: true, toMe: false, ts: T0 + H, chat: { id: 'c2', name: 'Other', isGroup: false } })
  s.set(T0 + 5 * H)
  await s.run()
  expect(s.sent.at(-1)!.text).toContain('Awaiting me (1)')
  s.db.query(`UPDATE items SET status = 'done' WHERE id = ?`).run(id)
  expect(await s.run()).toBe(false)
})

test('fyi and un-pinged action items are grouped by source and person, then marked digested', async () => {
  const s = setup()
  const a = s.add(1, 'fyi', { toMe: false, text: 'newsletter' })
  const b = s.add(2, 'action', { toMe: false, text: 'please review' })
  const c = s.add(3, 'fyi', { source: 'github', toMe: false, from: { id: 'bob', name: 'Bob' }, chat: { id: 'r', name: 'repo', isGroup: true }, text: '<b>PR</b> merged' })
  const pinged = s.add(4, 'action', { toMe: false })
  s.db.query(`UPDATE items SET status = 'pinged' WHERE id = ?`).run(pinged)
  const noise = s.add(5, 'noise', { toMe: false })
  const mine = s.add(6, 'fyi', { fromMe: true, toMe: false })
  s.fail(true)
  await expect(s.run()).rejects.toThrow('down')
  expect(s.status(a)).toBe('new')
  s.fail(false)
  await s.run()
  expect(s.sent[0]!.text).toBe([
    'Evening digest', '',
    'github', '  Bob in repo', '    • <b>PR</b> merged', '',
    'whatsapp', '  Ana (2)', '    • newsletter', '    • [action] please review',
  ].join('\n'))
  for (const id of [a, b, c]) expect(s.status(id)).toBe('digested')
  expect([s.status(pinged), s.status(noise), s.status(mine)]).toEqual(['pinged', 'new', 'new'])
  // Nothing new since the last digest: no message.
  expect(await s.run()).toBe(false)
})

test('i_promised loops from the triager are listed until closed', async () => {
  const s = setup()
  const id = s.add(1, 'noise', { fromMe: true, toMe: false })
  s.db.query(`INSERT INTO loops (item_id, kind, summary, opened_at) VALUES (?, 'i_promised', 'send the deck tomorrow', ?)`).run(id, T0)
  await s.run()
  expect(s.sent[0]!.text).toContain('I promised (1)\n  • whatsapp · send the deck tomorrow')
})
