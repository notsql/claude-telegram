/**
 * Item ingest (013 FR1): the `/ingest/<id>` webhook route served on the hook
 * endpoint, checked by HMAC instead of the hook bearer token, and the NDJSON
 * line reader for `stream` sources. Both end in `store`, which maps a payload
 * through the source's adapter and inserts it (deduped).
 */

import { createHmac, timingSafeEqual } from 'crypto'

/** `X-Wacli-Signature`-style check: `sha256=<hex HMAC-SHA256 of the raw body>`. */
export function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!header) return false
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const got = Buffer.from(header)
  return got.length === want.length && timingSafeEqual(got, want)
}

export type IngestRoute = (id: string, req: Request) => Promise<Response>

/**
 * `secretOf(id)` is the source's webhook secret, or undefined when `id` is not
 * a running webhook source. `store` receives the parsed body.
 */
export function createIngestRoute(opts: {
  secretOf: (id: string) => string | undefined
  header: (id: string) => string
  store: (id: string, payload: unknown) => void
  log: (line: string) => void
}): IngestRoute {
  return async (id, req) => {
    const secret = opts.secretOf(id)
    if (!secret || req.method !== 'POST') return new Response('not found', { status: 404 })
    const body = await req.text()
    if (!verifySignature(secret, body, req.headers.get(opts.header(id)))) {
      opts.log(`ingest ${id}: bad signature`)
      return new Response('unauthorized', { status: 401 })
    }
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      return new Response('bad json', { status: 400 })
    }
    try {
      opts.store(id, payload)
    } catch (err) {
      opts.log(`ingest ${id}: store failed: ${err}`)
      return new Response('store error', { status: 500 })
    }
    return new Response(null, { status: 204 })
  }
}

/** Splits a byte stream into lines, holding a partial line until its newline arrives. */
export function lineReader(onLine: (line: string) => void): { push: (chunk: Uint8Array) => void; end: () => void } {
  const decoder = new TextDecoder()
  let buf = ''
  const flush = (rest: string) => {
    const lines = rest.split('\n')
    buf = lines.pop()!
    for (const l of lines) if (l.trim()) onLine(l)
  }
  return {
    push: chunk => flush(buf + decoder.decode(chunk, { stream: true })),
    end: () => {
      const last = buf + decoder.decode()
      buf = ''
      if (last.trim()) onLine(last)
    },
  }
}
