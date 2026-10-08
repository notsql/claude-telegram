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
  const chatKey = policyKey(key)
  const chat = access.chats?.[chatKey]?.policy
  const topic = key === chatKey ? undefined : access.chats?.[key]?.policy
  const always = [...new Set([...(chat?.alwaysAllow ?? []), ...(topic?.alwaysAllow ?? [])])]
  return {
    approvers: access.allowFrom,
    ...defaultPolicy(type),
    ...chat,
    ...topic,
    // Always rules add up: a topic's own rules never hide the group's.
    ...(always.length && { alwaysAllow: always }),
  }
}

/**
 * Where Telegram-side policy writes land (Always, `/policy`): the whole chat,
 * so every topic in a group shares them. Topic overrides are terminal-only.
 */
export const policyKey = (key: string) => key.split(':')[0]!

/** Adds an Always rule (US2) to `alwaysAllow` under `key`, once. Mutates `access`. */
export function addAlwaysAllow(access: Access, key: string, rule: string): void {
  const chats = access.chats ??= {}
  const policy = (chats[key] ??= {}).policy ??= {}
  const rules = policy.alwaysAllow ??= []
  if (!rules.includes(rule)) rules.push(rule)
}

/** Removes an Always rule from `alwaysAllow` under `key`; false when it isn't there. Mutates `access`. */
export function removeAlwaysAllow(access: Access, key: string, rule: string): boolean {
  const policy = access.chats?.[key]?.policy
  const i = policy?.alwaysAllow?.indexOf(rule) ?? -1
  if (i < 0) return false
  policy!.alwaysAllow!.splice(i, 1)
  if (!policy!.alwaysAllow!.length) delete policy!.alwaysAllow
  return true
}

/**
 * FR12: in groups only owners start model turns unless the chat opts in with
 * `allowOthersOnSubscription`. DMs are already limited to `allowFrom` by gate().
 */
export function canStartTurn(access: Access, key: string, senderId: string): boolean {
  if (chatTypeOf(key) === 'private' || access.allowFrom.includes(senderId)) return true
  return resolvePolicy(access, key, 'group').allowOthersOnSubscription === true
}
