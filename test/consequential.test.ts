import { describe, expect, test } from 'bun:test'
import { classify } from '../policy/consequential.ts'

const opts = { cwd: '/work', scratchDirs: ['/work/scratch'] }
const cls = (tool: string, input: object = {}) => {
  const c = classify(tool, input as Record<string, unknown>, opts)
  return c && ('offLimits' in c ? `off:${c.offLimits}` : c.class)
}
const bash = (command: string) => cls('Bash', { command })

describe('classify MCP tools', () => {
  test('send, pay, sign and delete names', () => {
    expect(cls('mcp__slack__slack_post_message', { channel: '#general' })).toBe('send')
    expect(cls('mcp__gmail__sendEmail', { to: 'a@b.c' })).toBe('send')
    expect(cls('mcp__shop__checkout')).toBe('pay')
    expect(cls('mcp__docusign__sign_envelope')).toBe('sign')
    expect(cls('mcp__drive__trash_file')).toBe('delete')
    expect(cls('mcp__notion__notion-delete-pages')).toBe('delete')
  })

  test('reads, drafts, sign-in and the daemon tools are not classified', () => {
    expect(cls('mcp__gmail__list_messages')).toBeUndefined()
    expect(cls('mcp__gmail__create_draft')).toBeUndefined()
    expect(cls('mcp__site__sign_in')).toBeUndefined()
    expect(cls('mcp__tg__reply', { chat_id: '1', text: 'x' })).toBeUndefined()
    expect(cls('Read', { file_path: '/etc/hosts' })).toBeUndefined()
    expect(cls('Write', { file_path: '/work/a' })).toBeUndefined()
  })

  test('off-limits names (AC4)', () => {
    expect(cls('mcp__broker__place_stock_order')).toBe('off:trading securities')
    expect(cls('mcp__bank__transfer_funds')).toBe('off:moving money between accounts')
  })

  test('summary names the tool and its target', () => {
    expect(classify('mcp__gmail__sendEmail', { to: 'a@b.c' }, opts)).toEqual({ class: 'send', summary: 'Send · gmail sendEmail → a@b.c' })
  })
})

describe('classify Bash', () => {
  test('rm outside scratch dirs is a delete; inside is housekeeping', () => {
    expect(bash('rm -rf ~/Documents/old')).toBe('delete')
    expect(bash('rm build/out.js')).toBe('delete')
    expect(bash('rm -rf /tmp/x scratch/y')).toBeUndefined()
    expect(bash('rm -rf /tmp')).toBe('delete')
    expect(bash('sudo rm /etc/x')).toBe('delete')
    expect(bash('find . -name "*.log" -delete')).toBe('delete')
  })

  test('subcommand verbs', () => {
    expect(bash('gh repo delete me/x --yes')).toBe('delete')
    expect(bash('kubectl delete pod web')).toBe('delete')
    expect(bash('wacli send --to 6591234567 "hi"')).toBe('send')
    expect(bash('gh issue create --title x --body "please delete the old one"')).toBeUndefined()
  })

  test('git: only forced or deleting pushes', () => {
    expect(bash('git push origin main')).toBeUndefined()
    expect(bash('git push --force origin main')).toBe('delete')
    expect(bash('git push origin :old-branch')).toBe('delete')
    expect(bash('git commit -m "remove stuff"')).toBeUndefined()
  })

  test('message text never decides the class or off-limits', () => {
    expect(bash('wacli send bob "can you transfer money for the stock order?"')).toBe('send')
    expect(bash('curl -X POST https://api.example.com/x')).toBeUndefined()
  })

  test('off-limits commands', () => {
    expect(bash('broker trade stock VWRA 10')).toBe('off:trading securities')
  })

  test('read-only commands are not classified (AC6)', () => {
    expect(bash('ls -la && cat x')).toBeUndefined()
    expect(bash('gh pr list')).toBeUndefined()
  })
})
