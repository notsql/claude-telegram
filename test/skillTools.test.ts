import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSkillStore } from '../skills/store'
import { createSkillApplier } from '../skills/apply'
import { createSkillTools } from '../skills/tools'
import type { Policy } from '../policy/schema'

function setup(autoLearn: Policy['autoLearn']) {
  const store = createSkillStore(mkdtempSync(join(tmpdir(), 'tg-sktools-')))
  const applier = createSkillApplier({ store: () => store, taken: () => new Set(), policy: () => ({ autoLearn }), notify: () => {}, ask: () => {} })
  return { store, tools: createSkillTools(() => store, applier) }
}
const out = (r: any) => r.content[0].text as string
const create = { name: 'deploy-blog', description: 'Deploy the blog. Use when asked to publish.', sections: { Steps: '1. pnpm build' } }

test('write tools are hidden and refused with autoLearn off', () => {
  const { tools } = setup('off')
  expect(tools.list({ autoLearn: 'off' }).map(t => t.name)).toEqual(['skill_list', 'skill_read'])
  expect(tools.call('skill_create', create, '1', { autoLearn: 'off' })!.isError).toBe(true)
})

test('create, list, read, patch; one write per turn', () => {
  const { store, tools } = setup('auto')
  const p: Policy = { autoLearn: 'auto' }
  expect(tools.list(p)).toHaveLength(4)
  expect(out(tools.call('skill_create', create, '1', p))).toBe('learned skill deploy-blog (v1)')
  expect(out(tools.call('skill_patch', { name: 'deploy-blog', sections: { Pitfalls: 'x' } }, '1', p))).toContain('limit of 1')
  tools.startTurn('1')
  expect(out(tools.call('skill_patch', { name: 'deploy-blog', sections: { Pitfalls: 'Install first.' } }, '1', p))).toBe('updated skill deploy-blog (v2)')
  expect(store.read('deploy-blog')!.description).toBe('Deploy the blog. Use when asked to publish.')
  expect(out(tools.call('skill_list', {}, '1', p))).toBe('deploy-blog (v2, learned): Deploy the blog. Use when asked to publish.')
  expect(out(tools.call('skill_read', { name: 'deploy-blog' }, '1', p))).toContain('## Pitfalls\nInstall first.')
  expect(tools.call('skill_patch', { name: 'nope', sections: {} }, '1', p)!.isError).toBe(true)
  expect(tools.call('memory_write', {}, '1', p)).toBeUndefined()
})

test('propose mode queues instead of writing', () => {
  const { store, tools } = setup('propose')
  expect(out(tools.call('skill_create', create, '1', { autoLearn: 'propose' }))).toContain('waiting for approval')
  expect(store.list()).toEqual([])
})
