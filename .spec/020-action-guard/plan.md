# 020 — Plan

## Modules
```
policy/consequential.ts   classify(toolName, input) → {class, summary} | 'off_limits' | undefined
policy/actionConfirm.ts   action_confirm MCP tool → posts the card, awaits the tap (fail closed)
telegram/handlers/actions.ts   Show / confirm / cancel callbacks; ⚙️ Settings → 🛡 Actions
```

## Order in PreToolUse
```
scope limits (003) ─► consequential.classify ─┬─ off_limits → deny + reason
                                              ├─ class     → card, ignore Always/policy → allow|deny
                                              └─ none      → existing 003 flow
```

## Reuse
- The 003 approval card, the timeout and the audit log (`policy/approvals.ts`, `policy/audit.ts`).
- The `readOnly.ts` Bash parser for verb detection.
- The 013 send path already requires a tap. It is tagged `send` so it shows in the audit.

## Risks
- **Card fatigue**: only four classes, and read-only calls and work-dir writes are exempt.
- **Browser blind spot**: the guard depends on the agent declaring browser actions. This is mitigated by the system prompt rule, by 015's browser being owner-signed-in only, and by the audit log.
