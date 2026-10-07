/**
 * `memory_*` tools on the daemon MCP server (004 FR4), all on the one shared
 * store (FR2). Writes are stamped with the session key so a fact's origin
 * stays visible. With `memoryScope: none` the tools are hidden and refused.
 * At most MAX_WRITES_PER_TURN writes per turn (FR8); `startTurn` resets it.
 * With `user_id`, a tool works on that person's user model instead (T410).
 */

import type { Policy } from '../policy/schema.ts'
import { MAX_WRITES_PER_TURN } from './guard.ts'
import { MEMORY_TYPES, type MemoryStore, type MemoryType } from './store.ts'

/** A change the daemon reports with an Undo button (FR9). */
export type MemoryChange = { verb: 'Saved' | 'Updated' | 'Forgot'; name: string; description: string; undo: () => void }

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) })

const USER_ID = { type: 'string', description: 'Telegram user_id from the <channel> tag: work on that person\'s user model (their name, role, timezone, style) instead of the shared memory' }

const TOOLS = [
  {
    name: 'memory_write',
    description: 'Save one durable fact to the shared memory (all chats and the terminal see it). Use a short kebab-case name; writing an existing name replaces it. Never save secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...MEMORY_TYPES] },
        name: { type: 'string', description: 'kebab-case slug, e.g. prefers-pnpm' },
        description: { type: 'string', description: 'One line, used to decide relevance later' },
        body: { type: 'string', description: 'The fact. For feedback/project add **Why:** and **How to apply:** lines.' },
        user_id: USER_ID,
      },
      required: ['type', 'name', 'description', 'body'],
    },
  },
  {
    name: 'memory_update',
    description: 'Change fields of an existing memory. Prefer this over writing a near-duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        patch: {
          type: 'object',
          properties: { type: { type: 'string', enum: [...MEMORY_TYPES] }, description: { type: 'string' }, body: { type: 'string' } },
        },
        user_id: USER_ID,
      },
      required: ['name', 'patch'],
    },
  },
  {
    name: 'memory_search',
    description: 'Keyword search over the shared memory. Returns matching names and descriptions.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, user_id: USER_ID }, required: ['query'] },
  },
  {
    name: 'memory_read',
    description: 'Read one memory file by name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, user_id: USER_ID }, required: ['name'] },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory that is wrong or no longer true.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, user_id: USER_ID }, required: ['name'] },
  },
]

export function createMemoryTools(
  shared: MemoryStore,
  userStore: (userId: string) => MemoryStore,
  onChange: (key: string, change: MemoryChange) => void = () => {},
) {
  const writes = new Map<string, number>()

  /** Counts a write for `key`; false once the turn's limit is used. */
  const takeWrite = (key: string) => {
    const n = writes.get(key) ?? 0
    if (n >= MAX_WRITES_PER_TURN) return false
    writes.set(key, n + 1)
    return true
  }

  function write(store: MemoryStore, key: string, input: { type: MemoryType; name: string; description: string; body: string }, meta: Record<string, string>): string {
    const r = store.write({ ...input, metadata: { ...meta, source: 'telegram', session_key: key, updated: new Date().toISOString().slice(0, 10) } })
    const name = r.entry.name
    onChange(key, { verb: r.op === 'create' ? 'Saved' : 'Updated', name, description: r.entry.description, undo: () => store.restore(name, r.backup) })
    return `${r.op === 'create' ? 'saved' : 'updated'} ${name}${r.indexFull ? ' (memory index is over its line limit; consolidate soon)' : ''}`
  }

  return {
    startTurn(key: string): void {
      writes.delete(key)
    },

    list(policy: Policy) {
      return policy.memoryScope === 'none' ? [] : TOOLS
    },

    /** Undefined when `name` is not a memory tool. */
    call(name: string, args: Record<string, unknown>, key: string, policy: Policy): ToolResult | undefined {
      if (!TOOLS.some(t => t.name === name)) return undefined
      if (policy.memoryScope === 'none') return text('memory is turned off for this chat (memoryScope: none)', true)
      try {
        const userId = args.user_id == null || args.user_id === '' ? undefined : String(args.user_id)
        if (userId !== undefined && !/^\d+$/.test(userId)) return text('user_id must be a numeric Telegram user id', true)
        const store = userId ? userStore(userId) : shared
        switch (name) {
          case 'memory_search': {
            const hits = store.search(String(args.query ?? '')).slice(0, 10)
            return text(hits.length ? hits.map(e => `${e.name} (${e.type}): ${e.description}`).join('\n') : 'no matches')
          }
          case 'memory_read': {
            const e = store.read(String(args.name ?? ''))
            return e ? text(`${e.name} (${e.type}): ${e.description}\n\n${e.body}`) : text(`no memory named ${args.name}`, true)
          }
          case 'memory_delete': {
            if (!takeWrite(key)) return text(`limit of ${MAX_WRITES_PER_TURN} memory writes per turn reached`, true)
            const e = store.read(String(args.name ?? ''))
            const del = e && store.delete(e.name)
            if (!e || !del) return text(`no memory named ${args.name}`, true)
            onChange(key, { verb: 'Forgot', name: e.name, description: e.description, undo: () => store.restore(e.name, del.backup) })
            return text(`deleted ${e.name}`)
          }
          case 'memory_write': {
            if (!takeWrite(key)) return text(`limit of ${MAX_WRITES_PER_TURN} memory writes per turn reached`, true)
            const input = args as { type: MemoryType; name: string; description: string; body: string }
            return text(write(store, key, userId ? { ...input, type: 'user' } : input, userId ? { user_id: userId } : {}))
          }
          case 'memory_update': {
            const e = store.read(String(args.name ?? ''))
            if (!e) return text(`no memory named ${args.name}; use memory_write to create it`, true)
            if (!takeWrite(key)) return text(`limit of ${MAX_WRITES_PER_TURN} memory writes per turn reached`, true)
            const patch = (args.patch ?? {}) as Partial<Record<'type' | 'description' | 'body', string>>
            return text(write(store, key, {
              type: (patch.type ?? e.type) as MemoryType,
              name: e.name,
              description: patch.description ?? e.description,
              body: patch.body ?? e.body,
            }, e.metadata))
          }
        }
      } catch (err) {
        return text(`${name} failed: ${err instanceof Error ? err.message : err}`, true)
      }
      return undefined
    },
  }
}

export type MemoryTools = ReturnType<typeof createMemoryTools>
