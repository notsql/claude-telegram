import { describe, expect, test } from 'bun:test'
import { createGroupBuffer } from '../sessions/groupBuffer'
import { groupVerdict } from '../access'

const msg = (text: string, ts = 0) => ({ ts, user: 'bob', text })

describe('group buffer (002 FR8)', () => {
  test('take returns messages oldest first and clears them', () => {
    const b = createGroupBuffer()
    b.push('-100:1', msg('a'))
    b.push('-100:1', msg('b'))
    expect(b.take('-100:1').map(m => m.text)).toEqual(['a', 'b'])
    expect(b.take('-100:1')).toEqual([])
  })

  test('keys are separate', () => {
    const b = createGroupBuffer()
    b.push('-100:1', msg('topic 1'))
    b.push('-100:2', msg('topic 2'))
    expect(b.take('-100:1').map(m => m.text)).toEqual(['topic 1'])
  })

  test('drops the oldest past the message limit', () => {
    const b = createGroupBuffer({ maxMessages: 2 })
    for (const t of ['a', 'b', 'c']) b.push('k', msg(t))
    expect(b.take('k').map(m => m.text)).toEqual(['b', 'c'])
  })

  test('drops the oldest past the character limit and truncates one huge message', () => {
    const b = createGroupBuffer({ maxChars: 10 })
    b.push('k', msg('12345'))
    b.push('k', msg('67890'))
    b.push('k', msg('ab'))
    expect(b.take('k').map(m => m.text)).toEqual(['67890', 'ab'])
    b.push('k', msg('x'.repeat(50)))
    expect(b.take('k').map(m => m.text)).toEqual(['x'.repeat(10)])
  })
})

describe('groupVerdict (002 FR7)', () => {
  const yes = () => true
  const no = () => false

  test('unknown groups are dropped', () => {
    expect(groupVerdict(undefined, '1', no)).toBe('drop')
  })

  test('an allowed sender without a mention is buffered, with one is delivered', () => {
    const policy = { requireMention: true, allowFrom: ['1'] }
    expect(groupVerdict(policy, '1', no)).toBe('unmentioned')
    expect(groupVerdict(policy, '1', yes)).toBe('deliver')
  })

  test('a sender outside allowFrom is dropped, never buffered', () => {
    const policy = { requireMention: true, allowFrom: ['1'] }
    expect(groupVerdict(policy, '2', no)).toBe('drop')
    expect(groupVerdict(policy, '2', yes)).toBe('drop')
  })

  test('without requireMention every allowed message is delivered', () => {
    expect(groupVerdict({ requireMention: false, allowFrom: [] }, '2', no)).toBe('deliver')
  })
})
