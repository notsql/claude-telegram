import { expect, test } from 'bun:test'
import { defaultAccess } from '../access.ts'
import { removeAlwaysAllow } from '../policy/resolve.ts'
import { alwaysRuleAt, applyPolicyEdit, fieldView, label, permissionsView, POLICY_CALLBACK, policyView, resetPolicy, resetView, ruleLabel, rulesView, ruleView } from '../telegram/policyUi.ts'

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

test('main page describes each setting, with buttons that explain their values', () => {
  const v = policyView('5', { model: 'sonnet', schedulerAllowed: true, alwaysAllow: ['Read'] })
  expect(v.text).toContain('Model: Sonnet\nThe model for turns in this chat.')
  const b = buttons(v)
  expect(b.map(x => x.text)).toContain('Scheduler allowed: Yes')
  expect(b.slice(-3).map(x => x.callback_data)).toEqual(['pol:p', 'ext:m', 'pol:z'])
  for (const x of b) expect(POLICY_CALLBACK.test(x.callback_data!) || x.callback_data === 'ext:m').toBe(true)
  const f = fieldView('model', { model: 'sonnet' })
  expect(f.text).toContain('• Sonnet: Balanced speed and capability.')
  expect(buttons(f).map(x => x.text)).toEqual(['Default', '• Sonnet', 'Opus', 'Haiku', '« Back'])
  expect(buttons(f)[1]!.callback_data).toBe('pol:s:model:sonnet')
  expect(buttons(fieldView('permissionMode', {})).at(-1)!.callback_data).toBe('pol:p')
})

test('permissions traverse: kinds, then paged rules, then one rule; only Always rules can be removed', () => {
  const p = { allowedTools: Array.from({ length: 10 }, (_, i) => `T${i}`), disallowedTools: ['WebFetch'], alwaysAllow: ['Bash(npm test *)'] }
  const v = permissionsView(p)
  expect(v.text).not.toContain('WebFetch')
  expect(buttons(v).map(x => x.callback_data)).toEqual(['pol:f:permissionMode', 'pol:c:0:0', 'pol:c:1:0', 'pol:c:2:0', 'pol:m'])
  expect(buttons(rulesView(p, 0)).map(x => x.callback_data).slice(-3)).toEqual(['pol:r:0:7', 'pol:c:0:1', 'pol:p'])
  expect(buttons(rulesView(p, 0, 1)).map(x => x.callback_data)).toEqual(['pol:r:0:8', 'pol:r:0:9', 'pol:c:0:0', 'pol:p'])
  expect(buttons(rulesView(p, 1)).map(x => x.text)).toEqual(['Web Fetch', '« Back'])
  expect(buttons(ruleView(p, 0, 9)).map(x => x.callback_data)).toEqual(['pol:c:0:1'])
  expect(buttons(ruleView(p, 2, 0)).map(x => x.callback_data)).toEqual(['pol:x:0', 'pol:c:2:0'])
  for (const x of [...buttons(v), ...buttons(rulesView(p, 0)), ...buttons(ruleView(p, 2, 0))]) expect(POLICY_CALLBACK.test(x.callback_data!)).toBe(true)
  expect(alwaysRuleAt(p, 0)).toBe('Bash(npm test *)')
})

test('reset clears the editable settings and every permission rule', () => {
  const a = defaultAccess()
  a.chats = { '5': { policy: { model: 'opus', autoLearn: 'off', permissionMode: 'plan', allowedTools: ['Bash'], disallowedTools: ['WebFetch'], alwaysAllow: ['Read'], disabledSkills: ['x'], plugins: { 'a@b': false }, cwd: '/x' } } }
  resetPolicy(a, '5')
  expect(a.chats['5']!.policy).toEqual({ cwd: '/x' })
  expect(buttons(resetView()).map(x => x.callback_data)).toEqual(['pol:y', 'pol:m'])
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
