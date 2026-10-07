/**
 * JSONL line → indexable message (005). The format is internal to Claude Code
 * and changes between versions, so parsing is defensive: unknown types and
 * fields are skipped. Fixtures: test/fixtures/history/.
 *
 * Line shapes, from transcripts written by Claude Code 2.1.292 (2026-10-07).
 * Files are `~/.claude/projects/<project-dir>/<sessionId>.jsonl`; subagent
 * transcripts are separate files under `<sessionId>/subagents/agent-*.jsonl`.
 *
 * Every message line carries `type`, `uuid`, `parentUuid`, `sessionId`,
 * `timestamp` (ISO string), `cwd`, `version`, `isSidechain` and `entrypoint`.
 *
 * - `user`, `message.content` a **string**: a prompt.
 *   - Daemon turns (`promptSource: "sdk"`): the 002 inbound wrapper,
 *     `<channel source="telegram" chat_id=… message_id=… user=… user_id=… ts=…
 *     [chat_type=… thread_id=…]>[<recent_context>…</recent_context>\n]text</channel>`,
 *     with `<>&"` in user text XML-escaped.
 *   - Terminal turns (`origin.kind: "human"`): plain text. Also harness
 *     lines that are not user words: `isMeta: true`, or text starting with
 *     `<command-name>`, `<command-message>`, `<local-command-stdout>`,
 *     `<local-command-caveat>`, `<task-notification>`, `<bash-input>`.
 *   - `origin.kind: "channel"` (`server: "plugin:telegram:telegram"`): the
 *     old MCP-channel Telegram plugin, same `<channel source="telegram">` body.
 *   - `origin.kind: "peer"`: a subagent hand-back (model output, not the user).
 * - `user`, `message.content` an **array**:
 *   - `{type:"text", text}` blocks (with `image` blocks): a prompt.
 *   - `{type:"tool_result", tool_use_id, content}` plus a top-level
 *     `toolUseResult`: tool output. Never indexed (may hold secrets).
 * - `assistant`: `message` is an API message (`id`, `model`, `role`,
 *   `content`). One content block per line, so a single API message spans
 *   several lines sharing `message.id`:
 *   - `{type:"text", text}`: visible reply text.
 *   - `{type:"thinking", thinking, signature}`: not indexed.
 *   - `{type:"tool_use", id, name, input}`. For Telegram the user-visible
 *     text is in `name: "mcp__tg__reply"`, `input: {chat_id, text, reply_to?}`.
 * - `ai-title` `{aiTitle, sessionId}` and `custom-title`: session title; the
 *   latest one wins. There is no `summary` line type any more.
 * - `system` (`subtype`: `turn_duration`, `stop_hook_summary`, `api_error`,
 *   `local_command`, `away_summary`, …): not indexed.
 * - Not messages, skipped: `attachment` (hook output, reminders, env),
 *   `last-prompt`, `queue-operation`, `file-history-snapshot`,
 *   `file-history-delta`, `mode`, `permission-mode`, `cost-state`,
 *   `atis-latch`, `agent-name`, `pr-link`, `frame-link`, `bridge-session`,
 *   `continued-in`.
 */
