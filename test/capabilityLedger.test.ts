import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  capabilityId, findCapability, isSkipped, ledgerPath, loadLedger, saveLedger, SKIP_MS, type Capability,
} from '../capabilities/ledger'
import { defaultPolicy, PolicySchema } from '../policy/schema'

const dir = () => mkdtempSync(join(tmpdir(), 'tg-caps-'))
const cap: Capability = {
  id: 'cli:imagemagick', kind: 'cli', name: 'imagemagick', tier: 'T1', source: 'homebrew-core',
  install: ['brew', 'install', 'imagemagick'], approvedAt: 1, approvedBy: '123', installedAt: 2,
  status: 'installed', skippedUntil: null, skill: 'use-imagemagick', usedCount: 0, lastUsed: null,
}

test('missing file loads as an empty ledger', () => {
  expect(loadLedger(dir())).toEqual([])
})

test('save then load round-trips and leaves no temp file', () => {
  const d = dir()
  saveLedger(d, [cap])
  expect(loadLedger(d)).toEqual([cap])
  expect(existsSync(`${ledgerPath(d)}.tmp`)).toBe(false)
})

test('invalid entries are rejected on load and save', () => {
  const d = dir()
  writeFileSync(ledgerPath(d), JSON.stringify({ capabilities: [{ ...cap, status: 'maybe' }] }))
  expect(() => loadLedger(d)).toThrow()
  expect(() => saveLedger(d, [{ ...cap, kind: 'gem' } as unknown as Capability])).toThrow()
})

test('lookup by kind:name', () => {
  expect(capabilityId('mcp', 'notion')).toBe('mcp:notion')
  expect(findCapability([cap], 'cli', 'imagemagick')).toBe(cap)
  expect(findCapability([cap], 'mcp', 'imagemagick')).toBeUndefined()
})

test('skip lasts until skippedUntil', () => {
  const now = 1_000
  const skipped: Capability = { ...cap, status: 'skipped', skippedUntil: now + SKIP_MS }
  expect(isSkipped(skipped, now)).toBe(true)
  expect(isSkipped(skipped, now + SKIP_MS)).toBe(false)
  expect(isSkipped(cap, now)).toBe(false)
  expect(isSkipped(undefined, now)).toBe(false)
})

test('capabilityAcquisition defaults: ask in DM, off in groups', () => {
  expect(defaultPolicy('private').capabilityAcquisition).toBe('ask')
  expect(defaultPolicy('group').capabilityAcquisition).toBe('off')
  expect(PolicySchema.safeParse({ capabilityAcquisition: 'auto' }).success).toBe(false)
})
