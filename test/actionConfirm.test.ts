import { describe, expect, test } from 'bun:test'
import { createActionConfirm } from '../policy/actionConfirm.ts'
import { turnArgv } from '../agent/runner.ts'
import { ACTION_GUARD_INSTRUCTIONS } from '../agent/prompt.ts'

const textOf = (r: any) => r.content[0].text as string

describe('action_confirm (020 FR2)', () => {
  test('posts a 💳 card in the calling session and reports the answer (AC2)', async () => {
    const asked: string[] = []
    let ok = true
    const tools = createActionConfirm(async (key, tool, input, title) => { asked.push(`${key} ${tool} ${title} ${input.details}`); return ok })
    const args = { class: 'pay', summary: 'Pay S$84.20 to SP Group', details: 'Bill Oct 2026' }
    expect(textOf(await tools.call('action_confirm', args, '-100:7'))).toStartWith('Approved.')
    ok = false
    expect(textOf(await tools.call('action_confirm', args, '-100:7'))).toStartWith('Not approved.')
    expect(asked[0]).toBe('-100:7 action_confirm 💳 Pay · Pay S$84.20 to SP Group Bill Oct 2026')
  })

  test('rejects unknown classes and other tool names', async () => {
    const tools = createActionConfirm(async () => { throw new Error('must not ask') })
    expect((await tools.call('action_confirm', { class: 'trade', summary: 'x', details: '' }, '1'))!.isError).toBe(true)
    expect(await tools.call('reply', {}, '1')).toBeUndefined()
  })

  test('the action rules are appended only when passed (FR6)', () => {
    const opts = { settingsFile: '/s.json', mcpPort: 1, mcpToken: 't', hookToken: 'h', cwd: '/', maxTurns: 5, policyArgs: [] }
    const prompt = (o: object) => { const a = turnArgv('k', 'hi', o as any); return a[a.indexOf('--append-system-prompt') + 1]! }
    expect(prompt(opts)).not.toContain('action_confirm')
    expect(prompt({ ...opts, extraInstructions: ACTION_GUARD_INSTRUCTIONS })).toContain('call action_confirm first')
  })
})
