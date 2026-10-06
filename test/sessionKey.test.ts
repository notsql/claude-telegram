import { describe, expect, test } from 'bun:test'
import { parseKey, sessionKey } from '../sessions/key'

const chat = (id: number, type: string) => ({ id, type }) as any

describe('sessionKey (FR1)', () => {
  test('DM is the chat id', () => {
    expect(sessionKey({ chat: chat(123456789, 'private') })).toBe('123456789')
  })

  test('plain group is the chat id', () => {
    expect(sessionKey({ chat: chat(-4001, 'group') })).toBe('-4001')
  })

  test('forum topic includes the thread id', () => {
    const msg = { chat: chat(-1001234567890, 'supergroup'), message_thread_id: 42, is_topic_message: true as const }
    expect(sessionKey(msg)).toBe('-1001234567890:42')
  })

  test('General topic is the plain chat id', () => {
    expect(sessionKey({ chat: chat(-1001234567890, 'supergroup') })).toBe('-1001234567890')
  })

  test('reply thread in a non-forum supergroup is the plain chat id', () => {
    expect(sessionKey({ chat: chat(-1001234567890, 'supergroup'), message_thread_id: 7 })).toBe('-1001234567890')
  })
})

describe('parseKey', () => {
  test('round-trips chat and topic keys', () => {
    expect(parseKey('123456789')).toEqual({ chatId: '123456789' })
    expect(parseKey('-1001234567890:42')).toEqual({ chatId: '-1001234567890', threadId: 42 })
  })

  test('rejects malformed keys', () => {
    expect(() => parseKey('abc')).toThrow()
    expect(() => parseKey('-100:')).toThrow()
  })
})
