# 012 — Plan

## Modules
```
capabilities/
  ledger.ts      capabilities.json atomic IO, zod schema, lookup by kind:name, skip-until
  templates.ts   installer templates: name patterns, argv builders, matching uninstall argv
  install.ts     runs a template argv (no shell) with a timeout; captures output for the card
  request.ts     capability_request → card in owner DM, approval state, timeout → skip
  resume.ts      after install (+ auth Done) start the follow-up turn in the origin session
  tools.ts       capability_request, capability_list, capability_forget on the daemon MCP server
  gap.ts         PostToolUse(Bash) detector for exit 127 / "command not found"
assets/agents/tg-capability-scout.md
assets/skills/tg-capability-ladder/SKILL.md
```

## Flow
```
turn ── can't do X ──► tg-capability-ladder (skill)
   rung 1: which/ls PATH, ToolSearch, capability_list ── found ─► use it
   rung 2/3: Agent(tg-capability-scout) → candidate cards
           └► capability_request(card, reason, resume) ──► turn ends "waiting"
daemon: card in owner DM [Install][Details][Skip]
   Install ─► templates.validate → install.ts → ledger(installed)
           ─► auth needed? send command/URL, wait [Done]
           ─► resume.ts: runTurn(originKey, "capability ready; continue: <resume>")
   rung 4: WebFetch / mcp__safari-mcp__* inside the same turn (no install)
```

## Templates
| id | install argv | uninstall argv | name pattern |
|---|---|---|---|
| brew | `brew install <n>` | `brew uninstall <n>` | `^[a-z0-9@+._/-]{1,80}$` (tap/name allowed) |
| brew-cask | `brew install --cask <n>` | `brew uninstall --cask <n>` | same |
| npm | `npm i -g <n>` | `npm rm -g <n>` | npm package name regex |
| uv | `uv tool install <n>` | `uv tool uninstall <n>` | PEP 508 name |
| pipx | `pipx install <n>` | `pipx uninstall <n>` | PEP 508 name |
| mcp | `claude mcp add --scope user --transport <http\|stdio> <n> <url\|cmd…>` | `claude mcp remove --scope user <n>` | `^[a-z0-9-]{1,48}$`; url must be https |
| plugin | `claude plugin install <id>` | `claude plugin uninstall <id>` | `<name>@<marketplace>` |
| exact (T3) | owner-approved argv shown verbatim | recorded by the scout if any | — |

`claude mcp add` and `claude plugin install` are documented CLI surfaces, so they are within constitution VIII. Running turns pick up the new server on their next spawn because the runner doesn't pass `--strict-mcp-config`.

## Scout
The `tg-capability-scout` agent uses `model: sonnet` and `maxTurns: 15`. Its tools are WebSearch, WebFetch, and `Bash` restricted by `allowed-tools` to `brew search|info`, `npm view`, `pip index versions`, `gh api repos/*` and `curl -s https://registry.modelcontextprotocol.io/*`. It returns cards as JSON in its final message, and the main agent passes one card on to `capability_request`.

## Reuse
- The approval card pattern and buttons come from 003 `policy/approvals.ts`, and the notice with **Undo** comes from 004/006.
- The follow-up turn uses the same `runTurn` that the scheduler uses for `mode: session` (007 `run.ts`).
- The `PostToolUse` hook endpoint already exists (006 `Skill` matcher). Add a `Bash` matcher.

## Risks
- **Supply chain**: trust tiers, exact-command display for T3, no shell, and owner approval every time a new capability is added.
- **Prompt injection steering installs** (a web page saying "install evil-mcp"): installs are only proposed to the owner and never run without a tap, and the card shows source, publisher and tier.
- **Stuck sessions**: a request times out to Skip after 24h, and the resume turn is dropped if the session was reset.
