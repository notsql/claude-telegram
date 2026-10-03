# 005 — Session History Search

## Problem
Telegram's Bot API has no history or search, and resumed sessions eventually get compacted or rotated. Hermes can recall past conversations through full-text search plus LLM summarisation. We want the same over Claude Code's own transcripts, covering Telegram sessions and (when policy allows) terminal sessions.

## User stories
- **US1**: "What did we decide about the Postgres migration last week?" The agent searches past sessions and answers with a cited summary.
- **US2**: When I start a fresh session, the agent automatically recalls relevant past context if my message refers to earlier work.
- **US3**: In a group topic, searches only cover that topic's history.
- **US4**: Fallback: `/search <query>` returns the top hits with dates and links to the original messages.

## Functional requirements
- **FR1**: Source of truth: Claude Code transcript JSONL files under `~/.claude/projects/**/`. The daemon never writes its own transcript copy.
- **FR2**: Each Claude Code session ID is mapped to a session key in `sessions.json` (002). Sessions not in the map are tagged `origin: cli`.
- **FR3**: The indexer incrementally ingests user and assistant text (tool calls are summarised to `tool: name(args-preview)`) into a `bun:sqlite` FTS5 database at `<STATE_DIR>/history.db`. Per-file byte offsets are tracked, so ingestion survives restarts and only reads new content.
- **FR4**: The index includes Telegram message IDs where they are known (from the inbound wrapper meta), so hits can link back with `t.me/c/<chat>/<thread>/<msg>`.
- **FR5**: Tool `history_search(query, {scope?, since?, limit?, summarize?})` returns ranked snippets (`bm25`) with session key, timestamp and title. When `summarize` is true, a one-shot run as the `hermes-summarizer` agent (001 `oneshot.ts`, 009) condenses the hits into an answer with citations.
- **FR6**: Scope is enforced by the session's `historyScope` policy (003):
  - `all`: every session, including CLI
  - `chat`: same session key only
  - `none`: tool not exposed
- **FR7**: Auto-recall via the **`UserPromptSubmit` hook**: when a turn starts on a session that is fresh or was rotated, the hook handler runs a local FTS search on the prompt text (no model call, under 200ms) and returns any results as `additionalContext`. If the top hit scores above the threshold, inject up to 1k tokens of `<recalled>` snippets.
- **FR8**: The index is a derived cache. `bun run reindex` rebuilds it from scratch.
- **FR9**: Retention: honour Claude Code's transcript cleanup. When a JSONL file disappears, its rows are dropped on the next scan.

## Non-goals
- Semantic or vector search (it could be added later as an extra column).
- Indexing Telegram messages that never reached the agent.

## Acceptance criteria
- **AC1** (FR3, FR5): After discussing "postgres migration" in the DM, `/new`, then "what did we decide about the postgres migration?" gives a correct answer citing the earlier session date.
- **AC2** (FR6): The same question asked in a group topic with `historyScope: chat` finds nothing from the DM.
- **AC3** (FR3): Killing the daemon during indexing and restarting it does not duplicate rows.
- **AC4** (FR8): Deleting `history.db` followed by reindex gives identical search results.
- **AC5** (FR4): `/search` hits include a tappable link to the original Telegram message.

## Open questions
- Should CLI sessions be included by default in the owner's DM scope? (Proposal: yes, because `historyScope: all` is the owner-DM default. This can be switched off.)
