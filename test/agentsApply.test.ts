import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAgentApplier, learnedAgents, type AgentProposal } from '../agents/apply'
import { ProposalsSchema, reflectionInput, skillsContext } from '../reflection/prompt'

const triager: AgentProposal = {
  op: 'create',
  name: 'tg-issue-triager',
  description: 'Triage GitHub issues. Use proactively when asked to triage issues.',
  tools: ['Read', 'Grep', 'Bash(gh issue:*)'],
  model: 'sonnet',
  body: 'You triage issues.',
  reason: 'third triage request',
  confidence: 0.9,
}

function setup(autoLearn: 'auto' | 'propose' | 'off' = 'auto') {
  const dir = mkdtempSync(join(tmpdir(), 'tg-agapply-'))
  const notes: string[] = [], asks: { text: string; id: string }[] = []
  const a = createAgentApplier({ dir, policy: () => ({ autoLearn }), notify: (_, t) => notes.push(t), ask: (_, text, id) => asks.push({ text, id }) })
  return { dir, a, notes, asks }
}

test('the schema accepts an agents section', () => {
  expect(ProposalsSchema.parse({ memory: [], user_model: [], skills: [], agents: [triager], skill_outcomes: [] }).agents[0]!.tools).toHaveLength(3)
  expect(reflectionInput('', 'USER: hi', skillsContext([], 0, ['a', 'b']))).toContain('Similar tasks including this one: 3')
})

test('AC5: after 3 similar triage tasks tg-issue-triager is created with explicit tools', () => {
  const { dir, a, notes } = setup()
  expect(a.apply('1', { agents: [triager] }, 2)).toContain('only 2 similar')
  expect(existsSync(join(dir, 'tg-issue-triager.md'))).toBe(false)
  expect(a.apply('1', { agents: [triager] }, 3)).toBeUndefined()
  const md = readFileSync(join(dir, 'tg-issue-triager.md'), 'utf8')
  expect(md).toContain('tools: Read, Grep, Bash(gh issue:*)')
  expect(md).toContain('<!-- source: tg · version: 1 -->')
  expect(notes).toEqual(['🤖 Learned agent tg-issue-triager (v1)'])
  expect(learnedAgents(dir).map(x => x.name)).toEqual(['tg-issue-triager'])
})

test('AC5: a proposal with bypassPermissions is rejected', () => {
  const { dir, a } = setup()
  expect(a.apply('1', { agents: [{ ...triager, permissionMode: 'bypassPermissions' }] }, 5)).toContain('bypassPermissions')
  expect(a.apply('1', { agents: [{ ...triager, tools: [] }] }, 5)).toContain('explicit')
  expect(a.apply('1', { agents: [{ ...triager, confidence: 0.7 }] }, 5)).toBe('no confident agent proposal')
  expect(existsSync(join(dir, 'tg-issue-triager.md'))).toBe(false)
})

test('propose and groups ask first; Save writes; off does nothing', () => {
  const { a, asks } = setup('propose')
  a.apply('1', { agents: [triager] }, 3)
  expect(asks[0]!.text).toContain('Create agent tg-issue-triager?')
  expect(a.decide(asks[0]!.id, true)).toEqual({ text: '🤖 Learned agent tg-issue-triager (v1)' })
  expect(a.decide(asks[0]!.id, true)).toBeUndefined()

  const g = setup('auto')
  g.a.apply('-100:5', { agents: [triager] }, 3)
  expect(g.asks).toHaveLength(1)

  const off = setup('off')
  expect(off.a.apply('1', { agents: [triager] }, 3)).toContain('off')
})
