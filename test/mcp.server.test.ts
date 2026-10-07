import { afterAll, expect, test } from 'bun:test'
import { Api } from 'grammy'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startMcpServer } from '../mcp/server'
import { createMemoryStore } from '../memory/store'
import { createMemoryTools } from '../memory/tools'

const srv = startMcpServer({ authToken: 'secret', api: new Api('0:x'), botToken: '0:x', memory: createMemoryTools(createMemoryStore(mkdtempSync(join(tmpdir(), 'tg-mem-'))), () => { throw new Error('unused') }) })
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

test('rejects a malformed session key', async () => {
  const res = await fetch(url.replace('key=123', 'key=abc'), { method: 'POST', headers: { authorization: 'Bearer secret' } })
  expect(res.status).toBe(400)
})

test('lists the telegram and memory tools with the token', async () => {
  const res = await listTools({ authorization: 'Bearer secret' })
  expect(res.status).toBe(200)
  const body = await res.json() as { result: { tools: { name: string }[] } }
  expect(body.result.tools.map(t => t.name)).toEqual([
    'reply', 'react', 'download_attachment', 'edit_message',
    'memory_write', 'memory_update', 'memory_search', 'memory_read', 'memory_delete',
  ])
})

test('a tool after an async handler is still reached (007 schedule_* regression)', async () => {
  const policy = { list: () => [] }
  const s = startMcpServer({
    authToken: 'secret', api: new Api('0:x'), botToken: '0:x',
    memory: createMemoryTools(createMemoryStore(mkdtempSync(join(tmpdir(), 'tg-mem-'))), () => { throw new Error('unused') }),
    history: { ...policy, call: async () => undefined } as any,
    scheduler: { ...policy, call: (name: string) => name === 'schedule_list' ? { content: [{ type: 'text', text: 'no jobs' }] } : undefined } as any,
  })
  const res = await fetch(`http://127.0.0.1:${s.port}/mcp?key=123`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'schedule_list', arguments: {} } }),
  })
  s.stop()
  expect(((await res.json()) as any).result.content[0].text).toBe('no jobs')
})
