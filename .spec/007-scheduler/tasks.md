# 007 — Tasks
Depends on: 001 (runner, budget), 002 (session targets, semaphore), 003 (policy gating)

- [x] **T701** Add `croner`. `scheduler/store.ts` with zod schema and atomic IO.
  *Verify:* unit tests.
- [x] **T702** `engine.ts`: load, schedule and reschedule on change, with tz support.
  *Verify:* a job fires in a test with a short interval.
- [x] **T703** `run.ts`: fresh vs. session mode, `origin="scheduler"` wrapper, header, fallback post, status bookkeeping.
  *Verify:* AC1.
- [x] **T704** `describe.ts`: human-readable cron text and the next 3 runs.
  *Verify:* AC2.
- [x] **T705** `tools.ts`: `schedule_*` tools gated by `schedulerAllowed`, with narrowing-only `policyOverride`.
  *Verify:* AC3, AC6.
- [x] **T706** Catch-up on boot within `catchUpWindow`.
  *Verify:* AC4.
- [x] **T707** Failure notifications with Retry and Disable buttons, plus auto-disable after 3 failures.
  *Verify:* AC5.
- [x] **T708** `system.ts`: register the weekly memory consolidation (004) and skill pruning (006) jobs.
- [ ] **T709** Expose functions for the 008 `/cron` inline manager.
