# 008 — Slash-Command Menu (Fallback Controls)

## Problem
Telegram's `/` menu is the most discoverable way to control a bot. Under the constitution (principle I), commands are **not the main interface**: the agent should do these things on its own from natural language. Commands are a deterministic, reliable fallback that runs the same code paths. Skills should also show up in the menu.

## User stories
- **US1**: Typing `/` shows a short, relevant menu for the current context (DM, group, admin).
- **US2**: `/new` reliably starts a fresh conversation, even when the agent is confused.
- **US3**: Skills I have installed or the agent has learned appear as commands. `/deploy_blog staging` runs that skill with "staging" as input.
- **US4**: Commands that need arguments, when sent bare, open an inline keyboard (for example `/model` → model picker, `/cron` → job list).
- **US5**: Asking in plain words ("start fresh", "what's this costing me?", "forget that I use npm") does the same as the command.

## Functional requirements
- **FR1**: Session commands: `/new`, `/resume [n]`, `/sessions`, `/stop`, `/model [name]`, `/compact`, `/cost`, `/status`.
- **FR2**: Agent commands: `/remember <text>`, `/forget <name|query>`, `/memory`, `/search <query>`, `/skills [show|rm] [name]`, `/agents`, `/agent [name|off]` (009), `/cron`, `/policy`.
- **FR3**: Legacy commands remain: `/start`, `/help` and `/status` keep the current pairing-aware behaviour from `server.ts`, extended for the new features.
- **FR4**: **Skill commands**: discover all skills (user, project and plugin), map each `name` to Telegram's charset (`[a-z0-9_]{1,32}`: lowercase, `-`→`_`, truncate, deduplicate with a numeric suffix), and use the skill `description` truncated to 256 chars as the command description. A collision table is kept in `commands.json`.
- **FR5**: Invoking a skill command passes the **native skill invocation** `/<original-skill-name> <args>` as the `claude -p` prompt in the current session. Claude Code expands it, including `$ARGUMENTS` and named `arguments`. This also works for `disable-model-invocation` skills. Skills with `user-invocable: false` are never put in the menu.
- **FR6**: Menus are registered per scope with `setMyCommands` + `BotCommandScope`:
  - `all_private_chats`: session, agent and skill commands
  - `all_group_chats` and `all_chat_administrators`: the same, minus the DM-only `/start` and `/help` (owner decision 2026-10-07: groups get everything)
  Telegram's limit is 100 commands per scope. Built-in commands come first, then skills ranked by usage (006 `skills-usage.json`).
- **FR7**: The menu refreshes on daemon start, on the `skills-changed` event (debounced 30 seconds), on policy change, and at most once per minute.
- **FR8**: Unknown `/foo` that matches no command or skill is passed to the agent as text, so the agent can interpret it.
- **FR9**: Every command handler is a thin adapter over the functions exposed by 002–007, so there is no duplicated logic. Each command has an equivalent tool or natural-language path, documented in a parity table.
- **FR10**: Command authorisation: commands that change state (`/policy`, `/cron`, `/forget`, `/model`) need approver status in groups. In DMs they go through `dmCommandGate()`.
- **FR11**: Group handling: commands addressed to `@botname` are accepted, and commands addressed to other bots are ignored.

## Parity table (command ↔ autonomous path)
| Command | Tool / NL path |
|---|---|
| /new, /resume | `session_new`, `session_resume` tools ("let's start fresh") |
| /stop | interrupt (001), or a "stop" message when `interruptOnNewMessage` is set |
| /model | `session_set_model` (policy-bounded) |
| /compact | Claude Code compacts automatically. The command forces it with `claude -p --resume <id> "/compact"`. |
| /cost, /status | `session_status` tool |
| /remember, /forget, /memory | `memory_write`, `memory_delete`, `memory_search` |
| /search | `history_search` |
| /skills | `skill_list`, `skill_read`, and the archive |
| /cron | `schedule_*` |
| /policy | owner only. The agent may *suggest* changes but never applies them (constitution IV). |

## Non-goals
- Localised command descriptions (possible later via `language_code`).

## Acceptance criteria
- **AC1** (FR6): The DM `/` menu shows the session, agent and skill commands. The group `/` menu shows the same commands and skills, minus `/start` and `/help`.
- **AC2** (FR4, FR7): A newly learned skill appears in the menu within 1 minute of the notice.
- **AC3** (FR5): `/deploy_blog staging` invokes the skill with that argument.
- **AC4** (FR4): Two skills that normalise to the same command name both appear, with distinct suffixes.
- **AC5** (FR9): "forget that I use npm" and `/forget npm` produce the same result.
- **AC6** (FR10): A non-approver's `/policy` in a group is refused.

## Open questions
- Should `/compact` be exposed at all, given that Claude Code auto-compacts? (Proposal: yes, as a manual override.)
