/**
 * Installs the shipped tg agents and guidance skills (009 FR1, FR11) into
 * `~/.claude/agents/` and `~/.claude/skills/`. A manifest keeps the checksum
 * of every file as last installed, so an upgrade replaces a file only when it
 * still matches that checksum. A file the user edited (or one we never
 * installed) is left alone.
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'

export const ASSETS_DIR = join(import.meta.dir, '..', 'assets')

type Manifest = Record<string, string>
export type InstallResult = { installed: string[]; updated: string[]; kept: string[] }

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

/**
 * Copies `assets/{agents,skills}` into `claudeDir`. Paths in the result and
 * the manifest are relative to `claudeDir`, e.g. `agents/tg-researcher.md`.
 */
export function installAssets(claudeDir: string, manifestFile: string, assets = ASSETS_DIR): InstallResult {
  let manifest: Manifest = {}
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) } catch {}
  const result: InstallResult = { installed: [], updated: [], kept: [] }

  for (const src of [...files(join(assets, 'agents')), ...files(join(assets, 'skills'))]) {
    const rel = relative(assets, src)
    const dest = join(claudeDir, rel)
    const data = readFileSync(src)
    const want = sha(data)
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, data)
      manifest[rel] = want
      result.installed.push(rel)
      continue
    }
    const have = sha(readFileSync(dest))
    if (have === want) {
      manifest[rel] = want
    } else if (have === manifest[rel]) {
      writeFileSync(dest, data)
      manifest[rel] = want
      result.updated.push(rel)
    } else {
      result.kept.push(rel)
    }
  }

  mkdirSync(dirname(manifestFile), { recursive: true })
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  return result
}
