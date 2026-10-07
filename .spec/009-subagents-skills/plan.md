# 009 — Plan

## Modules
```
assets/agents/            shipped agent definitions (tg-*.md)
assets/skills/            shipped guidance skills (tg-skill-authoring, tg-research-method, …)
src/agents/
  install.ts      copy assets → ~/.claude/agents|skills; checksum to detect user edits; never overwrite edited files
  store.ts        read/write agent .md (frontmatter), .bak versioning, section patch (shared helpers with skills/store.ts)
  validate.ts     guardrails FR9 (tools explicit, no bypass/auto, no inline mcpServers, prefix, Agent tool gated)
  tools.ts        agent_list / agent_read / agent_create / agent_patch MCP tools (policy-gated, skill-author only)
  usage.ts        SubagentStart/SubagentStop http-hook handlers → agents-usage.json
src/agent/runner.ts       + `--agent <policy.agent>`; parent_tool_use_id → progress lines; --forward-subagent-text
src/reflection/           schema + apply extended with `agents` section
```

## Example shipped agent
```markdown
---
name: tg-researcher
description: Web research specialist. Use proactively when the user asks to research, compare, or find sources; returns a concise summary with links.
tools: WebSearch, WebFetch, Read, Grep, Glob
model: sonnet
memory: user
skills:
  - tg-research-method
maxTurns: 30
---
<!-- source: tg · version: 1 -->
You research questions on the web and return a short, sourced answer…
Check your memory for the user's preferred sources and past findings; update it with durable findings.
```
Agent frontmatter has no `metadata` field, so the tg markers live in an HTML comment on the first body line. `install.ts` and `store.ts` parse that comment.

## One-shots as agents
`agent/oneshot.ts` (001) becomes:
```
claude -p "<input>" --agent tg-reflector --output-format json --json-schema '<schema>' --settings '{"disableAllHooks": true}'
```
`disableAllHooks` stops the reflection run from triggering the daemon's own hooks (no recursion), and `--json-schema` gives schema-enforced `structured_output`. zod remains a second check.

## Policy integration (003)
- `ChatPolicy.agent?: string` must name an installed agent, which is checked when the policy is saved.
- Effective tools are the agent's `tools` ∩ the policy's allowed tools, minus the policy's `disallowedTools`. The daemon passes the policy's restrictions as CLI flags as before, and Claude Code applies the agent's own limits.

## Learned agents vs. learned skills
| Signal | Produce |
|---|---|
| A repeatable *procedure* (steps) | skill (006) |
| A repeatable procedure that needs isolation or heavy tool use | skill with `context: fork` + `agent:` |
| A recurring *role* with its own judgement, tools, model or memory | subagent (009 FR8) |

The reflector prompt includes this table.

## Risks
- **Description budget**: too many agents dilute delegation. Cap tg agents at 12 and have the curator propose archiving unused ones (to `~/.claude/agents/.archive/`).
- **Background subagents keeping `-p` open**: capped by `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`. The progress UX shows "background work running".
- **Agent memory growth**: the curator also reviews `~/.claude/agent-memory/tg-*/` weekly.
- **Subagent permission prompts**: these surface through the same `PermissionRequest` hook (003), so Telegram approvals work unchanged.
