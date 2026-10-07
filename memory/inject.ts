/**
 * Memory context for daemon turns (004 FR3), returned as `additionalContext`
 * from the `SessionStart` and `UserPromptSubmit` hooks:
 *
 *   <memory>…shared MEMORY.md index…</memory>
 *   <user_model user_id="…">…type:user files…</user_model>
 *
 * The full block goes out once per session. Context from earlier turns stays
 * in a resumed transcript (T401 b), so a resume, like each later prompt, only
 * gets what changed since: a newer index, or a participant not yet sent.
 * When the turn's cwd is the workspace, Claude Code already loads the index
 * natively (T401 a), as does the bridge import (FR10), so only a changed
 * index is sent. Everything fits a token budget (~4 chars per token); the
 * newest user-model files win.
 */

import type { Policy } from '../policy/schema.ts'
import { memoryRoot } from './paths.ts'
import type { MemoryStore } from './store.ts'

export const DEFAULT_BUDGET_TOKENS = 4000

type Sent = { indexMtime: number; users: Map<string, number> }

export type InjectOpts = {
  store: MemoryStore
  /** The user-model store for a Telegram user id. */
  userStore: (userId: string) => MemoryStore
  budgetTokens?: number
  /** True when the FR10 bridge import already loads the index in every session. */
  indexImported?: () => boolean
}

const attr = (v: string) => v.replace(/[^\w-]/g, '')

export function createInjector({ store, userStore, budgetTokens = DEFAULT_BUDGET_TOKENS, indexImported = () => false }: InjectOpts) {
  const sent = new Map<string, Sent>()

  function userBlock(userId: string, maxChars: number): string {
    let out = ''
    const files = userStore(userId).list().sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const e of files) {
      const piece = `- ${e.description}: ${e.body}\n`
      if (out.length + piece.length > maxChars) break
      out += piece
    }
    return out && `<user_model user_id="${attr(userId)}">\n${out}</user_model>`
  }

  const usersMtime = (userId: string) => Math.max(0, ...userStore(userId).list().map(e => e.mtimeMs))

  /**
   * The context to add for this hook call, or '' when nothing changed.
   * `participants` is the sender first, then other active group members.
   */
  function build(payload: Record<string, unknown>, policy: Policy, participants: string[]): string {
    if (policy.memoryScope === 'none') return ''
    const sessionId = String(payload.session_id ?? '')
    const native = (typeof payload.cwd === 'string' && memoryRoot(payload.cwd) === store.dir) || indexImported()
    const prev = sent.get(sessionId)
    const now: Sent = { indexMtime: store.indexMtime(), users: new Map(prev?.users) }
    let budget = budgetTokens * 4
    const parts: string[] = []

    const indexChanged = prev ? now.indexMtime > prev.indexMtime : !native
    const index = store.index().trim()
    if (indexChanged && index) {
      // Newest pointers are appended last, so keep the tail.
      const lines = index.split('\n')
      let kept = ''
      for (let i = lines.length - 1; i >= 0 && kept.length + lines[i]!.length < budget / 2; i--) kept = `${lines[i]}\n${kept}`
      parts.push(`<memory${prev ? ' updated="true"' : ''}>\n${kept}</memory>`)
      budget -= kept.length
    }

    for (const id of participants) {
      const mtime = usersMtime(id)
      if (!mtime || now.users.get(id) === mtime) continue
      const block = userBlock(id, budget)
      if (!block) continue
      parts.push(block)
      budget -= block.length
      now.users.set(id, mtime)
    }

    sent.set(sessionId, now)
    return parts.join('\n')
  }

  const output = (event: string, ctx: string) =>
    ctx ? { hookSpecificOutput: { hookEventName: event, additionalContext: ctx } } : {}

  return {
    sessionStart: (payload: Record<string, unknown>, policy: Policy, participants: string[]) =>
      output('SessionStart', build(payload, policy, participants)),
    userPromptSubmit: (payload: Record<string, unknown>, policy: Policy, participants: string[]) =>
      output('UserPromptSubmit', build(payload, policy, participants)),
  }
}
