# 001 — Tasks

- [x] **T001** Commit the untracked fork baseline (`server.ts`, `package.json`, `bun.lock`, `skills/`, `telegram/`, `ACCESS.md`).
  *Verify:* `git ls-files` lists them.
- [x] **T002** Extract `access.ts`, `telegram/send.ts` and `telegram/attachments.ts` from `server.ts` without changing behaviour.
  *Verify:* the legacy `claude --channels` flow still pairs and replies.
- [x] **T003** **CLI spike**: confirm and document, against the installed `claude` version:
  - `-p` with `--resume`, `--output-format stream-json --verbose`
  - `--settings` hook merge, `http` hook type with `headers` + `allowedEnvVars`, and whether `url` interpolates env
  - `--mcp-config` with an HTTP server (and the `system/init` `mcp_servers` status)
  - `--append-system-prompt`, `--allowedTools`/`--disallowedTools`/`--permission-mode`/`--max-turns`
  - hook payloads and outputs: `SessionStart`/`UserPromptSubmit` `additionalContext`, `PermissionRequest` `decision.behavior` + `applyRule`, `PreToolUse` `permissionDecision`, `Stop` `transcript_path` + `last_assistant_message`
  - SIGINT vs SIGTERM behaviour mid-turn
  - how usage-limit errors appear (`system/api_retry` `error` values, the error `result`)
  - what `system/init` lists (tools, skills or slash commands?, plugins, `capabilities`)
  Record the findings in this plan.
  *Verify:* a scripted turn works with no `ANTHROPIC_API_KEY`, and the start latency is noted.
- [x] **T004** `agent/stream.ts` parser with fixtures from T003, plus a contract test (`test:contract`).
  *Verify:* the test passes, and fails on a doctored fixture.
- [x] **T005** `mcp/server.ts` (streamable HTTP, `127.0.0.1`, bearer token, session binding) and `mcp/telegramTools.ts`.
  *Verify:* AC8, and the `claude` CLI lists `mcp__tg__reply`.
- [x] **T006** `hooks/endpoint.ts` and `hooks/settings.ts` (http hooks, async observational hooks, timeouts derived from config).
  *Verify:* the daemon logs each hook event during a turn, and AC6 (the terminal runs no daemon hooks).
- [x] **T007** `agent/runner.ts` `runTurn()` with a single global session (002 replaces this) and `--append-system-prompt`.
  *Verify:* AC1.
- [x] **T008** `agent/oneshot.ts`: `claude -p --agent <hermes-*> --output-format json --json-schema … --settings '{"disableAllHooks":true}'`, with zod as a second check, for 004–006 (agents from 009 T902; use `--model haiku` until then).
  *Verify:* returns `structured_output`, and no hook events fire.
- [x] **T016** `agent/initGuard.ts` (FR14): never-bare checks on `system/init`.
  *Verify:* AC9.
- [x] **T009** `daemon.ts`: bot startup, PID guard, approvals poller, error guards, graceful shutdown.
  *Verify:* AC2, AC3, and SIGTERM exits in under 10 seconds.
- [x] **T010** Auth guard and usage-limit handling: API-key refusal, login check, pause and notify.
  *Verify:* AC7.
- [x] **T011** `/stop` with SIGINT then SIGKILL, and the `interruptOnNewMessage` flag.
  *Verify:* AC4.
- [ ] **T012** Progress UX: typing loop and an edited progress message, with a new final message at the end.
  *Verify:* a 30-second task shows edits and the final message triggers a push notification.
- [ ] **T013** Service install: launchd and systemd templates (`PATH` including `claude` and `bun`), log directory.
  *Verify:* AC5.
- [x] **T014** Config: `maxTurns`, daily turn budget, default workspace `cwd`, minimum CLI version check.
- [ ] **T015** Update README and ACCESS.md for daemon mode.
  *Verify:* a fresh-install walkthrough works end to end.
