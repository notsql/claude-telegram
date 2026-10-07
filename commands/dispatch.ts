/**
 * Pre-router for `/cmd[@bot] args` (008 FR8, FR11): a built-in, a mapped
 * skill (sent as the native `/<skill-name> args` invocation, FR5), ignored
 * when addressed to another bot, or plain text for the agent.
 */

import type { CommandTable } from './skillMap.ts'

export type Route<C> =
  | { kind: 'builtin'; command: C; args: string }
  | { kind: 'skill'; text: string }
  | { kind: 'ignore' }
  | { kind: 'text' }

export function route<C>(text: string, botUsername: string, builtins: Map<string, C>, skills: CommandTable): Route<C> {
  const m = text.match(/^\/([A-Za-z0-9_]{1,32})(?:@(\w+))?(?:\s+([\s\S]*))?$/)
  if (!m) return { kind: 'text' }
  const [, raw, bot, rest] = m
  if (bot && bot.toLowerCase() !== botUsername.toLowerCase()) return { kind: 'ignore' }
  const name = raw!.toLowerCase()
  const args = rest?.trim() ?? ''
  const command = builtins.get(name)
  if (command) return { kind: 'builtin', command, args }
  const skill = Object.keys(skills).find(s => skills[s] === name)
  if (skill) return { kind: 'skill', text: `/${skill}${args ? ` ${args}` : ''}` }
  return { kind: 'text' }
}

/** FR10: state-changing commands need an approver in groups, a paired sender in DMs. */
export function authorised(command: { requiresApprover?: boolean }, isGroup: boolean, isApprover: boolean, isPaired: boolean): boolean {
  if (!command.requiresApprover) return true
  return isGroup ? isApprover : isPaired
}
