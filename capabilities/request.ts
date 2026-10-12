/**
 * `capability_request` (012 FR5, FR11): a card in the owner DM with Install /
 * Details / Skip. The daemon installs on Install (FR6) and records the answer
 * in the ledger per `kind:name`, so an installed capability is never asked
 * for again and a Skip holds for 30 days. No answer within 24h is a Skip
 * (fail closed, constitution IV). Pending cards are in memory only.
 */

import { InlineKeyboard, type Api } from 'grammy'
import { randomBytes } from 'crypto'
import type { Policy } from '../policy/schema.ts'
import { buildCommands, type Candidate, type Commands } from './templates.ts'
import type { InstallResult } from './install.ts'
import {
  capabilityId, findCapability, isSkipped, loadLedger, saveLedger, SKIP_MS,
  type Capability, type CapabilityKind,
} from './ledger.ts'

export const REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000

export type Tier = Capability['tier']

export type CapabilityRequest = {
  candidate: Candidate & { tier: Tier; source: string; publisher?: string; homepage?: string; why?: string }
  reason: string
  resume: string
}

/** Template kinds collapse to the ledger's kinds: anything that puts a command on PATH is a `cli`. */
export const ledgerKind = (c: Candidate): CapabilityKind => (c.kind === 'mcp' || c.kind === 'plugin' ? c.kind : 'cli')

type Pending = {
  req: CapabilityRequest
  commands: Commands
  messageId?: number
  timer: ReturnType<typeof setTimeout>
}

export type RequestDeps = {
  api: Api
  stateDir: string
  /** Owner ids (access.allowFrom); the first one's DM gets the card. */
  owners: () => string[]
  /** Telegram user id of whoever sent the key's current turn. */
  sender: (key: string) => string | undefined
  /** Runs an install argv (install.ts `runArgv`, stubbed in tests). */
  install: (argv: string[]) => Promise<InstallResult>
  timeoutMs?: number
  now?: () => number
}

export type Outcome = { ok: boolean; text: string }

