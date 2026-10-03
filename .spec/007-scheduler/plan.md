# 007 — Plan

## Modules
```
src/scheduler/
  store.ts      jobs.json atomic IO, zod schema
  engine.ts     croner instances keyed by job id; (re)load on store change; catch-up on boot
  run.ts        runJob(job) → runner.runTurn (claude -p) with fresh/session mode, header, fallback post, status update
  tools.ts      schedule_* tools on the daemon MCP server (gated by policy.schedulerAllowed)
  describe.ts   cron → human text + next N runs (croner's nextRuns)
  system.ts     built-in maintenance jobs (004 consolidation, 006 pruning)
```

## Job example
```json
{
  "id": "j_7f3k2",
  "kind": "cron",
  "expr": "30 8 * * 1-5",
  "tz": "Asia/Singapore",
  "title": "GitHub notifications briefing",
  "prompt": "Summarise my unread GitHub notifications, grouped by repo, max 10 bullets.",
  "sessionKey": "123456789",
  "mode": "fresh",
  "enabled": true,
  "createdBy": "123456789",
  "createdAt": 1759480000000,
  "lastRun": null, "lastStatus": null, "nextRun": 1759538400000, "failures": 0
}
```

## Run flow
1. Acquire the global semaphore and the per-job lock.
2. Run `resolvePolicy(sessionKey)` and narrow it with `policyOverride` (intersection only).
3. Call `runTurn(sessionKey, prompt, { mode, header: '⏰ ' + title, origin: 'scheduler' })`. The runner's inbound wrapper uses `origin="scheduler"` so the agent knows no human is waiting in real time.
4. Update `lastRun`, `lastStatus` and `nextRun`, and handle failures (notify, auto-disable).

## Natural-language time
The agent converts "every weekday at 8:30" into a cron expression or an ISO timestamp. The daemon validates it with croner and **echoes it back** in a human-readable form, so the user can catch a misreading. Relative times ("in 2 minutes", "tomorrow 3pm") are resolved by the agent using the `ts` from the inbound message and the user's tz from the user model.

## Risks
- **Timezone mistakes**: always store tz explicitly and show it in the confirmation.
- **Runaway cost**: `maxTurns` per job, the daily budget, and auto-disable after failures.
