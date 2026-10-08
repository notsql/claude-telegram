import { expect, test } from 'bun:test'
import { defaultAccess } from '../access.ts'
import { removeAlwaysAllow } from '../policy/resolve.ts'
import { alwaysRuleAt, applyPolicyEdit, fieldView, label, permissionsView, POLICY_CALLBACK, policyView, ruleLabel, ruleView } from '../telegram/policyUi.ts'

const buttons = (v: { keyboard: { inline_keyboard: { text: string; callback_data?: string }[][] } }) => v.keyboard.inline_keyboard.flat()

test('no page offers bypassPermissions (AC6)', () => {
  const p = { permissionMode: 'default' as const }
  for (const v of [policyView('5', p), fieldView('permissionMode', p), permissionsView(p)]) expect(JSON.stringify(v)).not.toContain('bypass')
})

test('labels turn camel and Pascal case into words', () => {
  expect(label('permissionMode')).toBe('Permission mode')
  expect(label('acceptEdits')).toBe('Accept edits')
  expect(label('schedulerAllowed')).toBe('Scheduler allowed')
  expect(label('true')).toBe('Yes')
  expect(ruleLabel('Bash(npm test *)')).toBe('Bash: npm test *')
  expect(ruleLabel('WebFetch')).toBe('Web Fetch')
})

test('main page lists settings as buttons that open their values', () => {
  const v = policyView('5', { model: 'sonnet', schedulerAllowed: true, alwaysAllow: ['Read'] })
  const b = buttons(v)
  expect(b.map(x => x.text)).toContain('Model: Sonnet')
  expect(b.map(x => x.text)).toContain('Scheduler allowed: Yes')
  expect(b.at(-1)).toEqual({ text: '🔐 Permissions (Default, 1 rules)', callback_data: 'pol:p' })
  for (const x of b) expect(POLICY_CALLBACK.test(x.callback_data!)).toBe(true)
  const f = buttons(fieldView('model', { model: 'sonnet' }))
  expect(f.map(x => x.text)).toEqual(['Default', '• Sonnet', 'Opus', 'Haiku', '« Back'])
  expect(f[1]!.callback_data).toBe('pol:s:model:sonnet')
  expect(buttons(fieldView('permissionMode', {})).at(-1)!.callback_data).toBe('pol:p')
})

test('permissions page lists every rule; only Always rules can be removed', () => {
  const p = { allowedTools: ['Read'], disallowedTools: ['WebFetch'], alwaysAllow: ['Bash(npm test *)'] }
  const v = permissionsView(p)
  expect(v.text).toContain('⛔ Blocked:\n• Web Fetch')
  expect(buttons(v).map(x => x.callback_data)).toEqual(['pol:f:permissionMode', 'pol:r:0', 'pol:r:1', 'pol:r:2', 'pol:m'])
  expect(buttons(ruleView(p, 0)).map(x => x.text)).toEqual(['« Back'])
  expect(buttons(ruleView(p, 2)).map(x => x.callback_data)).toEqual(['pol:x:2', 'pol:p'])
  expect(alwaysRuleAt(p, 0)).toBeUndefined()
  expect(alwaysRuleAt(p, 2)).toBe('Bash(npm test *)')
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

test('removeAlwaysAllow drops one rule', () => {
  const a = defaultAccess()
  a.chats = { '5': { policy: { alwaysAllow: ['Read', 'Grep'] } } }
  expect(removeAlwaysAllow(a, '5', 'Read')).toBe(true)
  expect(removeAlwaysAllow(a, '5', 'Read')).toBe(false)
  removeAlwaysAllow(a, '5', 'Grep')
  expect(a.chats['5']!.policy).toEqual({})
})
