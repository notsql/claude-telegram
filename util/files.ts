/**
 * Shared file IO. Writes go through tmp + rename, so a crash or a turn
 * reading at the same moment never sees half a file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/** Atomic write, creating the parent dir. Pass `0o600` for anything holding chat data. */
export function writeAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, text, mode === undefined ? undefined : { mode })
  renameSync(`${path}.tmp`, path)
}

/** Pretty-printed JSON, owner-only by default. */
export function writeJson(path: string, data: unknown, mode = 0o600): void {
  writeAtomic(path, JSON.stringify(data, null, 2) + '\n', mode)
}

/** Parsed JSON, or undefined when the file is missing or unreadable. */
export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}
