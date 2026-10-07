/**
 * Scheduled jobs in `STATE_DIR/jobs.json` (007 FR1). Writes go through a
 * temp file and rename so a crash never leaves a half-written file.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { PolicySchema } from '../policy/schema.ts'

const Common = {
  id: z.string(),
  tz: z.string(),
  title: z.string().optional(),
  prompt: z.string(),
  sessionKey: z.string(),
  mode: z.enum(['fresh', 'session']).default('fresh'),
  policyOverride: PolicySchema.optional(),
  enabled: z.boolean(),
  createdBy: z.string(),
  createdAt: z.number(),
  lastRun: z.number().nullable(),
  lastStatus: z.string().nullable(),
  nextRun: z.number().nullable(),
  failures: z.number().int().nonnegative(),
}

export const JobSchema = z.discriminatedUnion('kind', [
  z.object({ ...Common, kind: z.literal('cron'), expr: z.string() }),
  z.object({ ...Common, kind: z.literal('at'), at: z.string() }),
])

export type Job = z.infer<typeof JobSchema>

export const JobsFileSchema = z.object({ jobs: z.array(JobSchema) })

export const jobsPath = (stateDir: string) => join(stateDir, 'jobs.json')

/** Missing file means no jobs. A corrupt file throws rather than being silently overwritten. */
export function loadJobs(stateDir: string): Job[] {
  const path = jobsPath(stateDir)
  if (!existsSync(path)) return []
  return JobsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).jobs
}

export function saveJobs(stateDir: string, jobs: Job[]): void {
  const path = jobsPath(stateDir)
  const text = JSON.stringify(JobsFileSchema.parse({ jobs }), null, 2) + '\n'
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}
