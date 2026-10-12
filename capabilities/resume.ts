/**
 * After an install (012 FR7, FR8): if the capability needs a login, the owner
 * gets the exact command or URL and a **Done** button; the agent never sees a
 * secret. Once done (or straight away without auth), a follow-up turn runs in
 * the origin session. It is dropped if that session was reset in between
 * (plan Risks). Pending handoffs are in memory only.
 */

import { InlineKeyboard, type Api } from 'grammy'
import { randomBytes } from 'crypto'

export type Origin = { key: string; generation: number }

export type ResumeDeps = {
  api: Pick<Api, 'sendMessage'>
  owners: () => string[]
  /** The key's session generation (sessions/store.ts); a change means /new or /resume ran. */
  generation: (key: string) => number
  /** Starts the follow-up turn in the key's session (the scheduler's `mode: session` path). */
  run: (key: string, text: string) => void
}

type Handoff = { origin: Origin; name: string; resume: string }

export const resumeText = (name: string, resume: string) => `capability ${name} is ready; continue the task: ${resume}`

export function createResumer(deps: ResumeDeps) {
  const waiting = new Map<string, Handoff>()

  /** True if the turn was started; false if the origin session was reset. */
  function fire(h: Handoff): boolean {
    if (deps.generation(h.origin.key) !== h.origin.generation) return false
    deps.run(h.origin.key, resumeText(h.name, h.resume))
    return true
  }

  return {
    /** Called after a successful install. `auth` is the login command or URL, if any. */
    async installed(origin: Origin, name: string, resume: string, auth?: string): Promise<void> {
      const h = { origin, name, resume }
      if (!auth?.trim()) return void fire(h)
      const id = randomBytes(4).toString('hex')
      waiting.set(id, h)
      await deps.api.sendMessage(deps.owners()[0]!,
        `🔑 ${name} needs a login. Run or open this yourself, then tap Done:\n\n${auth.trim()}\n\nDon't send the secret here.`,
        { reply_markup: new InlineKeyboard().text('Done', `cap:done:${id}`) })
    },

    /** Owner tapped Done. Undefined if unknown or already done. */
    done(id: string): boolean | undefined {
      const h = waiting.get(id)
      if (!h) return undefined
      waiting.delete(id)
      return fire(h)
    },
  }
}

export type Resumer = ReturnType<typeof createResumer>
