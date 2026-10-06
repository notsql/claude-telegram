import { describe, expect, test } from 'bun:test'
import { createTopicNames } from '../sessions/topics'

const chat = { id: -100, type: 'supergroup', title: 'Ops' } as const
const created = (name: string) => ({ chat, message_thread_id: 7, forum_topic_created: { name, icon_color: 0 } })

describe('topic names (002 FR10)', () => {
  test('rename updates the cached name', () => {
    const t = createTopicNames()
    t.learn(created('Infra'))
    expect(t.get('-100:7')).toBe('Infra')
    t.learn({ chat, message_thread_id: 7, forum_topic_edited: { name: 'Platform' } })
    expect(t.get('-100:7')).toBe('Platform')
  })

  test('icon-only edit keeps the name', () => {
    const t = createTopicNames()
    t.learn(created('Infra'))
    t.learn({ chat, message_thread_id: 7, forum_topic_edited: { icon_custom_emoji_id: 'x' } })
    expect(t.get('-100:7')).toBe('Infra')
  })

  test('implicit reply to the creation message fills an unknown name but never undoes a rename', () => {
    const t = createTopicNames()
    const msg = { chat, message_thread_id: 7, reply_to_message: created('Infra') as never }
    t.learn(msg)
    expect(t.get('-100:7')).toBe('Infra')
    t.learn({ chat, message_thread_id: 7, forum_topic_edited: { name: 'Platform' } })
    t.learn(msg)
    expect(t.get('-100:7')).toBe('Platform')
  })

  test('unknown topics and plain chats have no name', () => {
    const t = createTopicNames()
    t.learn({ chat })
    expect(t.get('-100')).toBeUndefined()
    expect(t.get('-100:9')).toBeUndefined()
  })
})
