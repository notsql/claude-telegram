# 002 — Tasks
Depends on: 001 (T005, T007, T009)

- [x] **T201** `sessions/key.ts` with unit tests (DM, group, forum topic, General topic).
- [ ] **T202** `sessions/store.ts`: atomic persistence plus `new`, `resume` and `list`.
  *Verify:* unit tests, and the file survives a kill -9 mid-write.
- [ ] **T203** Runner passes `--resume <sessionId>` and the per-key `TG_SESSION_KEY`, and captures `session_id` from the stream-json `system/init` event. The MCP session binding (001 T005) uses the key.
  *Verify:* AC1.
- [ ] **T204** Thread-aware `Target` in `send.ts`. Every send path (reply tool, progress, files, errors) passes `message_thread_id`.
  *Verify:* AC2.
- [ ] **T205** `queue.ts`: serial execution per key, a global semaphore, batching of pending messages, and a "queued" reaction.
  *Verify:* AC3.
- [ ] **T206** `groupBuffer.ts` plus a hook in the router for messages dropped only because a mention was missing.
  *Verify:* AC4, and a non-allowlisted sender's text never shows up in the buffer.
- [ ] **T207** Inbound prompt formatter that escapes wrapper tags.
  *Verify:* unit test where the user text contains `</telegram>`.
- [ ] **T208** Topic name cache from service messages.
  *Verify:* renaming a topic updates `topic=` in the next prompt.
- [ ] **T209** Expose session lifecycle functions to 008 (`/new`, `/resume`, `/sessions`).
  *Verify:* AC5.
- [ ] **T210** grammY `auto-retry` and throttling for outbound sends.
  *Verify:* a burst of 50 chunks completes without 429 errors.
- [ ] **T211** Group onboarding doc: how to add the bot, turn off privacy mode in BotFather (required to see unmentioned messages for FR8), and enable topics.
