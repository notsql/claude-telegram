import { afterAll, expect, test } from 'bun:test'
import { startHookServer } from '../hooks/endpoint'
import { hookSlug, renderHookSettings } from '../hooks/settings'

const seen: string[] = []
const srv = startHookServer({
  authToken: 'secret',
  handlers: { 'user-prompt-submit': (_p, key) => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `key ${key}` } }) },
  log: line => seen.push(line),
})
afterAll(() => srv.stop())

const post = (event: string, headers: Record<string, string>) => fetch(`http://127.0.0.1:${srv.port}/hook/${event}`, {
  method: 'POST', headers, body: JSON.stringify({ session_id: 's1' }),
})
const auth = { authorization: 'Bearer secret', 'x-tg-session-key': '123' }

test('rejects requests without the bearer token (AC8)', async () => {
  expect((await post('stop', {})).status).toBe(401)
  expect((await post('stop', { ...auth, authorization: 'Bearer wrong' })).status).toBe(401)
})

test('rejects requests without a session key', async () => {
  expect((await post('stop', { authorization: 'Bearer secret' })).status).toBe(400)
})

test('logs the event and answers {} with no handler', async () => {
  const res = await post('stop', auth)
  expect(await res.json()).toEqual({})
  expect(seen).toContain('hook stop key=123 session=s1')
})

test('returns the registered handler output', async () => {
  const body = await (await post('user-prompt-submit', auth)).json() as any
  expect(body.hookSpecificOutput.additionalContext).toBe('key 123')
})

test('renders literal port, approval timeout and async observational hooks', () => {
  const { hooks } = renderHookSettings({ port: 4321, approvalTimeoutSec: 300 }) as any
  expect(hookSlug('PermissionRequest')).toBe('permission-request')
  expect(hooks.PermissionRequest[0].hooks[0]).toMatchObject({ url: 'http://127.0.0.1:4321/hook/permission-request', timeout: 330 })
  expect(hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(30)
  expect(hooks.Stop[0].hooks[0].async).toBe(true)
  expect(hooks.PreToolUse[0].hooks[0].async).toBeUndefined()
  expect(hooks.SessionStart[0].hooks[0].type).toBe('command')
})

test('disables the Telegram channel plugin so turns never start a second poller', () => {
  const settings = renderHookSettings({ port: 4321, approvalTimeoutSec: 300 }) as any
  expect(settings.enabledPlugins).toEqual({ 'telegram@claude-plugins-official': false })
})

test('a handler may hold the request past the 10s idle default', async () => {
  const slow = startHookServer({
    authToken: 't',
    handlers: { 'permission-request': () => new Promise(r => setTimeout(() => r({ ok: 1 }), 11_000)) },
    log: () => {},
  })
  try {
    const res = await fetch(`http://127.0.0.1:${slow.port}/hook/permission-request`, {
      method: 'POST', headers: { authorization: 'Bearer t', 'x-tg-session-key': '1' }, body: '{}',
    })
    expect(await res.json()).toEqual({ ok: 1 })
  } finally { slow.stop() }
}, 15_000)
