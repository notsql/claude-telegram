# 006 — Self-Authored Skills (Learning Loop)

## Problem
Today, procedures the agent works out ("how to deploy the blog", "how to file my expense report") are lost when the session ends. Hermes closes the loop: after solving something it extracts a reusable **skill**, loads it the next time a similar task comes up, and refines it as it is used. Claude Code already has native skills (`SKILL.md`). We need the agent to write and maintain them by itself.

## User stories
- **US1**: After the agent takes 15 tool calls to deploy my blog, it says "📘 Learned skill *deploy-blog*". Next time, "deploy the blog" is done in 3 steps.
- **US2**: When a skill fails or I correct the agent mid-run, it patches that skill afterwards.
- **US3**: New skills show up in Telegram's `/` menu automatically (008), and in my terminal Claude Code.
- **US4**: In groups, the agent proposes skills rather than saving them silently, and an approver confirms.
- **US5**: Fallback: `/skills` lists learned skills with usage stats, and `/skills rm <name>` or `/skills show <name>` manage them.

## Functional requirements
- **FR1**: Skills are written to `~/.claude/skills/<name>/SKILL.md` (user level), or `<chat cwd>/.claude/skills/` when the chat policy sets `skillScope: project`. Frontmatter: `name`, `description`, plus `metadata: {source: hermes, created_from: <session_id>, session_key, version, created, updated}`.
- **FR2**: The reflection worker (004) also gets the 006 proposal section. Trigger heuristics:
  - the turn had ≥ N tool calls (default 5), or
  - the user corrected the approach, or
  - the task was a repeat (005 search finds similar past requests), or
  - the agent explicitly flagged "this is reusable".
- **FR3**: Proposals are `create`, or `patch` an existing skill (matched by name or description similarity). Patch is preferred over create. A patch edits sections; it does not rewrite the whole file.
- **FR4**: Skill content is a procedure: when to use it, prerequisites, steps, commands, pitfalls and verification. It never contains secrets (004 guard) or chat-specific personal data.
- **FR5**: Guardrails:
  - Never overwrite a skill without `metadata.source = hermes`. Skills authored by the user or by plugins can only receive proposals, shown as a diff, which the owner approves.
  - Names must match `[a-z0-9-]{1,48}` and must not collide with built-in or plugin skills.
  - At most 1 skill write per turn.
- **FR6**: The `autoLearn` policy (003) applies: `auto` writes and notifies, `propose` sends a preview with ✅ Save / ✏️ Edit / ✖ Skip, and `off` disables skill learning.
- **FR7**: Usage tracking: when a hermes skill is invoked (detected by a **`PostToolUse` hook** with matcher `Skill`), record `{count, last_used, outcomes}` in `skills-usage.json`. The outcome is inferred by the reflection pass (success, corrected or failed).
- **FR8**: Refinement and pruning: when a skill has more than 2 failed or corrected outcomes, a refinement proposal is triggered. A weekly maintenance job (007) proposes archiving skills unused for 60 days by moving them to `~/.claude/skills/.archive/`.
- **FR9**: Tools: `skill_create`, `skill_patch`, `skill_list` and `skill_read`. The agent can also create skills directly in the middle of a turn when it is confident.
- **FR10**: Every write emits a notice with a **Show** button (renders the SKILL.md) and an **Undo** button (restores the previous version from `.bak`).

## Non-goals
- Skills that bundle scripts or binaries in v1 (SKILL.md only, though markdown may contain shell snippets).
- Sharing or publishing skills to a marketplace.

## Acceptance criteria
- **AC1** (FR2, FR3): A multi-step task in the DM produces `~/.claude/skills/<name>/SKILL.md` with `source: hermes`, and a notice appears.
- **AC2** (FR1, 008): The new skill appears in the bot's `/` menu within 1 minute, and in `claude` CLI `/skills`.
- **AC3** (FR3): Correcting the agent while it uses that skill leads to a patch (version +1). No second skill is created.
- **AC4** (FR5): A user-authored skill is never modified without a diff approval.
- **AC5** (FR6): In a default group, a skill is proposed with buttons and nothing is written until it is approved.
- **AC6** (FR7, FR8): Forcing 3 failures triggers a refinement proposal.

## Open questions
- Should learned skills default to user level (shared everywhere) or project level? (Proposal: user level for the owner DM, and project level when a chat has a custom `cwd`.)
