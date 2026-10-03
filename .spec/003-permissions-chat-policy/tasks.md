# 003 — Tasks
Depends on: 001 (hook endpoint T006, MCP server T005), 002 (session keys)

- [ ] **T301** `policy/schema.ts` and defaults per chat type. Extend `readAccessFile` with tolerant zod parsing.
  *Verify:* an existing `access.json` loads without changes.
- [ ] **T302** `policy/resolve.ts` with a topic → chat → default merge.
  *Verify:* unit tests.
- [ ] **T303** `policy/rules.ts`: derive "Always" rules (command prefix with ` *`, dir globs).
  *Verify:* unit tests for `Bash(npm test *)`, `Edit(~/proj/**)` and bare `WebSearch`.
- [ ] **T304** `approvals.ts`: `PermissionRequest` http hook handler, a long-held request until decision, pending map, timeout, deny-on-expiry, `applyRule` for Always.
  *Verify:* AC1, AC4, and killing the daemon mid-turn makes the tool call deny.
- [ ] **T313** `scope.ts`: `PreToolUse` hard-scope denies (reply target, memory/history scope, cwd escape) and the `trustedDirs` check in `args.ts` (FR13).
  *Verify:* AC5, and a chat `cwd` outside `trustedDirs` is refused when the policy is saved.
- [ ] **T305** Move the `callback_query:data` handler. Add an approvers check and the Always button.
  *Verify:* AC2, AC3.
- [ ] **T306** Keep the `yes xxxxx` text fallback working through the same resolver.
  *Verify:* manual test.
- [ ] **T307** `policy/args.ts`: map the policy to `claude -p` flags (`--model`, `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--max-turns`, `--agent`), render `alwaysAllow` into the per-turn settings, and set `cwd`. Generate the `PermissionRequest` hook `timeout` from `approvalTimeoutSec`.
  *Verify:* AC5 (tool part).
- [ ] **T308** MCP `tools/list` filtered by policy `requires` flags. This is groundwork for 004–007.
- [ ] **T309** `/policy` inline editor in Telegram (owner only, no bypass option).
  *Verify:* AC6.
- [ ] **T310** Extend the `/telegram:access` skill with policy subcommands and update ACCESS.md.
- [ ] **T311** `audit.log` for policy changes and approval decisions.
  *Verify:* entries appear with key, user, tool and decision.
- [ ] **T312** Owner-only turn trigger in groups (FR12): non-owner messages go to the group context buffer only. Add `allowOthersOnSubscription`, settable from the terminal skill only, with a warning and an audit entry.
  *Verify:* AC7.
