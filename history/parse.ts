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

export type TelegramMeta = { chat: string; thread?: string; msg?: string; user?: string }
export type Parsed =
  | { kind: 'message'; sessionId: string; role: 'user' | 'assistant'; ts: number; text: string; tg?: TelegramMeta }
  | { kind: 'title'; sessionId: string; title: string }

const REPLY_TOOL = 'mcp__tg__reply'
const PREVIEW = 80
const HARNESS = /^<(command-name|command-message|local-command-stdout|local-command-caveat|task-notification|bash-input)>/
const WRAPPER = /^<channel source="telegram"([^>]*)>([\s\S]*)<\/channel>\s*$/

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** Strip the 002 inbound wrapper (and its group `<recent_context>`), keeping the meta. */
export function unwrapInbound(content: string): { text: string; tg?: TelegramMeta } {
  const m = content.match(WRAPPER)
  if (!m) return { text: content }
  const attrs = Object.fromEntries([...m[1].matchAll(/ ([\w]+)="([^"]*)"/g)].map(([, k, v]) => [k, unescapeXml(v)]))
  const body = m[2].replace(/^<recent_context>[\s\S]*?<\/recent_context>\n/, '')
  const tg: TelegramMeta = { chat: attrs.chat_id }
  if (attrs.thread_id) tg.thread = attrs.thread_id
  if (attrs.message_id) tg.msg = attrs.message_id
  if (attrs.user) tg.user = attrs.user
  return { text: unescapeXml(body), tg: attrs.chat_id ? tg : undefined }
}

/** `tool: name(args-preview)` (005 FR3). Telegram replies index their text instead. */
export function summariseTool(name: string, input: unknown): string {
  if (name === REPLY_TOOL && typeof (input as any)?.text === 'string') return (input as any).text
  let args = JSON.stringify(input ?? {})
  if (args.length > PREVIEW) args = args.slice(0, PREVIEW - 1) + '…'
  return `tool: ${name}(${args})`
}

/** One JSONL line → a message or title to index, or undefined to skip. Never throws. */
export function parseLine(line: string): Parsed | undefined {
  let row: any
  try { row = JSON.parse(line) } catch { return }
  if (!row || typeof row !== 'object' || typeof row.sessionId !== 'string') return
  const sessionId = row.sessionId
  if (row.type === 'ai-title' && row.aiTitle) return { kind: 'title', sessionId, title: row.aiTitle }
  if (row.type === 'custom-title' && row.customTitle) return { kind: 'title', sessionId, title: row.customTitle }
  if (row.type !== 'user' && row.type !== 'assistant') return
  if (row.isMeta || row.origin?.kind === 'peer') return
  const ts = Date.parse(row.timestamp) || 0
  const content = row.message?.content
  const msg = (role: 'user' | 'assistant', text: string, tg?: TelegramMeta): Parsed | undefined =>
    text.trim() ? { kind: 'message', sessionId, role, ts, text: text.trim(), ...(tg && { tg }) } : undefined

  if (row.type === 'user') {
    if (typeof content === 'string') {
      if (HARNESS.test(content)) return
      const { text, tg } = unwrapInbound(content)
      return msg('user', text, tg)
    }
    if (!Array.isArray(content)) return
    return msg('user', content.filter(b => b?.type === 'text').map(b => b.text).join('\n'))
  }
  if (!Array.isArray(content)) return
  const parts = content.flatMap(b =>
    b?.type === 'text' ? [b.text] : b?.type === 'tool_use' ? [summariseTool(b.name, b.input)] : [])
  return msg('assistant', parts.join('\n'))
}
