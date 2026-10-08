/**
 * Applies agent proposals from reflection (009 FR8, FR9). A proposal is acted
 * on only when its confidence is at least MIN_CONFIDENCE and the role recurs:
 * at least MIN_RECURRENCE similar tasks, counted from 005 history by the
 * caller. Drafts pass `agentRefusal`; a patch only targets an agent this bot
 * wrote. Then the chat's `autoLearn` decides: `auto` in a DM writes and
 * notifies, `propose` (or any group) asks the owner with ✅ Save / ✕ Skip,
 * `off` does nothing. At most one agent per pass.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import type { Policy } from '../policy/schema.ts'
import { chatTypeOf } from '../policy/resolve.ts'
import type { Proposals } from '../reflection/prompt.ts'
import { MARKER, writeAgent } from './tools.ts'
import { agentRefusal, AGENT_NAME, type AgentDraft } from './validate.ts'

export const MIN_CONFIDENCE = 0.8
export const MIN_RECURRENCE = 3
const MAX_PENDING = 100

/** Name and description of each agent in `dir` this bot wrote, for the reflector. */
export function learnedAgents(dir: string): { name: string; description: string }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.md'))
    .map(f => readFileSync(join(dir, f), 'utf8'))
    .filter(t => MARKER.exec(t)?.[1] === 'tg')
    .map(t => ({ name: t.match(/^name:\s*(.+)$/m)?.[1] ?? '', description: t.match(/^description:\s*(.*)$/m)?.[1] ?? '' }))
}

export type AgentProposal = Proposals['agents'][number]

export type AgentApplyOpts = {
  dir: string
  policy: (key: string) => Policy
  /** A line for the chat: written, or the question with Save/Skip buttons carrying `id`. */
  notify: (key: string, text: string) => void
  ask: (key: string, text: string, id: string) => void
  log?: (line: string) => void
}

export function createAgentApplier(opts: AgentApplyOpts) {
  const log = opts.log ?? (() => {})
  const pending = new Map<string, { key: string; draft: AgentDraft }>()
  const current = (name: string) => {
    const f = join(opts.dir, `${name}.md`)
    return AGENT_NAME.test(name) && existsSync(f) ? readFileSync(f, 'utf8') : undefined
  }

  const drop = (name: string, why: string) => { log(`agents: dropped ${name}: ${why}`); return why }

  function run(d: AgentDraft): string {
    const cur = current(d.name)
    const refusal = agentRefusal(d, cur ? { existingSource: MARKER.exec(cur)?.[1] } : undefined)
    if (refusal) throw new Error(refusal)
    const v = writeAgent(opts.dir, d, cur)
    return `🤖 ${cur ? 'Updated' : 'Learned'} agent ${d.name} (v${v})`
  }

  return {
    /** `recurrence`: similar tasks including this one, from history. Returns why nothing happened, or undefined when acted on. */
    apply(key: string, proposals: Pick<Proposals, 'agents'>, recurrence: number): string | undefined {
      const p = proposals.agents.find(a => a.op !== 'none' && a.confidence >= MIN_CONFIDENCE)
      if (!p) return 'no confident agent proposal'
      const policy = opts.policy(key)
      if (!policy.autoLearn || policy.autoLearn === 'off') return 'agent learning is off'
      if (recurrence < MIN_RECURRENCE) return drop(p.name, `only ${recurrence} similar tasks`)
      const draft: AgentDraft = {
        name: p.name, description: p.description, tools: p.tools, model: p.model, skills: p.skills,
        memory: p.memory, permissionMode: p.permissionMode, body: p.body,
      }
      const cur = current(draft.name)
      if (p.op === 'create' && cur) return drop(p.name, 'already exists')
      const refusal = agentRefusal(draft, cur ? { existingSource: MARKER.exec(cur)?.[1] } : undefined)
      if (refusal) return drop(p.name, refusal)
      if (policy.autoLearn === 'auto' && chatTypeOf(key) !== 'group') {
        try { opts.notify(key, run(draft)) } catch (err) { log(`agents: dropped ${p.name}: ${err}`) }
        return undefined
      }
      const id = randomBytes(6).toString('hex')
      pending.set(id, { key, draft })
      if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!)
      opts.ask(key, `🤖 ${cur ? 'Update' : 'Create'} agent ${draft.name}?\n${draft.description}\nTools: ${draft.tools.join(', ')}\n\n${draft.body}`, id)
      return undefined
    },

    /** A Save or Skip tap. Undefined when the proposal is gone. */
    decide(id: string, save: boolean): { text?: string; error?: string } | undefined {
      const p = pending.get(id)
      if (!p) return undefined
      pending.delete(id)
      if (!save) return {}
      try { return { text: run(p.draft) } } catch (err) { return { error: err instanceof Error ? err.message : String(err) } }
    },
  }
}

export type AgentApplier = ReturnType<typeof createAgentApplier>
