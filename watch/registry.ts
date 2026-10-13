/**
 * Source registry (013 FR1): `STATE_DIR/sources.json`, written atomically.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { readJson, writeJson } from '../util/files.ts'

const SourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  title: z.string(),
  kind: z.enum(['stream', 'webhook', 'poll', 'agent-poll']),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  cursor: z.string().nullable(),
  status: z.enum(['ok', 'paused', 'error']),
  lastItemAt: z.number().nullable(),
  errors: z.number().int().nonnegative(),
})

export type Source = z.infer<typeof SourceSchema>

const SourcesFileSchema = z.object({ sources: z.array(SourceSchema) })

export const sourcesPath = (stateDir: string) => join(stateDir, 'sources.json')

/** Missing file means no sources. A corrupt file throws rather than being silently overwritten. */
export function loadSources(stateDir: string): Source[] {
  const path = sourcesPath(stateDir)
  if (!existsSync(path)) return []
  return SourcesFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).sources
}

export function saveSources(stateDir: string, sources: Source[]): void {
  const ids = new Set<string>()
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error(`duplicate source id "${s.id}"`)
    ids.add(s.id)
  }
  writeJson(sourcesPath(stateDir), SourcesFileSchema.parse({ sources }))
}

/** Loads, applies `fn` to source `id`, saves. Throws if `id` is unknown. */
function updateSource(stateDir: string, id: string, fn: (s: Source) => Source): Source {
  const sources = loadSources(stateDir)
  const i = sources.findIndex(s => s.id === id)
  if (i < 0) throw new Error(`unknown source "${id}"`)
  sources[i] = fn(sources[i]!)
  saveSources(stateDir, sources)
  return sources[i]!
}

/** Enable resumes a source; pause stops it without forgetting its cursor. */
export const setEnabled = (stateDir: string, id: string, enabled: boolean) =>
  updateSource(stateDir, id, s => ({ ...s, enabled, status: enabled ? 'ok' : 'paused' }))

export const setCursor = (stateDir: string, id: string, cursor: string | null) =>
  updateSource(stateDir, id, s => ({ ...s, cursor }))

/** Health counters: an item resets the error count; a failure increments it. */
export const recordItem = (stateDir: string, id: string, at: number) =>
  updateSource(stateDir, id, s => ({ ...s, lastItemAt: at, errors: 0, status: s.enabled ? 'ok' : s.status }))

/** Drops source `id`. Throws if unknown. */
export function removeSource(stateDir: string, id: string): void {
  const sources = loadSources(stateDir)
  if (!sources.some(s => s.id === id)) throw new Error(`unknown source "${id}"`)
  saveSources(stateDir, sources.filter(s => s.id !== id))
}

export const recordError =(stateDir: string, id: string) =>
  updateSource(stateDir, id, s => ({ ...s, errors: s.errors + 1, status: s.enabled ? 'error' : s.status }))

/** Where inbox summaries and digests go (a session key and the chat's title); unset means the owner DM. */
export type DeliveryTarget = { key: string; title: string }

const targetPath = (stateDir: string) => join(stateDir, 'inbox-target.json')
export const loadTarget = (stateDir: string) => readJson<DeliveryTarget>(targetPath(stateDir))
export const saveTarget = (stateDir: string, t: DeliveryTarget) => writeJson(targetPath(stateDir), t)
