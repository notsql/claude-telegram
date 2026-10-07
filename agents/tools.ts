/**
 * `agent_*` tools on the daemon MCP server (009 FR8, FR9), for the
 * tg-skill-author only: calls are refused unless `isAuthor(key)` says a
 * tg-skill-author is running for that session. Agents live as
 * `<dir>/<name>.md` (user scope). Writes pass `agentRefusal`, need
 * `autoLearn: auto` in a DM (groups and `propose` go through owner approval,
 * which is the reflection path), and are limited to one per turn. A patch
 * keeps the previous file in `<dir>/.bak/<name>.v<version>.md`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Policy } from '../policy/schema.ts'
import type { ToolResult } from '../memory/tools.ts'
import { chatTypeOf } from '../policy/resolve.ts'
import { agentRefusal, AGENT_NAME, type AgentDraft } from './validate.ts'

export const AUTHOR = 'tg-skill-author'

const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) })

const DRAFT_PROPS = {
  name: { type: 'string', description: 'tg- plus kebab-case' },
  description: { type: 'string', description: 'Short and trigger-oriented: "Use proactively when…"' },
  tools: { type: 'array', items: { type: 'string' }, description: 'Explicit tool list; never inherit-all' },
  model: { type: 'string' },
  skills: { type: 'array', items: { type: 'string' } },
  memory: { type: 'string', enum: ['user', 'project', 'local'] },
  permissionMode: { type: 'string' },
  mcpServers: { type: 'array', items: { type: 'string' }, description: 'Names of existing MCP servers' },
  body: { type: 'string', description: 'System prompt' },
}

const READ_TOOLS = [
  { name: 'agent_list', description: 'List the user-scope agents: name, whether this bot wrote it, and description.', inputSchema: { type: 'object', properties: {} } },
  { name: 'agent_read', description: 'Read one agent definition by name.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
]

const WRITE_TOOLS = [
  {
    name: 'agent_create',
    description: 'Create a tg- agent for a recurring role. Tools must be explicit. One agent write per turn.',
    inputSchema: { type: 'object', properties: DRAFT_PROPS, required: ['name', 'description', 'tools', 'body'] },
  },
  {
    name: 'agent_patch',
    description: 'Replace a tg- agent this bot wrote. Give the full definition. One agent write per turn.',
    inputSchema: { type: 'object', properties: DRAFT_PROPS, required: ['name', 'description', 'tools', 'body'] },
  },
]

const MARKER = /^<!-- source: (\S+) · version: (\d+) -->/m

export function renderAgent(d: AgentDraft, version: number): string {
  const list = (k: string, v?: unknown[]) => (v?.length ? [`${k}:`, ...v.map(x => `  - ${x}`)] : [])
  return [
    '---',
    `name: ${d.name}`,
    `description: ${JSON.stringify(d.description)}`,
    `tools: ${d.tools.join(', ')}`,
    ...(d.model ? [`model: ${d.model}`] : []),
    ...(d.memory ? [`memory: ${d.memory}`] : []),
    ...(d.permissionMode ? [`permissionMode: ${d.permissionMode}`] : []),
    ...list('skills', d.skills),
    ...list('mcpServers', d.mcpServers),
    '---',
    `<!-- source: tg · version: ${version} -->`,
    d.body.trim(),
    '',
  ].join('\n')
}

function draftOf(args: Record<string, unknown>): AgentDraft {
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined)
  return {
    name: String(args.name ?? ''),
    description: String(args.description ?? ''),
    tools: strs(args.tools) ?? [],
    model: args.model ? String(args.model) : undefined,
    skills: strs(args.skills),
    memory: args.memory as AgentDraft['memory'],
    permissionMode: args.permissionMode ? String(args.permissionMode) : undefined,
    mcpServers: Array.isArray(args.mcpServers) ? args.mcpServers : undefined,
    body: String(args.body ?? ''),
  }
}

export function createAgentTools(dir: string, isAuthor: (key: string) => boolean) {
  const wrote = new Set<string>()
  const file = (name: string) => join(dir, `${name}.md`)
  const read = (name: string) => {
    if (!/^[\w-]+$/.test(name) || !existsSync(file(name))) return undefined
    return readFileSync(file(name), 'utf8')
  }

  return {
    startTurn(key: string): void {
      wrote.delete(key)
    },

    list(policy: Policy) {
      return policy.autoLearn && policy.autoLearn !== 'off' ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS
    },

    /** Undefined when `name` is not an agent tool. */
    call(name: string, args: Record<string, unknown>, key: string, policy: Policy): ToolResult | undefined {
      if (![...READ_TOOLS, ...WRITE_TOOLS].some(t => t.name === name)) return undefined
      if (!isAuthor(key)) return text(`agent tools are only for ${AUTHOR}`, true)
      switch (name) {
        case 'agent_list': {
          const names = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort() : []
          return text(names.length
            ? names.map(n => {
              const t = read(n) ?? ''
              const desc = t.match(/^description:\s*(.*)$/m)?.[1] ?? ''
              return `${n}${MARKER.exec(t)?.[1] === 'tg' ? ' (learned)' : ''}: ${desc}`
            }).join('\n')
            : 'no agents yet')
        }
        case 'agent_read': {
          const t = read(String(args.name ?? ''))
          return t ? text(t) : text(`no agent named ${args.name}`, true)
        }
      }
      if (policy.autoLearn !== 'auto' || chatTypeOf(key) === 'group') {
        return text('agent changes in this chat need the owner\'s approval; propose it through reflection instead', true)
      }
      const draft = draftOf(args)
      const current = AGENT_NAME.test(draft.name) ? read(draft.name) : undefined
      if (name === 'agent_create' && current) return text(`${draft.name} already exists; use agent_patch`, true)
      if (name === 'agent_patch' && !current) return text(`no agent named ${draft.name}; use agent_create`, true)
      const marker = current ? MARKER.exec(current) : null
      const refusal = agentRefusal(draft, current ? { existingSource: marker?.[1] } : undefined)
      if (refusal) return text(refusal, true)
      if (wrote.has(key)) return text('limit of 1 agent write per turn reached', true)
      wrote.add(key)

      const prev = Number(marker?.[2] ?? 0)
      mkdirSync(dir, { recursive: true })
      if (current) {
        mkdirSync(join(dir, '.bak'), { recursive: true })
        writeFileSync(join(dir, '.bak', `${draft.name}.v${prev}.md`), current)
      }
      writeFileSync(`${file(draft.name)}.tmp`, renderAgent(draft, prev + 1))
      renameSync(`${file(draft.name)}.tmp`, file(draft.name))
      return text(`${current ? 'updated' : 'created'} agent ${draft.name} (v${prev + 1})`)
    },
  }
}

export type AgentTools = ReturnType<typeof createAgentTools>
