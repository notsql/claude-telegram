import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ACTIONS_CALLBACK, actionLines, actionsView } from '../telegram/handlers/actions.ts'
import { policyView } from '../telegram/policyUi.ts'

describe('🛡 Actions page (020 FR5)', () => {
  test('lists action entries newest first with their outcome (AC5)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'act-')), 'audit.log')
    const rows = [
      { ts: '2026-10-25T01:00:00Z', event: 'approval', key: '5', tool: 'Bash', decision: 'allow' },
      { ts: '2026-10-25T02:00:00Z', event: 'approval', key: '5', tool: 'mcp__gmail__sendEmail', decision: 'allow', action: 'send', summary: 'Send · gmail sendEmail → a@b.c' },
      { ts: '2026-10-25T03:00:00Z', event: 'approval', key: '5', tool: 'action_confirm', decision: 'expired', action: 'pay', summary: 'Pay S$84.20 to SP Group' },
      { ts: '2026-10-25T04:00:00Z', event: 'approval', key: '5', tool: 'mcp__bank__transfer_funds', decision: 'deny', action: 'off_limits', summary: 'moving money between accounts' },
    ]
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\nnot json\n')
    const lines = actionLines(file)
    expect(lines.map(l => l.action)).toEqual(['off_limits', 'pay', 'send'])
    const text = actionsView(lines, new Date('2026-10-25T05:00:00Z')).text
    expect(text).toContain('blocked: moving money between accounts')
    expect(text).toContain('timed out: Pay S$84.20 to SP Group')
    expect(text).toContain('approved: Send · gmail sendEmail → a@b.c')
    expect(actionLines(join(tmpdir(), 'missing-audit.log'))).toEqual([])
  })

  test('the Settings button shows only with the guard on and round-trips', () => {
    const data = (o: { actions?: boolean }) => policyView('5', {}, o).keyboard.inline_keyboard.flat().map(b => 'callback_data' in b ? b.callback_data : '')
    expect(data({ actions: true })).toContain('act:m')
    expect(data({})).not.toContain('act:m')
    expect(ACTIONS_CALLBACK.test('act:m')).toBe(true)
  })
})
