# 003 — Permissions & Per-Chat Policy

## Problem
A headless agent with shell and file access needs a human in the loop for risky tools. Different chats also need different trust levels: the owner's DM is not the same as a group with friends. Each chat (and topic) needs its own configurable restrictions, covering tools, model, working directory, and how much memory and history it can see.

## User stories
- **US1**: As the owner, when the agent wants to run a tool that is not pre-approved, I get Allow / Deny / Always / See-more buttons in the chat where the request came from.
- **US2**: As the owner, I tap "Always" once and that tool (or tool+pattern) no longer prompts in this chat.
- **US3**: As the owner, I configure a group topic so the agent can only read and search the web there, and can only search that topic's own history. Memory is shared across all chats; I can turn it off for a chat.
- **US4**: As the owner, I can view and edit a chat's policy from Telegram (`/policy`), or from the terminal (`/telegram:access`).
- **US5**: As a group member who is not an approver, I cannot approve tool calls.

## Functional requirements
- **FR1**: Approvals use two hooks (001 FR4). Claude Code's own rule engine does the matching, so we don't reimplement it.
  - **Rules first, natively**: the policy's `allowedTools`/`disallowedTools`/`alwaysAllow` and `permissionMode` are passed as CLI flags and settings permission rules, and Claude Code evaluates them.
  - **`PermissionRequest` hook**: fires only when Claude Code *would prompt* (no rule resolved the call). The daemon sends the Telegram buttons, waits, and returns `decision.behavior: allow | deny`. "Always" also returns `decision.updatedPermissions` (`addRules`, destination `session`). In `-p` mode with no other host, an unanswered request counts as a deny.
  - **`PreToolUse` hook**: used only for **hard scope enforcement** that rules can't express, for example a `memory_*` scope or `cwd` escape. Telegram tools may message any allowlisted chat, not just the session's own (owner decision 2026-10-07). It returns `permissionDecision: deny` with a reason, or nothing.
  
  Subagent permission prompts go through the same `PermissionRequest` hook (009).
