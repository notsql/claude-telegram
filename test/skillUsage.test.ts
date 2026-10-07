import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSkillUsage, invokedSkill } from '../skills/usage'
import { renderHookSettings } from '../hooks/settings'

test('invocations count up (FR7)', () => {
  const u = createSkillUsage(join(mkdtempSync(join(tmpdir(), 'tg-usage-')), 'skills-usage.json'))
  u.invoked('deploy-blog', new Date('2026-10-01T00:00:00Z'))
  u.invoked('deploy-blog', new Date('2026-10-07T00:00:00Z'))
  expect(u.get('deploy-blog')).toMatchObject({ count: 2, last_used: '2026-10-07T00:00:00.000Z' })
})

test('AC6: the third failed or corrected outcome triggers refinement, then the count restarts', () => {
  const u = createSkillUsage(join(mkdtempSync(join(tmpdir(), 'tg-usage-')), 'skills-usage.json'))
  expect(u.outcome('x', 'failed')).toBe(false)
  expect(u.outcome('x', 'success')).toBe(false)
  expect(u.outcome('x', 'corrected')).toBe(false)
  expect(u.outcome('x', 'failed')).toBe(true)
  expect(u.outcome('x', 'failed')).toBe(false)
  expect(u.get('x')!.outcomes).toEqual({ success: 1, corrected: 1, failed: 3 })
})

test('Skill payloads name the skill; other tools do not; the hook matches Skill only', () => {
  expect(invokedSkill({ tool_name: 'Skill', tool_input: { skill: 'deploy-blog' } })).toBe('deploy-blog')
  expect(invokedSkill({ tool_name: 'Skill', tool_input: { skill: 'telegram:access pair x' } })).toBe('access')
  expect(invokedSkill({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeUndefined()
  expect((renderHookSettings({ port: 1, approvalTimeoutSec: 60 }).hooks as any).PostToolUse[0].matcher).toBe('Skill')
})
