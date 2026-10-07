# 003 — Tasks
Depends on: 001 (hook endpoint T006, MCP server T005), 002 (session keys)

- [x] **T301** `policy/schema.ts` and defaults per chat type. Extend `readAccessFile` with tolerant zod parsing.
  *Verify:* an existing `access.json` loads without changes.
- [x] **T302** `policy/resolve.ts` with a topic → chat → default merge.
  *Verify:* unit tests.
- [x] **T303** `policy/rules.ts`: derive "Always" rules (command prefix with ` *`, dir globs).
  *Verify:* unit tests for `Bash(npm test *)`, `Edit(~/proj/**)` and bare `WebSearch`.
- [x] **T304** `approvals.ts`: `PermissionRequest` http hook handler, a long-held request until decision, pending map, timeout, deny-on-expiry, `updatedPermissions` for Always.
  *Verify:* AC1, AC4, and killing the daemon mid-turn makes the tool call deny.
- [x] **T313** `scope.ts`: `PreToolUse` hard-scope denies (reply target, memory/history scope, cwd escape) and the `trustedDirs` check in `args.ts` (FR13).
  *Verify:* AC5, and a chat `cwd` outside `trustedDirs` is refused when the policy is saved.
- [x] **T305** Move the `callback_query:data` handler. Add an approvers check and the Always button.
  *Verify:* AC2, AC3.
- [x] ~~**T306** Keep the `yes xxxxx` text fallback working through the same resolver.~~ Dropped 2026-10-07: buttons are enough.
  *Verify:* manual test.
- [x] **T307** `policy/args.ts`: map the policy to `claude -p` flags (`--model`, `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--max-turns`, `--agent`), render `alwaysAllow` into `--allowedTools` (same rule syntax as settings `permissions.allow`), and set `cwd`. Generate the `PermissionRequest` hook `timeout` from `approvalTimeoutSec`.
  *Verify:* AC5 (tool part).
- [x] **T308** MCP `tools/list` filtered by policy `requires` flags. This is groundwork for 004–007.
- [x] **T309** `/policy` inline editor in Telegram (owner only, no bypass option).
  *Verify:* AC6.
- [x] **T310** Extend the `/telegram:access` skill with policy subcommands and update ACCESS.md.
- [x] **T311** `audit.log` for policy changes and approval decisions.
  *Verify:* entries appear with key, user, tool and decision.
- [x] **T312** Owner-only turn trigger in groups (FR12): non-owner messages go to the group context buffer only. Add `allowOthersOnSubscription`, settable from the terminal skill only, with a warning and an audit entry.
  *Verify:* AC7.
- [x] **T313** Read-only calls skip the prompt (FR14); the prompt shows the call's description and See more a code block (FR2); Allow lasts the session and the button reads "Always" (FR15).
  *Verify:* `test/readOnly.test.ts` and `test/approvals.test.ts` pass.
