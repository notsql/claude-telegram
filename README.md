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

**Turn off the Telegram plugin.** Telegram allows one poller per bot token. The plugin starts its own poller in every Claude Code session that loads it, and the daemon then logs `409 Conflict`. Turns the daemon spawns already skip the plugin; disable it for your other sessions in `~/.claude/settings.json`:

```json
"enabledPlugins": { "telegram@claude-plugins-official": false }
```

Sessions that were already open keep the plugin until you restart them.

**1. Set the token and pair.** Put the token in `~/.claude/channels/telegram/.env` as `TELEGRAM_BOT_TOKEN=...` (step 3 of Quick Setup). With the plugin off, its skills are gone too, so install them as user skills from this repo:

```sh
ln -s "$PWD/skills/access" ~/.claude/skills/telegram-access
ln -s "$PWD/skills/configure" ~/.claude/skills/telegram-configure
```

Then pair as in step 5, using `/telegram-access pair <code>` in place of `/telegram:access pair <code>`.

On start the daemon also installs its `tg-*` agents and skills (from `assets/`) into `~/.claude/agents/` and `~/.claude/skills/`; files you have edited are kept.

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

The service runs `daemon.ts` from this checkout. Once it is installed, don't also run `bun run start:daemon`: each daemon replaces the one already polling, and launchd or systemd restarts the service, so the two keep killing each other. Manage it with:

| | macOS | Linux |
| --- | --- | --- |
| Restart (e.g. after `git pull`) | `launchctl kickstart -k gui/$(id -u)/com.claude.telegram` | `systemctl --user restart claude-telegram` |
| Stop | `launchctl bootout gui/$(id -u)/com.claude.telegram` | `systemctl --user stop claude-telegram` |
| Start again | `bun run install-service` | `systemctl --user start claude-telegram` |
| Follow the log | `tail -f ~/.claude/channels/telegram/logs/daemon.err.log` | same |

To debug in the foreground, stop the service first.

**Config.** Set these in `~/.claude/channels/telegram/.env` (or the environment) and restart:

| Variable | Default | Effect |
| --- | --- | --- |
| `TELEGRAM_WORKSPACE` | `~/.claude/channels/telegram/workspace` | Working directory for every turn |
| `TELEGRAM_MAX_TURNS` | `30` | `--max-turns` for each turn |
| `TELEGRAM_DAILY_TURN_BUDGET` | `0` (no limit) | Turns allowed per local day |
| `TELEGRAM_MAX_CONCURRENT_SESSIONS` | `3` | Chats or topics whose turns run at the same time; others wait with a 🫡 reaction |
| `TELEGRAM_INTERRUPT_ON_NEW_MESSAGE` | unset | `1` interrupts the running turn when a new message arrives |

**In chat.** The bot shows "typing…" while it works, and posts a progress message on turns longer than 8 seconds. The answer always arrives as a new message, so you get a notification. Each chat and forum topic is its own conversation, and up to `TELEGRAM_MAX_CONCURRENT_SESSIONS` of them work at once. Messages sent while the bot is busy in that chat are answered together in the next turn; a 🫡 reaction marks a message that is waiting. `/stop` interrupts the turn running in the chat or topic where you send it, and `/sessions` → 🆕 New starts a fresh conversation there (see [Commands](#commands)). When your usage limit is reached, the bot says when it will resume and holds queued messages until then.

### Commands

You don't need commands: ask in plain words and the agent does the same thing with its tools. Commands are a sure shortcut that runs the same code. Type `/` to see them; groups show the same ones except `/start` and `/help`. Commands only work for senders in your `allowFrom` list.

| Command | Plain words / agent tool |
| --- | --- |
| `/sessions` | "let's start fresh", "go back to yesterday's chat", "what's this costing me?" · `session_new`, `session_resume`, `session_status`. Shows the session's status with 🆕 New, ⏪ Resume (earlier sessions as buttons, paged) and 🗜 Compact (Claude Code compacts on its own; this forces it). |
| `/stop` | a "stop" message when `TELEGRAM_INTERRUPT_ON_NEW_MESSAGE=1` |
| `/memory` | "remember I use pnpm", "forget that" · `memory_write`, `memory_delete`, `memory_search`. Buttons list each entry (tap it, then 🗑 Forget, with Undo), + Add (reply to the prompt to save), 👤 About you, and paging. |
| `/skills [command] [args]` | "which skills do you have?" · `skill_list`, `skill_read`. Buttons list every skill that is on here, paged; tap one for ▶️ Run, 📄 Show and, for the chat's own skills, 📦 Archive / 🗑 Remove. `/skills <command> <args>` runs one with arguments. |
| `/cron` | "remind me tomorrow at 3pm…", "what have I scheduled?" · `schedule_*`; buttons pause, resume, delete or run now, and ➕ New job picks how often, the day and the hour, then asks what to do |
| `/settings` | Owner only. Lists each setting (model, memory scope, history scope, auto learn, scheduler allowed) with what it does; tap one to see what each value means and pick it. 🔐 Permissions has the permission mode and one button per kind of rule (allowed, blocked, ♾ Always), each paged; ♾ Always rules can be removed. 🧩 Skills, plugins & MCP switches each skill, plugin and MCP server (including claude.ai connectors) on or off for this chat only. Its 🛒 Browse plugins (owner only) lists your marketplaces' plugins by category, with Install, Update and Uninstall; a new install is on in that chat only. 🤖 Agent picks what this chat or topic runs as (the default assistant, or one of your agents, e.g. `tg-researcher` for a research topic). ↺ Reset to defaults (with a confirm) clears all of that, keeping only terminal-only settings such as `cwd`. The agent may suggest changes but never applies them. |
| `/usage` | Plan usage from Claude Code's own `/usage`: a bar for the current session and weekly limits with their reset times; ℹ️ Learn more shows what's using them. |
| `/start`, `/help` | Pairing instructions and this overview. |

Skills are not listed in the `/` menu; use `/skills`. Typing a skill's Telegram-safe name still works: `/deploy_blog staging` runs the `deploy-blog` skill with `staging` as its argument. Names stay stable once assigned (`commands.json` in the state directory). Every menu has ✖ Close. In groups, `/cron`, `/settings`, forgetting a memory and archiving or removing a skill need one of the chat's `approvers`.

### Groups and forum topics

Each group, and each topic in a forum group, gets its own conversation. To set one up:

1. **Add the bot.** In the group, open the member list, choose **Add members** and pick your bot.
2. **Turn on topics (optional).** In the group settings, choose **Edit** and enable **Topics**. This turns a basic group into a supergroup with a new `-100…` chat ID, so do it before the next step.
3. **Turn off privacy mode.** Send [@BotFather](https://t.me/BotFather) `/setprivacy`, pick your bot and choose **Disable**. With privacy mode on, Telegram delivers only @mentions and replies. The bot then can't see the group messages that weren't addressed to it, which it otherwise passes to the next mentioned turn as recent context. Telegram applies the change only to groups the bot joins afterwards, so remove the bot and add it again. Making the bot a group admin also gets it every message.
4. **Allow the group.** Get its chat ID (see [ACCESS.md](./ACCESS.md#groups)) and run `/telegram-access group add <chatId>`. Add `--no-mention` to have it answer every message, not just @mentions and replies.

Replies, progress messages and notices go to the topic the message came from. The bot learns topic names when a topic is created or renamed, and after a restart from the next message in each topic. The prompt carries the name, so you can ask it which topic it's in.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `session_*` | Daemon only: `session_new`, `session_resume`, `session_set_model`, `session_status`, the agent's side of the session commands. |
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
