import { expect, test } from 'bun:test'
import { defaultAccess } from '../access.ts'
import { applyPolicyEdit, policyKeyboard, renderPolicy } from '../telegram/policyUi.ts'

test('keyboard never offers bypassPermissions (AC6)', () => {
  expect(JSON.stringify(policyKeyboard({}).inline_keyboard)).not.toContain('bypass')
})

test('applyPolicyEdit stores allowed values on the exact key', () => {
  const a = defaultAccess()
  expect(applyPolicyEdit(a, '-100:7', 'memoryScope', 'none')).toBe('none')
  expect(applyPolicyEdit(a, '-100:7', 'schedulerAllowed', 'true')).toBe(true)
  applyPolicyEdit(a, '-100:7', 'model', 'opus')
  applyPolicyEdit(a, '-100:7', 'model', 'default')
  expect(a.chats!['-100:7']!.policy).toEqual({ memoryScope: 'none', schedulerAllowed: true })
})

test('applyPolicyEdit rejects bypass, cwd and unknown fields', () => {
  const a = defaultAccess()
  expect(() => applyPolicyEdit(a, '5', 'permissionMode', 'bypassPermissions')).toThrow()
  expect(() => applyPolicyEdit(a, '5', 'cwd', '/')).toThrow()
  expect(a.chats).toBeUndefined()
})

test('renderPolicy marks the current value', () => {
  expect(renderPolicy('5', { model: 'sonnet' })).toContain('model: sonnet')
  expect(JSON.stringify(policyKeyboard({ model: 'sonnet' }).inline_keyboard)).toContain('• sonnet')
})
