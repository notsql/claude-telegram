import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadSources, saveSources, type Source } from '../watch/registry'
import { backoffMs, createSupervisor, type Child, type Spawner } from '../watch/supervisor'

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

test('webhook: fills {port} and {secret}, no stdout; disabled, poll and unknown commands are not run', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tg-watch-'))
  const sources = [
    src('whatsapp', 'webhook', ['wacli', 'sync', '--follow', '--webhook', 'http://127.0.0.1:{port}/ingest/whatsapp', '--webhook-secret', '{secret}']),
    src('paused', 'stream', ['tgcli', 'watch'], { enabled: false }),
    src('github', 'poll', ['gh', 'api', 'notifications']),
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
