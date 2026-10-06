# Telegram

Connect a Telegram bot to your Claude Code with an MCP server.

The MCP server logs into Telegram as a bot and provides tools to Claude to reply, react, or edit messages. When you message the bot, the server forwards the message to your Claude Code session.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

**2. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install telegram@claude-plugins-official
```

**3. Give the server the token.**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `TELEGRAM_STATE_DIR` at a different directory per instance.

**4. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:telegram@claude-plugins-official
```

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram:access policy allowlist` directly.

## Daemon mode

Daemon mode runs the bot without an open Claude Code session. `daemon.ts` polls Telegram and runs each message as a `claude -p` turn on your Claude subscription, so replies arrive even when no terminal is open. The `--channels` flow above still works.

**Requirements:** the `claude` CLI on `PATH`, version 2.1.288 or newer, logged in with `claude auth login`. `ANTHROPIC_API_KEY` must be unset; the daemon refuses to start with it, because the CLI would bill the key instead of your subscription.

**1. Set the token and pair.** Follow steps 1, 3 and 5 of Quick Setup. Pairing works the same way: DM the bot, then run `/telegram:access pair <code>` from any Claude Code session.

**2. Try it in the foreground.**

```sh
bun install
bun run start:daemon
```

**3. Install it as a service** so it starts at login, restarts after a crash and comes back after a reboot:

```sh
bun run install-service
```

On macOS this loads a launchd agent (`~/Library/LaunchAgents/com.claude.telegram.plist`). On Linux it enables a systemd user unit (`~/.config/systemd/user/claude-telegram.service`); run `loginctl enable-linger $USER` so it also starts at boot before you log in. Logs go to `~/.claude/channels/telegram/logs/`. Rerun the command after moving the repo or upgrading `bun` or `claude`, because their paths are written into the service file.

**Config.** Set these in `~/.claude/channels/telegram/.env` (or the environment) and restart:

| Variable | Default | Effect |
| --- | --- | --- |
| `TELEGRAM_WORKSPACE` | `~/.claude/channels/telegram/workspace` | Working directory for every turn |
| `TELEGRAM_MAX_TURNS` | `30` | `--max-turns` for each turn |
| `TELEGRAM_DAILY_TURN_BUDGET` | `0` (no limit) | Turns allowed per local day |
| `TELEGRAM_INTERRUPT_ON_NEW_MESSAGE` | unset | `1` interrupts the running turn when a new message arrives |

**In chat.** The bot shows "typing…" while it works, and posts a progress message on turns longer than 8 seconds. The answer always arrives as a new message, so you get a notification. `/stop` interrupts the running turn. When your usage limit is reached, the bot says when it will resume and holds queued messages until then.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |

Inbound messages trigger a typing indicator automatically — Telegram shows
"botname is typing…" while the assistant works on a response.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive — no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages
— photos are downloaded eagerly on arrival since there's no way to fetch them
later.
