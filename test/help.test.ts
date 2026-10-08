import { expect, test } from 'bun:test'
import { helpText } from '../commands/help'

test('/help leads with plain language and lists DM commands', () => {
  const t = helpText([
    { name: 'new', description: 'Start a fresh session', menu: ['private', 'group'] },
    { name: 'secret', description: 'x', menu: ['admin'] },
  ])
  expect(t.startsWith('Just talk to me. Plain words work for everything')).toBe(true)
  expect(t).toContain('/new: Start a fresh session')
  expect(t).not.toContain('/secret')
})
