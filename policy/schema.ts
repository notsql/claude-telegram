import { z } from 'zod'

/** Per-session-key policy (003 FR7). Every field is optional so partial overrides merge over defaults. */
export const PolicySchema = z.object({
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  alwaysAllow: z.array(z.string()),
  model: z.string(),
  cwd: z.string(),
  maxTurns: z.number().int().positive(),
  agent: z.string(),
  teamsAllowed: z.boolean(),
  memoryScope: z.enum(['global', 'none']),
  historyScope: z.enum(['all', 'chat', 'none']),
  autoLearn: z.enum(['off', 'propose', 'auto']),
  /** 006 FR1: where learned skills go; `project` uses `<cwd>/.claude/skills/` when `cwd` is set. */
  skillScope: z.enum(['user', 'project']),
  schedulerAllowed: z.boolean(),
  /** 008 FR19: skills turned off here, by name; passed as `skillOverrides`. */
  disabledSkills: z.array(z.string()),
  /** 008 FR19: plugin id → on/off here, over the installed state; passed as `enabledPlugins`. */
  plugins: z.record(z.string(), z.boolean()),
  /** 008 FR19: MCP servers turned off here, by tool prefix (`claude_ai_Notion`); passed as `--disallowedTools mcp__<prefix>`. */
  disabledMcpServers: z.array(z.string()),
  approvers: z.array(z.string()),
  /** FR12: let non-owners start turns on the owner's subscription. Terminal skill only. */
  allowOthersOnSubscription: z.boolean(),
}).partial()

export type Policy = z.infer<typeof PolicySchema>

export const ChatEntrySchema = z.object({ policy: PolicySchema.optional() })
export type ChatEntry = z.infer<typeof ChatEntrySchema>

export type ChatType = 'private' | 'group'

const GROUP_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'mcp__tg']

/** Defaults by chat type (FR8). `approvers` defaults to the owner IDs, filled in at resolve time. */
export function defaultPolicy(type: ChatType): Policy {
  return type === 'private'
    ? { permissionMode: 'default', memoryScope: 'global', historyScope: 'all', autoLearn: 'auto', schedulerAllowed: true }
    : {
        permissionMode: 'default',
        allowedTools: GROUP_READ_ONLY_TOOLS,
        memoryScope: 'global',
        historyScope: 'chat',
        autoLearn: 'propose',
        schedulerAllowed: false,
      }
}

/**
 * Tolerant parse of `access.json` → `chats`: entries that fail validation are
 * dropped with a warning instead of failing the whole file.
 */
export function parseChats(raw: unknown): Record<string, ChatEntry> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, ChatEntry> = {}
  for (const [key, value] of Object.entries(raw)) {
    const r = ChatEntrySchema.safeParse(value)
    if (r.success) out[key] = r.data
    else process.stderr.write(`telegram channel: ignoring invalid chats[${key}] in access.json: ${r.error.message}\n`)
  }
  return out
}
