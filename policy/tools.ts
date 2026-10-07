import type { Policy } from './schema.ts'

/** Policy flags a Hermes MCP tool can require (FR7); 004–007 tools set one. */
export type ToolFlag = 'schedulerAllowed' | 'teamsAllowed'

/**
 * Tools a session may see (003 Tool filtering): a tool whose `requires` flag
 * is not true in the session's policy is left out of `tools/list`, so the
 * model never sees it.
 */
export function visibleTools<T extends { name: string; requires?: ToolFlag }>(tools: T[], policy: Policy): Omit<T, 'requires'>[] {
  return tools
    .filter(t => !t.requires || policy[t.requires] === true)
    .map(({ requires: _, ...t }) => t)
}
