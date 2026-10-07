import { expect, test } from 'bun:test'
import { authorised, route } from '../commands/dispatch'

const builtins = new Map([['policy', { requiresApprover: true }], ['new', {}]])
const skills = { 'deploy-blog': 'deploy_blog', 'telegram:access': 'telegram_access' }

test('built-ins, with or without @botname', () => {
  expect(route('/new', 'MyBot', builtins, skills)).toEqual({ kind: 'builtin', command: {}, args: '' })
  expect(route('/Policy@mybot  model opus ', 'MyBot', builtins, skills)).toEqual({ kind: 'builtin', command: { requiresApprover: true }, args: 'model opus' })
})

test('FR11: commands for another bot are ignored', () => {
  expect(route('/new@OtherBot', 'MyBot', builtins, skills)).toEqual({ kind: 'ignore' })
})

test('mapped skills become the native invocation', () => {
  expect(route('/deploy_blog staging', 'MyBot', builtins, skills)).toEqual({ kind: 'skill', text: '/deploy-blog staging' })
  expect(route('/telegram_access@MyBot', 'MyBot', builtins, skills)).toEqual({ kind: 'skill', text: '/telegram:access' })
})

test('FR8: unknown commands and plain text pass through', () => {
  expect(route('/foo bar', 'MyBot', builtins, skills)).toEqual({ kind: 'text' })
  expect(route('hello /new', 'MyBot', builtins, skills)).toEqual({ kind: 'text' })
})

test('AC6: a non-approver is refused state-changing commands in groups', () => {
  const policy = builtins.get('policy')!
  expect(authorised(policy, true, false, true)).toBe(false)
  expect(authorised(policy, true, true, true)).toBe(true)
  expect(authorised(policy, false, false, false)).toBe(false)
  expect(authorised(policy, false, false, true)).toBe(true)
  expect(authorised(builtins.get('new')!, true, false, false)).toBe(true)
})
