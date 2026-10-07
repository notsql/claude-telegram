import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSkillStore } from '../skills/store'
import { createSkillApplier, sectionDiff, type SkillChange, type SkillProposal } from '../skills/apply'
import { createSkillNotices } from '../skills/notices'
import type { Policy } from '../policy/schema'

const prop = (o: Partial<SkillProposal> = {}): SkillProposal => ({
  op: 'create', name: 'deploy-blog', description: 'Build and deploy the Astro blog to Cloudflare Pages',
  sections: { Steps: '1. pnpm build\n2. wrangler pages deploy dist' }, reason: '', confidence: 0.9, ...o,
})

function setup(autoLearn: Policy['autoLearn'] = 'auto') {
  const root = mkdtempSync(join(tmpdir(), 'tg-skapply-'))
  const store = createSkillStore(root)
  const notes: SkillChange[] = []
  const asks: { text: string; id: string; kind: string }[] = []
  const a = createSkillApplier({
    store: () => store,
    taken: () => new Set(['init', 'access']),
    policy: () => ({ autoLearn }),
    sessionOf: () => 'sess-1',
    notify: (_k, c) => notes.push(c),
    ask: (_k, text, id, kind) => asks.push({ text, id, kind }),
  })
  return { root, store, a, notes, asks }
}

test('AC1: auto writes a learned skill and notifies; low confidence, clashing names and extra proposals are dropped', () => {
  const { store, a, notes } = setup()
  a.apply('123', { skills: [prop({ confidence: 0.5, name: 'weak' }), prop(), prop({ name: 'second', description: 'other thing entirely' })] })
  a.apply('123', { skills: [prop({ name: 'access', description: 'manage telegram access lists' })] })
  expect(store.list().map(s => s.name)).toEqual(['deploy-blog'])
  expect(store.read('deploy-blog')!.metadata).toMatchObject({ source: 'tg', version: '1', created_from: 'sess-1', session_key: '123' })
  expect(notes.map(n => `${n.verb} ${n.name}`)).toEqual(['Learned deploy-blog'])
})

test('patch over create: a similar description patches the existing skill (version +1)', () => {
  const { store, a, notes } = setup()
  a.apply('1', { skills: [prop()] })
  a.apply('1', { skills: [prop({ name: 'blog-deploy', description: 'Build and deploy the Astro blog to Cloudflare Pages quickly', sections: { Pitfalls: 'Pass --branch main.' } })] })
  expect(store.list().map(s => s.name)).toEqual(['deploy-blog'])
  expect(store.read('deploy-blog')!.metadata.version).toBe('2')
  expect(notes[1]).toMatchObject({ verb: 'Updated', version: 2 })
  notes[1]!.undo()
  expect(store.read('deploy-blog')!.metadata.version).toBe('1')
})

test('AC4: a user-authored skill gets only a diff; Apply writes it', () => {
  const { root, store, a, notes, asks } = setup()
  mkdirSync(join(root, 'deploy-blog'))
  writeFileSync(join(root, 'deploy-blog', 'SKILL.md'), '---\nname: deploy-blog\ndescription: mine\n---\n## Steps\n1. pnpm build\n')
  a.apply('1', { skills: [prop({ op: 'patch' })] })
  expect(notes).toEqual([])
  expect(readFileSync(join(root, 'deploy-blog', 'SKILL.md'), 'utf8')).not.toContain('wrangler')
  expect(asks[0]!.kind).toBe('diff')
  expect(asks[0]!.text).toContain('+ 2. wrangler pages deploy dist')
  expect(a.decide(asks[0]!.id, true)!.change!.verb).toBe('Updated')
  expect(store.read('deploy-blog')!.metadata.source).toBeUndefined()
  expect(store.text('deploy-blog')).toContain('wrangler')
})

test('AC5: propose writes nothing until Save; Edit replaces the draft; off does nothing', () => {
  const { store, a, asks } = setup('propose')
  a.apply('-100', { skills: [prop()] })
  expect(store.list()).toEqual([])
  expect(asks[0]).toMatchObject({ kind: 'propose' })
  expect(asks[0]!.text).toContain('📘 Learn skill deploy-blog?')
  expect(a.pending(asks[0]!.id)!.draft).toContain('## Steps')
  const r = a.edit(asks[0]!.id, 'Deploy the blog. Use when asked to publish.\n\n## Steps\n1. pnpm deploy')!
  expect(r.change!.verb).toBe('Learned')
  expect(store.read('deploy-blog')).toMatchObject({ description: 'Deploy the blog. Use when asked to publish.' })
  expect(store.text('deploy-blog')).toContain('1. pnpm deploy')
  expect(a.decide(asks[0]!.id, true)).toBeUndefined()

  a.apply('-100', { skills: [prop({ name: 'other', description: 'something unrelated here' })] })
  expect(a.decide(asks[1]!.id, false)).toEqual({})
  expect(store.read('other')).toBeUndefined()

  const off = setup('off')
  expect(off.a.one('1', prop())).toContain('autoLearn: off')
  expect(off.store.list()).toEqual([])
})

test('notices: Show sends the SKILL.md, Undo runs once', async () => {
  const { a, notes } = setup()
  a.apply('1', { skills: [prop()] })
  const sent: { text: string; markup: any }[] = []
  const n = createSkillNotices({ sendMessage: async (_c: any, text: string, o: any) => { sent.push({ text, markup: o.reply_markup }); return {} as any } } as any)
  await n.notify('1', notes[0]!)
  expect(sent[0]!.text).toBe('📘 Learned skill deploy-blog')
  const [show, undo] = sent[0]!.markup.inline_keyboard[0].map((b: any) => b.callback_data.split(':')[2])
  expect(n.show(show)).toContain('name: deploy-blog')
  expect(n.undo(undo)).toBe('↩️ Removed skill deploy-blog')
  expect(n.undo(undo)).toBeUndefined()
  expect(n.show(show)).toBe('Skill deploy-blog no longer exists.')
})

test('sectionDiff shows removed and added lines per changed section', () => {
  expect(sectionDiff('## Steps\na\nb', { Steps: 'a\nc', Verify: 'v' })).toBe('## Steps\n- b\n+ c\n## Verify\n+ v')
})
