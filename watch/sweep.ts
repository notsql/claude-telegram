/**
 * Attention sweep (013 FR14). Watchers only see what is new; the sweep looks
 * for what is still waiting on the owner. The `attention-sweep` system job
 * asks each enabled source:
 *   - `poll` GitHub: open PRs awaiting the owner's review and open issues and
 *     PRs assigned to them, through `gh search` (no model call).
 *   - `agent-poll`: a one-shot `tg-poller` with only that connector's tools,
 *     asked for open tasks, requests waiting on a reply, invites to answer and
 *     anything due or overdue within two days.
 * `stream` and `webhook` chats are already covered by open loops (FR8).
 *
 * Each finding is stored as its own `action` item with ext id `sweep:<id>`, so
 * delivery (FR7) runs it through the summary check once and dedupe keeps it
 * from coming back; an unhandled one later shows up under the digest's loops.
 * A failed source is logged and skipped.
 */

import type { Database } from 'bun:sqlite'
import { basename } from 'path'
import { insertItem, type Item } from './store.ts'
import type { Source } from './registry.ts'
import { AgentPollSchema, connectorTools, type RunPoller } from './supervisor.ts'
import type { z } from 'zod'

export type Exec = (cmd: string[]) => Promise<string>

export type SweepOpts = {
  db: Database
  sources: Source[]
  runPoller: RunPoller
  exec?: Exec
  now?: () => number
  log?: (msg: string) => void
}

type GhHit = { title: string; url: string; updatedAt: string; repository: { nameWithOwner: string } }

const GH_FIELDS = 'title,url,updatedAt,repository'

/** `gh search` queries for what waits on the owner, with the verb each finding gets. */
export const githubSweeps = (gh: string): { verb: string; cmd: string[] }[] => [
  { verb: 'Review PR', cmd: [gh, 'search', 'prs', '--review-requested=@me', '--state=open', '--json', GH_FIELDS] },
  { verb: 'Work on', cmd: [gh, 'search', 'issues', '--assignee=@me', '--state=open', '--include-prs', '--json', GH_FIELDS] },
]

export function sweepInput(connector: string, now: number): string {
  return [
    `Using the ${connector} connector, find what is still waiting on the owner right now (now is ${new Date(now).toISOString()}), whenever it arrived:`,
    'open tasks assigned to them, requests or emails waiting on their reply, invites they have not answered, and anything due or overdue within the next two days.',
    'Skip newsletters, notifications, receipts and anything already done or answered.',
    'For each, `title` is the action the owner needs to take, starting with a verb, with the deadline if there is one, and `due` is that deadline in ISO 8601. Return `cursor` as now.',
  ].join(' ')
}

const task = (source: Source, id: string, ts: number, title: string, from: string, url?: string, due?: string): Item & { due?: number } => ({
  source: source.id,
  extId: `sweep:${id}`,
  ts,
  from: { id: from, name: from },
  // Each finding is its own conversation, so ✅ Done settles just that task.
  chat: { id: `sweep:${id}`, name: from, isGroup: false },
  text: title,
  url,
  toMe: true,
  fromMe: false,
  ...(due && !Number.isNaN(Date.parse(due)) ? { due: Date.parse(due) } : {}),
})

export function githubTasks(source: Source, verb: string, stdout: string, now: number): Item[] {
  const hits = (stdout.trim() ? JSON.parse(stdout) : []) as GhHit[]
  return hits.filter(h => h?.url && h.title).map(h => {
    const ts = Date.parse(h.updatedAt)
    return task(source, h.url, Number.isNaN(ts) ? now : ts, `${verb}: ${h.title}`, h.repository?.nameWithOwner ?? 'GitHub', h.url)
  })
}

export function connectorTasks(source: Source, connector: string, out: z.infer<typeof AgentPollSchema>, now: number): (Item & { due?: number })[] {
  return out.items.map(i => {
    const ts = Date.parse(i.ts)
    return task(source, i.id, Number.isNaN(ts) ? now : ts, i.title, i.from ?? connector, i.url, i.due)
  })
}

const bunExec: Exec = async cmd => {
  const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  if (code !== 0) throw new Error(`${cmd[0]} exited code=${code}`)
  return out
}

/** One sweep over every enabled source; returns how many new tasks were stored. */
export async function runSweep(o: SweepOpts): Promise<number> {
  const exec = o.exec ?? bunExec
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const label = o.db.query(`UPDATE items SET label = 'action', reason = 'attention sweep' WHERE id = ?`)
  const addLoop = o.db.query(`INSERT INTO loops (item_id, kind, summary, due, opened_at) VALUES (?, 'awaiting_me', ?, ?, ?)`)
  let stored = 0
  for (const s of o.sources.filter(s => s.enabled)) {
    const cfg = s.config as { command?: string[]; connector?: string }
    try {
      let found: (Item & { due?: number })[] = []
      if (s.kind === 'poll' && basename(String(cfg.command?.[0])) === 'gh') {
        for (const q of githubSweeps(cfg.command![0]!)) found.push(...githubTasks(s, q.verb, await exec(q.cmd), now()))
      } else if (s.kind === 'agent-poll' && cfg.connector) {
        const t = now()
        found = connectorTasks(s, cfg.connector, await o.runPoller(sweepInput(cfg.connector, t), AgentPollSchema, [connectorTools(cfg.connector)]), t)
      }
      for (const item of found) {
        const id = insertItem(o.db, item)
        if (id === null) continue
        label.run(id)
        // FR15: a deadline makes it a loop that gets nudged.
        if (item.due) addLoop.run(id, item.text, item.due, now())
        stored++
      }
    } catch (e) {
      log(`sweep ${s.id}: ${e instanceof Error ? e.message : e}`)
    }
  }
  return stored
}
