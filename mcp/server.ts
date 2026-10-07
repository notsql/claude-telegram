/**
 * MCP streamable-HTTP server for `claude -p` turns. Binds to 127.0.0.1 and
 * requires the per-daemon bearer token. Each turn's MCP config points at
 * `/mcp?key=<session key>`, which binds the request to that session (T003:
 * the query string reaches the server unexpanded, so the runner writes it
 * literally). Stateless: a fresh Server and transport per request.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Api } from 'grammy'
import { registerTelegramTools } from './telegramTools.ts'
import { parseKey } from '../sessions/key.ts'
import { loadAccess } from '../access.ts'
import { chatTypeOf, resolvePolicy } from '../policy/resolve.ts'
import type { MemoryTools } from '../memory/tools.ts'
import type { HistoryTools } from '../history/tools.ts'
import type { SkillTools } from '../skills/tools.ts'
import type { AgentTools } from '../agents/tools.ts'
import type { SessionTools } from '../agent/sessionTools.ts'

export type McpServerOpts = {
  /** Bearer token clients must send; random per daemon start. */
  authToken: string
  api: Api
  botToken: string
  memory: MemoryTools
  history?: HistoryTools
  skills?: SkillTools
  agents?: AgentTools
  session?: SessionTools
  /** 0 picks a free port. */
  port?: number
}

export function startMcpServer(opts: McpServerOpts): { port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/mcp') return new Response('not found', { status: 404 })
      if (req.headers.get('authorization') !== `Bearer ${opts.authToken}`) {
        return new Response('unauthorized', { status: 401 })
      }
      const key = url.searchParams.get('key')
      if (!key) return new Response('missing session key', { status: 400 })
      try {
        parseKey(key)
      } catch {
        return new Response('invalid session key', { status: 400 })
      }

      const mcp = new Server({ name: 'tg', version: '1.0.0' }, { capabilities: { tools: {} } })
      const policy = resolvePolicy(loadAccess(), key, chatTypeOf(key))
      registerTelegramTools(mcp, opts.api, opts.botToken, key, policy, {
        list: () => [...opts.memory.list(policy), ...opts.history?.list(policy) ?? [], ...opts.skills?.list(policy) ?? [], ...opts.agents?.list(policy) ?? [], ...opts.session?.list() ?? []],
        call: (name, args) => opts.memory.call(name, args, key, policy) ?? opts.skills?.call(name, args, key, policy) ?? opts.agents?.call(name, args, key, policy) ?? opts.session?.call(name, args, key, policy) ?? opts.history?.call(name, args, key, policy),
      })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await mcp.connect(transport)
      return transport.handleRequest(req)
    },
  })
  return { port: server.port!, stop: () => server.stop(true) }
}
