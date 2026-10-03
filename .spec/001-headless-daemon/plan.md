# 001 — Plan

## Module layout
```
src/
  daemon.ts            entry: env/state dir, auth guard, PID guard, bot + MCP + hook servers, shutdown
  config.ts            STATE_DIR, ENV_FILE loading, feature flags, min CLI version
  access.ts            Access types, load/save/prune, gate(), dmCommandGate(), isMentioned(), checkApprovals()
  telegram/
    bot.ts             grammY Bot, message:* handlers → router
    send.ts            chunk(), assertSendable(), sendText/sendFiles (thread-aware, see 002)
    attachments.ts     photo/document/voice/... download into inbox/
  agent/
    runner.ts          runTurn(key, prompt, opts) → spawn claude -p, parse stream-json, abort
    stream.ts          stream-json event types + parser (contract-tested)
    args.ts            policy (003) → CLI flags
    prompt.ts          TELEGRAM_INSTRUCTIONS (for --append-system-prompt)
    oneshot.ts         runOneShot(agent, input, schema) → claude -p --agent <hermes-*> --output-format json --json-schema … --settings '{"disableAllHooks":true}' (009)
    initGuard.ts       FR14: validate system/init (MCP connected, skills/plugins, hook_response seen)
  mcp/
    server.ts          MCP streamable-HTTP server on 127.0.0.1, bearer token, per-request session key
    registry.ts        tool registry with policy `requires` flags (003)
    telegramTools.ts   reply, react, edit_message, download_attachment
  hooks/
    endpoint.ts        HTTP routes /hook/<event> → handlers registered by 003–006, 009
    settings.ts        renders STATE_DIR/claude-settings.json (http hooks, timeouts, env)
  service/
    launchd.plist.tmpl  systemd.service.tmpl  install.ts
server.ts              legacy channel entry (kept until P1 is verified)
```
Code moves out of `server.ts` **verbatim first** (into `access.ts` and `telegram/*`), so that `server.ts` imports from it and both entry points keep working.

## Reuse from `server.ts`
| Existing | New home |
|---|---|
| `Access` types, `defaultAccess`, `readAccessFile`, `loadAccess`, `saveAccess`, `pruneExpired` | `access.ts` |
| `gate()`, `dmCommandGate()`, `isMentioned()`, `checkApprovals()` | `access.ts` |
| `chunk()`, `assertSendable()`, `PHOTO_EXTS`, `MAX_*` | `telegram/send.ts` |
| `message:*` attachment handlers, `safeName()` | `telegram/attachments.ts` + `bot.ts` |
| `ListTools`/`CallTool` handlers (reply/react/edit/download) | `mcp/telegramTools.ts` (moved from the stdio transport to HTTP) |
| Stale-PID guard, `unhandledRejection` handlers | `daemon.ts` (match on `daemon.ts`) |
| `instructions` string | `agent/prompt.ts` |
| `callback_query:data` permission handler | moves to 003 |

## Turn lifecycle
```ts
const child = Bun.spawn(['claude', '-p', prompt,
  ...(sid ? ['--resume', sid] : []),
  '--output-format', 'stream-json', '--verbose',
  '--settings', SETTINGS_FILE, '--mcp-config', MCP_FILE,
  '--append-system-prompt', TELEGRAM_INSTRUCTIONS,
  ...policyArgs(resolvePolicy(key))],
  { cwd: policy.cwd, env: { ...process.env, TG_SESSION_KEY: key, TG_DAEMON_URL, TG_HOOK_TOKEN } })
for await (const ev of parseStreamJson(child.stdout)) {
  // system/init → save session_id (002); assistant tool_use → progress; result → usage, errors
}
```
- **Session binding**: the MCP config URL includes the session key (`/mcp?key=<key>`), or the daemon maps requests by a per-turn token. Either way, `reply` defaults to the originating chat or topic and cannot target other chats unless the policy allows it.
- **Hooks are `http` type**. Claude Code POSTs the hook JSON and uses the response body as the hook output. There are no scripts. Example of the rendered settings:
  ```json
  { "hooks": {
      "PermissionRequest": [{ "hooks": [{ "type": "http",
        "url": "${TG_DAEMON_URL}/hook/permission-request?key=${TG_SESSION_KEY}",
        "headers": { "Authorization": "Bearer ${TG_HOOK_TOKEN}" },
        "allowedEnvVars": ["TG_DAEMON_URL", "TG_SESSION_KEY", "TG_HOOK_TOKEN"],
        "timeout": 330 }] }],
      "Stop": [{ "hooks": [{ "type": "http", "url": "…/hook/stop?key=${TG_SESSION_KEY}", "async": true, … }] }]
  } }
  ```
  Confirm env interpolation in `url` vs. `headers` in T003. If `url` can't be interpolated, use a fixed URL and pass the key in a header.
- **Session key on hooks**: from the query string or header. The hook payload's `session_id` is cross-checked against `sessions.json`.
- **Timeouts**: the default is 600s for http hooks, so approvals fit. `PermissionRequest` timeout = `approvalTimeoutSec` + 30s. Observational hooks (`Stop`, `PostToolUse`, `Subagent*`) use `async: true` so they never slow a turn.
- **Hook failure**: if the daemon is unreachable, `PermissionRequest` is left unresolved, which counts as a deny in `-p` mode, so the system fails closed. Context hooks fail open (no injection) and the failure is logged.
- **Prompt input** is passed as an argument, or through stdin when it is long. Images are passed as `image_path` in the wrapper, and the model reads them with the Read tool (as it does today).

## Progress UX
- `sendChatAction('typing')` repeats every 4 seconds while the child process is alive.
- If the turn runs longer than 8 seconds without a `reply`, post "⏳ Working…" and edit it from tool-use events (at most one edit every 3 seconds). When the turn ends, remove or replace it. The final answer is always a **new** message.

## Dependencies
- Add the MCP SDK (already a dependency) with its streamable HTTP transport, and `zod`. No Agent SDK.
- Runtime needs the `claude` CLI on PATH, logged in to the owner's subscription.
- `package.json` scripts: `start` → `bun src/daemon.ts`, `start:channel` → `bun server.ts`, `install-service`, `test:contract`.

## Risks
- **CLI output or flag drift**: pin the minimum version, run the contract test in CI and at startup (a `claude --version` check), and isolate parsing in `stream.ts`. Feature-detect with the `system/init` `capabilities` array where possible.
- **`--bare` becoming the default for `-p`**: this would silently drop hooks, skills, memory and subscription auth. `initGuard.ts` (FR14) detects it on the first turn.
- **Untrusted project config**: `-p` runs a cwd's `.claude/settings.json` hooks and `.mcp.json` servers **without a trust prompt**. Chat `cwd`s are restricted to an owner-approved allowlist (003).
- **Process start per turn** (about 1 second): acceptable for chat. Measure it in the T003 spike.
- **Plan limits**: an always-on agent with cron jobs and reflection uses up the usage window faster. Mitigations:
  - Haiku one-shots for background work
  - the reflection debounce
  - `--max-turns`
  - a daily turn budget
  - pausing on usage-limit results
  - showing usage in `/cost` and `/status`
- **Terms**: Pro and Max limits assume ordinary individual use. Other people's requests must not run on the owner's plan; 003 FR12 enforces this ([legal & compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- **Localhost endpoints**: bind to `127.0.0.1` only, use a random token per daemon start, and give child processes the token only through env.
- **Silent API-key fallback**: prevented by the startup guard (FR10).
