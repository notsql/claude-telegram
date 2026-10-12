import { expect, test } from 'bun:test'
import { gapHint, missingCommand } from '../capabilities/gap'
import { renderHookSettings } from '../hooks/settings'

const ctx = (r: any) => r.hookSpecificOutput?.additionalContext as string | undefined

test('AC3: a 127 failure from a missing command hints the capability ladder', () => {
  const out = gapHint({
    hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'foo-not-a-cmd --help' },
    error: 'Exit code 127\n(eval):1: command not found: foo-not-a-cmd',
  }) as any
  expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure')
  expect(ctx(out)).toBe('missing command `foo-not-a-cmd`: run tg-capability-ladder')
})

test('bash wording, stderr on a zero exit, and a bare 127 are all gaps', () => {
  expect(missingCommand({ tool_name: 'Bash', tool_response: { stdout: '', stderr: 'bash: line 1: jq: command not found' } })).toBe('jq')
  expect(missingCommand({ tool_name: 'Bash', error: 'Exit code 127' })).toBe('')
  expect(ctx(gapHint({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stderr: 'sh: rg: command not found' } }))).toContain('`rg`')
})

test('other failures and other tools are left alone', () => {
  expect(gapHint({ tool_name: 'Bash', error: 'Exit code 1\nno such file' })).toEqual({})
  expect(gapHint({ tool_name: 'Bash', tool_response: { stdout: 'ok', stderr: '' } })).toEqual({})
  expect(gapHint({ tool_name: 'Read', error: 'command not found: x' })).toEqual({})
})

test('Bash post-tool hooks are sync so the hint reaches the model', () => {
  const h = renderHookSettings({ port: 1, approvalTimeoutSec: 60 }).hooks as any
  const bash = h.PostToolUse.find((m: any) => m.matcher === 'Bash')
  expect(bash.hooks[0].async).toBeUndefined()
  expect(h.PostToolUseFailure[0]).toMatchObject({ matcher: 'Bash', hooks: [{ url: 'http://127.0.0.1:1/hook/post-tool-use-failure' }] })
})
