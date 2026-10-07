# 006 — Tasks
Depends on: 004 (reflection worker, guard), 005 (similar-request lookup), 003 (autoLearn, tool registry)

- [x] **T601** `skills/paths.ts`: roots, name validation, discovery of installed skill names for collision checks.
  *Verify:* unit tests.
- [x] **T602** `skills/store.ts`: frontmatter IO, section patching, `.bak` versioning, undo.
  *Verify:* unit tests for create, patch, undo.
- [x] **T603** Extend the reflection schema and prompt with the skills section and trigger heuristics.
  *Verify:* the proposal JSON is logged for a 10-tool-call task.
- [x] **T604** `skills/apply.ts`: confidence threshold, patch-over-create matching, protection of non-hermes skills (diff proposal only), per-turn cap.
  *Verify:* AC1, AC4.
- [x] **T605** `autoLearn` modes and the propose UI (✅ / ✏️ / ✖).
  *Verify:* AC5.
- [x] **T606** Notices with Show and Undo.
  *Verify:* FR10.
- [x] **T607** `skills/tools.ts`: `skill_create/patch/list/read` registered with policy gating.
- [x] **T608** `skills/usage.ts`: `PostToolUse` hook handler (matcher `Skill`) records invocations, and reflection records outcomes.
  *Verify:* the counts increase.
- [x] **T609** Refinement trigger on repeated failures or corrections.
  *Verify:* AC3, AC6.
- [x] **T610** Archive pruning, registered as a weekly system job with 007.
- [ ] **T611** Emit `skills-changed` for the 008 menu refresh.
  *Verify:* AC2. (Event emitted; the menu half of AC2 waits on 008 T808.)
