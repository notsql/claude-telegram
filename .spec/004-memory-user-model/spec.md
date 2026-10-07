# 004 — Persistent Memory & User Model

## Problem
Each Claude session starts with almost no knowledge of the user. Hermes keeps curated notes and a deepening model of each user, and it decides **on its own** what is worth remembering. We want the same thing, stored in Claude Code's native memory format so the CLI benefits too.

## User stories
- **US1**: I mention "I prefer pnpm over npm" once. From then on, in Telegram and in the terminal, the agent uses pnpm without being reminded.
- **US2**: I correct the agent ("don't summarise, just give me the diff"). It saves that as feedback and follows it from then on.
- **US3**: After a few weeks the agent knows my role, timezone, projects and communication style, and adapts to them without being asked.
- **US4**: When the agent saves something, I see a small "🧠 Remembered: …" note with an Undo button.
- **US5**: In a group, the agent learns group-specific facts (for example "this topic is about the infra repo"). They go into the same shared memory as everything else, tagged with where they came from, so every chat and the terminal can use them.
- **US6**: Fallback: `/remember …`, `/forget …` and `/memory` let me curate memory by hand.

## Functional requirements
- **FR1**: Memory is stored in the Claude Code auto-memory format. Each fact is one markdown file with frontmatter `name`, `description` and `metadata.type ∈ {user, feedback, project, reference}`, plus a one-line pointer in `MEMORY.md`.
- **FR2**: **One shared memory** (owner decision, 2026-10-07): every DM, group and topic reads and writes the same store. Only conversation sessions stay per chat or topic (002).
  - **memory**: the auto-memory dir for the daemon's workspace project. A fact learned in a group carries `metadata.session_key` so its origin stays visible, but it is not hidden from other chats.
  - **user**: `<memory>/users/<telegram_user_id>/`, holding `type: user` files that make up each person's user model (also shared across chats).
  - The policy's `memoryScope` is `global | none`: `none` turns memory off for a chat.
- **FR3**: Context injection through **hooks** (001 FR4).
  - The `SessionStart` hook returns `additionalContext` with:
    - the shared `MEMORY.md` index, unless `memoryScope = none`
    - the user-model files for the sender, and for other active participants in groups
  - The `UserPromptSubmit` hook adds a refreshed block only when the indexes changed since the session started, or when the sender differs (in groups).
  - Everything is subject to a token budget (default 4k), and the most recent and most relevant items are kept.
- **FR4**: Tools: `memory_write(type, name, description, body)`, `memory_search(query)`, `memory_read(name)`, `memory_delete(name)` and `memory_update(name, patch)`. The daemon stamps `session_key` on writes; with `memoryScope: none` the tools are hidden (003 tool filtering) and refused in code.
- **FR5** (autonomy, inline): `TELEGRAM_INSTRUCTIONS` (`--append-system-prompt`) includes save, curate and recall guidance in the same spirit as Claude Code's own memory instructions. Save corrections, durable preferences, project facts and references. Don't save anything derivable from code or anything that only matters within the conversation.
- **FR6** (autonomy, reflection): the `Stop` hook (after each turn) and the `PreCompact` hook (before context is lost) enqueue a shared **reflection worker** (also used by 006). It runs as the `hermes-reflector` agent (009: Haiku, no tools, `--json-schema`) over the turn delta, read from the hook's `transcript_path`, plus the current indexes, and returns structured proposals: `{memory: [...], user_model: [...], skills: [...]}`. Proposals pass dedup and validation, then are either applied (`autoLearn: auto`) or offered as buttons (`autoLearn: propose`).
- **FR7**: Curation. The reflection pass must prefer `update` or `delete` over adding a near-duplicate. Proposals are checked by name, by description similarity, and by keyword overlap with existing entries.
- **FR8**: Limits: at most 3 memory writes per turn, at most 2KB per file, and an index of at most 200 lines. When the index exceeds the limit, a consolidation pass is triggered.
- **FR9**: Each write sends a compact notice ("🧠 Saved *pnpm preference* · Undo") to the session target. Undo deletes the file or restores the previous version.
- **FR10**: Bridge to the CLI is optional. On opt-in, it does either or both of these:
  - (a) add an `@<global>/MEMORY.md` import to `~/.claude/CLAUDE.md`, so terminal sessions load the same index
  - (b) install the `SessionStart` memory hook into `~/.claude/settings.json`, so terminal sessions also get the user model
  
  Both changes are reversible and need explicit owner confirmation.
- **FR11**: Secret hygiene. Writes that contain token, key or password patterns are rejected.

## Non-goals
- Vector embeddings. Search is FTS and keyword based, reusing 005's SQLite.
- Honcho or other external user-modelling services.

## Acceptance criteria
- **AC1** (FR1, FR5): "I use pnpm" in the DM produces a `feedback` or `user` file and an index line within that turn.
- **AC2** (FR3): After `/new`, asking "which package manager do I use?" is answered correctly.
- **AC3** (FR10): With the bridge enabled, a terminal `claude` session in an unrelated repo also knows about pnpm.
- **AC4** (FR2, FR4, policy): A fact saved in a group topic (tagged with its `session_key`) is recalled in the owner DM and in another topic; a chat with `memoryScope: none` gets no memory tools or injection.
- **AC5** (FR6, FR7): Saying the same preference three times across sessions results in one file, not three.
- **AC6** (FR9): Tapping Undo removes the file and its index line.
- **AC7** (FR11): "remember my API key sk-…" is refused.

## Open questions
- Is the global root the daemon workspace's project memory dir, or a dedicated dir that is imported? (Proposal: the workspace project dir, so Claude Code's own memory tooling treats it as native, plus the FR10 bridge.)
- Does `claude -p` in the workspace cwd already load that project's auto-memory? If so, FR3 skips the global index to avoid sending it twice. Check this in T401.
