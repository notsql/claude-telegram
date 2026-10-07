import { expect, test } from 'bun:test'
import { helpText, pairingStatus } from '../commands/help'

test('/help leads with plain language and lists DM commands', () => {
  const t = helpText([
    { name: 'new', description: 'Start a fresh session', menu: ['private', 'group'] },
    { name: 'secret', description: 'x', menu: ['admin'] },
  ])
  expect(t.startsWith('Just talk to me. Plain words work for everything')).toBe(true)
  expect(t).toContain('/new: Start a fresh session')
  expect(t).not.toContain('/secret')
})

test('/status: paired, pending, unpaired', () => {
  const access = { allowFrom: ['1'], pending: { abc123: { senderId: '2' } as never } }
  expect(pairingStatus(access, '1', '@me', () => 'Session: x')).toBe('Paired as @me.\n\nSession: x')
  expect(pairingStatus(access, '2', '2', () => '')).toContain('/telegram:access pair abc123')
  expect(pairingStatus(access, '3', '3', () => '')).toBe('Not paired. Send me a message to get a pairing code.')
})
