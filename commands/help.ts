/**
 * `/start`, `/help` and `/status` text (008 FR3), DM-only as in the legacy
 * channel server. `/help` leads with plain language: commands are only the
 * fallback (constitution I).
 */

import type { Access } from '../access.ts'
import type { MenuBuiltin } from './menu.ts'

export const START_TEXT =
  `This bot bridges Telegram to a Claude Code session.\n\n` +
  `To pair:\n` +
  `1. DM me anything: you'll get a 6-char code\n` +
  `2. In Claude Code: /telegram:access pair <code>\n\n` +
  `After that, DMs here reach that session.`

export function helpText(builtins: MenuBuiltin[]): string {
  return [
    `Just talk to me. Plain words work for everything: "start fresh", "what's this costing?", ` +
    `"remember I use pnpm", "forget that", "find what we decided about postgres". ` +
    `Text, photos and files are forwarded; replies come back here.`,
    '',
    'The commands below do the same things when you want a sure shortcut:',
    ...builtins.filter(b => b.menu.includes('private')).map(b => `/${b.name}: ${b.description}`),
    '',
    'Skills show up in the / menu too, e.g. /deploy_blog staging.',
  ].join('\n')
}

/** The DM sender's pairing state; `session` is added once paired. */
export function pairingStatus(access: Pick<Access, 'allowFrom' | 'pending'>, senderId: string, name: string, session: () => string): string {
  if (access.allowFrom.includes(senderId)) return `Paired as ${name}.\n\n${session()}`
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) return `Pending pairing: run in Claude Code:\n\n/telegram:access pair ${code}`
  }
  return 'Not paired. Send me a message to get a pairing code.'
}
