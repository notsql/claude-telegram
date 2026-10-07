/**
 * `skill_*` tools on the daemon MCP server (006 FR9). `skill_list` and
 * `skill_read` work on the chat's skills root. `skill_create` and
 * `skill_patch` go through the applier, so the chat's `autoLearn`, the name
 * checks and the foreign-skill diff rule all apply; they are hidden when
 * `autoLearn` is off. One write per turn (FR5); `startTurn` resets it.
 */

import type { Policy } from '../policy/schema.ts'
import type { ToolResult } from '../memory/tools.ts'
import type { SkillApplier } from './apply.ts'
import { SECTIONS, type SkillStore } from './store.ts'

const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) })

const SECTIONS_SCHEMA = {
  type: 'object',
  description: 'Markdown per section. On patch, only the sections that change.',
  properties: Object.fromEntries(SECTIONS.map(s => [s, { type: 'string' }])),
}

const READ_TOOLS = [
  {
    name: 'skill_list',
    description: 'List the skills in this chat\'s skills folder: name, version, whether this bot wrote it, and description.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_read',
    description: 'Read one skill\'s SKILL.md by name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
]

const WRITE_TOOLS = [
  {
    name: 'skill_create',
    description: 'Save a reusable procedure you just worked out as a Claude Code skill, when you are confident it will recur. ' +
      'If a skill already covers it, this patches that one. Never include secrets or personal data. One skill write per turn.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case, [a-z0-9-]{1,48}' },
        description: { type: 'string', description: 'What it does plus a concrete "Use when…" phrase' },
        sections: { ...SECTIONS_SCHEMA, required: ['Steps'] },
      },
      required: ['name', 'description', 'sections'],
    },
  },
  {
    name: 'skill_patch',
    description: 'Fix or extend an existing skill: replaces only the given sections. Skills this bot did not write are sent to the owner as a diff instead.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, sections: SECTIONS_SCHEMA },
      required: ['name', 'sections'],
    },
  },
]

const learns = (p: Policy) => !!p.autoLearn && p.autoLearn !== 'off'

export function createSkillTools(storeFor: (key: string) => SkillStore, applier: Pick<SkillApplier, 'one'>) {
  const wrote = new Set<string>()

  return {
    startTurn(key: string): void {
      wrote.delete(key)
    },

    list(policy: Policy) {
      return learns(policy) ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS
    },

    /** Undefined when `name` is not a skill tool. */
    call(name: string, args: Record<string, unknown>, key: string, policy: Policy): ToolResult | undefined {
      const store = () => storeFor(key)
      switch (name) {
        case 'skill_list': {
          const all = store().list()
          return text(all.length
            ? all.map(s => `${s.name} (v${s.metadata.version ?? '1'}${s.metadata.source === 'tg' ? ', learned' : ''}): ${s.description}`).join('\n')
            : 'no skills yet')
        }
        case 'skill_read': {
          const t = store().text(String(args.name ?? ''))
          return t ? text(t) : text(`no skill named ${args.name}`, true)
        }
        case 'skill_create':
        case 'skill_patch': {
          if (!learns(policy)) return text('skill learning is off for this chat (autoLearn: off)', true)
          if (name === 'skill_patch' && !store().read(String(args.name ?? ''))) return text(`no skill named ${args.name}; use skill_create`, true)
          if (wrote.has(key)) return text('limit of 1 skill write per turn reached', true)
          wrote.add(key)
          const cur = name === 'skill_patch' ? store().read(String(args.name))! : undefined
          return text(applier.one(key, {
            op: name === 'skill_create' ? 'create' : 'patch',
            name: String(args.name ?? ''),
            description: String(args.description ?? cur?.description ?? ''),
            sections: (args.sections ?? {}) as Record<string, string>,
            reason: 'agent tool call',
            confidence: 1,
          }))
        }
      }
      return undefined
    },
  }
}

export type SkillTools = ReturnType<typeof createSkillTools>
