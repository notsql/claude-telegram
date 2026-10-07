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

## CLI spike findings (T901, CLI 2.1.292, 2026-10-07)
Run in a throwaway project with project-scope agents; nothing under `~/.claude` config was changed.

- **`claude -p --agent <name>`** works. `system/init` reflects the agent: `tools` is exactly the agent's `tools`, `model` is the agent's model (`haiku` → `claude-haiku-4-5-…`), and the body becomes the system prompt. `init.agents` lists all available agents (built-in + user + project), which `/agent` (T907) can use for its list. There is no field naming the active agent in `init`. Startup about 7 s.
- **`--json-schema` → `structured_output`** works with and without `--agent`, **but only if the `StructuredOutput` tool is available**. An agent with an explicit `tools:` list that omits it returns `subtype: success`, `structured_output: null` and free text (no error). An agent with no `tools:` field, or with `tools: StructuredOutput`, works. Decision: `tg-reflector` and `tg-summarizer` declare `tools: StructuredOutput` (spec FR1 table updated); learned agents that are used with `--json-schema` must include it too; zod stays as the null check. `num_turns` is 2 for a schema run.
- **Subagents in `-p` run in the background by default.** The `Agent` tool call returns "Async agent launched" at once (`system/task_started` with `is_backgrounded: true`, `subagent_type`, `tool_use_id`, `task_id`). The main turn emits a **first `result`** when it finishes; when the subagent completes, the session resumes and emits a **second `result`** with `origin.kind: "task-notification"`. The process exits after the last one. The runner must not treat the first `result` as the end of the turn: read until EOF and send the final assistant text (this is the AC4 "second message" path).
- **Stream events for progress**: `system/task_started`, `system/task_progress` (`description`, `last_tool_name`), `system/task_updated` (`patch.status` = `completed`/`killed`, `end_time`), `system/task_notification` (`status`, `output_file`), `system/background_tasks_changed` (current list). Subagent assistant/user messages carry `parent_tool_use_id` (the `Agent` tool_use id), plus `agent_id`, `subagent_type`, `task_description`. These are the best source for the "🔎 tg-researcher…" line. The `result` event has `subagent_stats.spawned`.
- **`--forward-subagent-text`**: subagent assistant text with `parent_tool_use_id` appeared in the stream both with and without the flag in this version. The runner passes it anyway (cheap, documented), but must not depend on it.
- **`SubagentStart` payload**: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `agent_id`, `agent_type`, `hook_event_name`. **`SubagentStop`** adds `permission_mode`, `stop_hook_active`, `agent_transcript_path` (`<session>/subagents/agent-<id>.jsonl`), `last_assistant_message`, `background_tasks`, `session_crons`. There is no duration or outcome field: `usage.ts` (T906) keys on `agent_id` and computes duration from Start→Stop. (Checked with command hooks; http hooks get the same JSON body.)
- **`memory: user`** writes to `~/.claude/agent-memory/<agent-name>/` (`MEMORY.md` index + one file per fact), also when the agent is the main session via `--agent`. `init.memory_paths` only lists the `auto` project memory, not the agent memory dir.
- **Background wait**: `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` is honoured: with 5000, a leftover background task was `killed` about 5 s after the final `result` and the process exited 0. Subagent-owned background Bash tasks appear as `task_started` with `owned_by_subagent` and `parent_task_id`. Standalone `sleep N` in Bash is blocked by the CLI, so a long-running wait could not be timed exactly; the 15-minute ceiling stays as planned.
- **`/skill-name args` in a `-p` prompt** expands: `/echo-args 123` with `arguments: [issue]` gave `$issue` = `123` and `$ARGUMENTS` = `123`. A slash command in the middle of a prompt (`please run /echo-args 123`) was also followed, by model invocation of the skill. AC6 is feasible by passing `/<skill> <args>` as the prompt.
