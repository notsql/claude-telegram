/**
 * Subagent usage (009 FR5, FR7) in `agents-usage.json`: per agent type, how
 * often it ran, when last, and total run time. Fed by the `SubagentStart` and
 * `SubagentStop` http hooks. The payloads carry no duration (T901), so the
 * start time is held per `agent_id` and the duration taken at Stop.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export type AgentUsage = {
  count: number
  last_used?: string
  /** Sum of Start→Stop durations of finished runs. */
  total_ms: number
}

export function createAgentUsage(file: string) {
  const running = new Map<string, { type: string; started: number }>()
  const load = (): Record<string, AgentUsage> => {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
  }
  const save = (all: Record<string, AgentUsage>) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }

  return {
    all: load,
    get: (type: string): AgentUsage | undefined => load()[type],

    /** `SubagentStart`: counts the run. */
    start(payload: Record<string, unknown>, now = Date.now()): void {
      const type = payload.agent_type, id = payload.agent_id
      if (typeof type !== 'string' || !type) return
      const all = load()
      const e = (all[type] ??= { count: 0, total_ms: 0 })
      e.count++
      e.last_used = new Date(now).toISOString()
      save(all)
      if (typeof id === 'string') running.set(id, { type, started: now })
    },

    /** `SubagentStop`: adds the run's duration; returns it for logging, or undefined for an unknown run. */
    stop(payload: Record<string, unknown>, now = Date.now()): { type: string; ms: number } | undefined {
      const id = payload.agent_id
      const run = typeof id === 'string' ? running.get(id) : undefined
      if (!run) return undefined
      running.delete(id as string)
      const ms = now - run.started
      const all = load()
      const e = (all[run.type] ??= { count: 0, total_ms: 0 })
      e.total_ms += ms
      save(all)
      return { type: run.type, ms }
    },
  }
}
