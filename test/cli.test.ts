import { expect, spyOn, test } from 'bun:test'
import pkg from '../package.json' with { type: 'json' }
import { commands, run } from '../cli'

// Stub table: records which handler ran with which args, never starts the daemon.
const stubs = () => {
  const calls: [string, string[]][] = []
  const table = Object.fromEntries(Object.keys(commands).map(k => [k, { usage: '', run: async (a: string[]) => { calls.push([k, a]) } }]))
  return { calls, table }
}
const quiet = () => [spyOn(process.stdout, 'write').mockImplementation(() => true), spyOn(process.stderr, 'write').mockImplementation(() => true)] as const

test('help, no args and -h print usage and exit 0', async () => {
  const [out, err] = quiet()
  for (const a of [[], ['help'], ['-h'], ['--help']]) expect(await run(a, stubs().table)).toBe(0)
  expect(String(out.mock.calls[0]![0])).toContain('reindex')
  out.mockRestore(); err.mockRestore()
})

test('--version prints the package version', async () => {
  const [out, err] = quiet()
  expect(await run(['--version'])).toBe(0)
  expect(await run(['-v'])).toBe(0)
  expect(out.mock.calls.map(c => c[0])).toEqual([`${pkg.version}\n`, `${pkg.version}\n`])
  out.mockRestore(); err.mockRestore()
})

test('routes start, reindex and memory to their handlers with the rest of argv', async () => {
  const { calls, table } = stubs()
  expect(await run(['start'], table)).toBe(0)
  expect(await run(['reindex'], table)).toBe(0)
  expect(await run(['memory', 'hook', 'on'], table)).toBe(0)
  expect(calls).toEqual([['start', []], ['reindex', []], ['memory', ['hook', 'on']]])
  expect(Object.keys(commands).sort()).toEqual(['memory', 'reindex', 'start'])
})

test('unknown command prints usage on stderr and exits 2', async () => {
  const [out, err] = quiet()
  const { calls, table } = stubs()
  expect(await run(['bogus'], table)).toBe(2)
  expect(String(err.mock.calls[0]![0])).toContain('unknown command: bogus')
  expect(calls).toEqual([])
  out.mockRestore(); err.mockRestore()
})
