# 002 — Plan

## Modules
```
src/sessions/
  key.ts         sessionKey(ctx) / parseKey(key) → { chatId, threadId? }
  store.ts       sessions.json load/save (atomic tmp+rename, like saveAccess), new/resume/list
  queue.ts       per-key serial queue + global semaphore (concurrency N), pending-batch buffer
  groupBuffer.ts ring buffer of unaddressed group messages per key
  topics.ts      topic name cache from forum_topic_created/edited service messages
```

## Data model — `sessions.json`
```json
{
  "-1001234567890:42": {
    "sessionId": "c0ffee…",
    "history": [{ "sessionId": "abc…", "startedAt": 1759480000000, "title": "Infra: k8s upgrade" }],
    "lastActive": 1759490000000
  },
  "123456789": { "sessionId": "…", "history": [], "lastActive": 0 }
}
```
- `title` is generated from the first user message, truncated. 005 can later refine it with a summary.
- Per-key `cwd` and `model` live in the **policy** (003), not here, so there is a single source of truth for configuration.

## Routing changes
- `gate()` stays as it is. After `deliver`, `bot.ts` calls `router.dispatch(ctx)`. The router computes the key, appends the message to the pending batch, and starts the queue if it is idle.
- When a group message is dropped **only** because a mention is required, it goes into `groupBuffer` instead of being discarded. Messages from senders who are not allowed are still discarded completely (constitution IV).
- `telegram/send.ts` takes a `Target = { chatId, threadId? }` everywhere. The `reply` tool resolves its target from the bound key. When the model passes an explicit `chat_id`, it must equal the bound chat, or be an allowlisted chat when the owner's DM policy allows cross-chat sends (003).

## Inbound prompt format
```
<channel source="telegram" chat_id="…" chat_type="supergroup" chat_title="Ops" topic="Infra" message_id="…" user="alice" user_id="…" ts="…" [image_path=… attachment_*=…]>
<recent_context>  (groups only, from groupBuffer)
  [10:02] bob: …
</recent_context>
message text</channel>
```
Only the daemon builds this wrapper (`agent/inbound.ts`). It keeps the `<channel source="telegram">` tag that `TELEGRAM_INSTRUCTIONS` and the tool descriptions already use, shared with the legacy `server.ts`. Every `<`, `>`, `&` and `"` in user text, recent context and attribute values is escaped, so text such as `</telegram>` or `</channel>` can't close or forge the wrapper.

## Risks
- **Changing a chat's `cwd`**: `--resume <id>` finds a session by ID in any project on the machine (CLI ≥ 2.1.223), so this is safe. If resume still fails (for example the transcript was cleaned up after `cleanupPeriodDays`), start a new session and carry a summary forward (005).
- **Rate limits**: Telegram allows about 30 msgs/sec globally and about 20/min per group. Use a send queue with backoff (grammY `auto-retry` plugin).
