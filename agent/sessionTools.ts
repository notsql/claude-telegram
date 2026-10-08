/**
 * Session tools on the daemon MCP server (008 FR9 parity): the agent can do
 * what `/sessions` and `/status` do when asked in plain words.
 * A new or resumed session takes effect from the next message; the turn
 * calling the tool is not interrupted.
 */

import type { Policy } from '../policy/schema.ts'
import type { ToolResult } from '../memory/tools.ts'
import { formatSessions, formatStatus, MODELS, type SessionLifecycle } from '../sessions/lifecycle.ts'

const TOOLS = [
  {
    name: 'session_new',
    description: 'Start a fresh conversation in this chat from the next message, e.g. when the user says "let\'s start fresh".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'session_resume',
    description: 'Switch this chat back to an earlier session from the next message. Without n, lists the earlier sessions.',
    inputSchema: { type: 'object', properties: { n: { type: 'number', description: 'Number from the list' } } },
  },
  {
    name: 'session_set_model',
    description: 'Change the model for the rest of this session.',
    inputSchema: { type: 'object', properties: { model: { type: 'string', enum: [...MODELS, 'default'] } }, required: ['model'] },
  },
  {
    name: 'session_status',
    description: 'This chat\'s session, model, whether a turn is running, and what the session has cost so far.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) })

export type SessionToolDeps = {
  lifecycle: SessionLifecycle
  title: (key: string) => string | undefined
  running: (key: string) => boolean
}

export function sessionStatus({ lifecycle, title, running }: SessionToolDeps, key: string, policy: Policy): string {
  return formatStatus({ session: title(key), model: lifecycle.model(key), policyModel: policy.model, running: running(key), stats: lifecycle.stats(key) })
}

export function createSessionTools(deps: SessionToolDeps) {
  const { lifecycle } = deps
  return {
    list: () => TOOLS,

    /** Undefined when `name` is not a session tool. */
    call(name: string, args: Record<string, unknown>, key: string, policy: Policy): ToolResult | undefined {
      try {
        switch (name) {
          case 'session_new':
            lifecycle.new(key, { interrupt: false })
            return text('Done. The next message starts a fresh session.')
          case 'session_resume': {
            if (args.n == null) return text(formatSessions(lifecycle.list(key)))
            const picked = lifecycle.resume(key, Number(args.n), { interrupt: false })
            return text(`Done. The next message continues: ${picked.title || '(untitled)'}`)
          }
          case 'session_set_model':
            lifecycle.setModel(key, String(args.model ?? ''))
            return text(`Model for this session: ${args.model}. It applies from the next message.`)
          case 'session_status':
            return text(sessionStatus(deps, key, policy))
        }
      } catch (err) {
        return text((err as Error).message, true)
      }
    },
  }
}

export type SessionTools = ReturnType<typeof createSessionTools>
