/**
 * Applies skill proposals (006 FR3, FR5, FR6) from reflection, the skill_*
 * tools and refinement. Proposals under MIN_CONFIDENCE are dropped and at
 * most one is acted on per call (one skill write per turn). A proposal is
 * matched to an existing skill by name, else by a description whose token
 * overlap is over SIMILAR, and then becomes a patch (patch over create).
 * A skill not written by this bot is never changed directly: the owner gets a
 * diff with ✅ Apply / ✖ Skip. Otherwise the chat's `autoLearn` decides:
 * `auto` writes and notifies, `propose` asks with ✅ Save / ✏️ Edit / ✖ Skip,
 * `off` does nothing. New names that clash with a built-in or installed
 * skill are dropped.
 */

import { randomBytes } from 'crypto'
import { jaccard, tokens } from '../memory/store.ts'
import type { Policy } from '../policy/schema.ts'
import type { Proposals } from '../reflection/prompt.ts'
import { SIMILAR } from '../reflection/apply.ts'
import { nameRefusal } from './paths.ts'
import { parseSkill, patchSections, splitSections, type SkillStore } from './store.ts'
import { fieldsToExtra, skillRefusal, type SkillFields } from './validate.ts'

export const MIN_CONFIDENCE = 0.7
const MAX_PENDING = 100

export type SkillProposal = Proposals['skills'][number]

/** A write the daemon reports with Show and Undo (FR10). */
export type SkillChange = { verb: 'Learned' | 'Updated'; name: string; version: number; store: SkillStore; undo: () => void }

/** One resolved proposal, ready to run. */
export type Planned = {
  store: SkillStore
  op: 'create' | 'patch'
  name: string
  description: string
  sections: Record<string, string>
  /** 009 FR10 frontmatter fields to set. */
  fields?: SkillFields
  /** Patching a skill this bot did not write: only after the owner approves the diff. */
  foreign: boolean
}

export type SkillApplyOpts = {
  /** The skill store a key writes to (its policy's `skillScope`). */
  store: (key: string) => SkillStore
  /** Names a new skill in `store` must not take. */
  taken: (store: SkillStore) => Set<string>
  policy: (key: string) => Policy
  /** The key's current Claude session id, for `metadata.created_from`. */
  sessionOf?: (key: string) => string | undefined
  notify: (key: string, change: SkillChange) => void
  /** Ask the key's approvers; `kind` picks the buttons. */
  ask: (key: string, text: string, id: string, kind: 'propose' | 'diff') => void
  log?: (line: string) => void
}

const clean = (sections: SkillProposal['sections']) =>
  Object.fromEntries(Object.entries(sections).filter((e): e is [string, string] => !!e[1]?.trim()))

/** The existing skill a proposal refers to: by name, else by a similar description. */
export function matchSkill(store: SkillStore, name: string, description: string) {
  const byName = store.read(name)
  if (byName) return byName
  const want = tokens(description)
  let best: { s: ReturnType<SkillStore['list']>[number]; score: number } | undefined
  for (const s of store.list()) {
    const score = jaccard(want, tokens(s.description))
    if (score > SIMILAR && (!best || score > best.score)) best = { s, score }
  }
  return best?.s
}

/** Changed sections of a foreign skill as `-`/`+` lines, for the owner to approve. */
export function sectionDiff(body: string, sections: Record<string, string>): string {
  const old = splitSections(body)
  const out: string[] = []
  for (const [head, text] of Object.entries(sections)) {
    const before = (old.get(head) ?? '').split('\n').filter(Boolean)
    const after = text.split('\n').filter(Boolean)
    if (before.join('\n') === after.join('\n')) continue
    out.push(`## ${head}`, ...before.filter(l => !after.includes(l)).map(l => `- ${l}`), ...after.filter(l => !before.includes(l)).map(l => `+ ${l}`))
  }
  return out.join('\n')
}

/** The draft as it will read, for previews and Edit. */
export function draftText(pl: Planned): string {
  const cur = pl.op === 'patch' ? pl.store.read(pl.name) : undefined
  const fields = pl.fields ? fieldsToExtra(pl.fields).map(([k, v]) => `${k}: ${v}\n`).join('') : ''
  return `${pl.description}\n${fields}\n${patchSections(cur?.body ?? '', pl.sections)}`
}

