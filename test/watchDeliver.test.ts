import { expect, test } from 'bun:test'
import { openInboxDb, insertItem, type Item } from '../watch/store.ts'
import { createDeliver, inQuietHours, snoozeUntil, type DeliverApi } from '../watch/deliver.ts'

const item = (n: number, over: Partial<Item> = {}): Item => ({
  source: 'whatsapp', extId: `m${n}`, ts: 1_000 + n,
  from: { id: 'boss', name: 'Boss' }, chat: { id: 'c1', name: 'Chat', isGroup: false },
  text: `hello ${n}`, toMe: true, fromMe: false, ...over,
})

const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m).getTime()

function setup(start = at(12), vips: string[] = []) {
  const db = openInboxDb(':memory:')
  const sent: { chatId: string; text: string; extra: any }[] = []
  let fail = false
  const api: DeliverApi = { async sendMessage(chatId, text, extra) { if (fail) throw new Error('down'); sent.push({ chatId, text, extra }) } }
  const muted: string[] = []
  let t = start
  const d = createDeliver({ db, api, owner: '42', vips, mute: (s, f) => muted.push(`${s}:${f}`), now: () => t })
  const add = (n: number, label: string, over: Partial<Item> = {}) => {
    const id = insertItem(db, item(n, over))!
    db.query('UPDATE items SET label = ?, reason = ? WHERE id = ?').run(label, `r${n}`, id)
    return id
  }
  const status = (id: number) => (db.query('SELECT status, snooze_until FROM items WHERE id = ?').get(id) as any)
  return { db, d, sent, muted, add, status, set: (ms: number) => { t = ms }, fail: (v: boolean) => { fail = v } }
}

test('AC1: an urgent VIP item pings the owner DM with the FR7 buttons, even in quiet hours', async () => {
  const s = setup(at(23, 30), ['boss'])
  const id = s.add(1, 'urgent', { text: 'urgent: call me', url: 'https://wa.me/1' })
  await s.d.tick()
  expect(s.sent).toHaveLength(1)
  expect(s.sent[0]!.chatId).toBe('42')
  expect(s.sent[0]!.text).toStartWith('🔴 whatsapp · Boss: r1')
  expect(s.sent[0]!.text).toContain('urgent: call me')
  expect(s.sent[0]!.extra.parse_mode).toBeUndefined()
  const buttons = s.sent[0]!.extra.reply_markup.inline_keyboard.flat()
  expect(buttons.map((b: any) => b.text)).toEqual(['Open', 'Draft reply', 'Snooze 1h', 'Tonight', 'Tomorrow', 'Mute sender', 'Done'])
  expect(buttons[0].url).toBe('https://wa.me/1')
  expect(s.status(id).status).toBe('pinged')
  await s.d.tick()
  expect(s.sent).toHaveLength(1)
})

test('fyi, noise, unlabelled and fromMe items never ping', async () => {
  const s = setup()
  s.add(1, 'fyi'); s.add(2, 'noise'); insertItem(s.db, item(3)); s.add(4, 'action', { fromMe: true })
  await s.d.tick()
  expect(s.sent).toHaveLength(0)
})

test('quiet hours hold non-VIP pings until they end', async () => {
  const s = setup(at(2))
  const a = s.add(1, 'urgent'); const b = s.add(2, 'action')
  await s.d.tick()
  expect(s.sent).toHaveLength(0)
  expect(s.status(a).status).toBe('new')
  s.set(at(7, 30))
  await s.d.tick()
  expect(s.sent).toHaveLength(2)
  expect(s.sent[0]!.text).toStartWith('🔴')
  expect(s.status(b).status).toBe('pinged')
})

test('pingsPerHour caps pings; overflow waits, not dropped', async () => {
  const s = setup()
  const ids = Array.from({ length: 8 }, (_, i) => s.add(i, 'action'))
  await s.d.tick()
  expect(s.sent).toHaveLength(6)
  expect(ids.filter(id => s.status(id).status === 'new')).toHaveLength(2)
  s.set(at(13, 1))
  await s.d.tick()
  expect(s.sent).toHaveLength(8)
})

test('a failed send leaves the item new for the next tick', async () => {
  const s = setup()
  const id = s.add(1, 'urgent')
  s.fail(true)
  await s.d.tick()
  expect(s.status(id).status).toBe('new')
  s.fail(false)
  await s.d.tick()
  expect(s.status(id).status).toBe('pinged')
})

test('snooze re-pings after the timer; done closes loops; mute calls back', async () => {
  const s = setup()
  const id = s.add(1, 'urgent')
  await s.d.tick()
  expect(s.d.tap('snz1', id)).toBe('💤 Snoozed until 13:00')
  expect(s.status(id)).toEqual({ status: 'snoozed', snooze_until: at(13) })
  s.set(at(12, 59)); await s.d.tick()
  expect(s.sent).toHaveLength(1)
  s.set(at(13)); await s.d.tick()
  expect(s.sent).toHaveLength(2)

  s.db.query('INSERT INTO loops (item_id, kind, summary, opened_at) VALUES (?, ?, ?, ?)').run(id, 'awaiting_me', 'x', 0)
  expect(s.d.tap('done', id)).toBe('✅ Done')
  expect(s.status(id).status).toBe('done')
  expect((s.db.query('SELECT closed_at FROM loops').get() as any).closed_at).toBe(at(13))

  const m = s.add(2, 'action')
  expect(s.d.tap('mute', m)).toBe('🔕 Muted Boss')
  expect(s.muted).toEqual(['whatsapp:boss'])
  expect(s.d.tap('draft', m)).toContain('not available')
  const drafted: any[] = []
  const d2 = createDeliver({ db: s.db, api: { sendMessage: async () => {} }, owner: '42', vips: [], mute: () => {}, draft: r => drafted.push(r) })
  expect(d2.tap('draft', m)).toBe('✍️ Drafting a reply…')
  expect(drafted).toEqual([{ id: m, source: 'whatsapp', from_id: 'boss', from_name: 'Boss', text: 'hello 2' }])
  expect(s.d.tap('done', 999)).toBe('Item no longer stored.')
})

test('snooze targets and quiet-hours window', () => {
  expect(snoozeUntil('snzn', at(12))).toBe(at(19))
  expect(snoozeUntil('snzn', at(20))).toBe(new Date(2026, 9, 13, 19).getTime())
  expect(snoozeUntil('snzt', at(1))).toBe(new Date(2026, 9, 13, 8, 30).getTime())
  const q = { start: '23:00', end: '07:30' }
  expect([at(22, 59), at(23), at(7, 29), at(7, 30)].map(t => inQuietHours(t, q))).toEqual([false, true, true, false])
})
