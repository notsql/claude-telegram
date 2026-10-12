/**
 * Acquired capabilities in `STATE_DIR/capabilities.json` (012 FR10), written atomically.
 * Entries are keyed by `kind:name` so approval and Skip carry across chats (FR5).
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { writeJson } from '../util/files.ts'

const Kind = z.enum(['cli', 'mcp', 'plugin'])
export type CapabilityKind = z.infer<typeof Kind>

const CapabilitySchema = z.object({
  /** `kind:name`. */
  id: z.string(),
  kind: Kind,
  name: z.string(),
  tier: z.enum(['T1', 'T2', 'T3']),
  source: z.string(),
  /** Install argv as run, without a shell. */
  install: z.array(z.string()),
  /** The paired uninstall argv (templates.ts), run by Undo; null when there is none. */
  uninstall: z.array(z.string()).nullable().optional(),
  approvedAt: z.number().nullable(),
  approvedBy: z.string().nullable(),
  installedAt: z.number().nullable(),
  status: z.enum(['installed', 'skipped', 'failed', 'uninstalled']),
  /** Epoch ms; a `skipped` entry suppresses the card until then (FR5). */
  skippedUntil: z.number().nullable(),
  skill: z.string().optional(),
  usedCount: z.number().int().nonnegative(),
  lastUsed: z.number().nullable(),
})

export type Capability = z.infer<typeof CapabilitySchema>

const LedgerFileSchema = z.object({ capabilities: z.array(CapabilitySchema) })

export const SKIP_MS = 30 * 24 * 60 * 60 * 1000

export const ledgerPath = (stateDir: string) => join(stateDir, 'capabilities.json')
export const capabilityId = (kind: CapabilityKind, name: string) => `${kind}:${name}`

/** Missing file means an empty ledger. A corrupt file throws rather than being silently overwritten. */
export function loadLedger(stateDir: string): Capability[] {
  const path = ledgerPath(stateDir)
  if (!existsSync(path)) return []
  return LedgerFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).capabilities
}

export function saveLedger(stateDir: string, capabilities: Capability[]): void {
  writeJson(ledgerPath(stateDir), LedgerFileSchema.parse({ capabilities }))
}

export function findCapability(ledger: Capability[], kind: CapabilityKind, name: string): Capability | undefined {
  const id = capabilityId(kind, name)
  return ledger.find(c => c.id === id)
}

export function isSkipped(c: Capability | undefined, now = Date.now()): boolean {
  return c?.status === 'skipped' && c.skippedUntil !== null && c.skippedUntil > now
}

/** FR9: the skill a capability's first successful use is learned under. */
export function useSkillName(c: Pick<Capability, 'name'>): string {
  return `use-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 48).replace(/-+$/, '')
}

/** Installed capabilities with no skill yet, for the reflection pass (FR9). */
export const unlearned = (ledger: Capability[]) => ledger.filter(c => c.status === 'installed' && !c.skill)

/** Links a newly learned `use-<name>` skill to its ledger entry (FR9), so rung 1 finds it. True if one was linked. */
export function linkSkill(stateDir: string, skill: string): boolean {
  const ledger = loadLedger(stateDir)
  const c = unlearned(ledger).find(c => useSkillName(c) === skill)
  if (!c) return false
  c.skill = skill
  saveLedger(stateDir, ledger)
  return true
}
