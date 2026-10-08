import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/** One `audit.log` line (003 FR10): policy changes, approval decisions and plugin installs. */
export type AuditEntry =
  | { event: 'approval'; key: string; tool: string; decision: string; user?: string; rule?: string }
  | { event: 'policy'; key: string; user: string; field: string; value: unknown }
  | { event: 'plugin'; key: string; user: string; action: string; plugin: string; ok: boolean }

/** Append-only JSONL writer. */
export function createAudit(file: string) {
  return (entry: AuditEntry) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
  }
}
