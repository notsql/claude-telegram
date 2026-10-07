import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createMemoryStore } from '../memory/store'
import { createMemoryTools } from '../memory/tools'
import { createNotices } from '../memory/notices'

test('a write sends a notice whose Undo removes the file and its index line (AC6)', async () => {
  const sent: any[] = []
  const notices = createNotices({ sendMessage: async (...a: any[]) => { sent.push(a); return {} as any } } as any)
  const store = createMemoryStore(mkdtempSync(join(tmpdir(), 'tg-mem-')))
  const tools = createMemoryTools(store, (k, c) => void notices.notify(k, c))
  tools.call('memory_write', { type: 'feedback', name: 'prefers-pnpm', description: 'pnpm preference', body: 'pnpm' }, '-100:5', { memoryScope: 'global' })

  const [chatId, text, opts] = sent[0]
  expect([chatId, text, opts.message_thread_id]).toEqual(['-100', '🧠 Saved: pnpm preference', 5])
  const id = opts.reply_markup.inline_keyboard[0][0].callback_data.split(':')[2]
  expect(notices.undo(id)).toBe('↩️ Undone: saved prefers-pnpm')
  expect(existsSync(join(store.dir, 'prefers-pnpm.md'))).toBe(false)
  expect(store.index()).toBe('')
  expect(notices.undo(id)).toBeUndefined()
})
