/**
 * Consequential-action classes (020 FR1, FR2, FR4): tool calls that send to
 * other people, pay, sign or delete, judged from MCP tool names and Bash
 * subcommands, plus the off-limits list that no approval can unlock. Reads
 * (003 FR14) and the daemon's own `mcp__tg__*` tools are never classified.
 * Acting in someone else's account can't be told from a call; the system
 * prompt covers it.
 */

import { tmpdir } from 'os'
import { expandPath, isInside } from './args.ts'
import { isReadOnly, splitCommand } from './readOnly.ts'

export type ActionClass = 'send' | 'pay' | 'sign' | 'delete'
export type Classification = { class: ActionClass; summary: string } | { offLimits: string }

/** Matched against single words of a tool name or subcommand; first class wins. */
const CLASSES: [ActionClass, RegExp][] = [
  ['pay', /^(pay|payment|payments|purchase|checkout|buy|charge|subscribe)$/],
  ['sign', /^(sign|esign|signature|countersign)$/],
  ['send', /^(send|reply|post|publish|forward|invite|tweet|dm|comment)$/],
  ['delete', /^(delete|del|remove|rm|trash|destroy|purge|erase|wipe|drop|unlink)$/],
]
/** Word pairs anywhere in a name or command (FR4): trading securities, moving money between accounts. */
const OFF_LIMITS: [RegExp, RegExp, string][] = [
  [/^(trade|trades|trading|buy|sell|order|orders)$/, /^(stock|stocks|share|shares|securities|security|etf|equity|equities|option|options|crypto)$/, 'trading securities'],
  [/^(transfer|transfers|move|send|wire)$/, /^(money|funds|fund|cash|balance)$/, 'moving money between accounts'],
]
/** `rm`-like commands, judged by their path arguments. */
const REMOVERS = new Set(['rm', 'rmdir', 'shred', 'srm', 'trash', 'unlink'])
const LABEL: Record<ActionClass, string> = { send: 'Send', pay: 'Pay', sign: 'Sign', delete: 'Delete' }

export type ClassifyOpts = {
  cwd: string
  /** `rm` inside these is housekeeping, not a delete (the system temp dir is always in). */
  scratchDirs?: string[]
}

export function classify(toolName: string, input: Record<string, unknown>, opts: ClassifyOpts): Classification | undefined {
  if (toolName.startsWith('mcp__tg__') || isReadOnly(toolName, input)) return
  if (toolName === 'Bash' && typeof input.command === 'string') return classifyCommand(input.command, opts)
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (!mcp) return
  const words = splitWords(mcp[2]!)
  const banned = offLimits(words)
  if (banned) return { offLimits: banned }
  const cls = classOf(words)
  if (cls) return { class: cls, summary: `${LABEL[cls]} · ${mcp[1]} ${mcp[2]}${target(input)}` }
}

function classifyCommand(command: string, opts: ClassifyOpts): Classification | undefined {
  // Unparseable commands (redirection, substitution) are judged on their bare words.
  const segments = splitCommand(command) ?? command.split(/[;&|\n]+/).map(s => s.trim().split(/\s+/).filter(Boolean))
  const summary = (cls: ActionClass) => `${LABEL[cls]} · ${command.length > 80 ? command.slice(0, 79) + '…' : command}`
  for (const words of segments) {
    // Only the command and its subcommands count, never message text (`wacli send "transfer money?"`).
    const banned = offLimits(commandWords(words))
    if (banned) return { offLimits: banned }
    const cls = segmentClass(words, opts)
    if (cls) return { class: cls, summary: summary(cls) }
  }
}

function segmentClass(words: string[], opts: ClassifyOpts): ActionClass | undefined {
  while (words.length && /^\w+=/.test(words[0]!)) words = words.slice(1)
  const cmd = words[0]?.split('/').pop()
  const args = words.slice(1)
  if (!cmd) return
  if (cmd === 'sudo' || cmd === 'xargs') return segmentClass(args.filter(a => !a.startsWith('-')), opts)
  if (REMOVERS.has(cmd)) {
    const scratch = [tmpdir(), '/tmp', '/private/tmp', ...(opts.scratchDirs ?? [])].map(d => expandPath(d, opts.cwd))
    const paths = args.filter(a => !a.startsWith('-')).map(a => expandPath(a, opts.cwd))
    return paths.length && paths.every(p => scratch.some(d => isInside(p, d) && p !== d)) ? undefined : 'delete'
  }
  // `-X POST` is an HTTP verb, not a post to people; 003 still asks for writes.
  if (cmd === 'curl') return
  if (cmd === 'find') return args.includes('-delete') ? 'delete' : undefined
  if (cmd === 'git') {
    // A forced or deleting push rewrites or removes what others can see; local git is 003's business.
    if (args[0] !== 'push') return
    return args.some(a => /^(-f|--force|--force-with-lease|--delete|-d)$/.test(a) || /^[+:]/.test(a)) ? 'delete' : undefined
  }
  return classOf(commandWords(words))
}

/**
 * The program name and up to three subcommand-like words: `gh repo delete x` →
 * gh, repo, delete, x. Text with spaces, paths and flags are left out, so a
 * message body never decides the class.
 */
const commandWords = (words: string[]) =>
  [words[0]?.split('/').pop() ?? '', ...words.slice(1).filter(a => /^[a-z][\w-]*$/i.test(a)).slice(0, 3)].flatMap(splitWords)

/** `postMessage`, `send-email`, `delete_file` → lowercase words. `sign_in`/`sign_up`/`sign_out` aren't signing. */
function splitWords(name: string): string[] {
  const words = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return words.filter((w, i) => !(w === 'sign' && /^(in|up|out|on|off)$/.test(words[i + 1] ?? '')))
}

const classOf = (words: string[]) => CLASSES.find(([, re]) => words.some(w => re.test(w)))?.[0]

function offLimits(words: string[]): string | undefined {
  return OFF_LIMITS.find(([a, b]) => words.some(w => a.test(w)) && words.some(w => b.test(w)))?.[2]
}

/** The first field naming who or what a call acts on, for the one-line summary. */
function target(input: Record<string, unknown>): string {
  for (const k of ['to', 'recipient', 'recipients', 'channel', 'email', 'amount', 'path', 'file_path', 'id']) {
    const v = input[k]
    if (typeof v === 'string' || typeof v === 'number') return ` → ${String(v).slice(0, 60)}`
    if (Array.isArray(v) && v.length) return ` → ${v.slice(0, 3).join(', ').slice(0, 60)}`
  }
  return ''
}
