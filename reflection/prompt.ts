/**
 * The reflector's instructions and proposal schema (004 FR6). 006 adds a
 * `skills` section when it lands.
 */

import { z } from 'zod'
import { MEMORY_TYPES } from '../memory/store.ts'

const Op = z.enum(['create', 'update', 'delete'])

export const ProposalsSchema = z.object({
  memory: z.array(z.object({
    op: Op,
    type: z.enum(MEMORY_TYPES),
    name: z.string(),
    description: z.string(),
    body: z.string(),
    reason: z.string(),
  })),
  user_model: z.array(z.object({
    op: Op,
    user_id: z.string(),
    name: z.string(),
    description: z.string(),
    body: z.string(),
    reason: z.string(),
  })),
})

export type Proposals = z.infer<typeof ProposalsSchema>

export const REFLECTION_INSTRUCTIONS = `You curate the long-term memory of a personal assistant that chats with its owner on Telegram. Below are the existing memory entries and the latest exchange. Decide whether the exchange taught anything worth remembering for future conversations. Most exchanges teach nothing: then return empty arrays.

Save (in "memory", shared by every chat):
- feedback: a correction or stated preference about how the assistant should work. Body: the rule, then "**Why:**" and "**How to apply:**" lines.
- project: a fact or decision about the user's projects that is not in the code.
- reference: where something lives outside this machine (a URL, dashboard, ticket).
Save (in "user_model", per Telegram user_id taken from the user_id attribute of the <channel> tag): durable facts about that person, such as preferred name, role, timezone, expertise and communication style. Facts about a person never go in "memory".

Never save: secrets, credentials or keys; anything derivable from code, git history or docs; one-off task details or anything that only matters to this conversation; guesses the exchange does not support; anything the assistant already saved, updated or deleted itself during the exchange ([tool ...memory_*] lines): do not propose those again, not even as an update.

Curate: if an existing entry covers the same thing, use op "update" with that entry's exact name and a merged body instead of "create". Use "delete" for an entry the exchange shows is wrong. Names are short kebab-case slugs. Descriptions are one line. Bodies are one or two short sentences. Propose at most 3 changes in total.`

export function reflectionInput(existing: string, delta: string): string {
  return `${REFLECTION_INSTRUCTIONS}\n\n<existing_memory>\n${existing || '(empty)'}\n</existing_memory>\n\n<exchange>\n${delta}\n</exchange>`
}
