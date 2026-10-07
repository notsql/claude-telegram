import { describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { scopeDecision } from '../policy/scope.ts'
import { isTrustedCwd } from '../policy/args.ts'

let answer = false
const asked: string[] = []
const opts = {
  trustedDirs: () => ['~/infra'],
  policy: (key: string) => (key === '-200' ? { memoryScope: 'none', historyScope: 'none' } : { memoryScope: 'global', historyScope: 'chat' }) as any,
  extraDirs: ['/state/inbox'],
  confirm: async (key: string, tool: string) => { asked.push(`${key} ${tool}`); return answer },
}
const call = (tool_name: string, tool_input: object, key: string) =>
  scopeDecision({ tool_name, tool_input, cwd: '/work' }, key, opts) as Promise<any>

describe('scopeDecision', () => {
  test('reply to another chat is allowed', async () => {
    expect(await call('mcp__tg__reply', { chat_id: '999', text: 'x' }, '-100:7')).toEqual({})
  })

  test('group file tools inside cwd, trusted dirs and inbox pass without asking', async () => {
    asked.length = 0
    expect(await call('Read', { file_path: '/work/a.txt' }, '-100')).toEqual({})
    expect(await call('Read', { file_path: 'sub/a.txt' }, '-100')).toEqual({})
    expect(await call('Read', { file_path: '~/infra/x.yaml' }, '-100')).toEqual({})
    expect(await call('Read', { file_path: '/state/inbox/p.jpg' }, '-100')).toEqual({})
    expect(await call('Glob', { pattern: '**' }, '-100')).toEqual({})
    expect(asked).toEqual([])
  })

  test('group file tools outside scope ask the approvers', async () => {
    asked.length = 0
    answer = true
    expect((await call('Read', { file_path: '/etc/passwd' }, '-100:7')).hookSpecificOutput.permissionDecision).toBe('allow')
    answer = false
    expect((await call('Grep', { pattern: 'x', path: '../' }, '-100')).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(asked).toEqual(['-100:7 Read', '-100 Grep'])
  })

  test('memory and history tools are denied when the policy turns them off', async () => {
    expect((await call('mcp__tg__memory_write', {}, '-200')).hookSpecificOutput.permissionDecision).toBe('deny')
    expect((await call('mcp__tg__history_search', { query: 'x' }, '-200')).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(await call('mcp__tg__memory_search', { query: 'x' }, '-100')).toEqual({})
    expect(await call('mcp__tg__history_search', { query: 'x' }, '-100')).toEqual({})
  })

  test('owner DM file tools are not scoped', async () => {
    expect(await call('Read', { file_path: '/etc/passwd' }, '5')).toEqual({})
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
  expect(policyArgs({ model: 'sonnet', agent: 'tg-x', allowedTools: ['Read', 'mcp__tg'] })).toEqual([
    '--model', 'sonnet', '--allowedTools', 'mcp__tg', 'Read', '--agent', 'tg-x',
  ])
  // Groups ask rather than block: nothing is disallowed by default.
  expect(policyArgs(defaultPolicy('group'))).not.toContain('--disallowedTools')
})
