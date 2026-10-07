import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ASSETS_DIR, installAssets } from '../agents/install'

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-agi-'))
  const assets = join(root, 'assets')
  mkdirSync(join(assets, 'agents'), { recursive: true })
  mkdirSync(join(assets, 'skills', 'tg-x'), { recursive: true })
  writeFileSync(join(assets, 'agents', 'tg-a.md'), 'v1')
  writeFileSync(join(assets, 'skills', 'tg-x', 'SKILL.md'), 's1')
  return { assets, claude: join(root, 'claude'), manifest: join(root, 'state', 'agents-installed.json') }
}

test('fresh install copies agents and skills', () => {
  const { assets, claude, manifest } = setup()
  const r = installAssets(claude, manifest, assets)
  expect(r.installed.sort()).toEqual(['agents/tg-a.md', 'skills/tg-x/SKILL.md'])
  expect(readFileSync(join(claude, 'agents', 'tg-a.md'), 'utf8')).toBe('v1')
  expect(readFileSync(join(claude, 'skills', 'tg-x', 'SKILL.md'), 'utf8')).toBe('s1')
})

test('upgrade replaces unedited files and keeps user-edited ones', () => {
  const { assets, claude, manifest } = setup()
  installAssets(claude, manifest, assets)
  writeFileSync(join(claude, 'skills', 'tg-x', 'SKILL.md'), 'mine')
  writeFileSync(join(assets, 'agents', 'tg-a.md'), 'v2')
  writeFileSync(join(assets, 'skills', 'tg-x', 'SKILL.md'), 's2')
  const r = installAssets(claude, manifest, assets)
  expect(r.updated).toEqual(['agents/tg-a.md'])
  expect(r.kept).toEqual(['skills/tg-x/SKILL.md'])
  expect(readFileSync(join(claude, 'agents', 'tg-a.md'), 'utf8')).toBe('v2')
  expect(readFileSync(join(claude, 'skills', 'tg-x', 'SKILL.md'), 'utf8')).toBe('mine')
  // still kept on later runs
  expect(installAssets(claude, manifest, assets).kept).toEqual(['skills/tg-x/SKILL.md'])
})

test('an existing file we never installed is not overwritten', () => {
  const { assets, claude, manifest } = setup()
  mkdirSync(join(claude, 'agents'), { recursive: true })
  writeFileSync(join(claude, 'agents', 'tg-a.md'), 'theirs')
  expect(installAssets(claude, manifest, assets).kept).toEqual(['agents/tg-a.md'])
  expect(readFileSync(join(claude, 'agents', 'tg-a.md'), 'utf8')).toBe('theirs')
})

test('shipped assets include the six tg agents and two guidance skills', () => {
  const claude = mkdtempSync(join(tmpdir(), 'tg-agi-real-'))
  const r = installAssets(claude, join(claude, 'm.json'))
  expect(r.installed.filter(p => p.startsWith('agents/')).length).toBe(6)
  expect(r.installed).toContain('skills/tg-research-method/SKILL.md')
  expect(r.installed).toContain('skills/tg-skill-authoring/SKILL.md')
  expect(ASSETS_DIR.endsWith('assets')).toBe(true)
})
