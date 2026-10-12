# 013 — Tasks
Depends on: 001 (runner, budget), 003 (approvals), 004 (memory), 007 (system jobs), 012 (acquiring new connectors).

- [ ] **T1301** `watch/registry.ts` + `store.ts` (`inbox.db` schema, FTS5, dedupe), plus the `TELEGRAM_WATCH` flag (FR1, FR2, FR12).
  *Verify:* unit tests; inserting the same item twice keeps one row.
- [ ] **T1302** `supervisor.ts` + `ingest.ts` + adapters for `tgcli watch` (stream) and `wacli` (webhook, HMAC), run read-only (FR1, FR3, FR4).
  *Verify:* live messages on both accounts land in `inbox.db` within 10s.
- [ ] **T1303** `poll` kind + GitHub adapter; `agent-poll` kind using `runOneShot` with a schema and a cursor (FR1, FR3).
  *Verify:* GitHub notifications and today's calendar events land as items.
- [ ] **T1304** `triage.ts`: rules stage, plus the shipped `tg-triager` with batching and budget (FR5, FR6, FR11).
  *Verify:* AC2, AC5, AC8.
- [ ] **T1305** `deliver.ts`: ping cards with buttons, quiet hours, `pingsPerHour`, snooze (FR7).
  *Verify:* AC1.
- [ ] **T1306** `digest.ts`: morning and evening system jobs, open-loop detection and closure (FR8).
  *Verify:* AC3.
- [ ] **T1307** `tools.ts` + `send.ts`: `inbox_*`, `source_*`, `draft_reply` with Send/Edit/Cancel (FR4, FR9).
  *Verify:* AC4, and US5 answered from the store.
- [ ] **T1308** `source_add` onboarding through 012, plus health notices with Fix/Pause (FR9, FR10).
  *Verify:* AC6, AC7.
- [ ] **T1309** `/sources` and `/inbox` fallback commands (008).
