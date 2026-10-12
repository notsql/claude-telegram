import { afterAll, expect, test } from 'bun:test'
import { createHmac } from 'crypto'
import { startHookServer } from '../hooks/endpoint'
import { createIngestRoute, lineReader, verifySignature } from '../watch/ingest'

const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

test('verifySignature accepts the wacli X-Wacli-Signature form and rejects others', () => {
  const body = '{"ID":"1"}'
  expect(verifySignature('s3cret', body, sign('s3cret', body))).toBe(true)
  expect(verifySignature('s3cret', body, sign('other', body))).toBe(false)
  expect(verifySignature('s3cret', body + ' ', sign('s3cret', body))).toBe(false)
  expect(verifySignature('s3cret', body, null)).toBe(false)
  expect(verifySignature('s3cret', body, 'sha256=short')).toBe(false)
})

const stored: [string, unknown][] = []
const srv = startHookServer({
  authToken: 'hook-token',
  log: () => {},
  ingest: createIngestRoute({
    secretOf: id => (id === 'whatsapp' ? 'k' : undefined),
    header: () => 'x-wacli-signature',
    store: (id, p) => { stored.push([id, p]) },
    log: () => {},
  }),
})
afterAll(() => srv.stop())

const post = (id: string, body: string, sig?: string) => fetch(`http://127.0.0.1:${srv.port}/ingest/${id}`, {
  method: 'POST', body, headers: sig ? { 'x-wacli-signature': sig } : {},
})

test('/ingest/<id> stores a correctly signed body and rejects the rest', async () => {
  const body = JSON.stringify({ ID: 'a' })
  expect((await post('whatsapp', body, sign('k', body))).status).toBe(204)
  expect(stored).toEqual([['whatsapp', { ID: 'a' }]])
  expect((await post('whatsapp', body, sign('wrong', body))).status).toBe(401)
  expect((await post('whatsapp', body)).status).toBe(401)
  expect((await post('unknown', body, sign('k', body))).status).toBe(404)
  expect((await post('whatsapp', 'nope', sign('k', 'nope'))).status).toBe(400)
  expect(stored).toHaveLength(1)
})

test('hook routes keep their bearer check alongside ingest', async () => {
  const res = await fetch(`http://127.0.0.1:${srv.port}/hook/stop`, { method: 'POST', body: '{}' })
  expect(res.status).toBe(401)
})

test('lineReader joins lines split across chunks, including multibyte characters', () => {
  const lines: string[] = []
  const r = lineReader(l => lines.push(l))
  const bytes = new TextEncoder().encode('{"a":1}\n{"t":"héllo"}\n\n{"b"')
  const cut = bytes.indexOf(0xc3) + 1 // split inside the é
  r.push(bytes.slice(0, 3))
  r.push(bytes.slice(3, cut))
  r.push(bytes.slice(cut))
  expect(lines).toEqual(['{"a":1}', '{"t":"héllo"}'])
  r.push(new TextEncoder().encode(':2}'))
  r.end()
  expect(lines).toEqual(['{"a":1}', '{"t":"héllo"}', '{"b":2}'])
})
