/**
 * Condense search hits into a cited answer (005 FR5). A one-shot model call
 * (001 `oneshot.ts`); it uses haiku until 009 ships the `hermes-summarizer` agent.
 */

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
