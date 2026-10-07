/**
 * Per-scope `/` menus (008 FR6, FR7). Every scope gets its built-ins, then
 * skills ranked by use; groups leave out the DM-only ones (`/start`, `/help`).
 * At most 100 per scope. Refreshes are debounced, at most one per minute,
 * and a scope is only pushed when its list changed.
 */

export type MenuScope = 'all_private_chats' | 'all_group_chats' | 'all_chat_administrators'
export type MenuCommand = { command: string; description: string }
/** Where a built-in shows: DMs, groups, and group admins only. */
export type Placement = 'private' | 'group' | 'admin'
export type MenuBuiltin = { name: string; description: string; menu: Placement[] }
export type MenuSkill = { command: string; description: string; uses: number }

const MAX_COMMANDS = 100

export function buildMenus(builtins: MenuBuiltin[], skills: MenuSkill[]): Record<MenuScope, MenuCommand[]> {
  const pick = (...where: Placement[]) =>
    builtins.filter(b => b.menu.some(m => where.includes(m))).map(b => ({ command: b.name, description: b.description }))
  const ranked = [...skills].sort((a, b) => b.uses - a.uses || a.command.localeCompare(b.command))
    .map(s => ({ command: s.command, description: (s.description || `Run the ${s.command} skill`).slice(0, 256) }))
  return {
    all_private_chats: [...pick('private'), ...ranked].slice(0, MAX_COMMANDS),
    all_group_chats: [...pick('group'), ...ranked].slice(0, MAX_COMMANDS),
    all_chat_administrators: [...pick('group', 'admin'), ...ranked].slice(0, MAX_COMMANDS),
  }
}

export function createMenu(
  build: () => Record<MenuScope, MenuCommand[]>,
  push: (scope: MenuScope, commands: MenuCommand[]) => Promise<unknown>,
  minGapMs = 60_000,
) {
  const pushed = new Map<MenuScope, string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastRun = -Infinity

  async function run(): Promise<void> {
    timer = undefined
    lastRun = Date.now()
    for (const [scope, commands] of Object.entries(build()) as [MenuScope, MenuCommand[]][]) {
      const json = JSON.stringify(commands)
      if (pushed.get(scope) === json) continue
      await push(scope, commands)
      pushed.set(scope, json)
    }
  }

  return {
    /** Schedules a refresh in `delayMs`, or later to keep the one-minute gap; a pending one absorbs it. */
    refresh(delayMs = 0): void {
      if (timer) return
      timer = setTimeout(() => void run().catch(() => {}), Math.max(delayMs, lastRun + minGapMs - Date.now()))
    },
  }
}
