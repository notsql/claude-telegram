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
- **Hooks are `http` type**, except `SessionStart` (see T003 findings). Claude Code POSTs the hook JSON and uses the response body as the hook output. `url` is **not** env-interpolated, so `settings.ts` writes the literal daemon port into it and the session key travels in a header. Example of the rendered settings:
  ```json
  { "hooks": {
      "PermissionRequest": [{ "hooks": [{ "type": "http",
        "url": "http://127.0.0.1:<port>/hook/permission-request",
        "headers": { "Authorization": "Bearer ${TG_HOOK_TOKEN}", "X-TG-Session-Key": "${TG_SESSION_KEY}" },
        "allowedEnvVars": ["TG_SESSION_KEY", "TG_HOOK_TOKEN"],
        "timeout": 330 }] }],
      "Stop": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:<port>/hook/stop", "async": true, … }] }],
      "SessionStart": [{ "hooks": [{ "type": "command", "command": "curl -sf -H \"Authorization: Bearer $TG_HOOK_TOKEN\" -H \"X-TG-Session-Key: $TG_SESSION_KEY\" --data-binary @- http://127.0.0.1:<port>/hook/session-start" }] }]
  } }
  ```
- **Session key on hooks**: from the `X-TG-Session-Key` header. The hook payload's `session_id` is cross-checked against `sessions.json`.
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

## T003 findings (Claude Code 2.1.288, 03/10/2026)
Run in a cloud container where auth comes through a proxy (`system/init` `apiKeySource: "none"`, no `ANTHROPIC_API_KEY`). Re-check auth and latency on the owner's Mac. Sanitised, trimmed fixtures for the T004 contract test: `test/fixtures/stream-json/`.

| Item | Result |
|---|---|
| `-p --resume <id>` | Works; the resumed turn keeps the same `session_id` and context. Also works after a SIGINT-interrupted turn. |
| `--output-format stream-json --verbose` | Event types seen: `system/init`, `system/status`, `system/hook_started`, `system/hook_response`, `system/permission_denied`, `system/task_notification`, `system/post_turn_summary`, `assistant`, `user`, `tool_progress`, `rate_limit_event`, `result`, plus unversioned extras (`active_goal`, `autocompact_state`). The parser must ignore unknown types. |
| `--settings <file>` | Merges with user settings (`flagSettings`). Inline JSON also works. |
| http hook `url` with `${VAR}` | **Not interpolated.** With `${TG_DAEMON_URL}` as the host, every hook was **silently dropped** (no error, no hook events). A literal `${TG_SESSION_KEY}` in the query string is sent unexpanded. |
| http hook `headers` + `allowedEnvVars` | Interpolated correctly (`Bearer tok`, `123:9`). |
| `SessionStart` | Fires in `-p` for **command** hooks only; an http hook on it was ignored. `additionalContext` reached the model. |
| `UserPromptSubmit` `additionalContext` | Works over http. |
| `PreToolUse` `permissionDecision: "deny"` | Blocks the tool; the reason is shown to the model and the call is listed in `result.permission_denials`. |
| `PermissionRequest` `decision.behavior: "allow"` | Works. Payload keys: `tool_name`, `tool_input`, `permission_suggestions`, `permission_mode`, `session_id`, `transcript_path`, `cwd`, `prompt_id`. Read-only commands (`echo`) are auto-allowed and never reach it. `applyRule` not yet exercised. |
| `Stop` payload | Includes `transcript_path`, `last_assistant_message`, `stop_hook_active`, `session_id`. |
| `--mcp-config` HTTP server | Connects (`mcp_servers: [{name:"tg",status:"connected"}]`); tool appears as `mcp__tg__reply`. `${VAR}` in MCP `headers` is interpolated; query string `?key=` reaches the server, so per-turn binding by URL works. Stateless streamable HTTP (`sessionIdGenerator: undefined`, JSON responses) is enough. |
| `--append-system-prompt`, `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--json-schema`, `--agent`, `--bare`, `--max-budget-usd` | Listed in `--help`. `--max-turns` is accepted but hidden from `--help`. |
| `--json-schema` one-shot | `--model haiku --output-format json --settings '{"disableAllHooks":true}'` returns `structured_output`; about 3.5 s wall clock. |
| SIGINT mid-tool | Exit 0 after about 1.8 s, with a final `result` `subtype: "error_during_execution"`, `is_error: true`. Use for `/stop`. |
| SIGTERM mid-tool | Exit 143 after about 1.4 s, **no `result` event**. Only for shutdown or as the escalation after SIGINT. |
| Usage-limit errors | Not reproducible here. `rate_limit_event` appears on every turn; treat `result.is_error` plus `api_retry` errors as the signal and capture a real fixture on the owner's plan. |
| `system/init` contents | `tools`, `mcp_servers`, `slash_commands` (skills appear here), `skills`, `agents`, `plugins`, `capabilities`, `apiKeySource`, `claude_code_version`, `permissionMode`, `model`, `startup_timing`. FR14 can check `apiKeySource`, `mcp_servers[].status` and `hook_response` events. |
| Start latency | `init` emitted about 1.5 s after process start; a trivial turn with hooks took about 19 s end to end here, mostly model time. |

Gotchas for the runner:
- Pass `stdin` as `/dev/null` (or the prompt). Otherwise `-p` waits 3 s for stdin and prints a warning.
- Strip inherited `CLAUDECODE` / `CLAUDE_CODE_SESSION_ID` env vars when the daemon itself runs under Claude Code, or the child reuses the parent's session id.
