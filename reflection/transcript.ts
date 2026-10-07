/**
 * Reads the turn delta from a Claude Code transcript JSONL (the hook's
 * `transcript_path`) as plain dialogue for the reflector: user text, the
 * agent's text and Telegram replies, and a one-line note per tool call.
 * Only complete lines are read, so a line still being written waits for the
 * next pass. Unknown line types are skipped; the format is internal.
 */

import { closeSync, openSync, readSync, statSync } from 'fs'

/** About 8k tokens of dialogue; the newest part wins. */
export const MAX_DELTA_CHARS = 32_000

const PREVIEW_CHARS = 160
const preview = (input: Record<string, unknown>) => {
  const s = JSON.stringify(input)
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s
}

/** Tool calls in a delta, Telegram replies and reactions aside (006 FR2 trigger). */
export const toolCalls = (delta: string) =>
  (delta.match(/\[tool (?!mcp__tg__(reply|react|edit_message)\b)/g) ?? []).length

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }

function lineText(line: string): string | undefined {
  let ev: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: string | Block[] } }
  try { ev = JSON.parse(line) } catch { return undefined }
  if ((ev.type !== 'user' && ev.type !== 'assistant') || ev.isMeta || ev.isSidechain) return undefined
  const content = ev.message?.content
  const parts: string[] = []
  if (typeof content === 'string') parts.push(content)
  else for (const b of content ?? []) {
    if (b.type === 'text' && b.text) parts.push(b.text)
    else if (b.type === 'tool_use') {
      // Telegram replies are the agent's real answer in daemon turns.
      // Memory calls show what the agent already saved, so reflection doesn't repeat it.
      // Other tools get a short arg preview, so 006 can read the procedure from the trace.
      const said = b.name?.endsWith('__reply') && typeof b.input?.text === 'string' ? `: ${b.input.text}`
        : b.name?.includes('__memory_') ? ` ${JSON.stringify(b.input)}`
        : b.input && Object.keys(b.input).length ? ` ${preview(b.input)}` : ''
      parts.push(`[tool ${b.name}${said}]`)
    }
  }
  const text = parts.join('\n').trim()
  return text ? `${ev.type === 'user' ? 'USER' : 'AGENT'}: ${text}` : undefined
}

/** Dialogue after byte `from`, and the offset to read from next time. */
export function readDelta(path: string, from: number): { text: string; offset: number } {
  let size: number
  try { size = statSync(path).size } catch { return { text: '', offset: from } }
  if (size < from) from = 0
  const buf = Buffer.alloc(size - from)
  const fd = openSync(path, 'r')
  try { readSync(fd, buf, 0, buf.length, from) } finally { closeSync(fd) }
  const raw = buf.toString('utf8')
  const end = raw.lastIndexOf('\n') + 1
  const text = raw.slice(0, end).split('\n').map(lineText).filter(Boolean).join('\n\n')
  return { text: text.length > MAX_DELTA_CHARS ? text.slice(-MAX_DELTA_CHARS) : text, offset: from + Buffer.byteLength(raw.slice(0, end)) }
}
