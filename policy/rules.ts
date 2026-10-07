import { homedir } from 'os'
import { dirname } from 'path'

/** Tools whose Always rule is a directory glob on `file_path`. Edit rules cover every editing tool. */
const FILE_TOOLS: Record<string, string> = { Edit: 'Edit', Write: 'Edit', MultiEdit: 'Edit', NotebookEdit: 'Edit', Read: 'Read' }

/**
 * Derives the "Always" rule (003 US2) for a tool call, in Claude Code
 * permission-rule syntax: Bash → command prefix with ` *` (the CLI's own
 * suggestion form), file tools → the file's directory as a `/**` glob, and
 * any other tool → the bare tool name.
 */
export function deriveRule(toolName: string, input: Record<string, unknown>, home = homedir()): string {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const [cmd, sub] = input.command.trim().split(/\s+/)
    if (cmd) return `Bash(${/^[a-z][\w-]*$/.test(sub ?? '') ? `${cmd} ${sub}` : cmd} *)`
  }
  const fileTool = FILE_TOOLS[toolName]
  const path = input.file_path ?? input.notebook_path
  if (fileTool && typeof path === 'string' && path.startsWith('/')) {
    return `${fileTool}(${rulePath(dirname(path), home)}/**)`
  }
  return toolName
}

/** Rule paths: `~/` is home-relative, `//` absolute (a single `/` is relative to the settings file). */
function rulePath(dir: string, home: string): string {
  if (dir === home) return '~'
  if (dir.startsWith(home + '/')) return '~' + dir.slice(home.length)
  return '/' + dir
}
