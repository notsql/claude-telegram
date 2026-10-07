# 009 — Tasks
Depends on: 001 (runner, http hooks), 003 (policy), 004/006 (reflection, skill store). The shipped agents can land in P2. Learned agents land with 006 (P4).

- [x] **T901** Spike against the installed CLI:
  - `claude -p --agent <name>`
  - `--json-schema` → `structured_output`
  - `--forward-subagent-text` and `parent_tool_use_id` in stream-json
  - `SubagentStart`/`SubagentStop` http hook payloads
  - `memory: user` path
  - background subagent wait behaviour in `-p`
  - `/skill-name args` expansion in a `-p` prompt
  Findings recorded in plan.md (CLI spike findings).
- [ ] **T902** Write the shipped agents (`assets/agents/tg-*.md`) and guidance skills (`assets/skills/tg-*`).
  *Verify:* `claude plugin validate ~/.claude/agents/` passes after install.
- [ ] **T903** `agents/install.ts`: checksum-aware install and upgrade.
  *Verify:* AC2, and a user-edited agent is not overwritten.
- [ ] **T904** Switch `oneshot.ts` to `--agent tg-reflector` / `tg-summarizer` + `--json-schema` + `disableAllHooks`.
  *Verify:* AC7, with no hook events during one-shots.
- [ ] **T905** Runner: `--agent` from policy, subagent progress lines, `--forward-subagent-text`, background wait ceiling env.
  *Verify:* AC1, AC3, AC4.
- [ ] **T906** `agents/usage.ts`: SubagentStart/Stop hook handlers, `agents-usage.json`.
  *Verify:* counts per agent increase.
- [ ] **T907** Policy `agent` field, its validation, and the `/agent` command (008).
  *Verify:* AC3.
- [ ] **T908** `agents/validate.ts` guardrails and `agents/tools.ts` (skill-author only).
  *Verify:* the AC5 rejection case.
- [ ] **T909** Extend the reflection schema and apply with the `agents` section and the 005-backed recurrence check.
  *Verify:* AC5.
- [ ] **T910** Upgrade the 006 SKILL.md template and validator for the FR10 fields, including validation of `!` commands against a read-only allowlist.
  *Verify:* AC6.
- [ ] **T911** Weekly maintenance (007): curator pass over agent memory, archive unused agents, skill-creator evals if installed.