export function createCapabilityRequests(deps: RequestDeps) {
  const pending = new Map<string, Pending>()
  const now = () => deps.now?.() ?? Date.now()

  function record(req: CapabilityRequest, commands: Commands, patch: Partial<Capability>): void {
    const kind = ledgerKind(req.candidate)
    const ledger = loadLedger(deps.stateDir)
    const prev = findCapability(ledger, kind, req.candidate.name)
    const entry: Capability = {
      id: capabilityId(kind, req.candidate.name), kind, name: req.candidate.name,
      tier: req.candidate.tier, source: req.candidate.source, install: commands.install,
      approvedAt: null, approvedBy: null, installedAt: null, status: 'skipped', skippedUntil: null,
      usedCount: 0, lastUsed: null,
      ...prev && { usedCount: prev.usedCount, lastUsed: prev.lastUsed, ...prev.skill && { skill: prev.skill } },
      ...patch,
    }
    saveLedger(deps.stateDir, [...ledger.filter(c => c.id !== entry.id), entry])
  }

  function card(p: Pick<Pending, 'req' | 'commands'>): string {
    const c = p.req.candidate
    return [
      `🧩 Capability request: ${c.name} (${ledgerKind(c)}, ${c.tier})`,
      `Source: ${c.source}${c.publisher ? ` · ${c.publisher}` : ''}`,
      `Why: ${p.req.reason}`,
      // AC4: T3 shows the exact command on the card itself.
      ...c.tier === 'T3' ? [`Command: ${p.commands.install.join(' ')}`] : [],
    ].join('\n')
  }

  const keyboard = (id: string, tier: Tier) => new InlineKeyboard()
    .text(tier === 'T3' ? '▶️ Run exact command' : '✅ Install', `cap:install:${id}`)
    .text('Details', `cap:details:${id}`)
    .text('Skip', `cap:skip:${id}`)

  function skip(id: string, p: Pending): void {
    clearTimeout(p.timer)
    pending.delete(id)
    record(p.req, p.commands, { status: 'skipped', skippedUntil: now() + SKIP_MS })
  }

  return {
    /** Validates and posts the card; the turn ends while it waits. Returns the tool's answer text. */
    async request(key: string, policy: Policy, req: CapabilityRequest): Promise<Outcome> {
      if (policy.capabilityAcquisition !== 'ask') return { ok: false, text: 'Capability acquisition is off in this chat. Tell the user what is missing instead.' }
      const owners = deps.owners()
      const sender = deps.sender(key)
      // FR11 / AC8: only an owner's turn may ask, and the card only ever goes to the owner DM.
      if (!owners[0] || !sender || !owners.includes(sender))
        return { ok: false, text: 'Only the owner can approve installs. Suggest the capability to the user; the owner can ask for it in their DM.' }
      let commands: Commands
      try {
        commands = buildCommands(req.candidate)
      } catch (err) {
        return { ok: false, text: `Rejected: ${(err as Error).message}` }
      }
      const kind = ledgerKind(req.candidate)
      const prev = findCapability(loadLedger(deps.stateDir), kind, req.candidate.name)
      if (prev?.status === 'installed') return { ok: true, text: `${prev.id} is already installed and approved; use it.` }
      if (isSkipped(prev, now())) return { ok: false, text: `The owner skipped ${prev!.id} until ${new Date(prev!.skippedUntil!).toISOString()}; don't ask again before then.` }
      const open = [...pending.values()].find(p => ledgerKind(p.req.candidate) === kind && p.req.candidate.name === req.candidate.name)
      if (open) return { ok: true, text: 'A request for this capability is already waiting for the owner.' }

      const id = randomBytes(4).toString('hex')
      const owner = owners[0]
      const p: Pending = { req, commands, timer: setTimeout(() => {
        if (!pending.has(id)) return
        skip(id, p)
        if (p.messageId != null) void deps.api.editMessageText(owner, p.messageId, `${card(p)}\n\n⌛ No answer; skipped`).catch(() => {})
      }, deps.timeoutMs ?? REQUEST_TIMEOUT_MS) }
      pending.set(id, p)
      try {
        const m = await deps.api.sendMessage(owner, card(p), { reply_markup: keyboard(id, req.candidate.tier) })
        p.messageId = m.message_id
      } catch (err) {
        clearTimeout(p.timer)
        pending.delete(id)
        return { ok: false, text: `Could not reach the owner: ${(err as Error).message}` }
      }
      return { ok: true, text: 'Waiting for approval: the owner has an Install card in their DM. End the turn here.' }
    },

    /** The full card for Details: every field the scout gave, plus the exact argv. */
    details(id: string): string | undefined {
      const p = pending.get(id)
      if (!p) return undefined
      const { candidate, resume } = p.req
      return [card(p), `Install: ${p.commands.install.join(' ')}`,
        ...p.commands.uninstall ? [`Undo: ${p.commands.uninstall.join(' ')}`] : [],
        ...candidate.homepage ? [`Homepage: ${candidate.homepage}`] : [],
        ...candidate.why ? [`Notes: ${candidate.why}`] : [],
        `Then: ${resume}`].join('\n')
    },

    /** Owner's answer. Undefined if unknown or already decided. Install never throws; failure is recorded. */
    async decide(id: string, action: 'install' | 'skip', by: string): Promise<Outcome | undefined> {
      const p = pending.get(id)
      if (!p) return undefined
      if (action === 'skip') {
        skip(id, p)
        return { ok: true, text: 'Skipped for 30 days' }
      }
      clearTimeout(p.timer)
      pending.delete(id)
      const at = now()
      const r = await deps.install(p.commands.install)
      record(p.req, p.commands, {
        status: r.ok ? 'installed' : 'failed', approvedAt: at, approvedBy: by,
        installedAt: r.ok ? now() : null, skippedUntil: null,
      })
      return r.ok
        ? { ok: true, text: '✅ Installed' }
        : { ok: false, text: `❌ Install failed${r.timedOut ? ' (timed out)' : ''}${r.output ? `:\n${r.output.slice(-1000)}` : ''}` }
    },
  }
}

export type CapabilityRequests = ReturnType<typeof createCapabilityRequests>
