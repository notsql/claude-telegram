/**
 * The reflector's instructions and proposal schema (004 FR6), with the 006
 * `skills` section: whether the exchange holds a reusable procedure worth a
 * new or patched skill (006 FR2, FR3), and the 009 `agents` section: whether a
 * recurring role deserves its own subagent (009 FR8).
 */

import { z } from 'zod'
import { MEMORY_TYPES } from '../memory/store.ts'
import { SECTIONS } from '../skills/store.ts'
import { OUTCOMES } from '../skills/usage.ts'

/** 009 FR10 SKILL.md fields; see skills/validate.ts. */
const SkillFieldsSchema = z.object({
  arguments: z.array(z.string()).optional(),
  'argument-hint': z.string().optional(),
  'allowed-tools': z.array(z.string()).optional(),
  context: z.literal('fork').optional(),
  agent: z.string().optional(),
  paths: z.array(z.string()).optional(),
  'disable-model-invocation': z.boolean().optional(),
})

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
  skills: z.array(z.object({
    op: z.enum(['create', 'patch', 'none']),
    name: z.string(),
    description: z.string(),
    sections: z.object(Object.fromEntries(SECTIONS.map(s => [s, z.string().optional()]))),
    fields: SkillFieldsSchema.optional(),
    reason: z.string(),
    confidence: z.number(),
  })),
  agents: z.array(z.object({
    op: z.enum(['create', 'patch', 'none']),
    name: z.string(),
    description: z.string(),
    tools: z.array(z.string()),
    model: z.string().optional(),
    skills: z.array(z.string()).optional(),
    memory: z.enum(['user', 'project', 'local']).optional(),
    permissionMode: z.string().optional(),
    body: z.string(),
    reason: z.string(),
    confidence: z.number(),
  })),
  skill_outcomes: z.array(z.object({
    name: z.string(),
    outcome: z.enum(OUTCOMES),
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

export const SKILL_INSTRUCTIONS = `Skills ("skills"): a skill is a reusable procedure (how to deploy the blog, how to file an expense report), saved as a SKILL.md the assistant loads next time a similar task comes up. Ask: is there a reusable procedure here that isn't already covered by an existing skill? If one covers it, what is wrong or missing in it?
Consider a skill only when at least one signal holds: the turn used many tool calls (the count is given below; 5 or more counts), the user corrected the approach, the task repeats an earlier request, or the assistant said the procedure is reusable. Otherwise return an empty "skills" array.
- op "patch" with an existing skill's exact name when it covers the task: give only the sections that change. Prefer patch over create.
- op "create" for a new procedure. name: kebab-case, at most 48 chars. description: what it does plus a concrete "Use when…" phrase; Claude Code uses it to decide when to load the skill, so make it trigger on the right requests.
- sections: "When to use", "Prerequisites", "Steps" (numbered, with the exact commands that worked), "Pitfalls" (what went wrong and the fix), "Verify". Markdown, concise.
- fields (optional SKILL.md frontmatter, only where relevant): "arguments" (names the user passes, used as $name in the steps, e.g. ["issue"]) with "argument-hint"; "allowed-tools" (a narrow pre-approved list such as "Bash(gh issue view:*)", never bare Bash); "context": "fork" plus "agent" for heavy procedures that should run in a subagent; "paths" (globs the skill applies to); "disable-model-invocation": true for side-effecting skills such as deploys. Steps may use !\`command\` blocks for live context: read-only commands only (git status/log/diff, gh issue view, ls, cat…), no pipes, variables or shell operators.
- Never include secrets, tokens, personal data or one-off details (specific file contents, dates, chat names).
- confidence: 0 to 1, how sure you are this is worth saving. Propose at most one skill.
Skill outcomes ("skill_outcomes"): for each skill the assistant invoked in the exchange ([tool Skill …] lines), report how it went: "success", "corrected" (the user corrected the approach) or "failed". If a skill was corrected or failed, also patch it with what went wrong. Empty when no skill was invoked.`

export const AGENT_INSTRUCTIONS = `Agents ("agents"): a subagent is a recurring *role* with its own judgement, tools, model or memory (an issue triager, a release checker). Choose the right artefact:
| Signal | Produce |
|---|---|
| A repeatable procedure (steps) | skill |
| A repeatable procedure that needs isolation or heavy tool use | skill (mention context: fork in its sections) |
| A recurring role with its own judgement, tools, model or memory | agent |
Propose an agent only when the role recurs: the similar-task count below must be 3 or more. Otherwise return an empty "agents" array.
- op "patch" with an existing learned agent's exact name when it covers the role (give the full definition); op "create" otherwise.
- name: "tg-" plus kebab-case. description: short and trigger-oriented ("Use proactively when…").
- tools: an explicit, minimal list (never "*", never Agent). Never set permissionMode to bypassPermissions or auto.
- body: the system prompt, concise. No secrets or personal data.
- confidence: 0 to 1. Propose at most one agent.`

/** The `<skills_context>` block: existing learned skills (name and description only) and the turn's signals. */
export function skillsContext(skills: { name: string; description: string }[], toolCalls: number, similar: string[], agents: { name: string; description: string }[] = []): string {
  return [
    `Existing skills:\n${skills.map(s => `- ${s.name}: ${s.description}`).join('\n') || '(none)'}`,
    `Existing learned agents:\n${agents.map(a => `- ${a.name}: ${a.description}`).join('\n') || '(none)'}`,
    `Similar tasks including this one: ${similar.length + 1}`,
    `Tool calls this turn: ${toolCalls}`,
    `Possibly similar earlier requests:\n${similar.map(t => `- ${t}`).join('\n') || '(none found)'}`,
  ].join('\n\n')
}

/** `skills` is the skills block (existing learned skills and the turn's signals), or null when skill learning is off. */
export function reflectionInput(existing: string | null, delta: string, skills: string | null = null): string {
  const memory = existing === null
    ? '(memory is off for this chat: return empty "memory" and "user_model")'
    : existing || '(empty)'
  const skillPart = skills === null
    ? '\n\nSkills are off for this chat: return empty "skills", "agents" and "skill_outcomes" arrays.'
    : `\n\n${SKILL_INSTRUCTIONS}\n\n${AGENT_INSTRUCTIONS}\n\n<skills_context>\n${skills}\n</skills_context>`
  return `${REFLECTION_INSTRUCTIONS}${skillPart}\n\n<existing_memory>\n${memory}\n</existing_memory>\n\n<exchange>\n${delta}\n</exchange>`
}

/** Refinement (006 FR8): a skill that keeps failing, with the exchange where it failed last. */
export const RefinementSchema = ProposalsSchema.shape.skills.element.omit({ op: true, name: true, confidence: true, fields: true })

export function refinementInput(skillMd: string, delta: string): string {
  return `This skill has failed or been corrected several times. Using the latest exchange where it was used, rewrite the sections that caused trouble so the next run succeeds. Give only the sections that change, plus the description (improve its "Use when…" phrase if it triggered wrongly). Never include secrets or personal data.\n\n<skill>\n${skillMd}\n</skill>\n\n<exchange>\n${delta}\n</exchange>`
}
