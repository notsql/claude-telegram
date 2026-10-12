import { expect, test } from 'bun:test'
import { TELEGRAM_INSTRUCTIONS } from '../agent/prompt'

test('appended system prompt carries the capability ladder rule', () => {
  expect(TELEGRAM_INSTRUCTIONS).toContain("Never say you can't do something before running the tg-capability-ladder skill")
})
