# Telegram — Access & Delivery

A Telegram bot is publicly addressable. Anyone who finds its username can DM it, and without a gate those messages would flow straight into your assistant session. The access model described here decides who gets through.

By default, a DM from an unknown sender triggers **pairing**: the bot replies with a 6-character code and drops the message. You run `/telegram:access pair <code>` from your assistant session to approve them. Once approved, their messages pass through.

All state lives in `~/.claude/channels/telegram/access.json`. The `/telegram:access` skill commands edit this file; the server re-reads it on every inbound message, so changes take effect without a restart. Set `TELEGRAM_ACCESS_MODE=static` to pin config to what was on disk at boot (pairing is unavailable in static mode since it requires runtime writes).

In daemon mode (`bun run start:daemon`, see the README) the same file and gate apply. With the plugin disabled (see the README), run `/telegram-access` from any Claude Code session on the daemon host; it takes the same arguments as `/telegram:access`, and the daemon picks up the change on the next message. Only users in `allowFrom` can use `/stop`.

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | Numeric user ID (e.g. `412587349`) |
| Group key | Supergroup ID (negative, `-100…` prefix) |
| `ackReaction` quirk | Fixed whitelist only; non-whitelisted emoji silently do nothing |
| Config file | `~/.claude/channels/telegram/access.json` |

## DM policies

`dmPolicy` controls how DMs from senders not on the allowlist are handled.

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/telegram:access pair <code>`. |
| `allowlist` | Drop silently. No reply. Useful if the bot's username is guessable and pairing replies would attract spam. |
| `disabled` | Drop everything, including allowlisted users and groups. |

```
/telegram:access policy allowlist
```

## User IDs

Telegram identifies users by **numeric IDs** like `412587349`. Usernames are optional and mutable; numeric IDs are permanent. The allowlist stores numeric IDs.

Pairing captures the ID automatically. To find one manually, have the person message [@userinfobot](https://t.me/userinfobot), which replies with their ID. Forwarding any of their messages to @userinfobot also works.

```
/telegram:access allow 412587349
/telegram:access remove 412587349
```

## Groups

Groups are off by default. Opt each one in individually.

```
/telegram:access group add -1001654782309
```

Supergroup IDs are negative numbers with a `-100` prefix, e.g. `-1001654782309`. They're not shown in the Telegram UI. To find one, either add [@RawDataBot](https://t.me/RawDataBot) to the group temporarily (it dumps a JSON blob including the chat ID), or add your bot and run `/telegram:access` to see recent dropped-from groups.

With the default `requireMention: true`, the bot responds only when @mentioned or replied to. Pass `--no-mention` to process every message, or `--allow id1,id2` to restrict which members can trigger it.

```
/telegram:access group add -1001654782309 --no-mention
/telegram:access group add -1001654782309 --allow 412587349,628194073
/telegram:access group rm -1001654782309
```

**Privacy mode.** Telegram bots default to a server-side privacy mode that filters group messages before they reach your code: only @mentions and replies are delivered. This matches the default `requireMention: true`, so it's normally invisible. Using `--no-mention` requires disabling privacy mode as well: message [@BotFather](https://t.me/BotFather), send `/setprivacy`, pick your bot, choose **Disable**. Without that step, Telegram never delivers the messages regardless of local config.

## Mention detection

In groups with `requireMention: true`, any of the following triggers the bot:

- A structured `@botusername` mention
- A reply to one of the bot's messages
- A match against any regex in `mentionPatterns`

```
/telegram:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## Delivery

Configure outbound behavior with `/telegram:access set <key> <value>`.

**`ackReaction`** reacts to inbound messages on receipt. Telegram accepts only a **fixed whitelist** of reaction emoji; anything else is silently ignored. The full Bot API list:

> 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

```
/telegram:access set ackReaction 👀
/telegram:access set ackReaction ""
```

**`replyToMode`** controls threading on chunked replies. When a long response is split, `first` (default) threads only the first chunk under the inbound message; `all` threads every chunk; `off` sends all chunks standalone.

**`textChunkLimit`** sets the split threshold. Telegram rejects messages over 4096 characters.

**`chunkMode`** chooses the split strategy: `length` cuts exactly at the limit; `newline` prefers paragraph boundaries.

## Skill reference

