# 006 — Plan

## Modules
```
src/skills/
  paths.ts      user/project skill roots, archive dir, name validation, collision check (scan installed plugin skills)
  store.ts      read/write SKILL.md with frontmatter, .bak versioning, section-level patch
  tools.ts      skill_* tools on the daemon MCP server (policy-gated)
  usage.ts      skills-usage.json; PostToolUse hook handler (matcher "Skill") records invocations
  apply.ts      consumes reflection proposals.skills → validate → apply/propose
  template.md   canonical SKILL.md skeleton
```
This reuses `reflection/worker.ts` from 004. 006 only adds a schema section and an apply handler.

## SKILL.md template
```markdown
---
name: deploy-blog
description: Build and deploy the personal Astro blog to Cloudflare Pages. Use when asked to publish/deploy the blog.
metadata:
  source: tg
  version: 1
  created_from: <claude_session_id>
  session_key: "123456789"
  created: 2026-10-03
  updated: 2026-10-03
---
## When to use
## Prerequisites
## Steps
## Pitfalls
## Verify
```
Optional frontmatter, filled when relevant (validated, 009 FR10):
```yaml
arguments: [env]                 # Telegram "/deploy_blog staging" → $env
argument-hint: "[staging|prod]"
allowed-tools: Bash(pnpm build *) Bash(wrangler pages deploy *)   # never broader than the chat policy
disable-model-invocation: true   # side-effecting → explicit invocation only
context: fork                    # heavy procedure → run in a subagent
agent: general-purpose
paths: ["blog/**"]
```
The live-context `` !`cmd` `` lines are limited to a read-only allowlist (`git status`, `git log`, `gh pr view`, …).
The `description` field is what Claude Code uses to decide when to load the skill. The reflection prompt has to optimise it for trigger accuracy, with concrete "Use when…" phrasing.

## Reflection prompt additions
- The input includes the turn's tool-call trace (names and arg previews), user corrections, and the existing learned skills (name and description only, so the token cost stays low).
- The model is asked: "Is there a reusable procedure here that isn't already covered? If it is covered, what is wrong or missing in the existing skill?"
- Output: `skills: [{op:'create'|'patch'|'none', name, description, sections:{...}, reason, confidence}]`. Only proposals with confidence ≥ 0.7 are acted on.

## Patch semantics
A patch replaces named sections (`## Steps`, and so on). Before writing, the previous file is saved to `<skill>/.bak/<version>.md`, `version` is incremented, and `updated` is set. Undo restores the last `.bak`.

## Integration with 008
After any write or archive, emit a `skills-changed` event. The command menu (008) debounces it and calls `setMyCommands`.

## Risks
- **Skill sprawl**: handled by the per-turn cap, the confidence threshold, patch-over-create, and archive pruning.
- **Bad skills reinforcing bad behaviour**: outcome tracking drives refinement, and the owner can always `/skills rm`.
- **Overlap with plugin skills**: the collision check runs against every discovered skill name.
