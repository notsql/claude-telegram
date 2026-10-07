import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAgentUsage } from '../agents/usage'

const file = () => join(mkdtempSync(join(tmpdir(), 'tg-agent-usage-')), 'agents-usage.json')

test('T906: counts per agent increase on SubagentStart, duration added on Stop', () => {
  const f = file()
  const u = createAgentUsage(f)
  u.start({ agent_id: 'a1', agent_type: 'tg-researcher' }, 1000)
  u.start({ agent_id: 'a2', agent_type: 'tg-researcher' }, 2000)
  u.start({ agent_id: 'b1', agent_type: 'Explore' }, 2000)
  expect(u.stop({ agent_id: 'a1' }, 4000)).toEqual({ type: 'tg-researcher', ms: 3000 })
  expect(u.stop({ agent_id: 'a2' }, 2500)).toEqual({ type: 'tg-researcher', ms: 500 })
  expect(u.stop({ agent_id: 'unknown' }, 9000)).toBeUndefined()
  expect(createAgentUsage(f).all()).toEqual({
    'tg-researcher': { count: 2, total_ms: 3500, last_used: new Date(2000).toISOString() },
    Explore: { count: 1, total_ms: 0, last_used: new Date(2000).toISOString() },
  })
})

test('payloads without an agent type are ignored', () => {
  const u = createAgentUsage(file())
  u.start({ agent_id: 'x' })
  expect(u.all()).toEqual({})
})
