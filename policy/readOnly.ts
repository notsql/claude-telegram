/**
 * Read-only tool calls are allowed without a prompt (003 FR14): only writes
 * and updates reach the chat. Bash counts as read-only when every command in
 * it is a known reader, or names a read verb (get, list, search, help…) as its
 * subcommand, through loops, `if` and variables. Anything with redirection,
 * substitution or a write verb asks.
 */

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'TodoWrite', 'ToolSearch'])

/** Read verbs, matched as a whole word or a `get-item` / `list_buckets` style prefix. */
const READ_VERB = /^(get|list|ls|search|read|fetch|history|help|show|status|view|describe|info|log|logs|query|find|lookup|whoami|version|diff|cat|inspect|top|ps)(?:[-_]|$)/i
const WRITE_VERB = /(^|[-_])(create|update|delete|del|write|set|put|post|patch|send|add|remove|rm|edit|move|mv|rename|share|trash|upload|install|uninstall|push|apply|exec|run|kill|stop|start|restart|reset|transition|spawn|copy|cp|merge|commit|publish|deploy|drop|insert|modify|save|clear|purge|archive)([-_]|$)/i

/** Commands that only read, whatever their arguments (bar the checks below). */
const READERS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'wc', 'pwd', 'echo', 'printf',
  'which', 'whereis', 'type', 'stat', 'file', 'du', 'df', 'date', 'whoami', 'id', 'uname', 'hostname', 'tree', 'sort', 'uniq',
  'cut', 'tr', 'jq', 'yq', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'env', 'printenv', 'ps', 'uptime',
  'man', 'sw_vers', 'true', 'test', '[', '[[', 'column', 'nl', 'od', 'xxd', 'hexdump', 'strings', 'md5', 'md5sum', 'shasum', 'sha256sum',
  'awk', 'sed', 'cd', 'curl', 'tldr', 'dig', 'nslookup', 'ping', 'lsof', 'top', 'free', 'vm_stat', 'sysctl', 'defaults', 'mdfind', 'plutil',
])
/** Never read-only, even with a read verb after them (`rm list`, `sudo …`). */
const WRITERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'dd', 'chmod', 'chown', 'chgrp', 'ln', 'mkdir', 'touch', 'tee', 'kill', 'killall', 'pkill', 'sudo', 'su', 'doas', 'xargs', 'eval', 'exec', 'sh', 'bash', 'zsh', 'source', '.', 'truncate', 'shred', 'install', 'open', 'osascript', 'launchctl', 'crontab', 'reboot', 'shutdown', 'node', 'ruby', 'perl', 'php', 'deno', 'npx', 'bunx', 'pipx'])
/** Flags that make a reader write or run something. */
const WRITE_FLAGS: Record<string, RegExp> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/,
  sed: /^(-i|--in-place)/,
  awk: /system|>/,
  sort: /^(-o|--output)/,
  defaults: /^(write|delete|import|rename)$/,
  sysctl: /=/,
  curl: /^(-X|--request|-d|--data|-F|--form|-T|--upload-file|-o|--output|-O|--remote-name)/,
  env: /./, // `env CMD` runs CMD; only bare `env` reads.
}
/**
 * `python3 -c '<code>'` reads when the code only imports these modules and
 * uses none of the names below, so it can't open files, run commands or
 * reach other modules (`sys.modules`, `__import__`, `getattr`…).
 */
const PY_SAFE_MODULES = new Set(['json', 'sys', 're', 'collections', 'itertools', 'functools', 'datetime', 'math', 'statistics', 'textwrap', 'pprint', 'string', 'operator', 'csv', 'base64', 'hashlib', 'time', 'zoneinfo', 'decimal', 'fractions', 'unicodedata', 'html', 'urllib.parse'])
const PY_UNSAFE = /\b(open|exec|eval|compile|getattr|setattr|delattr|globals|locals|vars|modules|breakpoint|input|exit|quit|help|memoryview|stdout\.buffer|platform|path|executable|argv)\b|__|\bsys\.(?!stdin\b|stdout\b|stderr\b)|\bcsv\.writer|\bjson\.dump\b/

