import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadSources, saveSources, type Source } from '../watch/registry'
import { AgentPollSchema, backoffMs, createSupervisor, type Child, type Spawner } from '../watch/supervisor'
import type { Item } from '../watch/store'

const src = (id: string, kind: Source['kind'], command: string[], extra: Partial<Source> = {}): Source => ({
  id, title: id, kind, enabled: true, config: { command, env: { WACLI_X: '1' } }, cursor: null, status: 'ok', lastItemAt: null, errors: 0, ...extra,
})

/** A child whose stdout yields `chunks` and then exits with `code`. */
function fakeChild(chunks: string[], code: number): Child {
  const enc = new TextEncoder()
  return {
    pid: 1234,
    stdout: new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close() } }),
    exited: Promise.resolve(code),
    kill: () => {},
  }
}

test('backoff doubles from 1s and caps at 5 min', () => {
  expect([0, 1, 2, 3].map(backoffMs)).toEqual([1000, 2000, 4000, 8000])
  expect(backoffMs(20)).toBe(300_000)
})

test('stream: NDJSON lines reach onPayload; exits restart with growing backoff and count errors', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-watch-'))
  const sources = [src('telegram-account', 'stream', ['/Users/x/.local/bin/tgcli', 'watch', '--output', 'json'])]
  saveSources(stateDir, sources)
  const spawned: { cmd: string[]; env: Record<string, string>; stdout: boolean }[] = []
  const payloads: unknown[] = []
  const delays: number[] = []
  let sup: ReturnType<typeof createSupervisor>
  const spawn: Spawner = (cmd, env, stdout) => {
    spawned.push({ cmd, env, stdout })
    return spawned.length === 1 ? fakeChild(['{"a":', '1}\n{"b":2}\nnot json\n'], 1) : fakeChild([], 1)
  }
  sup = createSupervisor({
    stateDir, sources, spawn, log: () => {}, now: () => 0,
    onPayload: (_s, p) => payloads.push(p),
    sleep: async ms => { delays.push(ms); if (delays.length === 3) sup.stop() },
  })
  await sup.start(4321)
  expect(payloads).toEqual([{ a: 1 }, { b: 2 }])
  expect(spawned).toHaveLength(3)
  expect(spawned[0]).toEqual({ cmd: ['/Users/x/.local/bin/tgcli', 'watch', '--output', 'json'], env: { WACLI_X: '1' }, stdout: true })
  expect(delays).toEqual([1000, 2000, 4000])
  expect(loadSources(stateDir)[0]).toMatchObject({ errors: 3, status: 'error' })
})

test('backoff resets after a child stayed up for a minute', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-watch-'))
  const sources = [src('telegram-account', 'stream', ['tgcli', 'watch'])]
  saveSources(stateDir, sources)
  let t = 0
  const delays: number[] = []
  let sup: ReturnType<typeof createSupervisor>
  const runFor = [0, 0, 120_000]
  let n = 0
  sup = createSupervisor({
    stateDir, sources, log: () => {}, onPayload: () => {},
    now: () => t,
    spawn: () => { t += runFor[n++] ?? 0; return fakeChild([], 0) },
    sleep: async ms => { delays.push(ms); if (delays.length === 3) sup.stop() },
  })
  await sup.start(1)
  expect(delays).toEqual([1000, 2000, 1000])
})

test('webhook: fills {port} and {secret}, no stdout; disabled and unknown commands are not run', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-watch-'))
  const sources = [
    src('whatsapp', 'webhook', ['wacli', 'sync', '--follow', '--webhook', 'http://127.0.0.1:{port}/ingest/whatsapp', '--webhook-secret', '{secret}']),
    src('paused', 'stream', ['tgcli', 'watch'], { enabled: false }),
    src('mystery', 'stream', ['mystery-cli']),
  ]
  saveSources(stateDir, sources)
  const spawned: { cmd: string[]; stdout: boolean }[] = []
  const logs: string[] = []
  let sup: ReturnType<typeof createSupervisor>
  sup = createSupervisor({
    stateDir, sources, log: l => logs.push(l), onPayload: () => {}, now: () => 0,
    spawn: (cmd, _env, stdout) => { spawned.push({ cmd, stdout }); return { ...fakeChild([], 0), stdout: null } },
    sleep: async () => sup.stop(),
  })
  await sup.start(5555)
  const secret = sup.secretOf('whatsapp')!
  expect(secret).toMatch(/^[0-9a-f]{64}$/)
  expect(sup.secretOf('paused')).toBeUndefined()
  expect(spawned).toEqual([{ cmd: ['wacli', 'sync', '--follow', '--webhook', 'http://127.0.0.1:5555/ingest/whatsapp', '--webhook-secret', secret], stdout: false }])
  expect(logs).toContain('watch mystery: no adapter for its command; skipped')
})

