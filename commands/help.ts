/**
 * `/start` and `/help` text (008 FR3), DM-only as in the legacy
 * channel server. `/help` leads with plain language: commands are only the
 * fallback (constitution I).
 */

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
    'All your skills are under /skills: tap one to run it, or send /skills deploy_blog staging to pass arguments.',
  ].join('\n')
}
