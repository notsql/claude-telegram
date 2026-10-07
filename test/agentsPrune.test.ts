import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { archiveAgent, evalTargets, skillCreatorInstalled, staleAgents } from '../agents/prune'

const agent = (dir: string, name: string, source: string, mtime: string) => {
  const f = join(dir, `${name}.md`)
  writeFileSync(f, `---\nname: ${name}\ndescription: d\n---\n<!-- source: ${source} · version: 1 -->\nbody\n`)
  utimesSync(f, new Date(mtime), new Date(mtime))
}

test('stale agents: learned, unused for 60 days by last use else mtime; shipped and user agents skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-agents-'))
  const assets = mkdtempSync(join(tmpdir(), 'tg-assets-'))
  mkdirSync(join(assets, 'agents'))
  writeFileSync(join(assets, 'agents', 'tg-curator.md'), '')
  agent(dir, 'tg-old', 'tg', '2026-06-01')
  agent(dir, 'tg-older', 'tg', '2026-05-01')
  agent(dir, 'tg-used', 'tg', '2026-06-01')
  agent(dir, 'tg-fresh', 'tg', '2026-10-01')
  agent(dir, 'tg-curator', 'tg', '2026-01-01')
  agent(dir, 'mine', 'user', '2026-01-01')
  const usage = { 'tg-used': { count: 3, last_used: '2026-09-30T00:00:00Z', total_ms: 1 } }
  expect(staleAgents(dir, usage, Date.parse('2026-10-07'), 60, assets)).toEqual(['tg-older', 'tg-old'])
})

test('archive moves the agent to .archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-agents-'))
  agent(dir, 'tg-old', 'tg', '2026-06-01')
  archiveAgent(dir, 'tg-old')
  expect(existsSync(join(dir, 'tg-old.md'))).toBe(false)
  expect(existsSync(join(dir, '.archive', 'tg-old.md'))).toBe(true)
  expect(() => archiveAgent(dir, 'tg-old')).toThrow()
})

test('skill-creator detection and eval targets', () => {
  const c = mkdtempSync(join(tmpdir(), 'tg-claude-'))
  expect(skillCreatorInstalled(c)).toBe(false)
  mkdirSync(join(c, 'plugins'))
  writeFileSync(join(c, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'other@m': [] } }))
  expect(skillCreatorInstalled(c)).toBe(false)
  writeFileSync(join(c, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'skill-creator@m': [] } }))
  expect(skillCreatorInstalled(c)).toBe(true)
  expect(evalTargets({ 'tg-a': { count: 5 }, 'tg-b': { count: 1 }, Explore: { count: 9 } }, { s: { count: 6 }, t: { count: 2 } }))
    .toEqual({ agents: ['tg-a'], skills: ['s'] })
})
