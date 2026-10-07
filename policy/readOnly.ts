/**
 * Read-only tool calls are allowed without a prompt (003 FR14): only writes
 * and updates reach the chat. Bash counts as read-only when every command in
 * it is a known reader, or names a read verb (get, list, search, help…) as its
 * subcommand. Anything with redirection, substitution or a write verb asks.
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
  'man', 'sw_vers', 'true', 'test', 'column', 'nl', 'od', 'xxd', 'hexdump', 'strings', 'md5', 'md5sum', 'shasum', 'sha256sum',
  'awk', 'sed', 'cd', 'curl', 'tldr', 'dig', 'nslookup', 'ping', 'lsof', 'top', 'free', 'vm_stat', 'sysctl', 'defaults', 'mdfind', 'plutil',
])
/** Never read-only, even with a read verb after them (`rm list`, `sudo …`). */
const WRITERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'dd', 'chmod', 'chown', 'chgrp', 'ln', 'mkdir', 'touch', 'tee', 'kill', 'killall', 'pkill', 'sudo', 'su', 'doas', 'xargs', 'eval', 'exec', 'sh', 'bash', 'zsh', 'source', '.', 'truncate', 'shred', 'install', 'open', 'osascript', 'launchctl', 'crontab', 'reboot', 'shutdown', 'python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'npx', 'bunx', 'pipx'])
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
  // Redirection, substitution, backgrounding and heredocs can write or hide a second command.
  if (/[<>`]|\$\(|(?<!&)&(?!&)|\|&/.test(command.replace(/\d?>\s*\/dev\/null|2>&1/g, ''))) return false
  const segments = command.split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(Boolean)
  return segments.length > 0 && segments.every(readOnlySegment)
}

function readOnlySegment(segment: string): boolean {
  const words = segment.split(/\s+/).map(w => w.replace(/^['"]|['"]$/g, ''))
  while (words.length && /^\w+=/.test(words[0]!)) words.shift() // `FOO=1 cmd`
  const [cmd, ...args] = words
  if (!cmd || WRITERS.has(cmd)) return false
  if (cmd === 'git') return readOnlyGit(args)
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
