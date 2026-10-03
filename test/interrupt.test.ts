import { describe, expect, test } from 'bun:test'
import { interruptChild } from '../agent/runner'

// A child that logs each signal it receives and ignores the ones listed.
const spawnChild = (ignore: string[]) => Bun.spawn(['bun', '-e', `
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => {
    console.log(s)
    if (!${JSON.stringify(ignore)}.includes(s)) process.exit(0)
  })
  console.log('ready')
  setInterval(() => {}, 1000)
`], { stdout: 'pipe' })

async function interrupt(ignore: string[]) {
  const child = spawnChild(ignore)
  const reader = child.stdout.getReader()
  await reader.read() // 'ready': handlers are installed
  const start = Date.now()
  interruptChild(child, 300, 300)
  const code = await child.exited
  let out = ''
  for (let r = await reader.read(); !r.done; r = await reader.read()) out += new TextDecoder().decode(r.value)
  return { code, signal: child.signalCode, out, ms: Date.now() - start }
}

describe('interruptChild (FR8)', () => {
  test('SIGINT alone ends a cooperative child', async () => {
    const r = await interrupt([])
    expect(r.code).toBe(0)
    expect(r.out.trim()).toBe('SIGINT')
    expect(r.ms).toBeLessThan(300)
  })

  test('escalates to SIGTERM when SIGINT is ignored', async () => {
    const r = await interrupt(['SIGINT'])
    expect(r.out.trim().split('\n')).toEqual(['SIGINT', 'SIGTERM'])
    expect(r.code).toBe(0)
  })

  test('escalates to SIGKILL when SIGINT and SIGTERM are ignored', async () => {
    const r = await interrupt(['SIGINT', 'SIGTERM'])
    expect(r.signal).toBe('SIGKILL')
    expect(r.ms).toBeGreaterThanOrEqual(600)
  })
})
