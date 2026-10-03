# 003 — Permissions & Per-Chat Policy

## Problem
A headless agent with shell and file access needs a human in the loop for risky tools. Different chats also need different trust levels: the owner's DM is not the same as a group with friends. Each chat (and topic) needs its own configurable restrictions, covering tools, model, working directory, and how much memory and history it can see.

## User stories
- **US1**: As the owner, when the agent wants to run a tool that is not pre-approved, I get Allow / Deny / Always / See-more buttons in the chat where the request came from.
- **US2**: As the owner, I tap "Always" once and that tool (or tool+pattern) no longer prompts in this chat.
- **US3**: As the owner, I configure a group topic so the agent can only read and search the web there, can't see my personal memory, and can only search that topic's own history.
- **US4**: As the owner, I can view and edit a chat's policy from Telegram (`/policy`), or from the terminal (`/telegram:access`).
- **US5**: As a group member who is not an approver, I cannot approve tool calls.

## Functional requirements
- **FR1**: Every tool call passes through the daemon's **`PreToolUse` hook** (001 FR4). The hook script POSTs `{tool_name, tool_input, session_key}` to the daemon and returns `permissionDecision: allow | deny` with a reason. The daemon evaluates in this order:
  1. Policy `disallowedTools` → deny.
  2. Policy `allowedTools` or `alwaysAllow` matches → allow.
  3. `permissionMode` shortcut.
  4. Otherwise prompt in Telegram and wait.
  
  `-p` mode cannot ask interactively, so the hook always returns a final decision and never `ask`.
- **FR2**: Prompt UI reuses the current keyboard (See more / ✅ Allow / ❌ Deny) and adds **♾ Always (this chat)**. "See more" expands to show the input preview, as it does today.
- **FR3**: The prompt goes to the **originating session target** (chat and topic). Only users in `policy.approvers` can answer (default: owner IDs from `allowFrom`). Taps from anyone else get an "not authorised" toast.
- **FR4**: If nobody answers within `approvalTimeoutSec` (default 300), the call is denied and the message is edited to "⌛ Expired". The `PreToolUse` hook's `timeout` in the settings template must be at least `approvalTimeoutSec` + 10s, so an expiry is a clean deny and never a hook error.
- **FR5**: The text fallback `yes xxxxx` / `no xxxxx` still works (reuse `PERMISSION_REPLY_RE`).
- **FR6**: A per-session-key policy is stored in `access.json` → `chats[key].policy`, resolved in this order: topic key → chat key → defaults for the chat type.
- **FR7**: Policy fields:
  - `permissionMode`: `default | acceptEdits | plan | bypassPermissions`
  - `allowedTools[]`, `disallowedTools[]`: Claude Code permission-rule syntax, e.g. `Bash(git status:*)`. These are also passed as `--allowedTools`/`--disallowedTools`.
  - `alwaysAllow[]`: rules appended through the Always button
  - `model`, `cwd`, `maxTurns`
  - `memoryScope`: `global | chat | none` (004)
  - `historyScope`: `all | chat | none` (005)
  - `autoLearn`: `off | propose | auto` (004/006)
  - `schedulerAllowed`: bool (007)
  - `approvers[]`
- **FR8**: Defaults by chat type:
  - Owner DM: `permissionMode: default`, broad tools, `memoryScope: global`, `historyScope: all`, `autoLearn: auto`.
  - Groups and topics: only the owner can trigger turns (FR12), read-only tools (`Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch` and the Telegram tools), `memoryScope: chat`, `historyScope: chat`, `autoLearn: propose`, `schedulerAllowed: false`.
- **FR9**: `bypassPermissions` can only be set from the terminal skill, never from Telegram.
- **FR10**: Every policy change and every approval decision is appended to `audit.log` (JSONL).
- **FR11**: Policy, memory and history scopes are enforced **in code** (tool filtering and query filters), not only through prompt instructions.
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
- **AC5** (FR8, FR11): In a default group, a request to edit a file is denied without a prompt, and `memory_search` returns no global or owner memories.
- **AC6** (FR9): Telegram `/policy` does not offer `bypassPermissions`.
- **AC7** (FR12): In a default group, a non-owner mentioning the bot gets no model turn. The text still appears in the context of the owner's next turn.

## Open questions
- Should "Always" store an exact command or a prefix pattern? (Proposal: the button stores the exact tool + command prefix such as `Bash(npm test:*)`, and "See more" offers a "broaden" option.)
