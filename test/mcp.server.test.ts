import { afterAll, expect, test } from 'bun:test'
import { Api } from 'grammy'
import { startMcpServer } from '../mcp/server'

const srv = startMcpServer({ authToken: 'secret', api: new Api('0:x'), botToken: '0:x' })
const url = `http://127.0.0.1:${srv.port}/mcp?key=123`
afterAll(() => srv.stop())

const listTools = (headers: Record<string, string>) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
})

test('rejects requests without the bearer token (AC8)', async () => {
  expect((await listTools({})).status).toBe(401)
  expect((await listTools({ authorization: 'Bearer wrong' })).status).toBe(401)
})

test('rejects requests without a session key', async () => {
  const res = await fetch(url.replace('?key=123', ''), { method: 'POST', headers: { authorization: 'Bearer secret' } })
  expect(res.status).toBe(400)
})

test('lists the telegram tools with the token', async () => {
  const res = await listTools({ authorization: 'Bearer secret' })
  expect(res.status).toBe(200)
  const body = await res.json() as { result: { tools: { name: string }[] } }
  expect(body.result.tools.map(t => t.name)).toEqual(['reply', 'react', 'download_attachment', 'edit_message'])
})
