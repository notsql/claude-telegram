# Hermes-style Claude Telegram Agent — Spec Index

Turn this fork of the official Claude Code Telegram channel plugin into an **always-on, self-improving personal agent**. It applies the principles of Nous Research's [Hermes Agent](https://hermes-agent.nousresearch.com/docs) on top of **Claude Code itself**. The daemon runs the unmodified `claude` CLI (`claude -p`) and integrates only through hooks and MCP. There is no Agent SDK and no direct API call (constitution VIII).

Start with [constitution.md](./constitution.md). Each feature folder follows spec-kit format:

- `spec.md`: what and why (user stories, requirements, acceptance criteria)
- `plan.md`: how (architecture, data model, modules)
- `tasks.md`: ordered, verifiable work items

## Features

| # | Feature | Phase | Depends on |
|---|---------|-------|------------|
| [001](./001-headless-daemon/spec.md) | Headless daemon (`claude -p` + hooks) | P1 | — |
| [002](./002-sessions-surfaces/spec.md) | Sessions & surfaces (DMs, groups, forum topics) | P1 | 001 |
| [003](./003-permissions-chat-policy/spec.md) | Permissions & per-chat policy | P1 | 001, 002 |
| [004](./004-memory-user-model/spec.md) | Persistent memory & user model | P2 | 001–003 |
| [008](./008-commands-menu/spec.md) | Slash-command menu (fallback controls) | P2 | 001–004 |
| [005](./005-history-search/spec.md) | Session history search (FTS5) | P3 | 002, 003 |
| [006](./006-skills-learning-loop/spec.md) | Self-authored skills / learning loop | P4 | 004, 005 |
| [007](./007-scheduler/spec.md) | Scheduled jobs (cron) | P5 | 001–003 |

## Hermes → Claude Code mapping

| Hermes concept | This project |
|---|---|
| Always-on gateway process | `daemon.ts`: a grammY long-poller that spawns `claude -p --resume` for each turn, run under launchd or systemd (001) |
| Agent loop / model access | The unmodified `claude` CLI on the owner's subscription. Hermes' direct-API approach is avoided (see [Auth](#auth)) |
| Persistent notes (`MEMORY.md`) | Claude Code auto-memory: one markdown file per fact with typed frontmatter, plus a `MEMORY.md` index (004) |
| User model (Honcho / `USER.md`) | Per-Telegram-user `type: user` memory files, refined by the reflection pass (004) |
| FTS5 session search + LLM summary | An indexer over Claude Code's own `~/.claude/projects/**/*.jsonl` transcripts → `bun:sqlite` FTS5 cache (005) |
| Skills created from experience | The reflection pass writes or patches `~/.claude/skills/<name>/SKILL.md` and tracks usage (006) |
| "Nudges" to persist knowledge | `Stop` and `PreCompact` hooks trigger a reflection pass (`claude -p --model haiku`) shared by 004 and 006 |
| Context assembly | `SessionStart` and `UserPromptSubmit` hooks inject memory, the user model and recalled history (004/005) |
| Scheduled automations | A daemon-owned `croner` scheduler, with results delivered to the originating chat or topic (007) |
| Multi-platform messaging | Telegram DMs, groups and forum topics (002). Other platforms are a non-goal for now. |
| Tool approval | The `PreToolUse` hook shows inline Allow / Deny / Always buttons, plus per-chat policy mapped to CLI flags (003) |
| Slash commands | Telegram bot menu (`setMyCommands`, scoped). These are a **fallback**; autonomy is the primary path (008) |

## Architecture

```
 Telegram (DM / group / forum topic)
        │  updates (long-poll)
        ▼
┌──────────────────────────── daemon.ts ─────────────────────────────┐
│ gate() ─► router ─► per-session queue (key = chat[:topic])          │
│                         │ spawn per turn                            │
│                         ▼                                           │
│   claude -p --resume <id> --output-format stream-json               │
│     --settings claude-settings.json  --mcp-config mcp.json          │
│     --append-system-prompt …  [policy flags]                        │
│     env: TG_SESSION_KEY TG_DAEMON_URL TG_HOOK_TOKEN                 │
│        │ stream-json            │ MCP (HTTP)          │ hooks        │
│        ▼                        ▼                     ▼              │
│  runner: session_id,     MCP server @127.0.0.1   hook endpoint       │
│  progress, usage,        reply react edit        SessionStart/       │
│  /stop = SIGINT          download memory_*       UserPromptSubmit →  │
│                          history_search skill_*    inject context    │
│                          schedule_* session_*    PreToolUse → policy │
│                                                    + inline buttons  │
│                                                  PostToolUse →       │
│                                                    progress, usage   │
│                                                  Stop/PreCompact →   │
│                                                    reflection        │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ reflection       │  │ history      │  │ scheduler            │   │
│  │ claude -p haiku  │  │ indexer (005)│  │ (croner, 007)        │   │
│  │ (004, 006)       │  │ JSONL→FTS5   │  │ → runTurn() → chat   │   │
│  └────────┬─────────┘  └──────────────┘  └──────────────────────┘   │
└───────────┼─────────────────────────────────────────────────────────┘
            ▼
 ~/.claude/  (one brain, shared with the CLI)
   CLAUDE.md · projects/<daemon>/memory/** · skills/** · projects/**/*.jsonl
 ~/.claude/channels/telegram/  (daemon state)
   .env · access.json · sessions.json · jobs.json · history.db · skills-usage.json · inbox/
```

## Glossary

- **Session key**: `"<chat_id>"` for DMs and plain groups, or `"<chat_id>:<message_thread_id>"` for forum topics.
- **Owner**: the Telegram user IDs in `access.allowFrom`, i.e. people who were paired through a DM.
- **Reflection pass**: a cheap model call made after a turn. It proposes memory, user-model and skill updates.
- **Chat policy**: the per-session-key configuration in `access.json` → `chats` (003).

## Auth
**Subscription only.** The daemon runs on the owner's Claude Pro or Max plan through the existing `claude` CLI login. No API key is used. Under [Claude Code legal & compliance](https://code.claude.com/docs/en/legal-and-compliance):
- Plan limits assume "ordinary, individual usage of Claude Code and the Agent SDK", so a single-owner personal bot fits.
- Other people's requests must not be routed through the owner's subscription. In groups, only the owner triggers turns (003 FR12).
- Always-on use (cron jobs, reflection) uses up usage windows faster. Hence Haiku for background passes, budgets, and pause-on-limit (001 FR10).

**Why the CLI and not the Agent SDK:** Hermes called the Anthropic API directly with Claude Code login tokens. Those requests were billed to "extra usage" credits instead of the plan, and failed with "out of extra usage" errors ([hermes-agent#32243](https://github.com/NousResearch/hermes-agent/issues/32243)). The fix requested by its users is to call `claude -p` ([#48320](https://github.com/NousResearch/hermes-agent/issues/48320)). Anthropic's billing guidance also groups Agent SDK usage with third-party apps, and moving those to separate billing is only paused. Running the unmodified `claude` binary is ordinary Claude Code usage, the clearest case for drawing on the subscription. The daemon never touches tokens.

## Baseline notes

- `server.ts`, `package.json`, `skills/` and `telegram/` are currently **untracked** in git. Commit the fork baseline before starting P1.
- Existing functions to reuse are listed in each `plan.md`. The main ones are: `gate()`, `dmCommandGate()`, `isMentioned()`, `chunk()`, `assertSendable()`, `loadAccess`/`saveAccess`/`pruneExpired`, `checkApprovals()`, the stale-PID guard, the `callback_query:data` permission handler, and the `message:*` attachment handlers.
