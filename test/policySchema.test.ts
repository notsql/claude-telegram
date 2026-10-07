import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'tg-policy-'))
process.env.TELEGRAM_STATE_DIR = dir
const { readAccessFile, saveAccess, ACCESS_FILE } = await import('../access.ts')
const { defaultPolicy, parseChats } = await import('../policy/schema.ts')

describe('policy schema', () => {
  test('existing access.json without chats loads unchanged', () => {
    const existing = {
      dmPolicy: 'allowlist',
      allowFrom: ['1875132728'],
      groups: { '-1004333640370': { requireMention: false, allowFrom: [] } },
      pending: {},
    }
    const text = JSON.stringify(existing, null, 2) + '\n'
    writeFileSync(ACCESS_FILE, text)
    const a = readAccessFile()
    expect(a).toMatchObject(existing)
    expect('chats' in a).toBe(false)
    saveAccess(a)
    expect(readFileSync(ACCESS_FILE, 'utf8')).toBe(text)
  })

  test('invalid chat entries are dropped, valid ones kept', () => {
    const chats = parseChats({
      '-100:5': { policy: { memoryScope: 'none', allowedTools: ['Read'] } },
      '-200': { policy: { permissionMode: 'yolo' } },
    })
    expect(Object.keys(chats)).toEqual(['-100:5'])
    expect(chats['-100:5'].policy?.memoryScope).toBe('none')
  })

  test('defaults per chat type', () => {
    expect(defaultPolicy('private').memoryScope).toBe('global')
    const g = defaultPolicy('group')
    expect(g.allowedTools).not.toContain('Edit')
    expect(g).toMatchObject({ memoryScope: 'global', historyScope: 'chat', autoLearn: 'propose', schedulerAllowed: false })
  })
})
