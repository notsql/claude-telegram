/**
 * Condense search hits into a cited answer (005 FR5). A one-shot model call
 * (001 `oneshot.ts`); it uses haiku until 009 ships the `tg-summarizer` agent.
 */

import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { runOneShot } from '../agent/oneshot.ts'

export const AnswerSchema = z.object({ answer: z.string() })
export type RunOneShot = (agent: string | undefined, input: string, schema: typeof AnswerSchema) => Promise<z.infer<typeof AnswerSchema>>

/** `numbered` is the hit list as the tool shows it: `[n] date · session · title` then the snippet. */
export async function summarizeHits(question: string, numbered: string, run: RunOneShot = runOneShot): Promise<string> {
  const input =
    'Answer the question using only these excerpts from past conversations. ' +
    'Cite excerpts as [n] with their date. If they do not answer it, say so.\n\n' +
    `Question: ${question}\n\nExcerpts:\n${numbered}`
  return (await run(undefined, input, AnswerSchema)).answer
}

export const SummarySchema = z.object({ summary: z.string() })
type RunSummary = (agent: string | undefined, input: string, schema: typeof SummarySchema) => Promise<z.infer<typeof SummarySchema>>

const SESSION_MAX_CHARS = 24_000

/**
 * Summary of one indexed session (005 T510), for 002's session rotation and
 * 006's skill extraction. Uses the newest messages when the session is longer
 * than the budget. Returns '' for a session with nothing indexed.
 */
export async function summarizeSession(db: Database, sessionId: string, run: RunSummary = runOneShot): Promise<string> {
  const rows = db.query('SELECT role, text FROM messages WHERE session_id = ? ORDER BY id DESC').all(sessionId) as { role: string; text: string }[]
  const lines: string[] = []
  let used = 0
  for (const r of rows) {
    const line = `${r.role}: ${r.text}`
    if (used + line.length > SESSION_MAX_CHARS) break
    lines.unshift(line)
    used += line.length + 1
  }
  if (!lines.length) return ''
  const input =
    'Summarise this conversation for whoever picks it up next: decisions made, work done, open threads and ' +
    'stated preferences. Be concrete and brief; leave out small talk.\n\n' + lines.join('\n')
  return (await run(undefined, input, SummarySchema)).summary
}
