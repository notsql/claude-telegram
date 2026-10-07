/**
 * The 009 FR10 SKILL.md fields for learned skills, and their validation:
 * - `arguments` (names usable as `$name`) and `argument-hint`
 * - `allowed-tools`: explicit, never bare `Bash` or `*`, and never broader
 *   than the chat policy (inside `allowedTools` when it lists any, and never
 *   a `disallowedTools` entry)
 * - `context: fork` with an `agent`, for heavy procedures
 * - `paths` globs, and `disable-model-invocation` for side-effecting skills
 * - `` !`command` `` live-context blocks in the body: read-only commands from
 *   READ_ONLY only, with no shell operators
 */

import type { Policy } from '../policy/schema.ts'

export type SkillFields = {
  arguments?: string[]
  'argument-hint'?: string
  'allowed-tools'?: string[]
  context?: 'fork'
  agent?: string
  paths?: string[]
  'disable-model-invocation'?: boolean
}

export const FIELD_NAMES = ['arguments', 'argument-hint', 'allowed-tools', 'context', 'agent', 'paths', 'disable-model-invocation'] as const

/** Commands a `!` block may run: the program, then the allowed first arguments (none listed: any). */
export const READ_ONLY: Record<string, string[] | null> = {
  git: ['status', 'log', 'diff', 'show', 'rev-parse'],
  gh: ['issue', 'pr', 'repo', 'run'],
  ls: null, cat: null, head: null, tail: null, wc: null, pwd: null, date: null,
  grep: null, rg: null, find: null, which: null, uname: null, echo: null,
}
/** gh subcommands under those groups that only read. */
const GH_READ = ['view', 'list', 'status', 'diff', 'checks']
const SHELL_OPS = /[;&|<>`$()\n\\]/
const FIND_WRITES = /(^|\s)-(exec|execdir|ok|okdir|delete|fprint\w*|fls)\b/

/** Why a `!` command is refused, or undefined when it is read-only. */
export function commandRefusal(cmd: string): string | undefined {
  if (SHELL_OPS.test(cmd)) return `!\`${cmd}\`: shell operators are not allowed`
  const [prog, sub, sub2] = cmd.trim().split(/\s+/)
  if (!prog || !(prog in READ_ONLY)) return `!\`${cmd}\`: ${prog} is not on the read-only allowlist`
  const subs = READ_ONLY[prog]
  if (subs && !subs.includes(sub ?? '')) return `!\`${cmd}\`: ${prog} ${sub ?? ''} is not read-only`
  if (prog === 'gh' && !GH_READ.includes(sub2 ?? '')) return `!\`${cmd}\`: gh ${sub} ${sub2 ?? ''} is not read-only`
  if (prog === 'rg' && /--pre\b/.test(cmd)) return `!\`${cmd}\`: rg may not run a preprocessor`
  if (prog === 'git' &&/--output\b/.test(cmd)) return `!\`${cmd}\`: git may not write files`
  if (prog === 'find' && FIND_WRITES.test(cmd)) return `!\`${cmd}\`: find may not run or delete`
  return undefined
}

/** The `` !`…` `` live-context commands in a SKILL.md body. */
export const liveCommands = (body: string) => [...body.matchAll(/!`([^`]*)`/g)].map(m => m[1]!)

const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const toolBase = (t: string) => t.replace(/\(.*$/, '').trim()

/** Why the fields or body are refused for this policy, or undefined. */
export function skillRefusal(f: SkillFields, body: string, policy: Pick<Policy, 'allowedTools' | 'disallowedTools'>): string | undefined {
  if (f.arguments?.some(a => !ARG_NAME.test(a))) return 'arguments must be plain names (letters, digits, _)'
  for (const t of f['allowed-tools'] ?? []) {
    if (!t.trim() || t.trim() === '*' || t.trim() === 'Bash') return `allowed-tools entry "${t}" is too broad`
    if (policy.disallowedTools?.some(d => d === t || d === toolBase(t))) return `allowed-tools entry "${t}" is disallowed in this chat`
    if (policy.allowedTools?.length && !policy.allowedTools.some(a => a === t || a === toolBase(t))) return `allowed-tools entry "${t}" is broader than this chat allows`
  }
  if (f.context !== undefined && f.context !== 'fork') return 'context may only be fork'
  if (f.agent !== undefined && (!f.context || !/^[\w-]{1,64}$/.test(f.agent))) return 'agent needs context: fork and a plain agent name'
  for (const c of liveCommands(body)) {
    const why = commandRefusal(c)
    if (why) return why
  }
  return undefined
}

/** The fields as SKILL.md frontmatter entries (raw YAML values), in FIELD_NAMES order. */
export function fieldsToExtra(f: SkillFields): [string, string][] {
  const out: [string, string][] = []
  for (const k of FIELD_NAMES) {
    const v = f[k]
    if (v === undefined || (Array.isArray(v) && !v.length)) continue
    out.push([k, Array.isArray(v) ? `[${v.map(x => JSON.stringify(x)).join(', ')}]` : typeof v === 'string' ? JSON.stringify(v) : String(v)])
  }
  return out
}
