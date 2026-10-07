import { expect, test } from 'bun:test'
import { visibleTools } from '../policy/tools.ts'

test('tools whose requires flag is not true are hidden', () => {
  const tools = [{ name: 'reply' }, { name: 'schedule', requires: 'schedulerAllowed' as const }]
  expect(visibleTools(tools, {}).map(t => t.name)).toEqual(['reply'])
  expect(visibleTools(tools, { schedulerAllowed: false }).map(t => t.name)).toEqual(['reply'])
  expect(visibleTools(tools, { schedulerAllowed: true })).toEqual([{ name: 'reply' }, { name: 'schedule' }])
})
