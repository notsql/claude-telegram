import { describe, expect, test } from 'bun:test'
import { defaultAccess, type Access } from '../access.ts'
import { defaultPolicy } from '../policy/schema.ts'
import { resolvePolicy } from '../policy/resolve.ts'

const access: Access = {
  ...defaultAccess(),
  allowFrom: ['1'],
  chats: {
    '-100': { policy: { model: 'sonnet', memoryScope: 'none' } },
    '-100:7': { policy: { memoryScope: 'global', allowedTools: ['Read'] } },
  },
}

describe('resolvePolicy', () => {
  test('no overrides gives defaults plus owner approvers', () => {
    expect(resolvePolicy(access, '5', 'private')).toEqual({ ...defaultPolicy('private'), approvers: ['1'] })
  })

  test('chat overrides defaults', () => {
    const p = resolvePolicy(access, '-100', 'group')
    expect(p).toMatchObject({ model: 'sonnet', memoryScope: 'none', historyScope: 'chat' })
  })

  test('topic overrides chat, which overrides defaults', () => {
    const p = resolvePolicy(access, '-100:7', 'group')
    expect(p).toMatchObject({ model: 'sonnet', memoryScope: 'global', allowedTools: ['Read'], autoLearn: 'propose' })
  })

  test('topic without its own entry inherits the chat', () => {
    expect(resolvePolicy(access, '-100:9', 'group').memoryScope).toBe('none')
  })

  test('explicit approvers override owner default', () => {
    const a = { ...access, chats: { '-100': { policy: { approvers: ['2'] } } } }
    expect(resolvePolicy(a, '-100:7', 'group').approvers).toEqual(['2'])
  })
})

test('chatTypeOf', async () => {
  const { chatTypeOf } = await import('../policy/resolve.ts')
  expect(chatTypeOf('-100:7')).toBe('group')
  expect(chatTypeOf('5')).toBe('private')
})

test('canStartTurn: owners always, others only with allowOthersOnSubscription (FR12)', async () => {
  const { canStartTurn } = await import('../policy/resolve.ts')
  expect(canStartTurn(access, '-100:7', '1')).toBe(true)
  expect(canStartTurn(access, '-100:7', '2')).toBe(false)
  const opted = { ...access, chats: { '-100': { policy: { allowOthersOnSubscription: true } } } }
  expect(canStartTurn(opted, '-100:7', '2')).toBe(true)
  expect(canStartTurn(access, '5', '5')).toBe(true)
})

test('alwaysAllow unions chat and topic rules; policyKey is the chat', async () => {
  const { policyKey } = await import('../policy/resolve.ts')
  const a = { ...access, chats: { '-100': { policy: { alwaysAllow: ['Bash(ls *)'] } }, '-100:7': { policy: { alwaysAllow: ['WebSearch'] } } } }
  expect(resolvePolicy(a, '-100:7', 'group').alwaysAllow).toEqual(['Bash(ls *)', 'WebSearch'])
  expect(resolvePolicy(a, '-100:9', 'group').alwaysAllow).toEqual(['Bash(ls *)'])
  expect(policyKey('-100:7')).toBe('-100')
})
