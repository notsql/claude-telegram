# 016 — Tasks
Depends on: 001 (runner, limits), 003 (policy, approvals), 007 (runTurn delivery), 008 (Settings), 013 (digest).

- [ ] **T1601** `tasks/store.ts` with states and the owner-only `done` rule; `TELEGRAM_TASKS` flag (FR1, FR9).
  *Verify:* unit tests for transitions; AC7.
- [ ] **T1602** `task_start` + `tasks/runner.ts`: a background session on its own queue, effort → model and turn limits, segments (FR2, FR3, FR4).
  *Verify:* AC1, AC6.
- [ ] **T1603** `task_update` reporting: new messages for `needs_you`/`review`, reply routing into the task session, review buttons (FR2, FR5).
  *Verify:* AC2, AC3.
- [ ] **T1604** Pinned 🗂 Tasks board edited in place, plus ⚙️ Settings → 🗂 Tasks pages; `task_list` (FR6).
  *Verify:* AC4.
- [ ] **T1605** Restart recovery with an attempts cap (FR7).
  *Verify:* AC5.
- [ ] **T1606** 🗂 line in the 013 digest (FR8).
  *Verify:* a digest with a task in `needs_you` lists it.
