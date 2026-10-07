import { describe, expect, test } from 'bun:test'
import { startProgress } from '../agent/progress'
import type { StreamEvent } from '../agent/stream'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function fakeApi() {
  const calls: string[] = []
  return {
    calls,
    sendChatAction: async () => { calls.push('typing') },
    sendMessage: async (_: string, text: string) => { calls.push(`send ${text}`); return { message_id: 7 } },
    editMessageText: async (_: string, id: number, text: string) => { calls.push(`edit ${id} ${text}`) },
    deleteMessage: async (_: string, id: number) => { calls.push(`delete ${id}`) },
  }
}

const tool = (name: string) => ({
  kind: 'assistant',
  event: { type: 'assistant', message: { content: [{ type: 'tool_use', id: name, name, input: {} }] } },
}) as unknown as StreamEvent

const opts = { typingMs: 20, delayMs: 50, editMs: 40 }

describe('startProgress', () => {
  test('types, posts after the delay, throttles edits and deletes on finish', async () => {
    const api = fakeApi()
    const p = startProgress(api, { chatId: '1' }, opts)
    await sleep(60)
    expect(api.calls.filter(c => c === 'typing').length).toBeGreaterThanOrEqual(3)
    expect(api.calls).toContain('send ⏳ Working…')
    p.onEvent(tool('Bash'))
    p.onEvent(tool('Read'))
    await sleep(60)
    expect(api.calls.filter(c => c.startsWith('edit'))).toEqual(['edit 7 ⏳ Working… (Read)'])
    p.finish()
    await sleep(30)
    expect(api.calls.at(-1)).toBe('delete 7')
    const n = api.calls.length
    await sleep(50)
    expect(api.calls.length).toBe(n)
  })

  test('shows subagent progress lines (009 FR5)', async () => {
    const api = fakeApi()
    const p = startProgress(api, { chatId: '1' }, opts)
    await sleep(60)
    p.onEvent({ kind: 'unknown', type: 'system/task_started', raw: { subagent_type: 'tg-researcher', tool_use_id: 'a1' } })
    await sleep(50)
    p.onEvent({
      kind: 'assistant',
      event: { type: 'assistant', parent_tool_use_id: 'a1', message: { content: [{ type: 'tool_use', id: 'w', name: 'WebSearch', input: {} }] } },
    } as unknown as StreamEvent)
    await sleep(50)
    p.finish()
    expect(api.calls.filter(c => c.startsWith('edit'))).toEqual([
      'edit 7 🔎 tg-researcher…',
      'edit 7 🔎 tg-researcher… (WebSearch)',
    ])
  })

  test('posts nothing when the agent replies before the delay', async () => {
    const api = fakeApi()
    const p = startProgress(api, { chatId: '1' }, opts)
    p.onEvent(tool('mcp__tg__reply'))
    await sleep(70)
    p.finish()
    expect(api.calls.some(c => c.startsWith('send'))).toBe(false)
  })

  test('typing and the progress message stay in the forum topic', async () => {
    const seen: unknown[] = []
    const api = {
      ...fakeApi(),
      sendChatAction: async (_: string, __: string, other?: unknown) => { seen.push(other) },
      sendMessage: async (_: string, __: string, other?: unknown) => { seen.push(other); return { message_id: 7 } },
    }
    const p = startProgress(api, { chatId: '-100', threadId: 42 }, opts)
    await sleep(60)
    p.finish()
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every(o => (o as { message_thread_id?: number }).message_thread_id === 42)).toBe(true)
  })

  test('a short turn never posts a progress message', async () => {
    const api = fakeApi()
    const p = startProgress(api, { chatId: '1' }, opts)
    await sleep(10)
    p.finish()
    await sleep(60)
    expect(api.calls).toEqual(['typing'])
  })
})
