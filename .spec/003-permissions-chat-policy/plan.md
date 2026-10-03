# 003 — Plan

## Modules
```
src/policy/
  schema.ts      zod schema for ChatPolicy + defaults per chat type
  resolve.ts     resolvePolicy(key) → merged effective policy (topic → chat → type default)
  approvals.ts   PreToolUse hook handler (/hook/pre-tool-use), pending map, timeout, Always rule writer
  rules.ts       rule matching (Claude Code permission-rule "Tool(prefix:*)" syntax)
  args.ts        policy → CLI flags (--model --permission-mode --allowedTools --disallowedTools --max-turns), cwd
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

## PreToolUse approval flow
0. `hooks/pre-tool-use.ts` reads the hook's stdin JSON and POSTs it, with `TG_SESSION_KEY` and the bearer token, to `/hook/pre-tool-use`. The request stays open until the daemon decides. The script then prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny","permissionDecisionReason":"…"}}` (confirm the exact schema in 001 T003).
1. `resolvePolicy(key)`.
2. Check the rules (deny first, then allow and alwaysAllow).
3. Prompt: create a 5-letter `request_id` with the existing alphabet, store it in `pending` with a resolver and timer, and send the keyboard to the target.
4. The `callback_query:data` handler (moved from `server.ts`) checks `ctx.from.id ∈ approvers`, resolves the request, and edits the message to show the outcome.
5. Always: derive the rule from tool and input (Bash → first token(s); Edit/Write → path dir glob), add it to `alwaysAllow` through `saveAccess`, then allow.

The daemon's MCP tools (for example `memory_*` with a scope) read the policy of their bound session key directly. They do not ask the model to behave.

If the daemon is unreachable (crashed or restarting), the hook script exits with a deny. It fails closed (constitution IV).

## Tool filtering
- Pass `--allowedTools`/`--disallowedTools` to `claude -p` **and** check them in the `PreToolUse` hook. The CLI flags hide or allow tools up front, and the hook is the guarantee.
- The MCP server's `tools/list` response for a session leaves out Hermes tools whose policy `requires` flag is false, so the model never sees them.
- Hermes tools added later (004–007) register a `requires` flag (for example `schedulerAllowed`). The tool registry leaves them out when the flag is false.

## Terminal skill
Extend `skills/access/SKILL.md` with `policy <key> <field> <value>`, `policy show <key>` and `policy reset <key>`. `bypassPermissions` can only be set here.

## Risks
- **Prompt fatigue**: mitigated by sensible default `allowedTools` for the owner DM and by the Always button.
- **Race when several approvers tap**: the first tap wins, and later taps get "already decided".
- **Hook timeout too short**: the CLI would treat it as a hook error. Generate the settings template from `approvalTimeoutSec` so the two can't drift.
