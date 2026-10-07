/**
 * Built-in commands (008 FR1–FR3). A handler gets the text after the command;
 * `requiresApprover` commands change state, so groups need the key's
 * approvers and DMs need a paired sender (FR10). `menu` places it in the
 * `/` menus (FR6).
 */

import type { Context } from 'grammy'
import type { MenuBuiltin } from './menu.ts'

export type Command = MenuBuiltin & {
  requiresApprover?: boolean
  handler: (ctx: Context, args: string) => Promise<unknown>
}

export const registry = (commands: Command[]) => new Map(commands.map(c => [c.name, c]))
