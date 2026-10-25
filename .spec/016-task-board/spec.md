# 016 — Task Board & Background Work

## Problem
Every piece of work is one chat turn today. A long job ("build me a sales forecast from Stripe", "research three venues and compare them") holds up that chat's queue and stops at `--max-turns`. If it needs a decision halfway, the question is lost in scrollback. Nothing lists what the agent is working on or what it is waiting on from me. A personal agent should take a job, keep working on it when I walk away, report back only when it finishes or needs me, and keep a running list I can check at any time.

## User stories
- **US1**: "Put together a forecast for next quarter from Stripe." The agent answers at once: "🗂 On it: *Q1 sales forecast*". The chat stays free. Twenty minutes later a **new** message arrives: "✅ Q1 sales forecast is ready for review" with the result.
- **US2**: Halfway through, the agent needs a choice. A message arrives: "❓ *Venue research* needs you: budget per head, $40 or $60?" I reply in that message's thread, and the task carries on.
- **US3**: "What are you working on?", or the pinned 🗂 Tasks message, shows each task with its state: 🔄 working, ❓ needs you, ⏳ waiting on someone, 👀 ready for review.
- **US4**: Only I close a task. A task that is ready for review stays on the board until I tap **✅ Done**, or ask for changes with **✏️ Change**.
- **US5**: The daemon restarts in the middle of a task. The task picks up where it stopped, and I get no duplicate messages.

## Functional requirements
- **FR1 — Task store.** `STATE_DIR/tasks.json`, human-readable (constitution V). Each task is `{id, title, brief, chat, thread?, state, sessionId?, effort, needs?, notes[], createdAt, updatedAt, attempts}`. `state` is one of `working | needs_you | waiting | review | done | dropped`.
- **FR2 — Tools.** These are on the daemon MCP server and owner-only, so they work in DMs, groups and topics alike:
  - `task_start({title, brief, effort})` hands the work to a background run, then the current turn ends with a short acknowledgement. The system prompt tells the agent to use it whenever a request will take more than a few minutes or many tool calls.
  - `task_update({id, state, note?, needs?})` is called from inside the task run. `needs_you` takes a question; `review` takes a summary of what was produced.
  - `task_list({state?})` answers US3.
  - The agent can't set `done`. Only the owner's button does (FR5).
- **FR3 — Background run.** A task runs as its own session with key `task:<id>`, on its own queue, so the origin chat stays free. It goes through the same `runTurn` path as 007 jobs, with the origin chat's policy (003) and approvals posted to the origin chat. Its system prompt carries the brief and the rule to report through `task_update`. Turn limits are per effort level: `quick` gets the chat default, and `deep` gets `TELEGRAM_TASK_MAX_TURNS` (default 200) and resumes for up to 3 segments.
- **FR4 — Effort.** The agent picks `effort` (`quick` | `deep`). `deep` runs on the owner's default model, and `quick` runs on Sonnet. Both count against `dailyTurnBudget` and pause on a plan limit (001 FR10). A task paused on a limit is shown as ⏳ with the reset time.
- **FR5 — Reporting.** State changes post a **new** message in the origin chat or topic, with `message_thread_id` respected (constitution VI):
  - `needs_you` comes with the question. A reply to that message is routed into the task session as the next turn, not into the chat session.
  - `review` comes with **✅ Done** / **✏️ Change** / **🗑 Drop**. Change asks for what to change as a reply and resumes the task.
  - `working` updates edit the board (FR6) and never ping.
- **FR6 — Board.** One 🗂 Tasks message is kept pinned in the owner DM and edited in place on every change. It lists open tasks grouped by state, with the newest first. ⚙️ Settings → 🗂 Tasks shows the same list, with a page per task that offers ⏸ Pause, ▶ Resume, 🗑 Drop and the last notes.
- **FR7 — Recovery.** On start, every `working` task whose process is gone is resumed with `--resume <sessionId>` and the prompt "the daemon restarted; continue from your last step". `attempts` is capped at 3. After that the task goes to `needs_you` with the last error.
- **FR8 — Digest.** The 013 digest gets a 🗂 line: tasks in `needs_you` or `review`, and those held up by a plan limit.
- **FR9 — Flag.** Ships behind `TELEGRAM_TASKS=1`.

## Non-goals
- Running several tasks for one request in parallel (agent teams, 010).
- Tasks for anyone but the owner.
- A separate app or web view. The board is Telegram-native.

## Acceptance criteria
- **AC1** (FR2, FR3): A long request in the DM returns "🗂 On it" within one turn. A second message sent during the task gets a normal reply right away.
- **AC2** (FR5): A task that calls `task_update(needs_you)` posts a question. Replying to it resumes the task in the task's own session, and the chat session doesn't see that reply.
- **AC3** (FR2, FR5): Calling `task_update({state: 'done'})` is refused. Tapping ✅ Done closes the task and removes it from the board.
- **AC4** (FR6): The pinned board is one message, edited in place, with no new pin per change.
- **AC5** (FR7): Killing the daemon mid-task and starting it again resumes the task once, and `attempts` goes up by one.
- **AC6** (FR3): The same flow works from a forum topic: updates arrive in that topic.
- **AC7** (FR9): Without the flag, `task_*` tools aren't registered and no board is pinned.
