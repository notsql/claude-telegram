# 017 — Plan

## Modules
```
deliverables/
  store.ts    work-dir layout, versioning, deliverables.json (rebuildable from folders)
  tools.ts    deliverable_save, deliverable_list
  refresh.ts  🔁 Keep current ↔ 007 job create/delete
telegram/handlers/deliverables.ts   US1 buttons, ✏️ Change reply flow, 📁 Files pages
```

## Flow
```
turn/task ──writes file──► deliverable_save(path) ──► copy → <work>/<slug>/v<n>.<ext>, latest.<ext>
                                              └──► sendDocument(chat, thread) + buttons
✏️ Change ─reply─► runTurn/task_start("edit <latest> : <instruction>") ─► deliverable_save(id)
🔁 daily ──► schedule_create (007) ─► job run ─► deliverable_save only on change
```

## Reuse
- `mcp/telegramTools.ts` sendDocument path and `assertSendable()`.
- The 007 `schedule_create` function. This is the same function the tool uses, so there is no separate scheduler logic (constitution I).
- 016 `task_start` for ✏️ Change when tasks are on.

## Risks
- **Large files**: Telegram bots can send up to 50 MB. Over that, the bot says where the file is on disk.
- **Wasted refresh runs**: each refresh is a full turn. Only daily or weekly is offered, and an unchanged result is never sent.
