# 012 — Capability Acquisition (Auto-Solve)

## Problem
When the agent can't do something, it currently says so and stops: there's no tool for the job, `command not found`, the MCP server isn't connected, or the site has no API. The owner then has to find and install a tool and ask again. Instead, the agent should work through a fixed **ladder**: use what is already installed, else find a CLI, else find an MCP server, else fall back to the web (fetch or a real browser). It vets what it finds, asks the owner **once** to install it, then finishes the original task. Next time it already knows how.

## User stories
- **US1**: "Convert this .heic to jpg." No converter is installed. The agent replies "I need `imagemagick` (Homebrew core, 1.2M installs/30d). Install?" with **Install** / **Skip**. I tap Install, it installs, converts, and sends the jpg.
- **US2**: "What's on my Linear board?" No Linear tool exists. The agent finds the official Linear MCP server in the MCP registry, shows a card with its publisher, auth method and the scopes it asks for, and after I approve, adds it and walks me through the OAuth login.
- **US3**: "Check my electricity bill on the SP portal." There's no CLI or MCP for it, so the agent drives Safari through the existing browser MCP, logs in with what I give it, and reads the bill.
- **US4**: The second time I ask for a heic conversion, nothing is searched or installed. A learned skill says to use `magick`.
- **US5**: Fallback: `/caps` lists acquired capabilities with how and when each was installed, with **Uninstall** and **Forget** buttons.

## Functional requirements
- **FR1 — The ladder.** Before telling the owner it can't do something, the agent runs the ladder, top to bottom, stopping at the first rung that works:
  1. **Already here**: tools in this turn, CLIs on `PATH`, configured MCP servers (including claude.ai connectors turned off for this chat), installed or marketplace plugins, skills, and the `capabilities.json` ledger.
  2. **CLI**: Homebrew (`brew search` / `brew info --json=v2`), then `npm`, `uv tool`/`pipx`, then GitHub releases.
  3. **MCP server**: the official MCP registry (`registry.modelcontextprotocol.io`), then Claude Code plugin marketplaces the owner has added.
  4. **Web**: `WebFetch`/`WebSearch` for public data, then browser automation through the configured browser MCP (`safari-mcp`) for sites that need a login or interaction.
  The ladder lives in a shipped skill, `tg-capability-ladder`, which the main agent preloads. It also appears as a one-line rule in the appended system prompt: "never say you can't before running the ladder".
- **FR2 — Detecting the gap.** Besides the model noticing for itself, a `PostToolUse` hook on `Bash` flags exit code 127 or a `command not found` message. The daemon then adds `additionalContext`: "missing command `<x>`: run tg-capability-ladder".
- **FR3 — Scouting.** Rungs 2 and 3 are delegated to a new subagent, `tg-capability-scout`, which has web tools and read-only Bash for `brew`, `npm view`, `pip index` and `gh api`. It returns at most 3 **candidate cards**: `{kind: cli|mcp|plugin, name, source, publisher, install, homepage, popularity, lastRelease, license, auth, scopes, risk, why}`.
- **FR4 — Trust tiers.** Each candidate gets a tier from its source:
  - `T1`: Homebrew core and casks, MCP servers published by the vendor itself (verified namespace in the registry), and the official plugin marketplace.
  - `T2`: npm/PyPI packages with a known publisher and real usage, and community registry entries.
  - `T3`: anything else, including `curl | sh` and unverified GitHub releases.
  The scout prefers higher tiers. A `T3` card shows ⚠️ and the exact command, and is never offered while a `T1`/`T2` candidate covers the need.
- **FR5 — Ask once.** The agent calls `capability_request({candidate, reason, resume})`. The daemon posts the card to the owner DM with **Install** / **Details** / **Skip** buttons, and the turn ends with "waiting for approval". Approval is recorded per capability (`kind:name`), so later turns, updates and other chats reuse it without asking again. Skip is remembered for 30 days, so the agent doesn't nag. An unanswered request times out to Skip, failing closed (constitution IV).
- **FR6 — The daemon installs, not the model.** After approval, the daemon itself runs the install from a fixed set of installer templates:
  - `brew install <name>`
  - `npm i -g <name>`
  - `uv tool install <name>`
  - `pipx install <name>`
  - `claude mcp add --scope user …`
  - `claude plugin install <id>`
  Names are validated against the template's pattern, and the commands run without a shell. `T3` commands run only when the owner taps **Run exact command** on a card that shows the whole command. The model never gets an unrestricted install path through `Bash`.
- **FR7 — Auth handoff.** When a capability needs a login (OAuth, QR code or API key), the daemon sends the owner the exact command to run, or the URL to open, and waits for **Done**. The agent never asks for a secret in chat and never stores one. CLIs and MCP servers keep their own credentials (constitution VIII).
- **FR8 — Resume.** Once install and auth are done, the daemon starts a follow-up turn in the original session: `capability <name> is ready; continue the task: <resume>`. The owner doesn't have to ask again.
- **FR9 — Learn it.** After the first successful use, the reflection pass (006) proposes a skill, `use-<name>`, covering when to use it and the commands or tools that worked. The ledger entry links to the skill, so rung 1 finds it next time.
- **FR10 — Ledger.** `capabilities.json` in STATE_DIR holds `{id, kind, name, tier, source, install, approvedAt, approvedBy, installedAt, status: installed|skipped|failed|uninstalled, skill?, usedCount, lastUsed}`. Each write gets a notice with **Undo**: uninstall with the matching template (`brew uninstall`, `claude mcp remove`, …) and archive the skill (constitution V).
- **FR11 — Scope.** Only owner turns in the owner DM can call `capability_request`. In groups, the agent may run the ladder only as far as "already here" and web rungs that the policy allows. It may suggest an install, but the request goes to the owner DM. Policy flag: `capabilityAcquisition: 'ask' | 'off'` (default `ask` in DM, `off` in groups).
- **FR12 — Budget.** Scouting uses at most 15 turns, and there is at most 1 open request per session. Each scout run counts toward the daily turn budget (001).

## Non-goals
- Installing without approval. The owner chose "ask once".
- Writing new CLIs or MCP servers from scratch when nothing exists. That can be a later feature.
- System package managers that need `sudo` (`apt`, `dnf`).

## Acceptance criteria
- **AC1** (FR1, FR3, FR5, FR6, FR8): With `imagemagick` uninstalled, "convert this heic to jpg" shows an Install card. Tapping Install installs it, and the jpg arrives with no further message from the owner.
- **AC2** (FR5): A second request that needs the same package installs or uses it without a new card. A Skip suppresses the card for that package for 30 days.
- **AC3** (FR2): `foo-not-a-cmd --help` failing with 127 inside a turn leads the agent to run the ladder instead of giving up.
- **AC4** (FR4, FR6): A card for a `T3` candidate shows the full command, and its install button reads **Run exact command**. A prompt-injected package name like `x; rm -rf ~` fails validation and nothing runs.
- **AC5** (FR7): Adding an OAuth MCP server sends login instructions and doesn't resume until **Done** is tapped.
- **AC6** (FR1): A task on a site with no API and no MCP server finishes through the browser MCP.
- **AC7** (FR10): **Undo** on an installed capability uninstalls it and archives its skill. `/caps` shows it as `uninstalled`.
- **AC8** (FR11): In a group, a missing-tool request produces no install card in the group. The owner DM gets one only when the owner made the request.

## Open questions
- Should an approved capability also be added to the permission allowlist (`Bash(magick:*)`, `mcp__linear`) so it doesn't prompt per call? (Proposal: yes for DM policy, via the same `alwaysAllow` path as 003's **Always** button.)
