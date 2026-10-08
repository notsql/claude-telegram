# 009 — Custom Subagents & Full Skill Usage

## Problem
A single generalist session does everything today: chat, research, reflection, curation and scheduled jobs. Claude Code has native **custom subagents** with their own context, model, tools, permission mode, preloaded skills, hooks and **persistent memory**. Skills can also run forked in a subagent, take arguments, pre-approve tools and inject live context. Using these features fully makes the agent cheaper (Haiku where it's enough), safer (narrow tools per role) and better at learning (per-role memory).

Agent teams would be the next step, but they can't run in `claude -p` (see [010](../010-agent-teams/spec.md)). Subagents are the parallelism primitive for now.

Docs checked 2026-10-03 against CLI 2.1.288: [sub-agents](https://code.claude.com/docs/en/sub-agents), [skills](https://code.claude.com/docs/en/skills), [headless](https://code.claude.com/docs/en/headless).

## User stories
- **US1**: "Research the best home NAS options under $500" is delegated automatically to a researcher subagent (web tools, own context). My chat gets a concise summary, not 40 tool calls.
- **US2**: The researcher remembers sources and preferences across sessions through its own agent memory.
- **US3**: My "Infra" forum topic always runs as an `infra-ops` agent with kubectl-only tools. My "Writing" topic runs as an editor agent on a different model.
- **US4**: Reflection, memory curation and skill authoring run as dedicated, narrowly scoped Haiku or Sonnet agents, not the main model.
- **US5**: When the learning loop notices a recurring *role* (for example "I keep asking it to triage GitHub issues the same way"), it proposes a new subagent, not only a skill.
- **US6**: Learned skills use the full skill format: arguments, pre-approved tools, forked execution and live context, so `/triage_issue 123` just works.
- **US7**: Every agent I have works the same way in my terminal `claude` (one brain).

## Functional requirements

### Shipped agents
- **FR1**: The daemon installs a set of **tg agents** into `~/.claude/agents/`, named with a `tg-` prefix and carrying `metadata`-style markers in the body header. On upgrade they are updated only if the user hasn't changed them (checksum).

  | Agent | Model | Tools | Memory | Role |
  |---|---|---|---|---|
  | `tg-reflector` | haiku | `StructuredOutput` only (T901) | — | Post-turn reflection for 004/006, run as `claude -p --agent tg-reflector --json-schema …` |
  | `tg-curator` | sonnet | Read, Glob, Grep, `mcp__tg__memory_*` | — | Weekly memory consolidation (004 FR8, through 007) |
  | `tg-skill-author` | sonnet | Read, Glob, Grep, `mcp__tg__skill_*`, `mcp__tg__agent_*` | `user` | Drafts and patches skills and agents (006, FR8) with preloaded `skill-authoring` guidance |
  | `tg-researcher` | sonnet | WebSearch, WebFetch, Read, Grep, Glob | `user` | Delegated research. Returns a summary with sources |
  | `tg-job-runner` | inherit | per job policy | — | Default agent for scheduled jobs (007). `maxTurns` bound |
  | `tg-summarizer` | haiku | `StructuredOutput` only | — | History summaries and session-rotation summaries (005) |

- **FR2**: Descriptions are short and trigger-oriented ("Use proactively when…"), stay within the combined description budget, and are tested with delegation evals (FR12).

### Per-chat main agent
- **FR3**: The chat policy (003) gains `agent?: string`. When it is set, turns run with `claude -p --agent <name>`, so that topic's whole session runs as that agent (system prompt, tools, model). The policy's tool limits still apply on top of the agent's own limits.
- **FR4**: `/settings` → 🤖 Agent (008 FR20, formerly `/agent`) lists the available agents and sets or clears the chat's agent (owner only). The agent can suggest switching but never switches by itself.

### Subagent use inside turns
- **FR5**: The main session may delegate to any installed subagent. This is native Claude Code behaviour. The daemon:
  - streams subagent progress into the progress message (using the `system/task_*` events and `parent_tool_use_id`; see the T901 findings in the plan)
  - logs each subagent's type and duration
  - counts subagent work toward the usage budget
- **FR6**: Background subagents are allowed. `claude -p` stays open until they finish, up to `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (set to 15 minutes for daemon turns). The chat gets the final result as a new message.
- **FR7**: The `SubagentStart` and `SubagentStop` http hooks (001) record agent activity, so 006 can track usage per agent (count, outcome) the same way it tracks skills.

### Learning loop extension (with 006)
- **FR8**: The reflection schema gains `agents: [{op: create|patch|none, name, description, tools, model, skills, memory, body, reason, confidence}]`. Creation needs **≥3 similar delegated or recurring tasks** (found through 005 history) and confidence ≥ 0.8.
- **FR9**: Guardrails for learned agents:
  - `permissionMode` can never be `bypassPermissions` or `auto`
  - `tools` must be listed explicitly (no inherit-all)
  - `Agent` is disallowed unless the owner allows it
  - `mcpServers` cannot be defined inline (only references to existing servers)
  - names use the `tg-` prefix
  - only agents whose metadata says `source: tg` can be patched
  - `autoLearn` modes from 003 apply, with group-originated proposals always set to `propose`

### Full skill usage (with 006)
- **FR10**: The SKILL.md template used by 006 includes, where relevant:
  - `arguments` / `argument-hint`, so Telegram args map to `$name`
  - `allowed-tools`: narrow pre-approval (never broader than the chat policy)
  - `context: fork` + `agent:` for heavy procedures, so they run in a subagent and keep the chat context clean
  - `` !`command` `` live-context blocks (read-only commands only, validated)
  - `paths`, so a skill activates only for relevant files
  - `disable-model-invocation: true` for side-effecting skills (deploys)
  - `user-invocable: false` for background knowledge
  - `model` / `effort` overrides
  - supporting files (`reference.md`, `scripts/`) for long material
- **FR11**: Agents preload the relevant skills through their `skills:` field (for example, the skill-author preloads `skill-authoring`, and the researcher preloads `research-method`). The daemon ships these guidance skills, also with the `tg-` prefix.
- **FR12**: Evaluation: when the `skill-creator` plugin is installed, the weekly maintenance job (007) runs its evals against tg skills and agents with enough usage, and feeds the results into refinement (006 FR8).

## Non-goals
- Agent teams (deferred to [010](../010-agent-teams/spec.md)).
- Plugin packaging of the tg agents (they live as plain user-scope files).

## Acceptance criteria
- **AC1** (FR1, FR5): A research question in the DM is delegated to `tg-researcher`, the progress message shows "🔎 tg-researcher…", and the reply is a summary with sources.
- **AC2** (FR1): The terminal `claude` lists the same tg agents in `/agents`.
- **AC3** (FR3): A topic with `agent: infra-ops` runs turns as that agent, and a Bash command outside its tools is denied.
- **AC4** (FR6): A background subagent task finishes after the main reply, and its result arrives as a second message.
- **AC5** (FR8, FR9): After 3 similar triage tasks, the loop proposes `tg-issue-triager` with explicit tools. A proposal containing `bypassPermissions` is rejected.
- **AC6** (FR10): A learned skill with `arguments: [issue]` invoked as `/triage_issue 123` from Telegram receives `123` as `$issue`.
- **AC7** (FR1): Reflection runs through `--agent tg-reflector --json-schema` and returns `structured_output` that passes zod.

## Open questions
- Should `tg-researcher` default to Sonnet or Haiku? (Proposal: Sonnet. Research quality matters, and it's invoked on demand only.)
- Should learned agents be allowed `memory: user`? (Proposal: yes. Memory is inspectable markdown under `~/.claude/agent-memory/<name>/`, and 004's guard rules apply when the curator reviews it.)
