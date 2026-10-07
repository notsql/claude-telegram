# 007 — Scheduled Jobs (Cron)

## Problem
A personal agent should act on its own schedule: morning briefings, reminders, recurring checks, and memory or skill maintenance. Our daemon is always on (001), so it can own the scheduling.

## User stories
- **US1**: "Every weekday at 8:30 send me a summary of my GitHub notifications." The agent creates the job on its own and confirms the schedule in plain words.
- **US2**: "Remind me tomorrow at 3pm to call the bank." A one-off job fires once and is then removed.
- **US3**: Job results arrive in the chat or topic where I created the job.
- **US4**: When a job fails, I'm told why and offered Retry or Disable buttons.
- **US5**: Fallback: `/cron` lists jobs with ⏸ / ▶ / 🗑 / ▶️ Run-now buttons.

## Functional requirements
- **FR1**: `jobs.json` in STATE_DIR: `{id, kind: 'cron'|'at', expr|at, tz, prompt, sessionKey, mode: 'fresh'|'session', policyOverride?, enabled, createdBy, createdAt, lastRun, lastStatus, nextRun, failures}`.
- **FR2**: The daemon schedules jobs with `croner`, using an explicit timezone (default: owner's tz from the user model, falling back to system tz).
- **FR3**: A run calls `runTurn()`, which spawns `claude -p` (001), under the **target session's policy** (003). `policyOverride` can only narrow permissions, never widen them. Approvals that a job needs go to the target chat as usual. If nobody answers before the timeout, the call is denied and the job is marked `needs_approval`.
- **FR4**: `mode: fresh` (default) runs in a new Claude Code session (no `--resume`), with memory injected by the `SessionStart` hook, so results don't clutter the chat's conversation. `mode: session` resumes the chat's session, which suits stateful follow-ups.
- **FR5**: Output: the agent uses `reply` to post to the target, and the run header shows "⏰ <job title>". If the agent produces no reply, the daemon posts its final text.
- **FR6**: Tools: `schedule_create({when, prompt, title?, mode?})` takes natural-language `when`, which the agent turns into cron or ISO form; the daemon validates it and echoes back a human-readable summary plus the next 3 run times. Also `schedule_list`, `schedule_update`, `schedule_delete` and `schedule_run_now`. All are gated by `schedulerAllowed`.
- **FR7**: Missed runs: on startup, a job whose `nextRun` is in the past by less than `catchUpWindow` (default 6h) runs once. Older missed runs are skipped and noted.
- **FR8**: Failure handling: after each failure the owner is notified with Retry and Disable buttons. After 3 consecutive failures the job is disabled automatically.
- **FR9**: Concurrency: jobs share 002's global semaphore. Two runs of the same job never overlap.
- **FR10**: System jobs, registered by the daemon and hidden from the agent's list unless asked for: weekly memory consolidation (004) and weekly skill pruning (006).
- **FR11**: Usage guard: each job runs with `--max-turns`, and jobs count toward the daily turn budget (001). When the subscription usage limit is hit, due jobs are deferred until the reset and not counted as failures.

## Non-goals
- Event triggers such as webhooks or file watchers (a possible future feature).
- Distributed or multi-machine scheduling.

## Acceptance criteria
- **AC1** (FR6): "remind me in 2 minutes to stretch" creates an `at` job, which posts in the same chat about 2 minutes later.
- **AC2** (FR2, FR6): "every weekday at 8:30" creates `30 8 * * 1-5` in the correct tz, and the confirmation lists the next 3 runs.
- **AC3** (FR3): A job created in a read-only group cannot use Bash, even when its prompt asks for it.
- **AC4** (FR7): With the daemon stopped across a scheduled time and restarted within the catch-up window, the job runs once.
- **AC5** (FR8): A job that always fails is disabled after 3 runs, and the owner is notified.
- **AC6** (FR6, 003): In a group with `schedulerAllowed: false`, the agent has no scheduling tools.

## Open questions
- Should jobs be able to post to a different chat than the one they were created in (for example, a DM-created job posting to a group topic)? (Proposal: allowed only from the owner DM, and only to chats the owner is allowlisted in.)
