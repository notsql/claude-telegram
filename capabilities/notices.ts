/**
 * Ledger notices (012 FR10): "🧩 Installed imagemagick" in the 📍 Updates chat with
 * **Undo** (`cap:undo:<id>`), which runs the paired uninstall argv, marks the
 * entry `uninstalled` and archives its `use-<name>` skill (constitution V).
 * `/caps` (US5) lists the ledger with the same button on installed entries.
 * Handles live in memory, so they lapse on daemon restart; `/caps` makes new ones.
 */

import { randomBytes } from 'crypto'
import type { Api } from 'grammy'
import { parseKey } from '../sessions/key.ts'
import type { InstallResult } from './install.ts'
import { loadLedger, saveLedger, type Capability } from './ledger.ts'

const MAX_PENDING = 200

export type CapabilityNoticeDeps = {
  api: Pick<Api, 'sendMessage'>
  stateDir: string
  /** Runs an uninstall argv (install.ts `runArgv`, stubbed in tests). */
  uninstall: (argv: string[]) => Promise<InstallResult>
  /** Moves a learned skill to the archive. */
  archiveSkill: (name: string) => void
}

const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : '?')

export function createCapabilityNotices(deps: CapabilityNoticeDeps) {
  const handles = new Map<string, string>()
  const running = new Set<string>()

  function button(capId: string, text: string) {
    const h = randomBytes(6).toString('hex')
    handles.set(h, capId)
    if (handles.size > MAX_PENDING) handles.delete(handles.keys().next().value!)
    return { text, callback_data: `cap:undo:${h}` }
  }

  return {
    /** Posts to session key `to` (the 📍 Updates chat). */
    notify(to: string, c: Capability): Promise<unknown> {
      const t = parseKey(to)
      return deps.api.sendMessage(t.chatId, `🧩 Installed ${c.name} (${c.kind}, ${c.tier}): ${c.install.join(' ')}`, {
        ...(t.threadId != null && { message_thread_id: t.threadId }),
        reply_markup: { inline_keyboard: [[button(c.id, '↩️ Undo')]] },
      }).catch(() => {})
    },

    /** `/caps`: every ledger entry with how and when, and Uninstall on installed ones. */
    list(): { text: string; keyboard?: { inline_keyboard: { text: string; callback_data: string }[][] } } {
      const ledger = loadLedger(deps.stateDir)
      if (!ledger.length) return { text: 'No capabilities acquired yet.' }
      const lines = ledger.map(c => `• ${c.name} (${c.kind}, ${c.tier}): ${c.status}`
        + (c.installedAt ? `, installed ${day(c.installedAt)} via ${c.install.join(' ')}` : '')
        + (c.skill ? `, skill ${c.skill}` : ''))
      const rows = ledger.filter(c => c.status === 'installed').map(c => [button(c.id, `🗑 Uninstall ${c.name}`)])
      return { text: `🧩 Capabilities\n\n${lines.join('\n')}`, ...(rows.length && { keyboard: { inline_keyboard: rows } }) }
    },

    /** Runs the uninstall once; the label to show, or undefined when the handle is gone or busy. */
    async undo(h: string): Promise<string | undefined> {
      const id = handles.get(h)
      if (!id || running.has(id)) return undefined
      const c = loadLedger(deps.stateDir).find(c => c.id === id)
      if (c?.status !== 'installed') return `${id} is not installed`
      if (!c.uninstall) return `No uninstall command is recorded for ${c.name}; remove it by hand.`
      running.add(id)
      let r: InstallResult
      try {
        r = await deps.uninstall(c.uninstall)
      } finally {
        running.delete(id)
      }
      if (!r.ok) return `❌ Uninstall failed${r.timedOut ? ' (timed out)' : ''}${r.output ? `:\n${r.output.slice(-1000)}` : ''}`
      handles.delete(h)
      const ledger = loadLedger(deps.stateDir)
      const entry = ledger.find(e => e.id === id)!
      const skill = entry.skill
      entry.status = 'uninstalled'
      delete entry.skill
      saveLedger(deps.stateDir, ledger)
      let archived = false
      if (skill) {
        try { deps.archiveSkill(skill); archived = true } catch { /* already gone */ }
      }
      return `↩️ Uninstalled ${c.name}${archived ? `; archived skill ${skill}` : ''}`
    },
  }
}

export type CapabilityNotices = ReturnType<typeof createCapabilityNotices>
