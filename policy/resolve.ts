import type { Access } from '../access.ts'
import { defaultPolicy, type ChatType, type Policy } from './schema.ts'

/** Telegram group and supergroup ids are negative; DMs use the user id. */
export const chatTypeOf = (key: string): ChatType => (key.startsWith('-') ? 'group' : 'private')

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

/** Adds an Always rule (US2) to the key's own `alwaysAllow`, once. Mutates `access`. */
export function addAlwaysAllow(access: Access, key: string, rule: string): void {
  const chats = access.chats ??= {}
  const policy = (chats[key] ??= {}).policy ??= {}
  const rules = policy.alwaysAllow ??= []
  if (!rules.includes(rule)) rules.push(rule)
}
