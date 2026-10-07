/**
 * Write checks for memory (004 FR8, FR11): secrets are refused, files are
 * capped at 2KB, and names are slugged so they are safe file names.
 */

export const MAX_FILE_BYTES = 2048
export const MAX_INDEX_LINES = 200
export const MAX_WRITES_PER_TURN = 3

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'API key'],
  [/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/, 'Telegram bot token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\b(password|passwd|pwd|secret|token|api[_ -]?key)\b\s*[:=]\s*\S{6,}/i, 'credential'],
  [/\b(my|the)\s+(password|api[_ -]?key|secret|token)\s+is\s+\S{6,}/i, 'credential'],
]

/** Lowercase kebab-case, at most 60 chars; empty when nothing usable remains. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')
}

/** Why a write must be refused, or null. `text` is the whole rendered file. */
export function refusal(text: string): string | null {
  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(text)) return `looks like it contains a ${what}; secrets are never saved to memory`
  }
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_FILE_BYTES) return `memory file is ${bytes} bytes, over the ${MAX_FILE_BYTES}-byte limit; keep it to one short fact`
  return null
}
