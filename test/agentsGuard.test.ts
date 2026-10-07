import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { agentRefusal, type AgentDraft } from '../agents/validate'
import { createAgentTools } from '../agents/tools'

const triager: AgentDraft = {
  name: 'tg-issue-triager',
  description: 'Triage GitHub issues. Use proactively when asked to triage issues.',
  tools: ['Read', 'Grep', 'Bash(gh issue:*)'],
  model: 'sonnet',
  body: 'You triage issues.',
}

test('AC5: a proposal with bypassPermissions is rejected; the explicit-tools one passes', () => {
  expect(agentRefusal(triager)).toBeUndefined()
  expect(agentRefusal({ ...triager, permissionMode: 'bypassPermissions' })).toContain('bypassPermissions')
  expect(agentRefusal({ ...triager, permissionMode: 'auto' })).toContain('auto')
})

test('FR9 guardrails', () => {
  expect(agentRefusal({ ...triager, name: 'issue-triager' })).toContain('tg-')
  expect(agentRefusal({ ...triager, tools: [] })).toContain('explicit')
  expect(agentRefusal({ ...triager, tools: ['*'] })).toContain('explicit')
  expect(agentRefusal({ ...triager, tools: ['Read', 'Agent'] })).toContain('Agent')
  expect(agentRefusal({ ...triager, mcpServers: [{ cmd: { command: 'x' } }] })).toContain('mcpServers')
  expect(agentRefusal({ ...triager, mcpServers: ['github'] })).toBeUndefined()
  expect(agentRefusal(triager, { existingSource: undefined })).toContain("can't be patched")
  expect(agentRefusal(triager, { existingSource: 'tg' })).toBeUndefined()
})

const out = (r: any) => r.content[0].text as string

test('agent tools: author-only, create then patch with backup, guardrails applied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-agtools-'))
  let author = false
  const tools = createAgentTools(dir, () => author)
  const p = { autoLearn: 'auto' as const }
  expect(tools.list({ autoLearn: 'off' }).map(t => t.name)).toEqual(['agent_list', 'agent_read'])
  expect(tools.call('skill_list', {}, '1', p)).toBeUndefined()
  expect(tools.call('agent_create', triager, '1', p)!.isError).toBe(true)

  author = true
  expect(out(tools.call('agent_create', { ...triager, permissionMode: 'bypassPermissions' }, '1', p))).toContain('not allowed')
  expect(out(tools.call('agent_create', triager, '1', p))).toBe('created agent tg-issue-triager (v1)')
  expect(readFileSync(join(dir, 'tg-issue-triager.md'), 'utf8')).toContain('<!-- source: tg · version: 1 -->')
  expect(out(tools.call('agent_patch', { ...triager, body: 'v2' }, '1', p))).toContain('limit of 1')
  tools.startTurn('1')
  expect(out(tools.call('agent_patch', { ...triager, body: 'v2' }, '1', p))).toBe('updated agent tg-issue-triager (v2)')
  expect(existsSync(join(dir, '.bak', 'tg-issue-triager.v1.md'))).toBe(true)
  expect(out(tools.call('agent_list', {}, '1', p))).toContain('tg-issue-triager (learned)')

  writeFileSync(join(dir, 'tg-mine.md'), '---\nname: tg-mine\ndescription: x\ntools: Read\n---\nmine\n')
  tools.startTurn('1')
  expect(out(tools.call('agent_patch', { ...triager, name: 'tg-mine' }, '1', p))).toContain("can't be patched")
  expect(out(tools.call('agent_create', { ...triager, name: 'tg-other' }, '-100:5', p))).toContain('approval')
})
