/**
 * Memory files in Claude Code's auto-memory format (004 FR1): one markdown
 * file per fact with `name`, `description` and `metadata.type` frontmatter,
 * plus a one-line pointer in `MEMORY.md`. Every overwrite or delete first
 * copies the old file to `.bak/<name>.<ts>.md`, which Undo restores (FR9).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { MAX_INDEX_LINES, refusal, slug } from './guard.ts'

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = typeof MEMORY_TYPES[number]

export type MemoryInput = {
  type: MemoryType
  name: string
  description: string
  body: string
  /** Extra `metadata` fields, e.g. `session_key`, `user_id`, `source`. */
  metadata?: Record<string, string>
}

export type MemoryEntry = MemoryInput & { metadata: Record<string, string>; file: string; mtimeMs: number }

export type WriteResult = {
  entry: MemoryEntry
  op: 'create' | 'update'
  /** The previous version, on update. */
  backup?: string
  /** The index passed MAX_INDEX_LINES; a consolidation pass is due (FR8). */
  indexFull: boolean
}

const INDEX = 'MEMORY.md'

function atomicWrite(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}

const quote = (v: string) => (/^[\w .,/@()+-]*$/.test(v) && v.trim() === v && v !== '' ? v : JSON.stringify(v))
const unquote = (v: string) => {
  v = v.trim()
  if (v.startsWith('"')) try { return JSON.parse(v) as string } catch {}
  return v.replace(/^'(.*)'$/, '$1')
}

export function render(e: MemoryInput): string {
  const meta = { type: e.type, ...e.metadata }
  return [
    '---',
    `name: ${quote(e.name)}`,
    `description: ${quote(e.description)}`,
    'metadata:',
    ...Object.entries(meta).map(([k, v]) => `  ${k}: ${quote(v)}`),
    '---',
    e.body.trim(),
    '',
  ].join('\n')
}

/** Tiny frontmatter parser: top-level scalars plus one nested `metadata:` map. */
export function parse(text: string): Omit<MemoryInput, 'type'> & { type?: string; metadata: Record<string, string> } | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return null
  const top: Record<string, string> = {}
  const metadata: Record<string, string> = {}
  let inMeta = false
  for (const line of m[1]!.split('\n')) {
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, indent, k, v] = kv as unknown as [string, string, string, string]
    if (!indent) {
      inMeta = k === 'metadata' && v === ''
      if (!inMeta) top[k] = unquote(v)
    } else if (inMeta) {
      metadata[k] = unquote(v)
    }
  }
  const { type, ...rest } = metadata
  return { name: top.name ?? '', description: top.description ?? '', type: type ?? top.type, body: m[2]!.trim(), metadata: rest }
}

export function createMemoryStore(dir: string) {
  const fileOf = (name: string) => join(dir, `${name}.md`)
  const indexPath = join(dir, INDEX)

  function readEntry(file: string): MemoryEntry | undefined {
    try {
      const p = parse(readFileSync(join(dir, file), 'utf8'))
      if (!p || !MEMORY_TYPES.includes(p.type as MemoryType)) return undefined
      return { ...p, name: p.name || file.replace(/\.md$/, ''), type: p.type as MemoryType, file, mtimeMs: statSync(join(dir, file)).mtimeMs }
    } catch {
      return undefined
    }
  }

  const indexText = () => { try { return readFileSync(indexPath, 'utf8') } catch { return '' } }
  const indexLines = () => indexText().split('\n').filter(l => l.trim()).length

  function setIndexLine(name: string, line: string | undefined): void {
    const pointer = `](${name}.md)`
    const lines = indexText().split('\n').filter(l => l.trim())
    const at = lines.findIndex(l => l.includes(pointer))
    if (line === undefined) { if (at >= 0) lines.splice(at, 1) }
    else if (at >= 0) lines[at] = line
    else lines.push(line)
    atomicWrite(indexPath, lines.length ? lines.join('\n') + '\n' : '')
  }

  function backup(name: string): string | undefined {
    if (!existsSync(fileOf(name))) return undefined
    const bakDir = join(dir, '.bak')
    mkdirSync(bakDir, { recursive: true })
    const path = join(bakDir, `${name}.${Date.now()}.md`)
    copyFileSync(fileOf(name), path)
    return path
  }

  const store = {
    dir,
    list(): MemoryEntry[] {
      let files: string[] = []
      try { files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== INDEX) } catch {}
      return files.map(readEntry).filter((e): e is MemoryEntry => !!e)
    },

    read(name: string): MemoryEntry | undefined {
      return readEntry(`${slug(name)}.md`)
    },

    /** Creates or replaces `name`. Throws with a user-facing reason when the guard refuses it. */
    write(input: MemoryInput): WriteResult {
      const name = slug(input.name)
      if (!name) throw new Error('memory name is empty')
      if (!MEMORY_TYPES.includes(input.type)) throw new Error(`type must be one of ${MEMORY_TYPES.join(', ')}`)
      const description = input.description.replace(/\s+/g, ' ').trim()
      const entry = { ...input, name, description, metadata: input.metadata ?? {} }
      const text = render(entry)
      const why = refusal(text)
      if (why) throw new Error(why)
      mkdirSync(dir, { recursive: true })
      const prev = backup(name)
      atomicWrite(fileOf(name), text)
      setIndexLine(name, `- [${name}](${name}.md) — ${description}`)
      return { entry: readEntry(`${name}.md`)!, op: prev ? 'update' : 'create', backup: prev, indexFull: indexLines() > MAX_INDEX_LINES }
    },

    /** Removes `name` and its index line; returns the backup, or undefined when it did not exist. */
    delete(name: string): { backup: string } | undefined {
      name = slug(name)
      const prev = backup(name)
      if (!prev) return undefined
      rmSync(fileOf(name))
      setIndexLine(name, undefined)
      return { backup: prev }
    },

    /** Undo (FR9): put `backup` back as `name`, or remove `name` when there was none (undoing a create). */
    restore(name: string, backupPath: string | undefined): void {
      if (!backupPath) {
        rmSync(fileOf(name), { force: true })
        setIndexLine(name, undefined)
        return
      }
      mkdirSync(dir, { recursive: true })
      copyFileSync(backupPath, fileOf(name))
      const e = readEntry(`${name}.md`)
      if (e) setIndexLine(name, `- [${name}](${name}.md) — ${e.description}`)
    },

    /** Keyword search over name, description and body, best first. */
    search(query: string): MemoryEntry[] {
      const words = tokens(query)
      if (!words.size) return []
      return store.list()
        .map(e => {
          const head = tokens(`${e.name} ${e.description}`)
          const body = tokens(e.body)
          let score = 0
          for (const w of words) score += head.has(w) ? 2 : body.has(w) ? 1 : 0
          return { e, score }
        })
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score || b.e.mtimeMs - a.e.mtimeMs)
        .map(r => r.e)
    },

    index: indexText,
    indexMtime(): number {
      try { return statSync(indexPath).mtimeMs } catch { return 0 }
    },
  }
  return store
}

export type MemoryStore = ReturnType<typeof createMemoryStore>

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'is', 'on', 'with', 'not', 'user', 'uses', 'use', 'i', 'my', 'me'])

export function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w)))
}

/** Jaccard similarity of two token sets (FR7 dedup). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return both / (a.size + b.size - both)
}
