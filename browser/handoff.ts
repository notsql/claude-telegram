/**
 * `browser_signin` on the daemon MCP server (015 FR4): when the agent lands on
 * a login page, it opens the site in the shared browser and the daemon posts
 * a card in the same chat, DM or group, with ✅ Signed in / Skip. Signed in
 * continues the task in the origin session, unless that session was reset
 * in between (as 012's resume). Pending handoffs are in memory only.
 */

import { InlineKeyboard, type Api } from 'grammy'
import { randomBytes } from 'crypto'
import type { ToolResult } from '../memory/tools.ts'
import { sendTo } from '../telegram/handlers/ui.ts'
import { signinUrl } from './signin.ts'

const TOOL = {
  name: 'browser_signin',
  description: "Call this as soon as a site needs the owner signed in (a login page in mcp__browser__*, or a site you know needs an account). It opens the site in the shared browser on the owner's Mac and asks them, in this chat, to sign in there; when they tap Signed in, the task continues in a new turn with your `resume` text. Never ask for a password or code in chat. End the turn after calling this.",
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The page to sign in on, usually the login page you reached.' },
      reason: { type: 'string', description: 'What the sign-in is for, in a few words for the owner, e.g. "read your SP bill".' },
      resume: { type: 'string', description: 'The task to continue once signed in.' },
    },
    required: ['url', 'reason', 'resume'],
  },
}

const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) })

export const continueText = (host: string, resume: string) => `The owner signed in to ${host} in the shared browser; continue the task: ${resume}`

type Handoff = { key: string; generation: number; host: string; resume: string }

export type HandoffDeps = {
  api: Api
  open: (url: string) => Promise<void>
  /** The key's session generation; a change means /new or /resume ran. */
  generation: (key: string) => number
  /** Starts the follow-up turn in the key's session. */
  run: (key: string, text: string) => void
}

export function createHandoffs(deps: HandoffDeps) {
  const waiting = new Map<string, Handoff>()
  return {
    list: () => [TOOL],

    /** Undefined when `name` is not this tool. */
    async call(name: string, args: Record<string, unknown>, key: string): Promise<ToolResult | undefined> {
      if (name !== TOOL.name) return
      const url = signinUrl(String(args.url ?? ''))
      if (!url) return text('url must be an http(s) address.', true)
      try {
        await deps.open(url)
      } catch (err) {
        return text(`Couldn't open the browser: ${err instanceof Error ? err.message : err}`, true)
      }
      const host = new URL(url).host
      const id = randomBytes(4).toString('hex')
      waiting.set(id, { key, generation: deps.generation(key), host, resume: String(args.resume ?? '') })
      const sent = await sendTo(deps.api, key,
        `🔑 To ${String(args.reason ?? 'carry on')}, I need you signed in to ${host}. It's open in the browser window on your Mac: sign in there, then tap ✅ Signed in and I'll carry on.\n\nI never see your password.`,
        { reply_markup: new InlineKeyboard().text('✅ Signed in', `web:d:${id}`).text('Skip', `web:s:${id}`) })
      if (!sent) return text('Opened the site, but could not post the sign-in card.', true)
      return text(`Opened ${host} and asked the owner to sign in. End the turn now; the task continues when they tap Signed in.`)
    },

    /** ✅ Signed in: true if the follow-up turn started, false if the session was reset, undefined if unknown or already done. */
    done(id: string): boolean | undefined {
      const h = waiting.get(id)
      if (!h) return undefined
      waiting.delete(id)
      if (deps.generation(h.key) !== h.generation) return false
      deps.run(h.key, continueText(h.host, h.resume))
      return true
    },

    /** Skip: true if it was waiting. */
    skip: (id: string) => waiting.delete(id),
  }
}

export type Handoffs = ReturnType<typeof createHandoffs>
