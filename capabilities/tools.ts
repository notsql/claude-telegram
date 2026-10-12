/**
 * `capability_request` on the daemon MCP server (012 FR5, FR11). Hidden and
 * refused where `capabilityAcquisition` is `off`.
 */

import type { ToolResult } from '../memory/tools.ts'
import type { Policy } from '../policy/schema.ts'
import type { CapabilityRequest, CapabilityRequests } from './request.ts'

const TOOL = {
  name: 'capability_request',
  description: 'Ask the owner to install a missing capability (one candidate card from tg-capability-scout). The daemon validates and installs it after the owner taps Install; you never run the install yourself. End the turn after calling this.',
  inputSchema: {
    type: 'object',
    properties: {
      candidate: {
        type: 'object',
        description: 'Template kind: brew | brew-cask | npm | uv | pipx | plugin (name only), mcp (name, transport http + url, or stdio + command argv), exact (T3 only: argv, optional uninstall argv). Plus tier (T1|T2|T3), source, and optionally publisher, homepage, why.',
        properties: {
          kind: { type: 'string', enum: ['brew', 'brew-cask', 'npm', 'uv', 'pipx', 'plugin', 'mcp', 'exact'] },
          name: { type: 'string' },
          tier: { type: 'string', enum: ['T1', 'T2', 'T3'] },
          source: { type: 'string' },
        },
        required: ['kind', 'name', 'tier', 'source'],
      },
      reason: { type: 'string', description: 'Why the task needs it, in one line for the owner.' },
      resume: { type: 'string', description: 'The task to continue once it is installed.' },
    },
    required: ['candidate', 'reason', 'resume'],
  },
}

const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) })

export function createCapabilityTools(requests: CapabilityRequests) {
  return {
    list: (policy: Policy) => (policy.capabilityAcquisition === 'ask' ? [TOOL] : []),

    /** Undefined when `name` is not a capability tool. */
    async call(name: string, args: Record<string, unknown>, key: string, policy: Policy): Promise<ToolResult | undefined> {
      if (name !== TOOL.name) return
      const c = args.candidate as Record<string, unknown> | undefined
      if (!c || typeof c !== 'object' || !['T1', 'T2', 'T3'].includes(String(c.tier)) || typeof c.source !== 'string')
        return text('candidate needs kind, name, tier (T1|T2|T3) and source.', true)
      if (c.kind === 'exact' && c.tier !== 'T3') return text('exact commands are T3 only.', true)
      const r = await requests.request(key, policy, {
        candidate: c as CapabilityRequest['candidate'],
        reason: String(args.reason ?? ''),
        resume: String(args.resume ?? ''),
      })
      return text(r.text, !r.ok)
    },
  }
}

export type CapabilityTools = ReturnType<typeof createCapabilityTools>
