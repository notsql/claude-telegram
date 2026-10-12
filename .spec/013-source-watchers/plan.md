# 013 — Plan

## Modules
```
watch/
  registry.ts     sources.json atomic IO, zod schema, enable/pause, cursor, health counters
  supervisor.ts   spawn + restart-with-backoff for stream/webhook-feeder commands; poll timers
  ingest.ts       /ingest/<id> route on the hook endpoint (HMAC check), NDJSON line reader
  adapters/       wacli.ts tgcli.ts github.ts generic.ts (field-map config) → Item
  store.ts        inbox.db: items, FTS5, loops, deliveries; dedupe (source, extId)
  triage.ts       rules stage + batched runOneShot('tg-triager') stage
  deliver.ts      ping cards, quiet hours, pingsPerHour, snooze timers
  digest.ts       morning/evening system jobs, open-loop sweep
  tools.ts        inbox_* source_* draft_reply on the daemon MCP server
  send.ts         per-source send templates (wacli send, tgcli send, …) run only from Send callbacks
assets/agents/tg-triager.md      StructuredOutput only, model: haiku
```

## Pipeline
```
 stream (tgcli watch) ─┐
 webhook (wacli sync) ─┤ adapters → Item → store (dedupe) ─► triage queue
 poll (gh api)        ─┤                                     │ every 2 min / 20 items
 agent-poll (claude)  ─┘                                     ▼
                                     rules ─► tg-triager (haiku, one-shot)
                                                 │ labels + loops
                                   ┌─────────────┼──────────────┐
                                 urgent/action  fyi          noise
                                 deliver.ping   digest queue  store only
```

## Data
```sql
items(id INTEGER PK, source, ext_id, ts, from_id, from_name, chat_id, chat_name, is_group,
      text, url, to_me, from_me, thread_id, label, reason, status /*new|pinged|digested|done|snoozed*/,
      snooze_until, UNIQUE(source, ext_id))
items_fts(text, from_name, chat_name)  -- content=items
loops(id PK, item_id, kind /*awaiting_me|i_promised*/, summary, due, opened_at, closed_at)
```
`inbox.db` is a daemon cache (constitution II). Durable owner decisions such as mute and VIP are written as memory (014), not only to the db.

## Built-in source configs
```json
[
  {"id":"whatsapp","kind":"webhook","config":{"command":["wacli","sync","--follow","--webhook","http://127.0.0.1:{port}/ingest/whatsapp","--webhook-allow-private","--webhook-secret","{secret}"],"env":{"WACLI_READONLY":"1"}}},
  {"id":"telegram-account","kind":"stream","config":{"command":["tgcli","watch","--json"]}},
  {"id":"github","kind":"poll","config":{"command":["gh","api","notifications","--paginate"],"intervalSec":300}},
  {"id":"calendar","kind":"agent-poll","config":{"connector":"Google Calendar","intervalSec":1800}}
]
```
Before T1302, check the exact `tgcli watch` output flags and the `wacli` webhook payload, and record them in the adapter tests. The commands above are this plan's assumptions.

## Reuse
- Long-running child supervision follows the stale-PID and restart patterns in `daemon.ts`.
- `runOneShot` gains `tg-triager` in its agent union.
- System jobs extend `SYSTEM_JOBS` in `scheduler/system.ts` with `digest-morning` and `digest-evening`.
- Ping buttons use the `callback_query:data` router, and send approval uses 003.
- `source_add` for a source with no connector hands off to `capability_request` (012).

## Risks
- **Prompt injection** from any sender in the world: wrapped data, a tool-less triager, and sends gated on owner taps.
- **Noise and fatigue**: rules first, a per-hour cap, quiet hours, and 014 learning from Snooze/Mute/Done.
- **Account bans**: watchers are read-only, and sends are paced (`--send-spacing`) and owner-initiated.
- **Privacy**: `inbox.db` is mode 0600 in STATE_DIR, and `assertSendable` blocks sending it.
