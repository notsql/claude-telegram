import { describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { scopeDecision } from '../policy/scope.ts'
import { isTrustedCwd } from '../policy/args.ts'

const opts = { trustedDirs: () => ['~/infra'], extraDirs: ['/state/inbox'] }
const call = (tool_name: string, tool_input: object, key: string) =>
  scopeDecision({ tool_name, tool_input, cwd: '/work' }, key, opts) as any

describe('scopeDecision', () => {
  test('reply to another chat is denied', () => {
    expect(call('mcp__tg__reply', { chat_id: '999', text: 'x' }, '-100:7').hookSpecificOutput.permissionDecision).toBe('deny')
    expect(call('mcp__tg__reply', { chat_id: '-100', text: 'x' }, '-100:7')).toEqual({})
  })

  test('group file tools stay inside cwd, trusted dirs and inbox', () => {
    expect(call('Read', { file_path: '/work/a.txt' }, '-100')).toEqual({})
    expect(call('Read', { file_path: 'sub/a.txt' }, '-100')).toEqual({})
    expect(call('Read', { file_path: '~/infra/x.yaml' }, '-100')).toEqual({})
    expect(call('Read', { file_path: '/state/inbox/p.jpg' }, '-100')).toEqual({})
    expect(call('Read', { file_path: '/etc/passwd' }, '-100').hookSpecificOutput.permissionDecision).toBe('deny')
    expect(call('Grep', { pattern: 'x', path: '../' }, '-100').hookSpecificOutput.permissionDecision).toBe('deny')
    expect(call('Glob', { pattern: '**' }, '-100')).toEqual({})
  })

  test('owner DM file tools are not scoped', () => {
    expect(call('Read', { file_path: '/etc/passwd' }, '5')).toEqual({})
  })
})

test('isTrustedCwd', () => {
  expect(isTrustedCwd('~/infra/sub', ['~/infra'])).toBe(true)
  expect(isTrustedCwd(`${homedir()}/infra`, ['~/infra'])).toBe(true)
  expect(isTrustedCwd('~/infra2', ['~/infra'])).toBe(false)
  expect(isTrustedCwd('~/x', [])).toBe(false)
})

test('policyArgs maps the policy to CLI flags', async () => {
  const { policyArgs } = await import('../policy/args.ts')
  const { defaultPolicy } = await import('../policy/schema.ts')
  expect(policyArgs({ permissionMode: 'default', alwaysAllow: ['Bash(ls *)'] })).toEqual([
    '--permission-mode', 'default', '--allowedTools', 'mcp__tg', 'Bash(ls *)',
  ])
  expect(policyArgs({ model: 'sonnet', agent: 'hermes-x', allowedTools: ['Read', 'mcp__tg'] })).toEqual([
    '--model', 'sonnet', '--allowedTools', 'mcp__tg', 'Read', '--agent', 'hermes-x',
  ])
  // AC5: group defaults deny edits natively, with no prompt.
  const group = policyArgs(defaultPolicy('group'))
  expect(group.slice(group.indexOf('--disallowedTools'))).toContain('Edit')
})
