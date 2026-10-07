/**
 * SKILL.md files under one skills root (006 FR1, plan "Patch semantics").
 * Frontmatter keeps `name`, `description`, any optional top-level fields
 * (`arguments`, `allowed-tools`, `context`…) as written, and a nested
 * `metadata` map (`source: hermes`, `version`, `created`, `updated`…).
 * A patch replaces named `## ` sections only. Before each patch the previous
 * file is copied to `<skill>/.bak/<version>.md`; undo restores the newest one.
 * Only `source: hermes` skills are patched unless the caller passes
 * `foreign: true` after an owner approved the diff (FR5).
 * Every write, undo, removal and archive emits `skills-changed` on
 * `skillEvents`, for the 008 menu refresh.
 */

import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { secretRefusal } from '../memory/guard.ts'
import { archiveDir, validName } from './paths.ts'

export const SECTIONS = ['When to use', 'Prerequisites', 'Steps', 'Pitfalls', 'Verify'] as const
export const MAX_SKILL_BYTES = 16_384

export type Skill = {
  name: string
  description: string
  /** Optional top-level frontmatter, raw YAML values, in file order. */
  extra: [string, string][]
  metadata: Record<string, string>
  body: string
  dir: string
}

export type SkillDraft = {
  name: string
  description: string
  /** Section heading → content, e.g. `{ Steps: '1. …' }`. */
  sections: Record<string, string>
  extra?: [string, string][]
  metadata?: Record<string, string>
}

const quote = (v: string) => (/^[\w .,/@()+-]*$/.test(v) && v.trim() === v && v !== '' ? v : JSON.stringify(v))
const unquote = (v: string) => {
  v = v.trim()
  if (v.startsWith('"')) try { return JSON.parse(v) as string } catch {}
  return v.replace(/^'(.*)'$/, '$1')
}
const today = () => new Date().toISOString().slice(0, 10)

export function parseSkill(text: string, dir = ''): Skill | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return null
  let name = '', description = ''
  const extra: [string, string][] = []
  const metadata: Record<string, string> = {}
  let inMeta = false
  for (const line of m[1]!.split('\n')) {
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, indent, k, v] = kv as unknown as [string, string, string, string]
    if (indent) { if (inMeta) metadata[k] = unquote(v); continue }
    inMeta = k === 'metadata' && v === ''
    if (inMeta) continue
    if (k === 'name') name = unquote(v)
    else if (k === 'description') description = unquote(v)
    else extra.push([k, v])
  }
  return { name, description, extra, metadata, body: m[2]!.trim(), dir }
}

export function renderSkill(s: Pick<Skill, 'name' | 'description' | 'extra' | 'metadata' | 'body'>): string {
  return [
    '---',
    `name: ${quote(s.name)}`,
    `description: ${quote(s.description)}`,
    ...s.extra.map(([k, v]) => `${k}: ${v}`),
    'metadata:',
    ...Object.entries(s.metadata).map(([k, v]) => `  ${k}: ${quote(v)}`),
    '---',
    s.body.trim(),
    '',
  ].join('\n')
}

/** `## Heading` → content. Text before the first heading is kept under ''. */
export function splitSections(body: string): Map<string, string> {
  const out = new Map<string, string>()
  let head = ''
  let lines: string[] = []
  const flush = () => { if (head || lines.join('').trim()) out.set(head, lines.join('\n').trim()) }
  for (const line of body.split('\n')) {
    const h = /^## (.+?)\s*$/.exec(line)
    if (h) { flush(); head = h[1]!; lines = [] } else lines.push(line)
  }
  flush()
  return out
}

/** Replaces the named sections in `body`, adds missing ones in template order, keeps the rest. */
export function patchSections(body: string, sections: Record<string, string>): string {
  const map = splitSections(body)
  for (const [k, v] of Object.entries(sections)) if (v.trim()) map.set(k, v.trim())
  const order = [...map.keys()].sort((a, b) => rank(a) - rank(b))
  return order.map(k => (k ? `## ${k}\n${map.get(k)}` : map.get(k)!)).join('\n\n')
}

const rank = (head: string) => {
  if (!head) return -1
  const i = SECTIONS.indexOf(head as typeof SECTIONS[number])
  return i < 0 ? SECTIONS.length : i
}

/** `skills-changed` with `{ root, name }`. */
export const skillEvents = new EventEmitter()
const changed = (root: string, name: string) => skillEvents.emit('skills-changed', { root, name })

export type SkillWrite = { skill: Skill; op: 'create' | 'patch'; version: number }

