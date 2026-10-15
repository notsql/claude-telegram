/**
 * `/signin <url>` (015 FR3): opens a site in the shared browser so the owner
 * can sign in there themselves. The profile keeps the login for the agent.
 */

import { dmCommandGate } from '../access.ts'
import type { Command } from '../commands/registry.ts'

/** An http(s) URL from the command text, adding `https://` when there's no scheme; null if it isn't one. */
export function signinUrl(arg: string): string | null {
  const raw = arg.trim()
  if (!raw || /\s/.test(raw)) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export const SIGNIN_USAGE = 'Send /signin <site>, e.g. /signin portal.spgroup.com.sg. It opens in the agent\'s browser on your Mac, where you sign in yourself.'

export function signinCommand(openTab: (url: string) => Promise<void>, log: (line: string) => void): Command {
  return {
    name: 'signin',
    description: "Sign in to a site in the agent's browser",
    menu: ['private'],
    requiresApprover: true,
    handler: async (ctx, args) => {
      if (!dmCommandGate(ctx)) return
      const url = signinUrl(args)
      if (!url) return ctx.reply(SIGNIN_USAGE)
      try {
        await openTab(url)
      } catch (err) {
        log(`signin: ${err}`)
        return ctx.reply(`Couldn't open the browser: ${err instanceof Error ? err.message : err}`)
      }
      return ctx.reply(`Opened ${url} in the agent's browser on your Mac. Sign in there; the agent stays signed in afterwards, even after restarts.`)
    },
  }
}
