import { describe, expect, test } from 'bun:test'
import type { Api } from 'grammy'
import { createApprovals } from '../policy/approvals.ts'
import { addAlwaysAllow } from '../policy/resolve.ts'
import { defaultAccess } from '../access.ts'

function fakeApi() {
  const sent: { chat: string; text: string; opts: any }[] = []
  const edits: string[] = []
  const api = {
    sendMessage: async (chat: string, text: string, opts: any) => { sent.push({ chat, text, opts }); return { message_id: 9 } },
    editMessageText: async (_c: string, _m: number, text: string) => { edits.push(text) },
  } as unknown as Api
  return { api, sent, edits }
}

const idOf = (opts: any) => /perm:allow:([a-z]{5})/.exec(JSON.stringify(opts.reply_markup))![1]
const tick = () => new Promise(r => setTimeout(r, 5))

describe('approvals', () => {
  test('prompt goes to the topic and Allow resolves the held request', async () => {
    const { api, sent } = fakeApi()
    const a = createApprovals({ api, timeoutSec: 60, saveRule: () => {} })
    const res = a.handle({ tool_name: 'Bash', tool_input: { command: 'ls ~' } }, '-100:7')
    await tick()
    expect(sent[0]).toMatchObject({ chat: '-100', text: '🔐 Permission: Bash', opts: { message_thread_id: 7 } })
    expect(a.decide(idOf(sent[0]!.opts), 'allow')).toBe(true)
    expect((await res).hookSpecificOutput.decision).toEqual({ behavior: 'allow' })
  })

  test('Deny returns a deny with a message; a second tap is rejected', async () => {
    const { api, sent } = fakeApi()
    const a = createApprovals({ api, timeoutSec: 60, saveRule: () => {} })
    const res = a.handle({ tool_name: 'Bash', tool_input: { command: 'rm x' } }, '5')
    await tick()
    const id = idOf(sent[0]!.opts)
    a.decide(id, 'deny')
    expect((await res).hookSpecificOutput.decision.behavior).toBe('deny')
    expect(a.decide(id, 'allow')).toBe(false)
  })

  test('unanswered prompts expire into a deny (AC4)', async () => {
    const { api, edits } = fakeApi()
    const a = createApprovals({ api, timeoutSec: 0.02, saveRule: () => {} })
    const out = await a.handle({ tool_name: 'Bash', tool_input: { command: 'ls' } }, '5')
    expect(out.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(edits).toEqual(['🔐 Permission: Bash\n\n⌛ Expired'])
  })

  test('Always saves the rule and applies it to the session', async () => {
    const { api, sent } = fakeApi()
    const saved: string[] = []
    const a = createApprovals({ api, timeoutSec: 60, saveRule: (k, r) => saved.push(`${k} ${r}`) })
    const res = a.handle({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, '5')
    await tick()
    a.decide(idOf(sent[0]!.opts), 'always')
    expect((await res).hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }], behavior: 'allow', destination: 'session' }],
    })
    expect(saved).toEqual(['5 Bash(npm test *)'])
  })

  test('See more shows the input until decided', async () => {
    const { api, sent } = fakeApi()
    const a = createApprovals({ api, timeoutSec: 60, saveRule: () => {} })
    void a.handle({ tool_name: 'Bash', tool_input: { command: 'ls' } }, '5')
    await tick()
    const id = idOf(sent[0]!.opts)
    expect(a.details(id)).toContain('"command": "ls"')
    a.decide(id, 'deny')
    expect(a.details(id)).toBeUndefined()
  })
})

test('addAlwaysAllow appends once to the exact key', () => {
  const access = defaultAccess()
  addAlwaysAllow(access, '-100:7', 'Bash(ls *)')
  addAlwaysAllow(access, '-100:7', 'Bash(ls *)')
  expect(access.chats).toEqual({ '-100:7': { policy: { alwaysAllow: ['Bash(ls *)'] } } })
})

test('keyboard has Always and keyOf tracks pending requests', async () => {
  const { api, sent } = fakeApi()
  const a = createApprovals({ api, timeoutSec: 60, saveRule: () => {} })
  void a.handle({ tool_name: 'Bash', tool_input: {} }, '-100:7')
  await tick()
  const id = idOf(sent[0]!.opts)
  expect(JSON.stringify(sent[0]!.opts.reply_markup)).toContain(`perm:always:${id}`)
  expect(a.keyOf(id)).toBe('-100:7')
  a.decide(id, 'deny')
  expect(a.keyOf(id)).toBeUndefined()
})

test('parseTextReply', async () => {
  const { parseTextReply } = await import('../policy/approvals.ts')
  expect(parseTextReply('Yes ABCDE')).toEqual({ id: 'abcde', decision: 'allow' })
  expect(parseTextReply(' n qwert ')).toEqual({ id: 'qwert', decision: 'deny' })
  expect(parseTextReply('yes')).toBeUndefined()
  expect(parseTextReply('yes hello there')).toBeUndefined()
})

test('decisions are audited with key, user, tool and decision', async () => {
  const { api, sent } = fakeApi()
  const entries: any[] = []
  const a = createApprovals({ api, timeoutSec: 60, saveRule: () => {}, audit: e => entries.push(e) })
  const res = a.handle({ tool_name: 'Bash', tool_input: { command: 'ls' } }, '5')
  await tick()
  a.decide(idOf(sent[0]!.opts), 'always', '42')
  await res
  expect(entries).toEqual([{ event: 'approval', key: '5', tool: 'Bash', decision: 'always', user: '42', rule: 'Bash(ls *)' }])
})

test('createAudit appends JSONL', async () => {
  const { createAudit } = await import('../policy/audit.ts')
  const { mkdtempSync, readFileSync } = await import('fs')
  const { join } = await import('path')
  const { tmpdir } = await import('os')
  const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.log')
  const audit = createAudit(file)
  audit({ event: 'policy', key: '5', user: '1', field: 'model', value: 'sonnet' })
  audit({ event: 'approval', key: '5', tool: 'Bash', decision: 'expired' })
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatchObject({ event: 'policy', field: 'model', value: 'sonnet' })
  expect(typeof lines[0].ts).toBe('string')
})
