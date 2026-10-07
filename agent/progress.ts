/**
 * US4 progress UX for one turn: "typing…" every `typingMs` while the child is
 * alive, and a "⏳ Working…" message posted after `delayMs` without a `reply`,
 * edited from tool-use and subagent events (009 FR5) at most once per `editMs`. `finish()` deletes it,
 * so the answer the agent sends is always a new message (and a push).
 */

import { toolUses, type StreamEvent } from './stream.ts'
import { threadOpts, type Target } from '../telegram/send.ts'

type ThreadOpts = { message_thread_id?: number }

export type ProgressApi = {
  sendChatAction(chat_id: string, action: 'typing', other?: ThreadOpts): Promise<unknown>
  sendMessage(chat_id: string, text: string, other?: ThreadOpts): Promise<{ message_id: number }>
  editMessageText(chat_id: string, message_id: number, text: string): Promise<unknown>
  deleteMessage(chat_id: string, message_id: number): Promise<unknown>
}

const REPLY_TOOL = 'mcp__tg__reply'

export function startProgress(
  api: ProgressApi,
  target: Target,
  { typingMs = 4000, delayMs = 8000, editMs = 3000 } = {},
) {
  let done = false
  let replied = false
  let text = '⏳ Working…'
  let shown = text
  let lastEdit = 0
  let editTimer: ReturnType<typeof setTimeout> | undefined
  let msg: Promise<number | undefined> | undefined
  const { chatId: chat_id } = target

  const typing = () => void api.sendChatAction(chat_id, 'typing', threadOpts(target)).catch(() => {})
  typing()
  const typingTimer = setInterval(typing, typingMs)

  const dropMessage = () => {
    clearTimeout(delayTimer)
    clearTimeout(editTimer)
    const m = msg
    msg = undefined
    void m?.then(id => id != null && api.deleteMessage(chat_id, id)).catch(() => {})
  }

  const flush = () => {
    editTimer = undefined
    if (done || !msg || text === shown) return
    lastEdit = Date.now()
    shown = text
    const next = text
    void msg.then(id => id != null && !done && api.editMessageText(chat_id, id, next)).catch(() => {})
  }

  const delayTimer = setTimeout(() => {
    if (done || replied) return
    lastEdit = Date.now()
    shown = text
    msg = api.sendMessage(chat_id, text, threadOpts(target)).then(m => m.message_id, () => undefined)
  }, delayMs)

  const show = (next: string) => {
    text = next
    if (!msg || editTimer) return
    editTimer = setTimeout(flush, Math.max(0, lastEdit + editMs - Date.now()))
  }

  // 009 FR5: subagent type per `Agent` tool_use id, from `system/task_started` (T901).
  const subagents = new Map<string, string>()

  return {
    onEvent(ev: StreamEvent): void {
      if (done) return
      if (ev.kind === 'unknown' && ev.type === 'system/task_started') {
        const { subagent_type: type, tool_use_id: id } = ev.raw
        if (typeof type !== 'string') return
        if (typeof id === 'string') subagents.set(id, type)
        show(`🔎 ${type}…`)
        return
      }
      if (ev.kind !== 'assistant') return
      const sub = ev.event.parent_tool_use_id ? subagents.get(ev.event.parent_tool_use_id) : undefined
      for (const tool of toolUses(ev.event)) {
        if (!sub && tool.name === REPLY_TOOL) {
          // The agent answered; drop the progress message so it can't trail the reply.
          replied = true
          dropMessage()
          return
        }
        text = sub ? `🔎 ${sub}… (${tool.name})` : `⏳ Working… (${tool.name})`
      }
      show(text)
    },
    finish(): void {
      done = true
      clearInterval(typingTimer)
      dropMessage()
    },
  }
}
