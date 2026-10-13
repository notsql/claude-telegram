import { expect, test } from 'bun:test'
import { openInboxDb } from '../watch/store'
import type { Source } from '../watch/registry'
import { runSweep, sweepInput } from '../watch/sweep'

const src = (over: Partial<Source>): Source => ({
  id: 'x', title: 'X', kind: 'poll', enabled: true, config: {}, cursor: null, status: 'ok', lastItemAt: null, errors: 0, ...over,
})
const gh = src({ id: 'github', config: { command: ['/opt/homebrew/bin/gh', 'api', 'notifications'] } })
const notion = src({ id: 'notion', kind: 'agent-poll', config: { connector: 'Notion' } })
const hit = { title: 'Fix login', url: 'https://github.com/o/r/pull/1', updatedAt: '2026-10-10T00:00:00Z', repository: { nameWithOwner: 'o/r' } }

test('findings become one action item each; a second sweep adds nothing', async () => {
  const db = openInboxDb(':memory:')
  const cmds: string[][] = []
  const tools: string[][] = []
  const o = {
    db, now: () => Date.parse('2026-10-14T00:00:00Z'),
    sources: [gh, notion, src({ id: 'wa', kind: 'webhook', config: { command: ['wacli'] } }), src({ id: 'off', kind: 'agent-poll', enabled: false, config: { connector: 'Gmail' } })],
    exec: async (cmd: string[]) => { cmds.push(cmd); return cmd[2] === 'prs' ? JSON.stringify([hit]) : '[]' },
    runPoller: async (_input: string, _s: any, t: string[]) => { tools.push(t); return { items: [{ id: 'p1', ts: 'bad', title: 'Submit the expense report by Friday', from: 'Finance', due: '2026-10-17T10:00:00Z' }], cursor: 'now' } },
  }
  expect(await runSweep(o)).toBe(2)
  expect(cmds.map(c => c.slice(0, 3))).toEqual([['/opt/homebrew/bin/gh', 'search', 'prs'], ['/opt/homebrew/bin/gh', 'search', 'issues']])
  expect(tools).toEqual([['mcp__claude_ai_Notion']])
  const rows = db.query('SELECT source, ext_id, chat_id, text, label, to_me, status FROM items ORDER BY id').all()
  expect(rows).toEqual([
    { source: 'github', ext_id: `sweep:${hit.url}`, chat_id: `sweep:${hit.url}`, text: 'Review PR: Fix login', label: 'action', to_me: 1, status: 'new' },
    { source: 'notion', ext_id: 'sweep:p1', chat_id: 'sweep:p1', text: 'Submit the expense report by Friday', label: 'action', to_me: 1, status: 'new' },
  ])
  expect(db.query('SELECT kind, summary, due FROM loops').all())
    .toEqual([{ kind: 'awaiting_me', summary: 'Submit the expense report by Friday', due: Date.parse('2026-10-17T10:00:00Z') }])
  expect(await runSweep(o)).toBe(0)
})

test('a failing source is skipped, the rest still swept', async () => {
  const db = openInboxDb(':memory:')
  const logs: string[] = []
  const n = await runSweep({
    db, sources: [gh, notion], log: l => logs.push(l),
    exec: async () => { throw new Error('gh exited code=1') },
    runPoller: async () => ({ items: [{ id: 'p1', ts: '2026-10-13T00:00:00Z', title: 'Pay the bill' }], cursor: 'now' }),
  })
  expect(n).toBe(1)
  expect(logs).toEqual(['sweep github: gh exited code=1'])
})

test('the connector prompt asks for standing tasks, not new items', () => {
  const p = sweepInput('Gmail', 0)
  expect(p).toContain('still waiting on the owner')
  expect(p).toContain('starting with a verb')
})
