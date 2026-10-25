# 018 — Topic Channels

## Problem
Everything proactive goes to one chat: pings, digests, task updates, and the conversations they start. Recurring subjects like the house move, hiring, or a client project end up mixed together in the owner DM. Telegram forum topics already work as separate sessions (002), and memory is shared across them (004). What's missing is the agent **opening and using** a topic per subject by itself, so each subject has its own thread with its own history, and the main chat stays a short main thread.

## User stories
- **US1**: In my forum group I open ⚙️ Settings → 🧵 Channels and tap **Use this group for channels**. The bot checks it can manage topics.
- **US2**: I've talked about the flat move in three separate conversations this week. The agent asks: "🧵 Open a *Flat move* channel? I'll keep move-related updates there." with **Yes** / **No**. Yes creates the topic and posts a short catch-up as its first message.
- **US3**: A WhatsApp message from the landlord gets pinged in the *Flat move* topic, not the DM. A 016 task I started there reports there too.
- **US4**: "Open a channel for Acme onboarding" works right away, with no proposal step.
- **US5**: In the *Flat move* topic, the agent still knows what I told it about my budget in the DM, because memory is shared. It doesn't pull in the DM conversation itself.

## Functional requirements
- **FR1 — Home group.** `access.json` gets `channels: {home: <chat_id>}`, set from the owner-only page in US1. The group must be a forum and the bot must have `can_manage_topics`. The page explains how to fix it when either is missing. New topics inherit the home group's chat policy (003).
- **FR2 — Registry.** `STATE_DIR/channels.json` holds `{id, title, thread, createdAt, match: {keywords[], contacts[], sources[]}, lastUsedAt}`. Each channel's session key is the normal `<home>:<thread>` (002).
- **FR3 — Tools.** These are owner-only:
  - `channel_open({title, match, catchUp})` calls `createForumTopic`, registers the channel, and posts `catchUp` (a short summary the agent writes from history) as the first message.
  - `channel_list` lists the channels.
  - `channel_route({channel, match})` edits what goes to a channel.
  - `channel_close({channel})` calls `closeForumTopic`, keeps the history, and stops routing to it.
- **FR4 — Proposals.** The reflection pass (004/006) gets a `channel` proposal kind. It proposes one when the same subject has come up in ≥3 separate sessions within 14 days and no channel matches it. A proposal is always shown with buttons and never applied silently. A rejected subject isn't proposed again for 30 days. There is at most one channel proposal per day.
- **FR5 — Routing.** 013 delivery checks each ping against channel `match` before using the default 📍 updates chat. The first channel that matches wins. 016 tasks report to the chat or topic they started in. Digests stay in the main chat, with one line per channel that has new activity: "🧵 Flat move · 3 new".
- **FR6 — Isolation.** Channels follow constitution IV. History and skills stay per session, and memory is shared. `catchUp` is written by the agent in the session that opened the channel, so only what that session could already see goes into the topic.
- **FR7 — Flag.** Ships behind `TELEGRAM_CHANNELS=1`. Without a home group, the tools explain how to set one up and do nothing else.

## Non-goals
- Channels in groups other than the owner's home group, or channels for other people.
- Creating Telegram groups. Only topics in an existing forum group are created.
- Moving old messages between chats.

## Acceptance criteria
- **AC1** (FR1): In a non-forum group, or without `can_manage_topics`, the Channels page says what's missing. In a forum group with the right it saves `home`.
- **AC2** (FR3): `channel_open` creates a topic, posts the catch-up, and a message in that topic runs in session `<home>:<thread>`.
- **AC3** (FR4): Seeded history with one subject in 3 sessions in 14 days gives one proposal. **No** suppresses it for 30 days.
- **AC4** (FR5): A 013 ping matching a channel's contact arrives in that topic, and the digest shows the 🧵 line.
- **AC5** (FR6): Asking in the topic "what did I say in the DM about X?" without memory of X gets no DM transcript content.
- **AC6** (FR7): Without the flag, nothing calls `createForumTopic`.
