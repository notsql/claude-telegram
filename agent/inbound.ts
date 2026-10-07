/**
 * Inbound prompt wrapper (002 plan, "Inbound prompt format"). Only the daemon
 * builds it: meta lives in attributes and every `<` in user-controlled text is
 * escaped, so a message body can't close the wrapper or forge a new one.
 */

import type { BufferedMessage } from '../sessions/groupBuffer.ts'

export const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5)

/** `recent` is unaddressed group chatter (002 FR8), oldest first. */
export function renderInbound(text: string, meta: Record<string, string>, recent: BufferedMessage[] = []): string {
  const attrs = Object.entries(meta).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('')
  const context = recent.length
    ? `<recent_context>\n${recent.map(m => escapeXml(`[${hhmm(m.ts)}] ${m.user}: ${m.text}`)).join('\n')}\n</recent_context>\n`
    : ''
  return `<channel source="telegram"${attrs}>${context}${escapeXml(text)}</channel>`
}

/**
 * 008 FR5: a skill command's prompt is only the native `/<skill> <args>`
 * invocation, which `claude -p` expands (anything after it would land in
 * `$ARGUMENTS`). The wrapper goes in as hook context so the agent still
 * knows where to reply.
 */
export function renderSkillInvocation(invocation: string, meta: Record<string, string>): { prompt: string; context: string } {
  return { prompt: invocation, context: renderInbound(invocation, meta) }
}
