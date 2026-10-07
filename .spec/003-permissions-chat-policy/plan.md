# 003 — Plan

## Modules
```
src/policy/
  schema.ts      zod schema for ChatPolicy + defaults per chat type
  resolve.ts     resolvePolicy(key) → merged effective policy (topic → chat → type default)
  approvals.ts   PermissionRequest hook handler (/hook/permission-request): pending map, timeout, Telegram buttons, updatedPermissions for Always
  scope.ts       PreToolUse hook handler (/hook/pre-tool-use): hard scope denies only (memory scope, cwd escape)
  rules.ts       derive an "Always" rule from tool+input (Bash → command prefix "Bash(npm test *)"; Edit/Write → dir glob)
  args.ts        policy → CLI flags (--model --permission-mode --allowedTools --disallowedTools --max-turns --agent), cwd (trustedDirs check)
  audit.ts       append-only audit.log
src/telegram/policyUi.ts   /policy inline keyboard editor (owner only)
```

## `access.json` extension
```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["123456789"],
  "groups": { "-1001234567890": { "requireMention": true, "allowFrom": [] } },
  "chats": {
    "-1001234567890": { "policy": { "memoryScope": "chat", "historyScope": "chat" } },
    "-1001234567890:42": { "policy": { "allowedTools": ["Bash(kubectl get:*)"], "cwd": "~/infra", "autoLearn": "auto" } }
  }
}
```
- `groups` (gating: who can reach the bot) and `chats` (policy: what the bot can do) stay separate. The existing ACCESS.md semantics don't change.
- `readAccessFile()` gains a zod parse. Unknown fields are kept so newer and older versions can coexist.

## Approval flow (PermissionRequest http hook)
1. Claude Code evaluates its permission rules: the CLI flags from `args.ts` plus `alwaysAllow`, appended to `--allowedTools`. Calls that match are allowed or denied natively, and no hook fires.
2. For anything that would prompt, Claude Code POSTs the `PermissionRequest` payload (`tool_name`, `tool_input`, `tool_use_id`, `permission_rule`) to `/hook/permission-request?key=…`. The HTTP request stays open until a decision is made.
3. The daemon creates a 5-letter `request_id` with the existing alphabet, stores it in `pending` with a resolver and timer, and sends the keyboard to the session target.
4. The `callback_query:data` handler (moved from `server.ts`) checks `ctx.from.id ∈ approvers`, resolves the request, and edits the message to show the outcome.
5. The response body is `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow|deny"}}}`. Confirm the exact shape in 001 T003.
6. **Always**: the rules come from the payload's `permission_suggestions` (Claude Code's own suggestion, which includes e.g. the `Read(//dir/**)` a Bash command needs for a path outside the cwd); only when there are none does `rules.ts` derive the rule. The daemon persists them to `alwaysAllow` (so later turns get it through `--allowedTools`), and also returns `decision.updatedPermissions` (`addRules`, destination `session`) so the current session stops asking.

The daemon's MCP tools (for example `memory_*` with a scope) read the policy of their bound session key directly. They do not ask the model to behave.

If the daemon is unreachable, the http hook fails, the request goes unanswered, and `-p` denies it. The system fails closed (constitution IV). Confirm this in T003.

## Scope enforcement (PreToolUse http hook)
`scope.ts` handles only what permission rules can't express: a `reply`/`edit` to a chat other than the bound one, `memory_*`/`history_search` outside the policy scope (also enforced inside the tools themselves), and, in groups, file tools outside `cwd` + `trustedDirs` + the inbox (the owner DM is not path-scoped). That last check asks the approvers from inside the hook (no Always button) and returns `allow` or `deny`: a PreToolUse `ask` counts as a deny in `-p` and never reaches `PermissionRequest` (tested on 2.1.292). The PreToolUse hook `timeout` is therefore also `approvalTimeoutSec` + 30s. The memory/history checks land with the 004/005 tools. It returns `permissionDecision: "deny"` with a reason, or an empty object.

## Tool filtering
- Pass `--allowedTools`/`--disallowedTools` to `claude -p`, so Claude Code enforces them natively.
- The MCP server's `tools/list` response for a session leaves out Hermes tools whose policy `requires` flag is false, so the model never sees them.
- Hermes tools added later (004–007) register a `requires` flag (for example `schedulerAllowed`). The tool registry leaves them out when the flag is false.

## Terminal skill
Extend `skills/access/SKILL.md` with `policy <key> <field> <value>`, `policy show <key>` and `policy reset <key>`. `bypassPermissions` can only be set here.

## Risks
- **Prompt fatigue**: mitigated by sensible default `allowedTools` for the owner DM and by the Always button.
- **Race when several approvers tap**: the first tap wins, and later taps get "already decided".
- **Hook timeout too short**: the CLI would treat it as a hook error. Generate the settings template from `approvalTimeoutSec` so the two can't drift.
- **Untrusted cwd config**: `-p` runs a project's hooks and MCP servers without a trust prompt. This is handled by the `trustedDirs` allowlist (FR13).