export function createSkillApplier(opts: SkillApplyOpts) {
  const log = opts.log ?? (() => {})
  const pending = new Map<string, { key: string; plan: Planned }>()

  function plan(key: string, p: SkillProposal): Planned | undefined {
    const store = opts.store(key)
    const sections = clean(p.sections)
    const existing = matchSkill(store, p.name, p.description)
    if (existing) {
      return { store, op: 'patch', name: existing.name, description: p.description || existing.description, sections, fields: p.fields, foreign: existing.metadata.source !== 'tg' }
    }
    const why = nameRefusal(p.name, opts.taken(store))
    if (why) return void log(`skills: dropped ${p.name}: ${why}`)
    if (!sections.Steps) return void log(`skills: dropped ${p.name}: no Steps section`)
    return { store, op: 'create', name: p.name, description: p.description, sections, fields: p.fields, foreign: false }
  }

  function run(key: string, pl: Planned): SkillChange {
    const { store, name } = pl
    const why = skillRefusal(pl.fields ?? {}, Object.values(pl.sections).join('\n'), opts.policy(key))
    if (why) throw new Error(why)
    const extra = pl.fields && fieldsToExtra(pl.fields)
    if (pl.op === 'create') {
      const session = opts.sessionOf?.(key)
      store.create({ name, description: pl.description, sections: pl.sections, extra, metadata: { ...(session && { created_from: session }), session_key: key } })
      return { verb: 'Learned', name, version: 1, store, undo: () => store.remove(name) }
    }
    const cur = extra && store.read(name)?.extra.filter(([k]) => !extra.some(([e]) => e === k))
    const r = store.patch(name, { description: pl.foreign ? undefined : pl.description, sections: pl.sections, extra: cur && [...cur, ...extra] }, { foreign: pl.foreign })
    return { verb: 'Updated', name, version: r.version, store, undo: () => store.undo(name) }
  }

  function hold(key: string, pl: Planned): string {
    const id = randomBytes(6).toString('hex')
    pending.set(id, { key, plan: pl })
    if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!)
    return id
  }

  function askFor(key: string, pl: Planned): void {
    if (pl.foreign) {
      const diff = sectionDiff(pl.store.read(pl.name)?.body ?? '', pl.sections)
      if (!diff) return
      opts.ask(key, `📘 Suggested change to your skill ${pl.name}:\n\n${diff}`, hold(key, pl), 'diff')
      return
    }
    const what = pl.op === 'create' ? `Learn skill ${pl.name}` : `Update skill ${pl.name}`
    opts.ask(key, `📘 ${what}?\n\n${draftText(pl)}`, hold(key, pl), 'propose')
  }

  /** Acts on one proposal; `ask` forces the approval step even under `auto`. A line describing the outcome. */
  function one(key: string, p: SkillProposal, ask = false): string {
    const policy = opts.policy(key)
    if (!policy.autoLearn || policy.autoLearn === 'off') return 'skill learning is off for this chat (autoLearn: off)'
    const pl = plan(key, p)
    if (!pl) return `skill ${p.name} was not saved: invalid or clashing name, or no Steps`
    if (pl.foreign || ask || policy.autoLearn === 'propose') {
      askFor(key, pl)
      return `proposed ${pl.op === 'create' ? 'new skill' : 'change to'} ${pl.name}; waiting for approval`
    }
    try {
      const change = run(key, pl)
      opts.notify(key, change)
      return `${change.verb.toLowerCase()} skill ${change.name} (v${change.version})`
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      log(`skills: dropped ${pl.name}: ${why}`)
      return `skill ${pl.name} was not saved: ${why}`
    }
  }

  return {
    one,

    apply(key: string, proposals: Pick<Proposals, 'skills'>): void {
      const p = proposals.skills.find(s => s.op !== 'none' && s.confidence >= MIN_CONFIDENCE)
      if (p) one(key, p)
    },

    /** The pending plan's key and draft, for Edit. */
    pending(id: string): { key: string; draft: string } | undefined {
      const p = pending.get(id)
      return p && { key: p.key, draft: draftText(p.plan) }
    },

    /** A Save or Skip tap. Undefined when the proposal is gone. */
    decide(id: string, save: boolean): { change?: SkillChange; error?: string } | undefined {
      const p = pending.get(id)
      if (!p) return undefined
      pending.delete(id)
      if (!save) return {}
      try {
        return { change: run(p.key, p.plan) }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },

    /**
     * ✏️ Edit: the approver's reply replaces the draft. It may be a whole
     * SKILL.md or the description line followed by `## ` sections.
     */
    edit(id: string, text: string): { change?: SkillChange; error?: string } | undefined {
      const p = pending.get(id)
      if (!p) return undefined
      const fm = parseSkill(text)
      const body = fm ? fm.body : text
      const sections = Object.fromEntries([...splitSections(body)].filter(([k]) => k))
      const lead = fm?.description || splitSections(body).get('')?.split('\n')[0]?.trim()
      if (!Object.keys(sections).length) return { error: 'no ## sections found; reply with the edited draft' }
      p.plan = { ...p.plan, sections, ...(lead && { description: lead }) }
      return this.decide(id, true)
    },
  }
}

export type SkillApplier = ReturnType<typeof createSkillApplier>
