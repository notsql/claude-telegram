# 004 — Plan

## Modules
```
src/memory/
  paths.ts       resolve the shared memory root and users/ from workspace cwd (Claude Code's project-dir sanitisation)
  store.ts       read/write/delete with frontmatter (gray-matter or tiny parser), index maintenance, version backup (.bak/<ts>)
  inject.ts      build the memory context block within a token budget → SessionStart/UserPromptSubmit hook handlers
  tools.ts       memory_* tools on the daemon MCP server, scope-checked against resolvePolicy(key)
  guard.ts       secret pattern rejection, size limits, name slugging
src/reflection/
  worker.ts      queue of {sessionKey, transcriptPath, fromOffset}; fed by Stop/PreCompact hooks; debounced; runs agent/oneshot.ts (--agent tg-reflector, 009)
  prompt.ts      reflection system prompt + JSON schema for proposals
  apply.ts       dedup/merge → apply or propose (inline keyboard), emits notices
```

## Memory file example
```markdown
---
name: prefers-pnpm
description: User uses pnpm, not npm, for JS projects
metadata:
  type: feedback
  source: telegram
  session_key: "123456789"
  user_id: "123456789"
  updated: 2026-10-03
---
Use pnpm for install/run/test. **Why:** user said npm is slow in their monorepo. **How to apply:** any JS package command.
```
The `source`, `session_key` and `user_id` fields are extensions. Claude Code ignores unknown metadata.

## Reflection worker
- **Trigger**: the `Stop` hook POSTs `{session_id, transcript_path}` plus `TG_SESSION_KEY`. The worker enqueues `{key, transcriptPath, fromOffset}`, where `fromOffset` is the byte offset reflected up to last time. Calls are debounced (30 seconds of quiet per key) so that a fast back-and-forth is reflected on once. `PreCompact` triggers an immediate, non-debounced pass so knowledge is saved before compaction drops it.
- **Input**: the turn delta parsed from the transcript JSONL (user and assistant text plus a summary of tool calls, capped at about 8k tokens, reusing 005's `parse.ts`), the relevant indexes, and the sender's user-model files.
- **Model**: `agent/oneshot.ts` runs `claude -p --agent tg-reflector --output-format json --json-schema <proposals schema> --settings '{"disableAllHooks":true}'` (009). `disableAllHooks` stops it from triggering reflection on itself. Claude Code enforces the schema and returns `structured_output`. zod re-validates it, with one retry on failure.
- **Output schema**:
  ```ts
  { memory: Array<{op:'create'|'update'|'delete', scope, type, name, description, body, reason}>,
    user_model: Array<{op, user_id, name, description, body, reason}>,
    skills: Array<...> /* 006 */,
    agents: Array<...> /* 009 */ }
  ```
- **apply.ts**: skips chats with `memoryScope: none`, runs guard checks, deduplicates by name and by token overlap with existing descriptions (a simple Jaccard score over 0.6 means update instead of create), and handles `autoLearn` modes.
- The reflection prompt follows Claude Code's memory guidance: what to save, what not to save, and to prefer updating over adding.

## Injection
`inject.ts` builds:
```
<memory>…shared MEMORY.md index…</memory>
<user_model user_id="…">…bodies of type:user files…</user_model>
```
This block is returned as `additionalContext` from the **`SessionStart`** hook, once per session (including resumes). The **`UserPromptSubmit`** hook adds a delta only when an index has changed since then (an mtime check) or when a new group participant speaks. This keeps the prompt prefix stable for caching. The append-system-prompt text stays static.

## Risks
- **Memory bloat or drift**: handled by the limits and the consolidation pass (a weekly 007 job run as `--agent tg-curator`, 009). The curator also reviews subagent memories in `~/.claude/agent-memory/tg-*/`.
- **Reflection recursion or cost**: one-shots run without daemon hooks, and use Haiku with debounce and a daily cap.
- **Hook latency**: the `SessionStart` and `UserPromptSubmit` handlers must answer in under 200ms. Indexes are cached in memory and invalidated by fs watch.
- **Privacy in groups**: memory is shared by design, so anything learned in a group is visible to the bot in every chat (owner decision 2026-10-07). User-model files for group participants are only written when the group policy is `autoLearn != off`; set `memoryScope: none` on a chat that should neither read nor add to memory.

## Spike results (T401, Claude Code 2.1.292, 2026-10-07)
- **(a) Yes.** `claude -p` in a cwd loads that project's auto-memory from `~/.claude/projects/<sanitised cwd>/memory/MEMORY.md` and the model can read the linked files. Sanitisation replaces every non-alphanumeric character of the real path (`pwd -P`) with `-`, so `/private/tmp/x.y` → `-private-tmp-x-y`.
- **(b) Yes**, for both `SessionStart` (command hook) and `UserPromptSubmit` `additionalContext`, on a fresh session and on `--resume`. `SessionStart` input has `source: "startup"` or `"resume"`. Context injected on earlier turns stays in the resumed transcript, so re-injecting the same block on every resume duplicates it: `inject.ts` should send the full block on `startup` only and, on `resume`, just the delta since the last injection (same mtime check as `UserPromptSubmit`).
- **(c) Yes.** `Stop` input includes `transcript_path` (the session JSONL), plus `session_id`, `cwd`, `last_assistant_message` and `stop_hook_active`.
