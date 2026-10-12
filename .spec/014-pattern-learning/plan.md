# 014 — Plan

## Modules
```
patterns/
  signals.ts    record(kind, subject, value) → inbox.db signals table; hooks from 013 deliver/ingest, runner, 007 run
  aggregate.ts  SQL → compact stats (hour-of-week histogram, per-contact latency p50/n, feedback counts, request clusters via 005 FTS)
  miner.ts      system jobs (daily light / weekly full) → runOneShot('tg-pattern-miner') → thresholds → apply/propose
  apply.ts      write/patch/delete memory files (004 writer) with pattern metadata; schedule/skill proposals with buttons
  read.ts       current vip/mute/active_hours for 013 triage and digest timing (parsed from memory files, cached)
  tools.ts      pattern_list, pattern_forget
assets/agents/tg-pattern-miner.md   StructuredOutput only, model: sonnet
```

## Data
```sql
signals(ts INTEGER, kind TEXT, subject TEXT, value REAL, INDEX(kind, subject, ts))
pattern_rejections(key TEXT PK, until INTEGER)   -- kind:subject → 30-day suppression
```
Signals are derived telemetry. The patterns themselves live in memory files, so deleting `inbox.db` loses only evidence history, not what was learned (constitution II).

## Memory file example
```markdown
---
name: vip-manager-whatsapp
description: Owner replies to <name> (WhatsApp) fast; treat as VIP
metadata:
  type: feedback
  source: tg
  pattern: vip
  subject: whatsapp:6591234567
  evidence: {n: 8, window: 14d, p50_reply_min: 6}
  confidence: 0.86
---
Treat messages from <name> on WhatsApp as VIP: always triage, ping even in quiet hours if urgent.
```

## Reuse
- Memory writes, dedupe and Undo go through the 004 `apply.ts` path.
- Schedule proposals call the same function as `schedule_create` (007).
- Skill proposals go through 006 `skill_create` via `tg-skill-author`.
- System job registration extends `SYSTEM_JOBS`.

## Risks
- **Wrong inferences annoy the owner**: thresholds, Undo on every auto-apply, decay, and nothing that spends usage applied silently.
- **Creepiness and privacy**: aggregates only, bodies never leave the daemon for mining, and every learned pattern can be listed and forgotten.
