import { expect, test } from 'bun:test'
import { openInboxDb, insertItem, type Item } from '../watch/store.ts'
import { runDigest, type DigestApi } from '../watch/digest.ts'
import type { BriefSchema } from '../watch/deliver.ts'
import type { z } from 'zod'

const H = 3_600_000
const T0 = new Date(2026, 9, 12, 8, 0).getTime()

type Brief = z.infer<typeof BriefSchema>

const item = (n: number, over: Partial<Item> = {}): Item => ({
  source: 'whatsapp', extId: `m${n}`, ts: T0,
  from: { id: 'ana', name: 'Ana' }, chat: { id: 'c1', name: 'Ana', isGroup: false },
  text: `hello ${n}`, toMe: true, fromMe: false, ...over,
})

function setup() {
  const db = openInboxDb(':memory:')
  const sent: { chatId: string; text: string; extra: any }[] = []
  const inputs: string[] = []
  let fail: boolean | string = false
  let budget = true
  // Default model: every conversation is important, summarised by its number.
  let judge = (input: string): Brief => ({ threads: [...input.matchAll(/<conversation n="(\d+)"/g)].map(m => ({ n: Number(m[1]), important: true, summary: `sum ${m[1]}` })) })
  let modelDown = false
  const api: DigestApi = { async sendMessage(chatId, text, extra) {
    if (fail === true || (typeof fail === 'string' && text.includes(fail))) throw new Error('down')
    sent.push({ chatId, text, extra })
  } }
  let t = T0
  const add = (n: number, label: string | null, over: Partial<Item> = {}) => {
    const id = insertItem(db, item(n, over))!
    db.query('UPDATE items SET label = ? WHERE id = ?').run(label, id)
    return id
  }
  const run = () => runDigest({
    db, api, to: { chatId: '42' }, title: 'Evening digest', now: () => t,
    run: async (_agent, input) => { inputs.push(input); if (modelDown) throw new Error('model down'); return judge(input) },
    budget: { take: () => budget },
    examples: () => '<example want="no">newsletter</example>',
  })
  const status = (id: number) => (db.query('SELECT status FROM items WHERE id = ?').get(id) as { status: string }).status
  return {
    db, sent, inputs, add, run, status,
    set: (ms: number) => { t = ms }, fail: (v: boolean | string) => { fail = v }, budget: (v: boolean) => { budget = v },
    judge: (fn: typeof judge) => { judge = fn }, modelDown: (v: boolean) => { modelDown = v },
  }
}

test('AC3: an unanswered DM appears after 4h with Reply, Done and Not like this, and drops off once I reply', async () => {
  const s = setup()
  const id = s.add(1, 'urgent', { text: 'can you call me?' })
  s.set(T0 + 3 * H)
  expect(await s.run()).toBe(false)
  expect(s.inputs).toHaveLength(0)
  s.set(T0 + 4 * H)
  expect(await s.run()).toBe(true)
  expect(s.sent.map(m => m.text)).toEqual(['📋 Evening digest', '🔴 Ana · whatsapp · Mon 12 Oct at 08:00\nsum 1'])
  expect(s.sent[1]!.extra.reply_markup.inline_keyboard.map((row: any[]) => row.map(x => x.callback_data)))
    .toEqual([[`inb:do:${id}`, `inb:draft:${id}`], [`inb:done:${id}`, `inb:nah:${id}`]])
  // A second digest still shows it while unanswered.
  await s.run()
  expect(s.sent[3]!.text).toContain('Ana · whatsapp')
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
  expect(s.sent.at(-1)!.text).toContain('Ana · whatsapp')
  s.db.query(`UPDATE items SET status = 'done' WHERE id = ?`).run(id)
  expect(await s.run()).toBe(false)
})

