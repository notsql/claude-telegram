# 005 — Tasks
Depends on: 002 (sessions.json, inbound wrapper), 003 (historyScope)

- [x] **T501** Inspect the current Claude Code JSONL line shapes (user, assistant, tool_use, summary) and document them in `parse.ts` comments, with test fixtures.
- [x] **T502** `history/db.ts` schema, migrations and FTS sync triggers.
  *Verify:* unit test inserts a row and searches it.
- [x] **T503** `parse.ts`: extract Telegram meta, strip the wrapper, summarise tools, skip tool results.
  *Verify:* fixture tests.
- [x] **T504** `indexer.ts`: offset tailing, watcher plus poll fallback, throttled backfill, removal of deleted files.
  *Verify:* AC3, and FR9.
- [x] **T505** `search.ts`: FTS query escaping, scope filter, bm25, snippets.
  *Verify:* AC2.
- [ ] **T506** `summarize.ts` (a Haiku one-shot through the `claude` CLI) and the `history_search` MCP tool.
  *Verify:* AC1.
- [x] **T507** `recall.ts`: `UserPromptSubmit` hook handler for auto-recall on fresh or rotated sessions, with a threshold, token cap and a latency under 200ms.
  *Verify:* a fresh session referring to earlier work gets a `<recalled>` block (debug log).
- [x] **T508** `bun run reindex`.
  *Verify:* AC4.
- [x] **T509** Expose functions for 008 `/search`, with `t.me/c/...` links.
  *Verify:* AC5.
- [x] **T510** Provide a session-summary helper used by 002's session rotation and 006's skill extraction.