- **FR2**: Prompt UI reuses the current keyboard (See more / ✅ Allow / ❌ Deny) and adds **♾ Always** (saved to the chat's `alwaysAllow`). The prompt names the tool and what the call is for: Bash's `description`, else its file path, URL, query or pattern. "See more" shows the Bash command (or the JSON input) in a code block (2026-10-07).
- **FR3**: The prompt goes to the **originating session target** (chat and topic). Only users in `policy.approvers` can answer (default: owner IDs from `allowFrom`). Taps from anyone else get an "not authorised" toast.
- **FR4**: If nobody answers within `approvalTimeoutSec` (default 60), the call is denied and the message is edited to "⌛ Expired". The `PermissionRequest` hook's `timeout` is generated as `approvalTimeoutSec` + 30s (the http hook default of 600s already allows this), so an expiry is a clean deny and never a hook error.
- **FR5**: The text fallback `yes xxxxx` / `no xxxxx` still works (reuse `PERMISSION_REPLY_RE`).
- **FR6**: A per-session-key policy is stored in `access.json` → `chats[key].policy`, resolved in this order: topic key → chat key → defaults for the chat type. Telegram-side writes (Always, `/policy`) go to the chat key, so all topics in a group share them; `alwaysAllow` rules from chat and topic add up. Topic-level overrides are set from the terminal skill.
- **FR7**: Policy fields:
  - `permissionMode`: `default | acceptEdits | plan | bypassPermissions`
  - `allowedTools[]`, `disallowedTools[]`: Claude Code permission-rule syntax, e.g. `Bash(git status:*)`. These are also passed as `--allowedTools`/`--disallowedTools`.
  - `alwaysAllow[]`: rules appended through the Always button
  - `model`, `cwd`, `maxTurns`
  - `agent`: run turns as this named subagent (009)
  - `teamsAllowed`: reserved for 010
  - `memoryScope`: `global | none` (004; memory is shared across chats, `none` turns it off)
  - `historyScope`: `all | chat | none` (005)
  - `autoLearn`: `off | propose | auto` (004/006)
  - `schedulerAllowed`: bool (007)
  - `approvers[]`
- **FR8**: Defaults by chat type:
  - Owner DM: `permissionMode: default`, broad tools, `memoryScope: global`, `historyScope: all`, `autoLearn: auto`.
  - Groups and topics: only the owner can trigger turns (FR12), shared memory (`memoryScope: global`), read-only tools pre-approved (`Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch` and the Telegram tools); anything else, and any file path outside the chat's cwd, asks an approver instead of being blocked, `historyScope: chat`, `autoLearn: propose`, `schedulerAllowed: false`.
- **FR9**: `bypassPermissions` can only be set from the terminal skill, never from Telegram.
- **FR10**: Every policy change and every approval decision is appended to `audit.log` (JSONL).
- **FR11**: Policy, memory and history scopes are enforced **in code** (tool filtering and query filters), not only through prompt instructions.
- **FR14**: **Reads never prompt** (owner decision 2026-10-07). Read-only calls are allowed by the hook without a prompt and audited as `auto`: Read, Glob, Grep, WebFetch, WebSearch; MCP tools whose names are reads (get, list, search, read, fetch…) with no write verb; and Bash commands where every part is a known reader (`ls`, `cat`, `git status`…) or has a read verb as its subcommand (`kubectl get`, `gh pr list`, `npm search`, `--help`). Splitting respects quotes and looks through `for`/`if` blocks and simple variables (`T=~/bin/tool; $T history`); `$(…)` is allowed when its command is read-only, and `python3 -c` when the code imports only safe modules (json, sys, re…) and touches no files, processes or other modules. Redirection, substitution, backgrounding or a write verb anywhere still prompts.
- **FR15**: **Allow lasts the session.** ✅ Allow adds the call's rule (as Always would derive it) for the rest of the chat's session, in memory, passed to later turns with `--allowedTools`; `/new` and `/resume` clear it. Always also persists it.
- **FR13**: **cwd allowlist.** `claude -p` runs a working directory's `.claude/settings.json` hooks and `.mcp.json` servers **without a trust prompt**. A chat `cwd` must therefore be in the owner-approved `trustedDirs` list, which can only be set from the terminal skill.
- **FR12**: **Owner-only on subscription.** Because auth is the owner's subscription (001 FR10), turns in groups are triggered only by owner IDs by default. Messages from other members can still feed the group context buffer (002 FR8), but they never start a model turn.
  - The owner can set `allowOthersOnSubscription: true` on a chat, from the terminal skill only. Doing so shows a terms warning and is recorded in `audit.log`.

## Non-goals
- Role hierarchies beyond owner and approvers.
- Policies that change over time (time-of-day rules).

## Acceptance criteria
- **AC1** (FR1–2): In the DM, "run `ls ~`" shows a prompt. Allow runs it and Deny returns a refusal to the model.
- **AC2** (FR2, FR6): After tapping Always on `Bash(ls:*)`, the next `ls` runs without a prompt in that chat, but still prompts in another chat.
- **AC3** (FR3): A non-approver group member taps Allow and nothing happens. A toast appears.
- **AC4** (FR4): An ignored prompt expires and the tool is denied.
- **AC5** (FR8, FR11): In a default group, a request to edit a file or read outside the chat's cwd shows an approval prompt and runs only if allowed, and `history_search` returns only that chat's history.
- **AC6** (FR9): Telegram `/policy` does not offer `bypassPermissions`.
- **AC7** (FR12): In a default group, a non-owner mentioning the bot gets no model turn. The text still appears in the context of the owner's next turn.

## Open questions
- Should "Always" store an exact command or a prefix pattern? (Proposal: the button stores the exact tool + command prefix such as `Bash(npm test:*)`, and "See more" offers a "broaden" option.)
