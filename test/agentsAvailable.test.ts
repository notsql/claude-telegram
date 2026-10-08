import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { availableAgents, chatAgents, setPolicyAgent } from '../agents/available'
import { resolvePolicy } from '../policy/resolve'
import { policyArgs } from '../policy/args'
import { defaultAccess } from '../access'

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'tg-agents-'))
  const claude = join(root, 'claude'), cwd = join(root, 'proj')
  mkdirSync(join(claude, 'agents'), { recursive: true })
  mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(claude, 'agents', 'tg-researcher.md'), '---\nname: tg-researcher\ntools: Read\n---\nbody\n')
  writeFileSync(join(claude, 'agents', 'nofm.md'), 'no frontmatter\n')
  writeFileSync(join(claude, 'agents', 'notes.txt'), 'ignored')
  writeFileSync(join(cwd, '.claude', 'agents', 'ops.md'), '---\nname: "infra-ops"\ntools: Bash(kubectl:*)\n---\n')
  return { claude, cwd }
}

test('lists user and project agents by frontmatter name', () => {
  const { claude, cwd } = dirs()
  expect(availableAgents(claude, cwd)).toEqual(['infra-ops', 'nofm', 'tg-researcher'])
  expect(availableAgents(claude)).toEqual(['nofm', 'tg-researcher'])
  expect(availableAgents(join(claude, 'missing'))).toEqual([])
})

test('AC3: a topic set to infra-ops runs turns with --agent infra-ops; unknown names are rejected', () => {
  const access = defaultAccess()
  const topic = '-100123:7'
  expect(() => setPolicyAgent(access, topic, 'nope', ['infra-ops'])).toThrow('No agent named nope.')
  setPolicyAgent(access, topic, 'infra-ops', ['infra-ops'])
  const p = resolvePolicy(access, topic, 'group')
  expect(p.agent).toBe('infra-ops')
  expect(policyArgs(p)).toContain('infra-ops')
  expect(resolvePolicy(access, '-100123', 'group').agent).toBeUndefined()
  setPolicyAgent(access, topic, undefined, [])
  expect(resolvePolicy(access, topic, 'group').agent).toBeUndefined()
})

test('chatAgents leaves out structured-output-only agents and carries descriptions', () => {
  const { claude, cwd } = dirs()
  writeFileSync(join(claude, 'agents', 'tg-reflector.md'), '---\nname: tg-reflector\ndescription: Reflects.\ntools: StructuredOutput\n---\n')
  writeFileSync(join(claude, 'agents', 'tg-researcher.md'), '---\nname: tg-researcher\ndescription: Web research.\ntools: Read\n---\n')
  expect(chatAgents(claude, cwd)).toEqual([
    { name: 'infra-ops', description: '' }, { name: 'nofm', description: '' }, { name: 'tg-researcher', description: 'Web research.' },
  ])
})
