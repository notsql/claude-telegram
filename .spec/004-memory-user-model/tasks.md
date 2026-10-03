# 004 — Tasks
Depends on: 001, 002, 003 (policy scopes, tool registry)

- [ ] **T401** Spike, recorded in plan.md:
  - (a) Does `claude -p` in the workspace cwd load that project's auto-memory?
  - (b) Does `SessionStart`/`UserPromptSubmit` `additionalContext` reach the model in `-p` mode, including on `--resume`?
  - (c) Does the `Stop` hook input include `transcript_path`?
- [ ] **T402** `memory/paths.ts` + `store.ts` (frontmatter, index maintenance, `.bak` versions).
  *Verify:* unit tests for create, update, delete and index sync.
- [ ] **T403** `memory/guard.ts`: secret patterns, size limits, slugging.
  *Verify:* AC7.
- [ ] **T404** `memory/tools.ts` with scope enforcement from `resolvePolicy`.
  *Verify:* AC4.
- [ ] **T405** `memory/inject.ts` with a token budget and mtime caching, wired to the `SessionStart` and `UserPromptSubmit` hook handlers (under 200ms).
  *Verify:* AC2.
- [ ] **T406** Memory guidance in `TELEGRAM_INSTRUCTIONS` (when to save, curate and recall).
  *Verify:* AC1.
- [ ] **T407** `reflection/worker.ts`: fed by the `Stop` hook (debounced) and the `PreCompact` hook (immediate). Reads the transcript delta, runs `agent/oneshot.ts` (Haiku, no tools, no hooks), and validates the output with zod.
  *Verify:* a log shows proposals after a turn, and the one-shot does not trigger another reflection.
- [ ] **T408** `reflection/apply.ts`: dedup/merge, `autoLearn` modes, and propose buttons (✅ Save / ✖ Skip).
  *Verify:* AC5.
- [ ] **T409** Write notices with an Undo callback.
  *Verify:* AC6.
- [ ] **T410** User model: `users/<id>/` files, injected for the sender (and for group participants under the chat root).
  *Verify:* the agent addresses the user by their preferred name or style after one session.
- [ ] **T411** CLI bridge opt-in: (a) an `@import` line in `~/.claude/CLAUDE.md` and/or (b) the `SessionStart` memory hook in `~/.claude/settings.json`. Both need confirmation and are reversible.
  *Verify:* AC3.
- [ ] **T412** Expose functions for 008 (`/remember`, `/forget`, `/memory`).
