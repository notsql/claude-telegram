/**
 * Hook endpoint for `claude -p` turns: `POST /hook/<event>` on 127.0.0.1 with
 * the per-daemon bearer token (AC8). The session key comes from the
 * `X-TG-Session-Key` header. Each event is logged, then passed to the handler
 * registered for it (003–006, 009); the handler's return value is the hook
 * output. With no handler the response is `{}`, which Claude Code treats as
 * "no opinion".
 */

export type HookHandler = (payload: Record<string, unknown>, sessionKey: string) => unknown | Promise<unknown>

export type HookServerOpts = {
  /** Bearer token clients must send; random per daemon start. */
  authToken: string
  /** Keyed by route slug, e.g. `permission-request`. */
  handlers?: Record<string, HookHandler>
  /** 0 picks a free port. */
  port?: number
  log?: (line: string) => void
}

export function startHookServer(opts: HookServerOpts): { port: number; stop: () => void } {
  const log = opts.log ?? (line => process.stderr.write(line + '\n'))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    async fetch(req) {
      const event = new URL(req.url).pathname.match(/^\/hook\/([a-z-]+)$/)?.[1]
      if (!event || req.method !== 'POST') return new Response('not found', { status: 404 })
      if (req.headers.get('authorization') !== `Bearer ${opts.authToken}`) {
        return new Response('unauthorized', { status: 401 })
      }
      const key = req.headers.get('x-tg-session-key')
      if (!key) return new Response('missing session key', { status: 400 })

      let payload: Record<string, unknown>
      try {
        payload = await req.json() as Record<string, unknown>
      } catch {
        return new Response('bad json', { status: 400 })
      }
      log(`hook ${event} key=${key} session=${payload.session_id ?? '-'}`)

      const handler = opts.handlers?.[event]
      try {
        return Response.json(handler ? (await handler(payload, key)) ?? {} : {})
      } catch (err) {
        // Non-2xx is a non-blocking hook error: context hooks fail open, and an
        // unresolved PermissionRequest is a deny in -p, so approvals fail closed.
        log(`hook ${event} handler failed: ${err}`)
        return new Response('handler error', { status: 500 })
      }
    },
  })
  return { port: server.port!, stop: () => server.stop(true) }
}
