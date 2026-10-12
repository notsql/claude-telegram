/**
 * Capability gap detector (012 FR2). A Bash call that exits 127 or prints
 * `command not found` gets `additionalContext` nudging the agent toward the
 * capability ladder instead of giving up. A non-zero Bash exit arrives as
 * `PostToolUseFailure` (`error` text); a zero exit, e.g. `foo || true`, as
 * `PostToolUse` (`tool_response.stdout/stderr`). Both are checked.
 */

/** bash/sh: `x: command not found`; zsh: `command not found: x`. */
const ZSH = /command not found: ([\w.+-]+)/
const SH = /([\w.+-]+): command not found/

/** The missing command in a Bash hook payload: its name, '' for a bare exit 127, undefined when nothing is missing. */
export function missingCommand(payload: Record<string, unknown>): string | undefined {
  if (payload.tool_name !== 'Bash') return undefined
  const res = payload.tool_response as { stdout?: unknown; stderr?: unknown } | undefined
  const text = [payload.error, res?.stderr, res?.stdout].filter(s => typeof s === 'string').join('\n')
  const name = (text.match(ZSH) ?? text.match(SH))?.[1]
  if (name) return name
  return /exit code 127\b/i.test(text) ? '' : undefined
}

/** Hook output for a Bash `PostToolUse`/`PostToolUseFailure` payload; `{}` when nothing is missing. */
export function gapHint(payload: Record<string, unknown>) {
  const name = missingCommand(payload)
  if (name === undefined) return {}
  const hookEventName = payload.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse'
  return { hookSpecificOutput: { hookEventName, additionalContext: `missing command \`${name || 'unknown'}\`: run tg-capability-ladder` } }
}
