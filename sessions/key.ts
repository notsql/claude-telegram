import type { Message } from 'grammy/types'

/** A Telegram conversation surface: a chat, or a forum topic inside one. */
export type SessionTarget = { chatId: string; threadId?: number }

/**
 * Session key (FR1): `chat_id`, or `chat_id:message_thread_id` for forum topic
 * messages. The General topic and reply threads in non-forum groups also carry
 * `message_thread_id` but not `is_topic_message`, so they map to the plain chat.
 */
export function sessionKey(msg: Pick<Message, 'chat' | 'message_thread_id' | 'is_topic_message'>): string {
  const chatId = String(msg.chat.id)
  return msg.is_topic_message && msg.message_thread_id != null
    ? `${chatId}:${msg.message_thread_id}`
    : chatId
}

export function parseKey(key: string): SessionTarget {
  const m = /^(-?\d+)(?::(\d+))?$/.exec(key)
  if (!m) throw new Error(`invalid session key: ${key}`)
  return m[2] ? { chatId: m[1], threadId: Number(m[2]) } : { chatId: m[1] }
}
