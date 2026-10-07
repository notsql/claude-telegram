import { describe, expect, test } from 'bun:test'
import { deriveRule } from '../policy/rules.ts'

const home = '/Users/me'

describe('deriveRule', () => {
  test('Bash keeps command and subcommand as a prefix', () => {
    expect(deriveRule('Bash', { command: 'npm test -- --watch' }, home)).toBe('Bash(npm test *)')
  })

  test('Bash with a non-subcommand argument keeps only the command', () => {
    expect(deriveRule('Bash', { command: 'ls ~' }, home)).toBe('Bash(ls *)')
    expect(deriveRule('Bash', { command: 'ls' }, home)).toBe('Bash(ls *)')
  })

  test('Edit under home becomes a ~ dir glob', () => {
    expect(deriveRule('Edit', { file_path: '/Users/me/proj/a.ts' }, home)).toBe('Edit(~/proj/**)')
    expect(deriveRule('Write', { file_path: '/Users/me/proj/sub/b.ts' }, home)).toBe('Edit(~/proj/sub/**)')
  })

  test('absolute paths outside home use //', () => {
    expect(deriveRule('Read', { file_path: '/etc/hosts' }, home)).toBe('Read(//etc/**)')
  })

  test('other tools are bare', () => {
    expect(deriveRule('WebSearch', { query: 'x' }, home)).toBe('WebSearch')
  })
})
