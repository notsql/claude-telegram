import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import * as access from '../access'

// Keep the real access state (~/.claude/channels/telegram) out of the test.
mock.module('../access.ts', () => ({
  ...access,
  assertAllowedChat: () => {},
  loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} }),
}))
const { registerTelegramTools } = await import('../mcp/telegramTools')

/** Registers the tools on a fake server and returns a `reply` caller plus the API calls it made. */
function setup(key?: string) {
  const calls: { method: string; chat_id: string; other: Record<string, unknown> }[] = []
  const record = (method: string) => async (chat_id: string, _: unknown, other: Record<string, unknown> = {}) => {
    calls.push({ method, chat_id, other })
    return { message_id: calls.length }
  }
  const api = { sendMessage: record('sendMessage'), sendPhoto: record('sendPhoto'), sendDocument: record('sendDocument') }
  const handlers = new Map<unknown, (req: unknown) => Promise<{ isError?: boolean }>>()
  const server = { setRequestHandler: (schema: unknown, h: any) => handlers.set(schema, h) }
  registerTelegramTools(server as any, api as any, '0:x', key)
  const reply = (args: Record<string, unknown>) =>
    handlers.get(CallToolRequestSchema)!({ params: { name: 'reply', arguments: args } })
  return { calls, reply }
}

describe('reply tool targets (002 FR4)', () => {
  test('text and files to the bound chat land in its topic', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tg-')), 'notes.txt')
    writeFileSync(file, 'hi')
    const { calls, reply } = setup('-100123:42')
    const res = await reply({ chat_id: '-100123', text: 'hello', files: [file] })
    expect(res.isError).toBeUndefined()
    expect(calls.map(c => [c.method, c.other.message_thread_id])).toEqual([
      ['sendMessage', 42],
      ['sendDocument', 42],
    ])
  })

  test('a chat-level key sends without a thread', async () => {
    const { calls, reply } = setup('-100123')
    await reply({ chat_id: '-100123', text: 'hello' })
    expect(calls[0].other).not.toHaveProperty('message_thread_id')
  })

  test('another chat does not inherit the bound topic', async () => {
    const { calls, reply } = setup('-100123:42')
    await reply({ chat_id: '555', text: 'hello' })
    expect(calls[0].other).not.toHaveProperty('message_thread_id')
  })

  test('the stdio channel (no key) sends without a thread', async () => {
    const { calls, reply } = setup()
    await reply({ chat_id: '-100123', text: 'hello' })
    expect(calls[0].other).not.toHaveProperty('message_thread_id')
  })
})
