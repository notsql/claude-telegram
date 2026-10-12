/**
 * `source_add` proposals (013 FR9): a built-in config from the plan, or a
 * custom one whose command has an adapter. The command's binary is resolved
 * to an absolute path (launchd's PATH is minimal); a missing binary is handed
 * to `capability_request` (012) by the agent, which then calls `source_add`
 * again from the resume turn.
 */

import { basename } from 'path'
import { ADAPTERS, POLL_ADAPTERS } from './supervisor.ts'
import type { Source } from './registry.ts'

type Proposal = Pick<Source, 'id' | 'title' | 'kind' | 'config'>

export const BUILTINS: Record<string, Proposal> = {
  whatsapp: { id: 'whatsapp', title: 'WhatsApp', kind: 'webhook', config: { command: ['wacli', 'sync', '--follow', '--presence-mode', 'quiet', '--webhook', 'http://127.0.0.1:{port}/ingest/whatsapp', '--webhook-allow-private', '--webhook-secret', '{secret}'] } },
  'telegram-account': { id: 'telegram-account', title: 'Telegram account', kind: 'stream', config: { command: ['tgcli', 'watch', '--output', 'json'] } },
  github: { id: 'github', title: 'GitHub', kind: 'poll', config: { command: ['gh', 'api', 'notifications', '--paginate'], intervalSec: 300 } },
  calendar: { id: 'calendar', title: 'Calendar', kind: 'agent-poll', config: { connector: 'Google Calendar', intervalSec: 1800 } },
}

export type SourceArgs = {
  builtin?: string
  id?: string
  title?: string
  kind?: string
  command?: unknown
  connector?: string
  intervalSec?: number
  expectSilenceMaxSec?: number
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** A ready-to-add source, or an error (or capability handoff) message for the agent. */
export function propose(a: SourceArgs, which: (bin: string) => string | null): { source: Source } | { error: string } {
  let p: Proposal
  if (a.builtin) {
    const b = BUILTINS[a.builtin]
    if (!b) return { error: `unknown builtin "${a.builtin}"; one of ${Object.keys(BUILTINS).join(', ')}` }
    p = structuredClone(b)
    if (a.title) p.title = a.title
  } else {
    const title = String(a.title ?? '').trim()
    const id = a.id ?? slug(title)
    if (!title || !id) return { error: 'title is required' }
    if (a.kind === 'agent-poll') {
      if (!a.connector?.trim()) return { error: 'agent-poll needs connector (the claude.ai connector name, e.g. "Microsoft Outlook")' }
      p = { id, title, kind: 'agent-poll', config: { connector: a.connector.trim() } }
    } else if (a.kind === 'stream' || a.kind === 'webhook' || a.kind === 'poll') {
      const cmd = a.command
      if (!Array.isArray(cmd) || !cmd.length || !cmd.every(x => typeof x === 'string')) return { error: 'command must be a non-empty argv array' }
      const bin = basename(cmd[0]!)
      if (!(a.kind === 'poll' ? POLL_ADAPTERS : ADAPTERS)[bin]) return { error: `no ${a.kind} adapter for ${bin}; use a builtin, or kind agent-poll with a connector` }
      p = { id, title, kind: a.kind, config: { command: cmd } }
    } else return { error: 'kind must be stream, webhook, poll or agent-poll (or pass builtin)' }
  }
  if (a.intervalSec !== undefined) p.config.intervalSec = a.intervalSec
  if (a.expectSilenceMaxSec !== undefined) p.config.expectSilenceMaxSec = a.expectSilenceMaxSec
  const cmd = p.config.command as string[] | undefined
  if (cmd) {
    const bin = cmd[0]!
    const abs = bin.startsWith('/') ? bin : which(bin)
    if (!abs) {
      return { error: `${basename(bin)} is not installed. Find it with tg-capability-scout, call capability_request with resume "call source_add ${JSON.stringify(a)} again", then end the turn.` }
    }
    p.config.command = [abs, ...cmd.slice(1)]
  }
  return { source: { ...p, enabled: true, cursor: null, status: 'ok', lastItemAt: null, errors: 0 } }
}
