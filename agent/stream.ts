/**
 * Parser for `claude -p --output-format stream-json --verbose` (one JSON
 * object per line). Only the events the daemon acts on are validated; every
 * other type passes through as `unknown` so new CLI event types never break a
 * turn. A known event that fails its schema is reported as `invalid` rather
 * than thrown, so the runner can log drift and the contract test can fail on
 * it. Shapes recorded against Claude Code 2.1.288 (see 001 plan, T003).
 */

import { z } from 'zod'

const ContentBlock = z.union([
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.looseObject({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean().optional(),
  }),
  z.looseObject({ type: z.string() }),
])
export type ContentBlock = z.infer<typeof ContentBlock>

const Usage = z.looseObject({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
})
export type Usage = z.infer<typeof Usage>

export const InitEvent = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string().min(1),
  cwd: z.string(),
  model: z.string(),
  permissionMode: z.string(),
  apiKeySource: z.string(),
  claude_code_version: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string() })),
  slash_commands: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  plugins: z.array(z.unknown()).optional(),
  capabilities: z.array(z.string()).optional(),
})

export const HookStartedEvent = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('hook_started'),
  hook_id: z.string(),
  hook_name: z.string(),
  hook_event: z.string(),
})

export const HookResponseEvent = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('hook_response'),
  hook_id: z.string(),
  hook_name: z.string(),
  hook_event: z.string(),
  outcome: z.string(),
  output: z.string().optional(),
  exit_code: z.number().optional(),
})

export const ApiRetryEvent = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('api_retry'),
  error: z.unknown().optional(),
})

export const AssistantEvent = z.looseObject({
  type: z.literal('assistant'),
  session_id: z.string(),
  parent_tool_use_id: z.string().nullable().optional(),
  message: z.looseObject({
    id: z.string(),
    model: z.string(),
    content: z.array(ContentBlock),
    usage: Usage.optional(),
  }),
})

export const UserEvent = z.looseObject({
  type: z.literal('user'),
  session_id: z.string(),
  parent_tool_use_id: z.string().nullable().optional(),
  message: z.looseObject({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(ContentBlock)]),
  }),
})

export const ToolProgressEvent = z.looseObject({
  type: z.literal('tool_progress'),
  tool_name: z.string(),
  parent_tool_use_id: z.string().nullable().optional(),
  elapsed_time_seconds: z.number(),
})

export const RateLimitEvent = z.looseObject({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.looseObject({
    status: z.string(),
    resetsAt: z.number().optional(),
    rateLimitType: z.string().optional(),
  }),
})

export const ResultEvent = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  session_id: z.string().min(1),
  is_error: z.boolean(),
  num_turns: z.number(),
  duration_ms: z.number(),
  total_cost_usd: z.number(),
  stop_reason: z.string().nullable().optional(),
  terminal_reason: z.string().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  usage: Usage,
  permission_denials: z
    .array(z.looseObject({ tool_name: z.string(), tool_use_id: z.string() }))
    .optional(),
})

export type InitEvent = z.infer<typeof InitEvent>
export type HookStartedEvent = z.infer<typeof HookStartedEvent>
export type HookResponseEvent = z.infer<typeof HookResponseEvent>
export type ApiRetryEvent = z.infer<typeof ApiRetryEvent>
export type AssistantEvent = z.infer<typeof AssistantEvent>
export type UserEvent = z.infer<typeof UserEvent>
export type ToolProgressEvent = z.infer<typeof ToolProgressEvent>
export type RateLimitEvent = z.infer<typeof RateLimitEvent>
export type ResultEvent = z.infer<typeof ResultEvent>

export type StreamEvent =
  | { kind: 'init'; event: InitEvent }
  | { kind: 'hook_started'; event: HookStartedEvent }
  | { kind: 'hook_response'; event: HookResponseEvent }
  | { kind: 'api_retry'; event: ApiRetryEvent }
  | { kind: 'assistant'; event: AssistantEvent }
  | { kind: 'user'; event: UserEvent }
  | { kind: 'tool_progress'; event: ToolProgressEvent }
  | { kind: 'rate_limit'; event: RateLimitEvent }
  | { kind: 'result'; event: ResultEvent }
  /** Any other type or system subtype; the runner ignores these. */
  | { kind: 'unknown'; type: string; raw: Record<string, unknown> }
  /** Not JSON, or a known type that failed its schema (CLI drift). */
  | { kind: 'invalid'; line: string; error: string }

type Known = Exclude<StreamEvent, { kind: 'unknown' | 'invalid' }>
const SYSTEM: Record<string, [Known['kind'], z.ZodType]> = {
  init: ['init', InitEvent],
  hook_started: ['hook_started', HookStartedEvent],
  hook_response: ['hook_response', HookResponseEvent],
  api_retry: ['api_retry', ApiRetryEvent],
}
const TOP: Record<string, [Known['kind'], z.ZodType]> = {
  assistant: ['assistant', AssistantEvent],
  user: ['user', UserEvent],
  tool_progress: ['tool_progress', ToolProgressEvent],
  rate_limit_event: ['rate_limit', RateLimitEvent],
  result: ['result', ResultEvent],
}

/** Parses one stream-json line. Returns null for blank lines. */
export function parseLine(line: string): StreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (err) {
    return { kind: 'invalid', line: trimmed, error: `bad JSON: ${(err as Error).message}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'invalid', line: trimmed, error: 'not a JSON object' }
  }
  const obj = raw as Record<string, unknown>
  const type = typeof obj.type === 'string' ? obj.type : ''
  const entry = type === 'system'
    ? SYSTEM[typeof obj.subtype === 'string' ? obj.subtype : '']
    : TOP[type]
  if (!entry) {
    const label = type === 'system' ? `system/${String(obj.subtype)}` : type || '(none)'
    return { kind: 'unknown', type: label, raw: obj }
  }
  const [kind, schema] = entry
  const parsed = schema.safeParse(obj)
  if (!parsed.success) {
    return { kind: 'invalid', line: trimmed, error: `${kind}: ${z.prettifyError(parsed.error)}` }
  }
  return { kind, event: parsed.data } as StreamEvent
}

/** Splits a byte or string stream into lines and yields parsed events. */
export async function* parseStreamJson(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of source) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const ev = parseLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      if (ev) yield ev
    }
  }
  buf += decoder.decode()
  const ev = parseLine(buf)
  if (ev) yield ev
}

/** Text of an assistant message's text blocks, joined. */
export function assistantText(ev: AssistantEvent): string {
  return ev.message.content
    .flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('')
}

/** Tool calls in an assistant message, for progress lines. */
export function toolUses(ev: AssistantEvent): { id: string; name: string; input: unknown }[] {
  return ev.message.content.flatMap(b =>
    b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string'
      ? [{ id: b.id, name: b.name, input: b.input }]
      : [],
  )
}