test('only conversations the model keeps are sent; the rest are digested quietly and their loops closed', async () => {
  const s = setup()
  const news = s.add(1, 'fyi', { toMe: false, text: 'newsletter <b>deals</b>' })
  const task = s.add(2, 'action', { toMe: false, from: { id: 'bob', name: 'Bob' }, chat: { id: 'r', name: 'repo', isGroup: true }, text: 'please review' })
  const pinged = s.add(3, 'action', { toMe: false, from: { id: 'cy', name: 'Cy' }, chat: { id: 'c3', name: 'Cy', isGroup: false } })
  s.db.query(`UPDATE items SET status = 'pinged' WHERE id = ?`).run(pinged)
  const noise = s.add(4, 'noise', { toMe: false, from: { id: 'dee', name: 'Dee' }, chat: { id: 'c4', name: 'Dee', isGroup: false } })
  const mine = s.add(5, 'fyi', { fromMe: true, toMe: false, chat: { id: 'c5', name: 'Eve', isGroup: false } })
  s.judge(input => ({ threads: [...input.matchAll(/<conversation n="(\d+)" name="([^"]*)"/g)].map(m => ({ n: Number(m[1]), important: m[2] === 'repo', summary: 'Review the PR for Bob today.' })) }))
  await s.run()
  expect(s.inputs[0]).toContain('newsletter &lt;b&gt;deals&lt;/b&gt;')
  expect(s.inputs[0]).toContain('<example want="no">newsletter</example>')
  expect(s.inputs[0]).not.toContain('Dee')
  expect(s.sent.map(m => m.text)).toEqual(['📋 Evening digest', '🟠 repo · whatsapp · Mon 12 Oct at 08:00\nReview the PR for Bob today.'])
  expect(s.sent.every(m => m.extra.parse_mode === undefined)).toBe(true)
  expect([news, task].map(s.status)).toEqual(['digested', 'digested'])
  expect([pinged, noise, mine].map(s.status)).toEqual(['pinged', 'new', 'new'])
  // Nothing new since the last digest: no model call, no message.
  expect(await s.run()).toBe(false)
  expect(s.inputs).toHaveLength(1)
})

test('an unimportant conversation closes its awaiting-me loop and never comes back', async () => {
  const s = setup()
  const id = s.add(1, 'fyi', { text: 'lol nice' })
  s.set(T0 + 5 * H)
  s.judge(() => ({ threads: [{ n: 1, important: false, summary: '' }] }))
  expect(await s.run()).toBe(false)
  expect(s.status(id)).toBe('digested')
  expect(s.db.query('SELECT closed_at FROM loops').get()).toEqual({ closed_at: T0 + 5 * H })
  s.judge(() => { throw new Error('should not be asked') })
  expect(await s.run()).toBe(false)
})

test('a failed send or model call, or a spent budget, holds everything for the next digest', async () => {
  const s = setup()
  const id = s.add(1, 'fyi', { toMe: false })
  s.budget(false)
  expect(await s.run()).toBe(false)
  s.budget(true)
  s.modelDown(true)
  expect(await s.run()).toBe(false)
  expect(s.status(id)).toBe('new')
  s.modelDown(false)
  s.fail(true)
  await expect(s.run()).rejects.toThrow('down')
  expect(s.status(id)).toBe('new')
  s.fail(false)
  expect(await s.run()).toBe(true)
  expect(s.status(id)).toBe('digested')
})

test('i_promised loops are listed without a model call, in the forum topic when there is one', async () => {
  const s = setup()
  const id = s.add(1, 'noise', { fromMe: true, toMe: false })
  s.db.query(`INSERT INTO loops (item_id, kind, summary, opened_at) VALUES (?, 'i_promised', 'send the deck tomorrow', ?)`).run(id, T0)
  await s.run()
  expect(s.inputs).toHaveLength(0)
  expect(s.sent.map(m => m.text)).toEqual(['📋 Evening digest', 'I promised (1)\n  • whatsapp · send the deck tomorrow'])
  expect(s.sent[0]!.extra).toEqual({})
})

test('the model is told the current time and message dates; each conversation is its own dated message', async () => {
  const s = setup()
  const old = s.add(1, 'fyi', { toMe: false, ts: T0 - 48 * H, text: 'party on Saturday?' })
  const bob = s.add(2, 'action', { toMe: false, ts: T0 - H, from: { id: 'bob', name: 'Bob' }, chat: { id: 'c2', name: 'Bob', isGroup: false }, text: 'pay the bill by Friday' })
  const cy = s.add(3, 'action', { toMe: false, from: { id: 'cy', name: 'Cy' }, chat: { id: 'c3', name: 'Cy', isGroup: false } })
  s.set(T0 + H)
  s.judge(() => ({ threads: [{ n: 1, important: false, summary: '' }, { n: 2, important: true, summary: 'Pay the bill by Fri 16 Oct.' }, { n: 3, important: true, summary: 'sum 3' }] }))
  // Cy's message fails to send: Bob's stays digested, Cy's waits for the next digest.
  s.fail('Cy')
  await expect(s.run()).rejects.toThrow('down')
  expect(s.inputs[0]).toContain(`It is now ${new Date(T0 + H).toString()}`)
  expect(s.inputs[0]).toContain(`ts="${new Date(T0 - 48 * H).toISOString()}"`)
  expect(s.sent.map(m => m.text)).toEqual(['📋 Evening digest', '🟠 Bob · whatsapp · Mon 12 Oct at 07:00\nPay the bill by Fri 16 Oct.'])
  expect(s.sent[1]!.extra.reply_markup.inline_keyboard.flat().map((x: any) => x.callback_data)).toContain(`inb:do:${bob}`)
  expect([old, bob, cy].map(s.status)).toEqual(['digested', 'digested', 'new'])
  s.fail(false)
  s.judge(() => ({ threads: [{ n: 1, important: true, summary: 'sum 3' }] }))
  await s.run()
  expect(s.sent.at(-1)!.text).toBe('🟠 Cy · whatsapp · Mon 12 Oct at 08:00\nsum 3')
  expect(s.status(cy)).toBe('digested')
})