test('a spawn that throws is retried with backoff instead of crashing', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-watch-'))
  const sources = [src('telegram-account', 'stream', ['tgcli', 'watch'])]
  saveSources(stateDir, sources)
  const delays: number[] = []
  let sup: ReturnType<typeof createSupervisor>
  sup = createSupervisor({
    stateDir, sources, log: () => {}, onPayload: () => {}, now: () => 0,
    spawn: () => { throw new Error('ENOENT') },
    sleep: async ms => { delays.push(ms); if (delays.length === 2) sup.stop() },
  })
  await sup.start(1)
  expect(delays).toEqual([1000, 2000])
})

test('poll: runs gh every interval with ?since=<cursor>, stores items and advances the cursor', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-watch-'))
  const sources = [{ ...src('github', 'poll', []), config: { command: ['gh', 'api', 'notifications', '--paginate'], intervalSec: 300 } }]
  saveSources(stateDir, sources)
  const page = (id: string, at: string) => JSON.stringify([{ id, reason: 'mention', updated_at: at, subject: { title: 't' + id, url: null, type: 'Issue' }, repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' } }])
  const outs = [page('1', '2026-10-12T01:00:00Z') + page('2', '2026-10-12T02:00:00Z'), '[]', 'oops']
  const cmds: string[][] = []
  const items: Item[] = []
  const delays: number[] = []
  let sup: ReturnType<typeof createSupervisor>
  sup = createSupervisor({
    stateDir, sources, log: () => {}, onPayload: () => {}, onItem: (_s, i) => items.push(i),
    spawn: cmd => { cmds.push(cmd); const o = outs[cmds.length - 1]!; return fakeChild([o], o === 'oops' ? 1 : 0) },
    sleep: async ms => { delays.push(ms); if (delays.length === 3) sup.stop() },
  })
  await sup.start(1)
  expect(items.map(i => i.extId)).toEqual(['1:2026-10-12T01:00:00Z', '2:2026-10-12T02:00:00Z'])
  expect(cmds[0]).toEqual(['gh', 'api', 'notifications', '--paginate'])
  expect(cmds[1]).toEqual(['gh', 'api', 'notifications?since=2026-10-12T02%3A00%3A00Z', '--paginate'])
  expect(delays).toEqual([300_000, 300_000, 300_000])
  expect(loadSources(stateDir)[0]).toMatchObject({ cursor: '2026-10-12T02:00:00Z', errors: 1 })
})

test('agent-poll: asks tg-poller with the connector tools and cursor; skipped without a poller', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-watch-'))
  const sources = [{ ...src('calendar', 'agent-poll', []), cursor: '2026-10-12T00:00:00Z', config: { connector: 'Google Calendar' } }]
  saveSources(stateDir, sources)
  const calls: { input: string; tools: string[] }[] = []
  const items: Item[] = []
  const delays: number[] = []
  let sup: ReturnType<typeof createSupervisor>
  sup = createSupervisor({
    stateDir, sources, log: () => {}, onPayload: () => {}, onItem: (_s, i) => items.push(i), now: () => Date.parse('2026-10-12T06:00:00Z'),
    runPoller: async (input, schema, tools) => {
      calls.push({ input, tools })
      return schema.parse({ items: [{ id: 'evt1', ts: '2026-10-12T09:00:00Z', title: 'Standup 09:00' }], cursor: '2026-10-12T06:00:00Z' })
    },
    sleep: async ms => { delays.push(ms); sup.stop() },
  })
  await sup.start(1)
  expect(calls[0]!.tools).toEqual(['mcp__claude_ai_Google_Calendar'])
  expect(calls[0]!.input).toContain('since 2026-10-12T00:00:00Z')
  expect(items).toEqual([{ source: 'calendar', extId: 'evt1', ts: Date.parse('2026-10-12T09:00:00Z'), from: { id: 'Google Calendar', name: 'Google Calendar' }, chat: { id: 'Google Calendar', name: 'Google Calendar', isGroup: false }, text: 'Standup 09:00', url: undefined, toMe: false, fromMe: false }])
  expect(delays).toEqual([1_800_000])
  expect(loadSources(stateDir)[0]!.cursor).toBe('2026-10-12T06:00:00Z')
  expect(AgentPollSchema.safeParse({ items: [] }).success).toBe(false)

  const logs: string[] = []
  await createSupervisor({ stateDir, sources, log: l => logs.push(l), onPayload: () => {} }).start(1)
  expect(logs).toEqual(['watch calendar: no connector or poller; skipped'])
})
