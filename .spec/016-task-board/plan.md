# 016 — Plan

## Modules
```
tasks/
  store.ts     tasks.json load/save, state transitions (owner-only `done`)
  runner.ts    start/resume a task session (key `task:<id>`), segments, attempts; reuses agent/runner runTurn
  tools.ts     task_start, task_update, task_list on the daemon MCP server
  board.ts     render + edit-in-place the pinned 🗂 Tasks message; Settings page
  recover.ts   on start: resume `working` tasks whose run is gone
telegram/handlers/tasks.ts   ✅ Done / ✏️ Change / 🗑 Drop / ⏸ / ▶ callbacks; reply-to-question routing
```

## Data
```json
{ "tasks": [{ "id": "t_8f2c", "title": "Q1 sales forecast", "brief": "…", "chat": "123", "thread": null,
  "state": "needs_you", "sessionId": "…", "effort": "deep", "needs": "Use Stripe or the sheet?",
  "notes": [{"at": 0, "text": "pulled 412 invoices"}], "attempts": 0,
  "board": {"chat": "123", "message_id": 991}, "askMessageId": 1002 }] }
```
`askMessageId` maps a reply to the task (FR5). The task's transcript is a normal Claude Code JSONL, so 005 history indexes it.

## Reuse
- 007 `runJob`/`runTurn` deliver-to-chat path, `narrowPolicy`, and the approval relay.
- 001 progress/typing helpers. The board edit uses the same edit-in-place code.
- 008 Settings page scaffolding.
- 013 `watch/digest.ts` gets one more section, next to 🤝 On your plate.

## Risks
- **Usage burn**: deep tasks are the most expensive thing the bot does. Segments are capped, the daily budget applies, and a task paused on a limit is shown on the board.
- **Reply routing mistakes**: only an explicit reply to the ❓ message goes to the task. Everything else goes to the chat.
