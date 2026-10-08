import { expect, test } from 'bun:test'
import { bar, formatUsage } from '../agent/planUsage'

test('bar rounds to tenths and clamps', () => {
  expect(bar(41)).toBe('████░░░░░░')
  expect(bar(0)).toBe('░░░░░░░░░░')
  expect(bar(130)).toBe('██████████')
})

test('formatUsage draws a bar per limit and contributor, and passes unknown lines through', () => {
  const out = formatUsage([
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 7% used · resets Oct 8 at 11:09am (Asia/Singapore)',
    "What's contributing to your limits usage?",
    'Last 24h · 1349 requests · 56 sessions',
    '  43% of your usage came from subagent-heavy sessions',
    '  Top skills: /new-feature-spec 1%',
  ].join('\n'))
  expect(out).toBe([
    '📊 Plan usage', '',
    'Current session: 7%', '█░░░░░░░░░', 'Resets Oct 8 at 11:09am (Asia/Singapore)',
    '', "What's using it",
    '', 'Last 24h · 1349 requests · 56 sessions',
    '████░░░░░░ 43% subagent-heavy sessions',
    '  Top skills: /new-feature-spec 1%',
  ].join('\n'))
})
