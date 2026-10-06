/**
 * Renders the `--settings` file that wires Claude Code's hooks to the daemon's
 * hook endpoint. Passed only to daemon turns, so terminal sessions never run
 * these hooks (FR2, AC6). T003: http hook `url`s are not env-interpolated, so
 * the port is written literally and the token and session key travel in
 * headers. `SessionStart` ignores http hooks in `-p`, so it uses curl.
 * It also disables the Telegram channel plugin for daemon turns: the plugin
 * would start its own poller on the same bot token and cause 409 conflicts.
 */

import { writeFileSync, renameSync } from 'fs'

export type HookEvent =
  | 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PermissionRequest'
  | 'PostToolUse' | 'SubagentStart' | 'SubagentStop' | 'Stop' | 'PreCompact'

/** `PermissionRequest` → `permission-request`, the endpoint's route slug. */
export const hookSlug = (event: HookEvent) => event.replace(/(?<!^)([A-Z])/g, '-$1').toLowerCase()

const CHANNEL_PLUGIN = 'telegram@claude-plugins-official'

/** Observational hooks: fire-and-forget so they never slow a turn. */
const ASYNC: HookEvent[] = ['PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact']

export type HookSettingsOpts = {
  port: number
  /** Approval window (003 FR4); the hook outlives it by 30s so expiry is a clean deny. */
  approvalTimeoutSec: number
}

export function renderHookSettings({ port, approvalTimeoutSec }: HookSettingsOpts) {
  const url = (e: HookEvent) => `http://127.0.0.1:${port}/hook/${hookSlug(e)}`
  const http = (e: HookEvent, extra: Record<string, unknown> = {}) => [{ hooks: [{
    type: 'http',
    url: url(e),
    headers: { Authorization: 'Bearer ${TG_HOOK_TOKEN}', 'X-TG-Session-Key': '${TG_SESSION_KEY}' },
    allowedEnvVars: ['TG_SESSION_KEY', 'TG_HOOK_TOKEN'],
    ...extra,
  }] }]

  return {
    enabledPlugins: { [CHANNEL_PLUGIN]: false },
    hooks: {
      SessionStart: [{ hooks: [{
        type: 'command',
        command: `curl -sf -H "Authorization: Bearer $TG_HOOK_TOKEN" -H "X-TG-Session-Key: $TG_SESSION_KEY" --data-binary @- ${url('SessionStart')}`,
      }] }],
      UserPromptSubmit: http('UserPromptSubmit', { timeout: 30 }),
      PreToolUse: http('PreToolUse'),
      PermissionRequest: http('PermissionRequest', { timeout: approvalTimeoutSec + 30 }),
      ...Object.fromEntries(ASYNC.map(e => [e, http(e, { async: true })])),
    },
  }
}

/** Atomic write, so a turn never reads a half-written file. */
export function writeHookSettings(path: string, opts: HookSettingsOpts): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(renderHookSettings(opts), null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}
