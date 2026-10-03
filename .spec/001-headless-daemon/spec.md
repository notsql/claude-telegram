# 001 — Headless Daemon (`claude -p` + hooks)

## Problem
The fork runs as an MCP *channel* inside an interactive `claude --channels` session, so the agent is reachable only while a terminal session is open. Hermes-style behaviour needs an agent that is always on, survives reboots, runs scheduled work, and starts Claude Code turns by itself.

Hermes itself hit a billing problem: it called the Anthropic API directly with the Claude Code login token. Those requests were billed to "extra usage" credits instead of the plan ([hermes-agent#32243](https://github.com/NousResearch/hermes-agent/issues/32243)). Anthropic's billing guidance also groups Agent SDK usage with third-party apps. We therefore run **only the unmodified `claude` binary** and integrate through its documented flags, hooks and MCP (constitution VIII).

## User stories
- **US1**: As the owner, I message the bot at any time, even with no terminal open, and get a reply.
- **US2**: As the owner, I can install the daemon as a background service that starts on login or boot and restarts after a crash.
- **US3**: As the owner, I send `/stop` (or a follow-up, if configured) while the agent is working, and the current turn is interrupted.
- **US4**: As the owner, I see "typing…" and a progress message that updates while long work runs, then get a push notification when it finishes.
- **US5**: As the owner, every model call uses my Claude subscription through the official CLI, so a third-party billing change doesn't break the bot.

## Functional requirements
- **FR1**: A new entry point `daemon.ts` owns the grammY bot (long-polling). For each inbound turn it spawns:
  ```
  claude -p <prompt> --resume <id> --output-format stream-json --verbose
    --settings <STATE_DIR>/claude-settings.json --mcp-config <STATE_DIR>/mcp.json
    --append-system-prompt <TELEGRAM_INSTRUCTIONS>
    [--model … --permission-mode … --allowedTools … --disallowedTools … --max-turns …]   (from 003 policy)
  ```
  The child process gets the env vars `TG_SESSION_KEY`, `TG_DAEMON_URL` and `TG_HOOK_TOKEN`.
- **FR2**: The normal Claude Code configuration (CLAUDE.md, skills, memory, user settings) loads as usual because this is the real CLI. Daemon-specific hooks are added **only** through `--settings`, so terminal sessions are unaffected unless the owner opts in (004 FR10).
- **FR3**: Telegram and Hermes tools are served by an **MCP server inside the daemon** (streamable HTTP on `127.0.0.1`, bearer-token auth). `mcp.json` points the CLI to it. The tools reuse `server.ts` logic and share the daemon's in-memory state.
- **FR4**: A **hook endpoint** inside the daemon (localhost HTTP, same token) receives calls from small hook scripts (`hooks/*.ts`, run by Bun). Hooks used: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` and `PreCompact`. Their owners are 003–006.
- **FR5**: The daemon parses the stream-json output. It reads `session_id` from the `system/init` event, posts progress from tool-use events, records usage, and handles the final `result`.
- **FR6**: Access control, pairing, the approvals poller, attachment download to `inbox/`, and chunking behave exactly as they do today.
- **FR7**: Only one poller instance runs per state dir (the existing PID guard, adapted to `daemon.ts`).
- **FR8**: Interrupt: `/stop` sends SIGINT to the turn's `claude` process (SIGKILL after 3 seconds). The config flag `interruptOnNewMessage` does the same when a new message arrives.
- **FR9**: Graceful shutdown on SIGTERM/SIGINT: stop polling, interrupt child processes, persist the session map, and exit within 10 seconds.
- **FR10**: **Subscription-only auth.** The daemon never reads, stores or forwards credentials. At startup:
  - It refuses to start if `ANTHROPIC_API_KEY` is set (unless config `allowApiKey: true`), because the CLI would bill the key.
  - It checks that `claude` is logged in. If not, it reports to the owner and the logs.
  - On usage or rate-limit results, it pauses queues and tells the owner when usage resets.
- **FR11**: A service installer: a launchd plist on macOS and an optional systemd user unit. Logs go to `~/.claude/channels/telegram/logs/`. The service `PATH` must find `claude` and `bun`.
- **FR12**: Pin a minimum `claude` CLI version. A contract test checks that the stream-json event shapes and hook I/O the daemon relies on still match.
- **FR13**: The legacy `server.ts` channel mode stays runnable until P1 is verified.

## Non-goals
- Agent SDK or direct Anthropic API calls (constitution VIII).
- API-key billing. See [Auth](../README.md#auth) for why.
- Platforms other than Telegram, webhook mode, and multiple bots per daemon. Use separate `TELEGRAM_STATE_DIR` instances instead.

## Acceptance criteria
- **AC1** (FR1–5): With no terminal open, a DM to the bot receives a model-generated reply through the `reply` MCP tool.
- **AC2** (FR6): The stranger, pairing code, `/telegram:access pair` and confirmation flow is identical to today.
- **AC3** (FR7): Starting a second daemon replaces the stale poller without a 409 loop.
- **AC4** (FR8): `/stop` during a long task ends it within about 3 seconds and the bot confirms.
- **AC5** (FR11): After a reboot, the bot is back online with no manual steps.
- **AC6** (FR2): A skill in `~/.claude/skills/` is invoked from natural language. A terminal `claude` session does **not** run the daemon's hooks.
- **AC7** (FR10): With `ANTHROPIC_API_KEY` unset, AC1 passes on the subscription. With it set, the daemon exits with a clear message. When the usage limit is hit, the owner gets a "paused until <time>" message.
- **AC8** (FR3, FR4): A request to the MCP or hook endpoint without the token is rejected with 401.

## Open questions
- Queue or interrupt by default when a new message arrives mid-turn? (Proposal: queue, with `/stop` used for interrupts.)
- Default `cwd`? (Proposal: `~/.claude/channels/telegram/workspace`, overridable per chat in 003.)
