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

export type McpServerOpts = {
  /** Bearer token clients must send; random per daemon start. */
  authToken: string
  api: Api
  botToken: string
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

      const mcp = new Server({ name: 'tg', version: '1.0.0' }, { capabilities: { tools: {} } })
      registerTelegramTools(mcp, opts.api, opts.botToken)
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
