# 008 — Slash-Command Menu (Fallback Controls)

## Problem
Telegram's `/` menu is the most discoverable way to control a bot. Under the constitution (principle I), commands are **not the main interface**: the agent should do these things on its own from natural language. Commands are a deterministic, reliable fallback that runs the same code paths. Skills should also show up in the menu.

## User stories
- **US1**: Typing `/` shows a short, relevant menu for the current context (DM, group, admin).
- **US2**: `/new` reliably starts a fresh conversation, even when the agent is confused.
- **US3**: Skills I have installed or the agent has learned appear as commands. `/deploy_blog staging` runs that skill with "staging" as input.
- **US4**: Commands that need arguments, when sent bare, open an inline keyboard (for example `/sessions` → New / Resume / Compact, `/cron` → job list).
- **US5**: Asking in plain words ("start fresh", "what's this costing me?", "forget that I use npm") does the same as the command.

## Functional requirements
- **FR1**: Session commands: `/sessions`, `/stop`, `/usage` (Claude Code's own `/usage` report, run as `claude -p /usage`, drawn with a bar per limit; what's using it is behind ℹ️ Learn more, FR17). (`/new`, `/resume` and `/compact` were folded into `/sessions`' buttons, and `/model` and `/cost` dropped, on 2026-10-08, FR14. The model stays changeable in plain words via `session_set_model`; cost is in `/sessions`. `/status` was dropped on 2026-10-08 as `/sessions` already shows it.)
- **FR2**: Agent commands: `/memory`, `/skills [command] [args]`, `/cron`, `/settings`. (`/agent` moved into `/settings` as 🤖 Agent on 2026-10-08, FR20; `/agents` was never built.) (`/search` dropped on 2026-10-08: ask in plain words, `history_search`.) (`/remember` and `/forget` were folded into `/memory`'s buttons on 2026-10-07, FR13.)
- **FR3**: Legacy commands remain: `/start` and `/help` keep the current pairing-aware behaviour from `server.ts`, extended for the new features.
- **FR4**: **Skill commands**: discover all skills (user, project and plugin), map each `name` to Telegram's charset (`[a-z0-9_]{1,32}`: lowercase, `-`→`_`, truncate, deduplicate with a numeric suffix), and use the skill `description` truncated to 256 chars as the command description. A collision table is kept in `commands.json`.
- **FR5**: Invoking a skill command passes the **native skill invocation** `/<original-skill-name> <args>` as the `claude -p` prompt in the current session. Claude Code expands it, including `$ARGUMENTS` and named `arguments`. This also works for `disable-model-invocation` skills. Skills with `user-invocable: false` are never put in the menu.
- **FR6**: Menus are registered per scope with `setMyCommands` + `BotCommandScope`:
  - `all_private_chats`: session and agent commands
  - `all_group_chats` and `all_chat_administrators`: the same, minus the DM-only `/start` and `/help` (owner decision 2026-10-07: groups get everything)
  Skills are not listed one per command; they all sit behind `/skills` (FR12, owner decision 2026-10-07). Typed skill commands (FR4, FR5) still work.
- **FR7**: The menu refreshes on daemon start and on policy change, at most once per minute.
- **FR8**: Unknown `/foo` that matches no command or skill is passed to the agent as text, so the agent can interpret it.
- **FR9**: Every command handler is a thin adapter over the functions exposed by 002–007, so there is no duplicated logic. Each command has an equivalent tool or natural-language path, documented in a parity table.
- **FR10**: Command authorisation: commands that change state (`/settings`, `/cron`, Forget) need approver status in groups. In DMs they go through `dmCommandGate()`.
- **FR11**: Group handling: commands addressed to `@botname` are accepted, and commands addressed to other bots are ignored.
- **FR12**: **`/skills` buttons.** `/skills` lists every discovered skill as buttons, most used first, 12 per page. Tapping one shows ▶️ Run (the FR5 invocation with no arguments), 📄 Show (its SKILL.md), and, for skills in the chat's skill store, 📦 Archive and 🗑 Remove (approvers only, FR10). `/skills <command> <args>` runs a skill with arguments.
- **FR13**: **`/memory` buttons.** `/memory` lists shared memory entries as buttons, newest first, 10 per page, plus + Add and 👤 About you. An entry shows its text with 🗑 Forget (approvers only, with the Undo notice). Add asks for a reply and saves it as `/remember` did.

- **FR14**: **`/sessions` buttons.** `/sessions` shows the session status with 🆕 New, ⏪ Resume and 🗜 Compact. Resume lists earlier sessions as buttons, most recent first, 8 per page, with « Back; tapping one resumes it. Owner only, like the commands it replaces.
- **FR15**: **`/settings` buttons** (replaces `/policy`, 2026-10-08). The main page describes each editable policy setting and shows it as a `Setting: Value` button; tapping one explains each value (current one marked), and tapping a value sets it. ↺ Reset to defaults, after a confirm, clears the editable settings and every permission rule (allowed, blocked, ♾ Always) from the chat's entry; terminal-only fields such as `cwd` stay. 🔐 Permissions is its own page: the permission mode, then one button per kind of rule (allowed, blocked, ♾ Always) with its count; each opens its rules 8 per page, a rule shows its details, and Always rules can be removed. Field and value names are shown as words (`permissionMode` → Permission mode, `acceptEdits` → Accept edits, `true` → Yes).
- **FR16**: **✕ Close.** Every inline menu (`/memory`, `/skills`, `/sessions`, `/usage`, `/settings`, `/cron`) has ✕ Close on every page, beside « Back where there is one. It deletes the menu message, or removes its buttons when Telegram won't delete it.
- **FR17**: **`/usage` Learn more.** `/usage` shows only the limits, each with a bar and reset time. ℹ️ Learn more swaps in what's using them (contributors per period, each with a bar), with « Back to the limits. The report is kept per message, so the button doesn't rerun `claude`, except after a restart.
- **FR18**: **`/cron` New job.** `/cron` ends with + New job. It asks how often (Once, Every day, Weekdays, Every week, Every hour), then the day for weekly, then the hour (06:00–23:00, on the hour), each step with « Back. Then it asks for what to do as a reply, and creates the job through `schedule_create` in the host timezone, so the same validation and `schedulerAllowed` check apply. Once means the next time that hour comes round. Anything finer (minutes, other timezones) is done in plain words.
- **FR19**: **Skills, plugins & MCP switches.** `/settings` → 🧩 Skills, plugins & MCP turns skills, plugins and MCP servers on or off for this chat only. Skills lists the chat's skills (not plugin skills, which follow their plugin) as ✅/🚫 buttons, 12 per page; Plugins lists installed plugins (user scope, plus project installs covering the chat's cwd) and any other plugin a turn there loads, such as synced ones; the channel plugin and Claude Code's `@builtin` ones are never offered. MCP Servers lists every server turns there load (user, project and claude.ai connectors; not the daemon's own `tg`), from the `system/init` events of its turns, or one local `claude -p /cost` probe for a cwd with no turn yet; a server is switched off with a server-level deny (`--disallowedTools mcp__<prefix>`), which removes all its tools (T823). The chat stores `disabledSkills`, `plugins` and `disabledMcpServers` (overrides only where they differ from the installed state), and turns get them as `skillOverrides` and `enabledPlugins` merged into the daemon's `--settings` JSON, since a second `--settings` flag replaces the first (T821). Reset clears them.
- **FR20**: **🤖 Agent in `/settings`** (replaces `/agent`). The page explains that the default assistant already delegates to agents, lists the agents a chat can run as with their descriptions (structured-output-only ones such as tg-reflector are left out), and sets one, or Default assistant, on the session key, so a forum topic can have its own (009 FR3, US3). Skills switched off here (FR19) are also hidden from `/skills` and refused when typed as `/<skill>`.
- **FR21**: **🛒 Browse plugins** (2026-10-08). The Plugins page (FR19) has 🛒 Browse plugins: the catalogs of the marketplaces already added (`known_marketplaces.json`), by category, then plugins 10 per page (installed ones marked ✓), then a plugin's page (description, category, author, homepage, marketplace). Not installed: 📥 Install, with a confirm that says it runs the plugin's code (hooks, MCP servers) on this computer as you. Installed: ⬆️ Update and 🗑 Uninstall (with a confirm). All of it runs `claude plugin install|update|uninstall --json` (user scope). A new install is disabled in user settings (`claude plugin disable`), so the terminal and other chats are unaffected, and switched on for this chat only (FR19); the result page shows `claude plugin details`. Plugins that need a marketplace-declared command confirmed are refused with a pointer to the terminal (no `-y`). Uninstall drops every chat's override for it. Owner only; works in DMs and groups (DM-only until 2026-10-08), and an install from a group or topic is on there only. Adding marketplaces and plugin settings (`configure`, which may hold secrets) stay in the terminal.
- **FR22**: **+ New skill** (2026-10-08). `/skills` ends with + New skill. It asks, by reply, what the skill should do in plain words, then runs that as a turn asking the agent to draft it with `skill_create`, so `autoLearn` decides (propose: ✅ Save / ✏️ Edit / ✕ Skip; auto: saved with Undo) and the name checks apply. With `autoLearn: off` the button says to turn it on in `/settings`. Groups need an approver (FR10).
## Parity table (command ↔ autonomous path)
| Command | Tool / NL path |
|---|---|
| /sessions (New, Resume, Compact buttons) | `session_new`, `session_resume`, `session_status` tools ("let's start fresh"); Compact forces `claude -p --resume <id> "/compact"` |
| /stop | interrupt (001), or a "stop" message when `interruptOnNewMessage` is set |
| (plain words) | `session_status` tool; the model is changed in plain words via `session_set_model` (policy-bounded) |
| /memory (Add, Forget buttons) | `memory_write`, `memory_delete`, `memory_search` |
| (plain words) | `history_search` |
| /skills | `skill_list`, `skill_read`, and the archive |
| /cron | `schedule_*` |
| /settings | owner only. The agent may *suggest* changes but never applies them (constitution IV). |

## Non-goals
- Localised command descriptions (possible later via `language_code`).

## Acceptance criteria
- **AC1** (FR6): The DM `/` menu shows the session, agent and skill commands. The group `/` menu shows the same commands and skills, minus `/start` and `/help`.
- **AC2** (FR4, FR7): A newly learned skill appears in the menu within 1 minute of the notice.
- **AC3** (FR5): `/deploy_blog staging` invokes the skill with that argument.
- **AC4** (FR4): Two skills that normalise to the same command name both appear, with distinct suffixes.
- **AC5** (FR9): "forget that I use npm" and the /memory Forget button produce the same result.
- **AC6** (FR10): A non-approver's `/settings` in a group is refused.

## Open questions
- Should `/compact` be exposed at all, given that Claude Code auto-compacts? (Proposal: yes, as a manual override.)