export function createSkillStore(root: string) {
  const dirOf = (name: string) => join(root, name)
  const fileOf = (name: string) => join(dirOf(name), 'SKILL.md')

  function check(name: string, text: string): void {
    if (!validName(name)) throw new Error(`skill name "${name}" must match [a-z0-9-]{1,48}`)
    const secret = secretRefusal(text, 'skills')
    if (secret) throw new Error(secret)
    const bytes = new TextEncoder().encode(text).length
    if (bytes > MAX_SKILL_BYTES) throw new Error(`SKILL.md is ${bytes} bytes, over the ${MAX_SKILL_BYTES}-byte limit`)
  }

  function write(name: string, text: string): void {
    mkdirSync(dirOf(name), { recursive: true })
    writeFileSync(`${fileOf(name)}.tmp`, text)
    renameSync(`${fileOf(name)}.tmp`, fileOf(name))
    changed(root, name)
  }

  const store = {
    root,

    read(name: string): Skill | undefined {
      if (!validName(name)) return undefined
      try { return parseSkill(readFileSync(fileOf(name), 'utf8'), dirOf(name)) ?? undefined } catch { return undefined }
    },

    list(): Skill[] {
      let names: string[] = []
      try { names = readdirSync(root).filter(n => !n.startsWith('.')) } catch {}
      return names.map(n => store.read(n)).filter((s): s is Skill => !!s)
    },

    /** Raw SKILL.md, for Show. */
    text(name: string): string | undefined {
      try { return readFileSync(fileOf(name), 'utf8') } catch { return undefined }
    },

    /** New hermes skill at version 1. Throws when it exists or the guard refuses it. */
    create(d: SkillDraft): SkillWrite {
      if (existsSync(fileOf(d.name))) throw new Error(`skill ${d.name} already exists; patch it instead`)
      const metadata = { source: 'hermes', version: '1', ...d.metadata, created: today(), updated: today() }
      const skill = { name: d.name, description: d.description.replace(/\s+/g, ' ').trim(), extra: d.extra ?? [], metadata, body: patchSections('', d.sections), dir: dirOf(d.name) }
      const text = renderSkill(skill)
      check(d.name, text)
      write(d.name, text)
      return { skill, op: 'create', version: 1 }
    },

    /** Replaces sections (and optionally description/extra); backs up, bumps `version`. */
    patch(name: string, p: { description?: string; sections: Record<string, string>; extra?: [string, string][]; metadata?: Record<string, string> }, opts: { foreign?: boolean } = {}): SkillWrite {
      const cur = store.read(name)
      if (!cur) throw new Error(`no skill named ${name}`)
      if (cur.metadata.source !== 'hermes' && !opts.foreign) throw new Error(`skill ${name} was not written by hermes; propose a diff instead`)
      const prev = Number(cur.metadata.version) || 1
      const version = prev + 1
      const skill: Skill = {
        ...cur,
        description: p.description?.replace(/\s+/g, ' ').trim() || cur.description,
        extra: p.extra ?? cur.extra,
        metadata: { ...cur.metadata, ...p.metadata, version: String(version), updated: today() },
        body: patchSections(cur.body, p.sections),
      }
      const text = renderSkill(skill)
      check(name, text)
      const bak = join(dirOf(name), '.bak')
      mkdirSync(bak, { recursive: true })
      writeFileSync(join(bak, `${prev}.md`), store.text(name)!)
      write(name, text)
      return { skill, op: 'patch', version }
    },

    /** Restores the newest `.bak` (and removes it). False when there is none. */
    undo(name: string): boolean {
      const bak = join(dirOf(name), '.bak')
      let versions: number[] = []
      try { versions = readdirSync(bak).map(f => parseInt(f, 10)).filter(n => n > 0) } catch {}
      if (!versions.length) return false
      const last = join(bak, `${Math.max(...versions)}.md`)
      write(name, readFileSync(last, 'utf8'))
      rmSync(last)
      return true
    },

    /** Removes a skill entirely (undoing its creation). */
    remove(name: string): void {
      if (!validName(name)) return
      rmSync(dirOf(name), { recursive: true, force: true })
      changed(root, name)
    },

    /** Moves a skill to `.archive/<name>` (a dated suffix when that is taken). */
    archive(name: string): string {
      if (!store.read(name)) throw new Error(`no skill named ${name}`)
      const dest = archiveDir(root)
      mkdirSync(dest, { recursive: true })
      let to = join(dest, name)
      if (existsSync(to)) to = `${to}-${Date.now()}`
      renameSync(dirOf(name), to)
      changed(root, name)
      return to
    },
  }
  return store
}

export type SkillStore = ReturnType<typeof createSkillStore>
