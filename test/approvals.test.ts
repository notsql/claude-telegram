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
    const kept: string[] = []
    const a = createApprovals({ api, timeoutSec: 60, saveRule: () => { throw new Error('Allow must not persist') }, sessionRule: (k, r) => kept.push(`${k} ${r}`) })
    const res = a.handle({ tool_name: 'Bash', tool_input: { command: 'npm install', description: 'Install deps' } }, '-100:7')
    await tick()
    expect(sent[0]).toMatchObject({ chat: '-100', text: expect.stringMatching(/^🔐 Permission: Bash\nInstall deps\n\nOr reply "yes [a-km-z]{5}" \/ "no [a-km-z]{5}"\.$/), opts: { message_thread_id: 7 } })
    expect(a.decide(idOf(sent[0]!.opts), 'allow')).toBe(true)
    // FR15: Allow lasts the session, so it adds the rule without saving it to the chat.
    expect((await res).hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm install *' }], behavior: 'allow', destination: 'session' }],
    })
    expect(kept).toEqual(['-100:7 Bash(npm install *)'])
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
    const out = await a.handle({ tool_name: 'Bash', tool_input: { command: 'touch x' } }, '5')
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

  test('See more shows the command in a code block until decided', async () => {
    const { api, sent } = fakeApi()
    const a = createApprovals({ api, timeoutSec: 60, saveRule: () => {} })
    void a.handle({ tool_name: 'Bash', tool_input: { command: 'rm a && echo "<b>"' } }, '5')
    await tick()
    const id = idOf(sent[0]!.opts)
    expect(a.details(id)).toBe('🔐 Permission: Bash\n\n<pre><code class="language-bash">rm a &amp;&amp; echo "&lt;b&gt;"</code></pre>')
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
  const res = a.handle({ tool_name: 'Bash', tool_input: { command: 'mkdir x' } }, '5')
  await tick()
  a.decide(idOf(sent[0]!.opts), 'always', '42')
  await res
  await a.handle({ tool_name: 'Grep', tool_input: { pattern: 'x' } }, '5')
  expect(entries).toEqual([
    { event: 'approval', key: '5', tool: 'Bash', decision: 'always', user: '42', rule: 'Bash(mkdir x *)' },
    { event: 'approval', key: '5', tool: 'Grep', decision: 'auto' },
  ])
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

test('confirm prompts without Always and resolves to a boolean', async () => {
  const { api, sent } = fakeApi()
  const a = createApprovals({ api, timeoutSec: 60, saveRule: () => {} })
  const res = a.confirm('-100', 'Read', { file_path: '/etc/hosts' })
  await tick()
  expect(JSON.stringify(sent[0]!.opts.reply_markup)).not.toContain('always')
  a.decide(idOf(sent[0]!.opts), 'allow')
  expect(await res).toBe(true)
})

test('Always prefers the CLI suggestions, e.g. a Read rule for a path outside cwd', async () => {
  const { api, sent } = fakeApi()
  const saved: string[] = []
  const a = createApprovals({ api, timeoutSec: 60, saveRule: (_k, r) => saved.push(r) })
  const res = a.handle({
    tool_name: 'Bash',
    tool_input: { command: 'touch ~/Development/x' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//Users/me/Development/**' }], behavior: 'allow', destination: 'session' }],
  }, '5')
  await tick()
  a.decide(idOf(sent[0]!.opts), 'always')
  expect((await res).hookSpecificOutput.decision.updatedPermissions[0].rules).toEqual([{ toolName: 'Read', ruleContent: '//Users/me/Development/**' }])
  expect(saved).toEqual(['Read(//Users/me/Development/**)'])
})

test('tool names read as words in the prompt', async () => {
  const { toolLabel } = await import('../policy/approvals.ts')
  expect(toolLabel('Bash')).toBe('Bash')
  expect(toolLabel('WebFetch')).toBe('Web Fetch')
  expect(toolLabel('NotebookEdit')).toBe('Notebook Edit')
  expect(toolLabel('mcp__claude_ai_Notion__notion-query-data-sources')).toBe('Notion · Notion Query Data Sources')
  expect(toolLabel('mcp__claude_ai_Atlassian_Rovo__getJiraIssue')).toBe('Atlassian Rovo · Get Jira Issue')
  expect(toolLabel('mcp__claude_ai_Google_Drive__list_recent_files')).toBe('Google Drive · List Recent Files')
  expect(toolLabel('mcp__tg__memory_write')).toBe('tg · Memory Write')
  expect(toolLabel('mcp__x__fetchURLContent')).toBe('x · Fetch URL Content')
})