function readOnlyPython(args: string[]): boolean {
  // Flags before -c may only be isolation and quiet flags: `-I`, `-S`, `-E`, `-s`, `-B`, `-u`.
  const c = args.indexOf('-c')
  if (c < 0 || !args.slice(0, c).every(a => /^-[ISEsBu]+$/.test(a))) return false
  const body: string[] = []
  for (const stmt of (args[c + 1] ?? '').split(/[;\n]/)) {
    const m = /^\s*(?:import\s+([\w., ]+)|from\s+([\w.]+)\s+import\b)/.exec(stmt)
    if (!m) { body.push(stmt); continue }
    const mods = (m[1] ?? m[2]!).split(',').map(x => x.trim().split(/\s+as\s+/)[0]!)
    if (!mods.every(mod => PY_SAFE_MODULES.has(mod))) return false
  }
  const rest = body.join('\n')
  return !/\bimport\b/.test(rest) && !PY_UNSAFE.test(rest)
}

/** git, the commonest case, by subcommand. */
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'fetch', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'reflog', 'grep', 'config', 'tag', 'stash'])
const GIT_WRITE_FLAGS = /^(-d|-D|--delete|-m|-M|--move|-c|-C|--copy|--set-upstream-to|-u|--unset|--add|--replace-all|--edit|-e|-f|--force)$/

export function isReadOnly(toolName: string, input: Record<string, unknown>): boolean {
  if (READ_TOOLS.has(toolName)) return true
  if (toolName === 'Bash') return typeof input.command === 'string' && readOnlyCommand(input.command)
  const mcp = /^mcp__.+?__(.+)$/.exec(toolName)
  if (mcp) return readOnlyName(mcp[1]!)
  return false
}

/** An MCP tool name such as `getJiraIssue`, `notion-search` or `list_recent_files`. */
function readOnlyName(name: string): boolean {
  const words = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
  return !WRITE_VERB.test(words) && words.split(/[-_]/).some(w => READ_VERB.test(w))
}

export function readOnlyCommand(command: string): boolean {
  const segments = splitCommand(command)
  if (!segments?.length) return false
  const vars = new Map<string, string>()
  return segments.every(words => readOnlySegment(words, vars))
}

/**
 * Splits a command into simple commands (word lists) on unquoted `;`, `|`,
 * `&&`, `||` and newlines, removing quotes. Undefined when it holds anything
 * that could write or hide a command: substitution (`$(`, backticks, even in
 * double quotes), backgrounding, or redirection other than to /dev/null or
 * between output streams.
 */
function splitCommand(command: string): string[][] | undefined {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let quoted = false // the word had quotes, so an empty one still counts
  let quote: '"' | "'" | undefined
  const endWord = () => { if (word || quoted) words.push(word); word = ''; quoted = false }
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = [] }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    const rest = command.slice(i)
    if (quote === "'") { if (c === "'") quote = undefined; else word += c; continue }
    if (c === '`' || rest.startsWith('$(')) {
      // Substitution is fine when what it runs is itself read-only.
      const end = c === '`' ? command.indexOf('`', i + 1) : closingParen(command, i + 2)
      if (end < 0 || !readOnlyCommand(command.slice(i + (c === '`' ? 1 : 2), end))) return undefined
      word += command.slice(i, end + 1)
      quoted = true
      i = end
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = undefined
      else if (c === '\\' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; quoted = true; continue }
    if (c === '\\') { if (i + 1 < command.length) word += command[++i]; continue }
    if (c === ' ' || c === '\t') { endWord(); continue }
    if (c === ';' || c === '\n') { endSegment(); continue }
    if (rest.startsWith('&&') || rest.startsWith('||')) { endSegment(); i++; continue }
    if (c === '|') { if (command[i + 1] === '&') return undefined; endSegment(); continue }
    if (c === '>' || c === '<' || c === '&') {
      // `2>&1`, `>&2`, `>/dev/null`, `2>/dev/null`, `&>/dev/null`: harmless.
      const m = /^&?>(?:&[12]|\s*\/dev\/null)(?=[\s;|&]|$)/.exec(rest)
      if (!m || !/^[12]?$/.test(word)) return undefined
      word = ''
      i += m[0].length - 1
      continue
    }
    word += c
  }
  if (quote) return undefined
  endSegment()
  return segments
}

