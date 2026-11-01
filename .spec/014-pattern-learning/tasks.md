# 014 — Tasks
Depends on: 004 (memory writer), 005 (history), 006 (skills), 007 (scheduler), 013 (inbox.db, triage, digests).

- [ ] **T1401** `signals.ts` table plus recording points in the runner, 013 ingest and deliver callbacks, and 007 runs; `TELEGRAM_PATTERNS` flag (FR1, FR9).
  *Verify:* unit tests; signals appear after a ping is snoozed.
- [ ] **T1402** `aggregate.ts` stats with no message bodies (FR2, FR8).
  *Verify:* AC6 on seeded data.
- [ ] **T1403** Ship `tg-pattern-miner`; `miner.ts` system jobs with thresholds and rejection suppression (FR2, FR3).
  *Verify:* AC3.
- [ ] **T1404** `apply.ts`: auto-apply vip/mute/active_hours/preference as memory files with Undo, and propose routine/skill with buttons (FR4).
  *Verify:* AC1, AC2.
- [ ] **T1405** `read.ts` wired into 013 triage rules, quiet hours and digest times (FR5).
  *Verify:* AC4.
- [ ] **T1406** Decay and contradiction handling (FR6).
  *Verify:* AC5.
- [ ] **T1407** `pattern_list` / `pattern_forget` tools (FR7).
  *Verify:* AC7.
- [ ] **T1408** Repeated tasks: `patterns/` with a `signals` row per 🤖 Do it, a `patterns` table, the `tg-pattern-miner` agent and weekly `pattern-mining` system job behind `TELEGRAM_PATTERNS=1`; proposals validated against cited ids; 📈 cards with Yes / No / Not now. Yes on a `routine` creates a 007 job in that chat, and Yes on a `skill` starts a turn that authors it (FR1–FR4, FR9).
  *Verify:* AC2, AC3 on seeded history; a live pass over real history produces only proposals with real evidence.

