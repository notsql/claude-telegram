# 002 — Sessions & Surfaces

## Problem
The channel plugin sends every chat into one shared Claude context and does not understand forum topics. A personal agent needs a separate, resumable conversation for each DM, group and forum topic, so that work in one thread does not pollute another.

## User stories
- **US1**: As the owner, my DM with the bot is one continuous conversation that survives daemon restarts.
- **US2**: As the owner, I add the bot to a group with forum topics, and each topic (for example "Infra" or "Writing") acts as its own workspace with its own context.
- **US3**: As a group member on the allowlist, I @mention the bot (or reply to it) and it answers in the same topic.
- **US4**: As the owner, I can start a fresh conversation in the current chat or topic, and resume an earlier one.

## Functional requirements
- **FR1**: Session key = `chat_id`, or `chat_id:message_thread_id` when the message belongs to a forum topic (`is_topic_message`). The General topic counts as the plain `chat_id`.
- **FR2**: `sessions.json` maps each session key to `{ sessionId, history: [{sessionId, startedAt, title}], lastActive }`. These are Claude Code session IDs.
- **FR3**: Each turn runs `claude -p --resume <sessionId>` (001). The `session_id` from the stream-json `system/init` event is stored, because resume can return a new ID.
- **FR4**: Every outbound send (reply, files, progress, permission prompts, scheduler output) carries `message_thread_id` when the key has a topic.
- **FR5**: Turns are serialised per session key. Up to N sessions (default 3) run concurrently across keys. Extra keys wait in a FIFO with a "queued" reaction.
- **FR6**: Messages that arrive while a turn is running are batched into the next turn, unless `interruptOnNewMessage` is set (001).
- **FR7**: Group gating keeps today's rules (`groups[chat_id]`, `requireMention`, `allowFrom`, `mentionPatterns`, and reply-to-bot counts as a mention). Policy can be set per topic (see 003).
- **FR8**: The inbound prompt includes sender identity (username, user_id), chat type and title, and topic name when known. In groups it includes up to K recent messages that were *not* addressed to the bot (an in-memory ring buffer per chat), so the agent has conversational context. Telegram's API has no history endpoint, which makes this buffer necessary.
- **FR9**: Session lifecycle operations (`new`, `resume <n>`, `list`) are available as functions, used by the tools here and by the commands in 008.
- **FR10**: Bot service messages (topic created or renamed) update a cached topic-name map, used for titles.

## Non-goals
- Telegram broadcast channels (`channel_post`).
- Sharing a session across several chats.

## Acceptance criteria
- **AC1** (FR1–3): After a daemon restart, the DM agent still remembers the previous exchange.
- **AC2** (FR1, FR4): The same question asked in two forum topics gets independent answers, and each answer lands in its own topic.
- **AC3** (FR5): Two chats send long tasks at the same time. Both progress, and messages within one chat stay in order.
- **AC4** (FR7): An unmentioned group message is not answered, but it does appear in the context of the next mentioned turn (FR8).
- **AC5** (FR9): `/new` followed by a question gets an answer with no prior context, and `/resume 1` restores the old context.

## Open questions
- What should the ring-buffer size K be for group context? (Proposal: 20 messages or 4k characters.)
- Should idle sessions auto-rotate (start a fresh Claude Code session after X days, with a summary carried forward)? (Proposal: yes, after 7 days. The summary comes from 005.)
