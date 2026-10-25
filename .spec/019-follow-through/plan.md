# 019 — Plan

## Modules
```
followthrough/
  prep.ts     pick items before a digest, run draft turns (016 quick task or runOneShot), store drafts on items
  rules.ts    notify_rule memory files: write/read/list (via the 004 memory writer), cached for triage
  tools.ts    notify_rule, notify_rule_list
```

## Touch points
- `watch/triage.ts`: `awaiting_them` in the loop enum, the closing rule, and rules applied before urgency.
- `watch/digest.ts`: 📝 Draft ready buttons and the ⏳ Waiting on others section.
- `watch/send.ts`: the Send / Edit / Cancel path is reused as it is.
- `inbox.db`: a `drafts(item_id PK, text, at)` table. It is derived and can be dropped.

## Risks
- **Prep spends usage on items the owner ignores**: a cap of 3, the budget gate, and once 014 is on, ping feedback (`ping_feedback`) can lower the prep count for contacts whose drafts are never used.
- **False `awaiting_them`**: a 3-working-day threshold and a Drop button. Dropping counts as 🔕 Not like this feedback (013 FR13).
