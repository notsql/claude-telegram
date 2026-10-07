import type { Access } from '../access.ts'
import { defaultPolicy, type ChatType, type Policy } from './schema.ts'

/**
 * Effective policy for a session key (FR6): topic key → chat key → defaults for
 * the chat type. Each field takes the most specific value set; `approvers`
 * falls back to the owner IDs in `allowFrom` (FR3).
 */
export function resolvePolicy(access: Access, key: string, type: ChatType): Policy {
  const chatKey = key.split(':')[0]
  const chat = access.chats?.[chatKey]?.policy
  const topic = key === chatKey ? undefined : access.chats?.[key]?.policy
  return {
    approvers: access.allowFrom,
    ...defaultPolicy(type),
    ...chat,
    ...topic,
  }
}
