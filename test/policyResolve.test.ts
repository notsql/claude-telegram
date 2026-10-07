import { describe, expect, test } from 'bun:test'
import { defaultAccess, type Access } from '../access.ts'
import { defaultPolicy } from '../policy/schema.ts'
import { resolvePolicy } from '../policy/resolve.ts'

const access: Access = {
  ...defaultAccess(),
  allowFrom: ['1'],
  chats: {
    '-100': { policy: { model: 'sonnet', memoryScope: 'none' } },
    '-100:7': { policy: { memoryScope: 'chat', allowedTools: ['Read'] } },
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
    expect(p).toMatchObject({ model: 'sonnet', memoryScope: 'chat', allowedTools: ['Read'], autoLearn: 'propose' })
  })

  test('topic without its own entry inherits the chat', () => {
    expect(resolvePolicy(access, '-100:9', 'group').memoryScope).toBe('none')
  })

  test('explicit approvers override owner default', () => {
    const a = { ...access, chats: { '-100': { policy: { approvers: ['2'] } } } }
    expect(resolvePolicy(a, '-100:7', 'group').approvers).toEqual(['2'])
  })
})
