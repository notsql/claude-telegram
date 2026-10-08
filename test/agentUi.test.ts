import { expect, test } from 'bun:test'
import { AGENT_CALLBACK, agentView } from '../telegram/agentUi.ts'

test('agent page marks the current choice and its callbacks round-trip', () => {
  const agents = [{ name: 'tg-researcher', description: 'Web research.' }]
  const v = agentView('tg-researcher', agents)
  expect(v.text).toContain('• tg-researcher: Web research.')
  const b = v.keyboard.inline_keyboard.flat()
  expect(b.map(x => x.text)).toEqual(['Default assistant', '• tg-researcher', '« Back'])
  for (const x of b.slice(0, -1)) expect(AGENT_CALLBACK.test(x.callback_data!)).toBe(true)
  expect(AGENT_CALLBACK.test('agn:m')).toBe(true)
  expect(agentView(undefined, agents).keyboard.inline_keyboard[0]![0]!.text).toBe('• Default assistant')
})
