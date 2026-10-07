# 005 — Plan

## Modules
```
src/history/
  db.ts         bun:sqlite open/migrate, FTS5 schema
  indexer.ts    scan ~/.claude/projects/**/*.jsonl, tail from stored offset, parse, insert; fs.watch + 60s poll fallback
  parse.ts      JSONL line → {role, text, ts, toolSummary, telegramMeta?}
  search.ts     query building (escape FTS syntax), scope filter, bm25 ranking, snippet()
  summarize.ts  condense with citations via agent/oneshot.ts (--agent hermes-summarizer, 009)
  tools.ts      history_search tool on the daemon MCP server (scope-checked)
  recall.ts     auto-recall handler for the UserPromptSubmit hook (fresh/rotated sessions, FTS only)
```

## Schema
```sql
CREATE TABLE files    (path TEXT PRIMARY KEY, offset INTEGER, mtime INTEGER);
CREATE TABLE sessions (session_id TEXT PRIMARY KEY, session_key TEXT, origin TEXT, project TEXT, title TEXT, started_at INTEGER);
CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, ts INTEGER, tg_chat TEXT, tg_thread TEXT, tg_msg TEXT, text TEXT);
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');
-- triggers keep messages_fts in sync
CREATE INDEX idx_messages_session ON messages(session_id);
```
`session_key` comes from joining with `sessions.json`. The join is refreshed whenever the store changes.

## Parsing notes
- The inbound wrapper `<channel source="telegram" chat_id=… message_id=…>` from 002 appears in user content (line shapes: `parse.ts` header, T501). `parse.ts` extracts `tg_*` from it and strips the wrapper from the indexed text.
- Assistant text and `reply` tool inputs (`text`) are both indexed, because in Telegram the text sent to the user lives in the reply tool call.
- The JSONL format is internal to Claude Code and could change. Parsing is defensive: unknown line types are skipped, and parse failures are counted in metrics.

## Scope filter
```sql
WHERE (:scope = 'all') OR (sessions.session_key = :key)
```
This is applied in SQL. The model never chooses scope beyond what the policy allows.

## Risks
- **Large transcript volume**: the initial backfill is throttled (batch commits, yields to the event loop) and progress is logged.
- **Tool output secrets in transcripts**: only text and summaries of tool *inputs* are indexed, never tool results.
