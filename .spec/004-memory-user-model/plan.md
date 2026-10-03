# 004 — Plan

## Modules
```
src/memory/
  paths.ts       resolve global/chat/user roots from workspace cwd (Claude Code's project-dir sanitisation)
  store.ts       read/write/delete with frontmatter (gray-matter or tiny parser), index maintenance, version backup (.bak/<ts>)
  inject.ts      build the memory context block within a token budget → SessionStart/UserPromptSubmit hook handlers
  tools.ts       memory_* tools on the daemon MCP server, scope-checked against resolvePolicy(key)
  guard.ts       secret pattern rejection, size limits, name slugging
src/reflection/
  worker.ts      queue of {sessionKey, transcriptPath, fromOffset}; fed by Stop/PreCompact hooks; debounced; runs agent/oneshot.ts (claude -p --model haiku)
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
- **Model**: `claude -p --model haiku --output-format json` with tools disabled and no `--settings` hooks, so it doesn't trigger reflection on itself. The JSON is validated with zod, with one retry if it is malformed.
- **Output schema**:
  ```ts
  { memory: Array<{op:'create'|'update'|'delete', scope, type, name, description, body, reason}>,
    user_model: Array<{op, user_id, name, description, body, reason}>,
    skills: Array<...> /* 006 */ }
  ```
- **apply.ts**: enforces scope (policy), runs guard checks, deduplicates by name and by token overlap with existing descriptions (a simple Jaccard score over 0.6 means update instead of create), and handles `autoLearn` modes.
- The reflection prompt borrows from Hermes' "nudge" idea and from Claude Code's memory guidance: what to save, what not to save, and to prefer updating over adding.

## Injection
`inject.ts` builds:
```
<memory scope="global">…MEMORY.md index…</memory>
<memory scope="chat">…</memory>
<user_model user_id="…">…bodies of type:user files…</user_model>
```
This block is returned as `additionalContext` from the **`SessionStart`** hook, once per session (including resumes). The **`UserPromptSubmit`** hook adds a delta only when an index has changed since then (an mtime check) or when a new group participant speaks. This keeps the prompt prefix stable for caching. The append-system-prompt text stays static.

## Risks
- **Memory bloat or drift**: handled by the limits and the consolidation pass (a periodic job through 007: "consolidate memory" every week).
- **Reflection recursion or cost**: one-shots run without daemon hooks, and use Haiku with debounce and a daily cap.
- **Hook latency**: the `SessionStart` and `UserPromptSubmit` handlers must answer in under 200ms. Indexes are cached in memory and invalidated by fs watch.
- **Privacy in groups**: user-model files for group participants are only written when the group policy is `autoLearn != off`, and are stored under the chat root, not under the global `users/`.
