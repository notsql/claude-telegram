import type { Message } from 'grammy/types'

/**
 * Forum topic names per session key (FR10), learned from topic created and
 * edited service messages. In memory only; after a restart a topic message's
 * implicit reply to its creation message fills in names that aren't known yet.
 */

type TopicMessage = Pick<Message, 'chat' | 'message_thread_id' | 'forum_topic_created' | 'forum_topic_edited' | 'reply_to_message'>

export function createTopicNames() {
  const names = new Map<string, string>()

  return {
    learn(msg: TopicMessage): void {
      if (msg.message_thread_id == null) return
      const key = `${msg.chat.id}:${msg.message_thread_id}`
      const name = msg.forum_topic_created?.name ?? msg.forum_topic_edited?.name
      if (name) names.set(key, name)
      // The creation message carries the original name, so it must not undo a rename.
      else if (!names.has(key) && msg.reply_to_message?.forum_topic_created) {
        names.set(key, msg.reply_to_message.forum_topic_created.name)
      }
    },

    get(key: string): string | undefined {
      return names.get(key)
    },
  }
}