/** Index of the `)` closing a `$(` whose contents start at `from`, or -1. Quote-aware. */
function closingParen(command: string, from: number): number {
  let depth = 1
  let quote: string | undefined
  for (let i = from; i < command.length; i++) {
    const c = command[i]!
    if (quote) { if (c === quote) quote = undefined; else if (c === '\\' && quote === '"') i++; continue }
    if (c === "'" || c === '"') quote = c
    else if (c === '\\') i++
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

/** Shell keywords that wrap a command: `do ls`, `then cat x`, `if grep -q …`. */
const PREFIX_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '('])
const END_KEYWORDS = new Set(['done', 'fi', '}', ')'])

function readOnlySegment(words: string[], vars: Map<string, string>): boolean {
  words = [...words]
  while (words.length && PREFIX_KEYWORDS.has(words[0]!)) words.shift()
  if (!words.length || (words.length === 1 && END_KEYWORDS.has(words[0]!))) return true
  // `for x in a b c` only sets the loop variable.
  if (words[0] === 'for') return true
  // `T=~/bin/tool` remembers T, so a later `$T history` is judged as `~/bin/tool history`.
  const assigns: [string, string][] = []
  while (words.length && /^\w+=/.test(words[0]!)) {
    const [, k, v] = /^(\w+)=(.*)$/.exec(words.shift()!)!
    assigns.push([k!, v!])
  }
  if (!words.length) {
    for (const [k, v] of assigns) vars.set(k, v)
    return true
  }
  // Known variables are filled in; `$d/wacli` with `$d` a loop directory is judged by its name, `wacli`.
  let cmd = words[0]!.replace(/\$\{?(\w+)\}?/g, (ref, k: string) => vars.get(k) ?? ref)
  // `/opt/homebrew/bin/gh` is judged as `gh`.
  cmd = cmd.split('/').pop()!
  // A program name that is still a variable (`$X history`) could be anything.
  if (cmd.includes('$')) return false
  const args = words.slice(1)
  if (!cmd || WRITERS.has(cmd)) return false
  if (cmd === 'git') return readOnlyGit(args)
  if (/^python3?(\.\d+)?$/.test(cmd)) return readOnlyPython(args)
  if (READERS.has(cmd)) {
    const bad = WRITE_FLAGS[cmd]
    return !bad || !args.some(a => bad.test(a))
  }
  // A read verb as the subcommand: `gh pr list`, `kubectl get pods`, `npm help`, `aws s3 ls`, `foo --help`.
  const sub = args.filter(a => !a.startsWith('-')).slice(0, 3)
  if (args.some(a => WRITE_VERB.test(a) && !a.startsWith('-'))) return false
  return args.includes('--help') || args.includes('-h') || sub.some(a => READ_VERB.test(a))
}

function readOnlyGit(args: string[]): boolean {
  const i = args.findIndex(a => !a.startsWith('-'))
  const sub = args[i]
  if (!sub || !GIT_READ.has(sub)) return false
  const rest = args.slice(i + 1)
  if (rest.some(a => GIT_WRITE_FLAGS.test(a))) return false
  // `git branch foo`, `git tag v1`, `git config k v`, `git stash` (push) create or change things.
  if (sub === 'branch' || sub === 'tag') return rest.every(a => a.startsWith('-')) || rest.includes('--list') || rest.includes('-l')
  if (sub === 'config') return rest.some(a => /^--(get|get-all|list|get-regexp)$|^-l$/.test(a))
  if (sub === 'stash') return ['list', 'show'].includes(rest[0] ?? '')
  if (sub === 'remote') return rest.every(a => a.startsWith('-') || a === 'show' || a === 'get-url') && !rest.includes('add')
  return true
}
