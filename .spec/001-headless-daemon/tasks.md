# 001 — Tasks

- [ ] **T001** Commit the untracked fork baseline (`server.ts`, `package.json`, `bun.lock`, `skills/`, `telegram/`, `ACCESS.md`).
  *Verify:* `git ls-files` lists them.
- [ ] **T002** Extract `access.ts`, `telegram/send.ts` and `telegram/attachments.ts` from `server.ts` without changing behaviour.
  *Verify:* the legacy `claude --channels` flow still pairs and replies.
- [ ] **T003** **CLI spike**: confirm and document, against the installed `claude` version:
  - `-p` with `--resume`, `--output-format stream-json --verbose`
  - `--settings` hook merge
  - `--mcp-config` with an HTTP server
  - `--append-system-prompt`, `--allowedTools`/`--disallowedTools`/`--permission-mode`/`--max-turns`
  - hook stdin/stdout schemas (`additionalContext`, `permissionDecision`)
  - how usage-limit errors appear in the output
  Record the findings in this plan.
  *Verify:* a scripted turn works with no `ANTHROPIC_API_KEY`, and the start latency is noted.
- [ ] **T004** `agent/stream.ts` parser with fixtures from T003, plus a contract test (`test:contract`).
  *Verify:* the test passes, and fails on a doctored fixture.
- [ ] **T005** `mcp/server.ts` (streamable HTTP, `127.0.0.1`, bearer token, session binding) and `mcp/telegramTools.ts`.
  *Verify:* AC8, and the `claude` CLI lists `mcp__tg__reply`.
- [ ] **T006** `hooks/endpoint.ts`, `hooks/client.ts`, the settings template, and no-op hook scripts.
  *Verify:* the daemon logs each hook event during a turn, and AC6 (the terminal runs no daemon hooks).
- [ ] **T007** `agent/runner.ts` `runTurn()` with a single global session (002 replaces this) and `--append-system-prompt`.
  *Verify:* AC1.
- [ ] **T008** `agent/oneshot.ts`: `claude -p --model haiku --output-format json` with tools disabled and zod validation, for 004–006.
  *Verify:* returns parsed JSON.
- [ ] **T009** `daemon.ts`: bot startup, PID guard, approvals poller, error guards, graceful shutdown.
  *Verify:* AC2, AC3, and SIGTERM exits in under 10 seconds.
- [ ] **T010** Auth guard and usage-limit handling: API-key refusal, login check, pause and notify.
  *Verify:* AC7.
- [ ] **T011** `/stop` with SIGINT then SIGKILL, and the `interruptOnNewMessage` flag.
  *Verify:* AC4.
- [ ] **T012** Progress UX: typing loop and an edited progress message, with a new final message at the end.
  *Verify:* a 30-second task shows edits and the final message triggers a push notification.
- [ ] **T013** Service install: launchd and systemd templates (`PATH` including `claude` and `bun`), log directory.
  *Verify:* AC5.
- [ ] **T014** Config: `maxTurns`, daily turn budget, default workspace `cwd`, minimum CLI version check.
- [ ] **T015** Update README and ACCESS.md for daemon mode.
  *Verify:* a fresh-install walkthrough works end to end.