| Command | Effect |
| --- | --- |
| `/telegram:access` | Print current state: policy, allowlist, pending pairings, enabled groups. |
| `/telegram:access pair a4f91c` | Approve pairing code `a4f91c`. Adds the sender to `allowFrom` and sends a confirmation on Telegram. |
| `/telegram:access deny a4f91c` | Discard a pending code. The sender is not notified. |
| `/telegram:access allow 412587349` | Add a user ID directly. |
| `/telegram:access remove 412587349` | Remove from the allowlist. |
| `/telegram:access policy allowlist` | Set `dmPolicy`. Values: `pairing`, `allowlist`, `disabled`. |
| `/telegram:access group add -1001654782309` | Enable a group. Flags: `--no-mention` (also requires disabling privacy mode), `--allow id1,id2`. |
| `/telegram:access group rm -1001654782309` | Disable a group. |
| `/telegram:access set ackReaction 👀` | Set a config key: `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `mentionPatterns`. |
| `/telegram:access policy show -1001654782309:42` | Show a chat's or topic's policy overrides. |
| `/telegram:access policy -1001654782309 model sonnet` | Set a policy field for a chat (`<chatId>`) or topic (`<chatId>:<threadId>`). |
| `/telegram:access policy reset -1001654782309` | Drop a chat's policy overrides. |
| `/telegram:access trust add ~/infra` | Allow chats to use a `cwd` inside this directory. |

## Chat policy

What the bot may do in a chat is separate from who can reach it. Policies live in `chats`, keyed by chat id or `chatId:threadId` for a forum topic. A topic inherits its chat's entry, which overrides the defaults for the chat type:

- **DMs**: the normal permission prompts, global memory, all history.
- **Groups**: only owners (`allowFrom`) start turns; other members' messages are kept as context for the owner's next turn. `allowOthersOnSubscription: true`, set from the terminal, lets them trigger turns on your subscription. Read-only tools run without asking; Bash, edits and file paths outside the chat's workspace show an approval prompt. Memory is shared with all your chats; history is per chat; no scheduler.

When the agent wants a tool that no rule allows, the chat gets **See more / ✅ Allow / ❌ Deny / ♾ Always (this chat)** buttons. Only `approvers` (default: `allowFrom`) can answer; `yes abcde` / `no abcde` also works, in groups without an @mention (with privacy mode on, send it as a reply to the prompt so the bot receives it). Unanswered prompts deny after 1 minute. **Always** saves Claude Code's suggested rule (for example `Bash(npm test *)`) to the chat's `alwaysAllow`. In a group it applies to every topic.

The owner can also edit common fields with `/policy` in the chat; in a group the edit applies to all topics (topic-only overrides are set from the terminal). `bypassPermissions`, `cwd` and `trustedDirs` can only be set from the terminal. Policy changes and approval decisions are logged to `audit.log` in the state directory.

## Config file

`~/.claude/channels/telegram/access.json`. Absent file is equivalent to `pairing` policy with empty lists, so the first DM triggers pairing.

```jsonc
{
  // Handling for DMs from senders not in allowFrom.
  "dmPolicy": "pairing",

  // Numeric user IDs allowed to DM.
  "allowFrom": ["412587349"],

  // Groups the bot is active in. Empty object = DM-only.
  "groups": {
    "-1001654782309": {
      // true: respond only to @mentions and replies.
      // false also requires disabling privacy mode via BotFather.
      "requireMention": true,
      // Restrict triggers to these senders. Empty = any member (subject to requireMention).
      "allowFrom": []
    }
  },

  // Per-chat or per-topic policy (see Chat policy).
  "chats": {
    "-1001654782309:42": { "policy": { "cwd": "~/infra", "allowedTools": ["Bash(kubectl get *)"] } }
  },

  // Directories a chat cwd may point into. Terminal only.
  "trustedDirs": ["~/infra"],

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": ["^hey claude\\b"],

  // Emoji from Telegram's fixed whitelist. Empty string disables.
  "ackReaction": "👀",

  // Threading on chunked replies: first | all | off
  "replyToMode": "first",

  // Split threshold. Telegram rejects > 4096.
  "textChunkLimit": 4096,

  // length = cut at limit. newline = prefer paragraph boundaries.
  "chunkMode": "newline"
}
```
