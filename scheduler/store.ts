/**
 * Scheduled jobs in `STATE_DIR/jobs.json` (007 FR1), written atomically.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { PolicySchema } from '../policy/schema.ts'
import { writeJson } from '../util/files.ts'

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

const JobSchema = z.discriminatedUnion('kind', [
  z.object({ ...Common, kind: z.literal('cron'), expr: z.string() }),
  z.object({ ...Common, kind: z.literal('at'), at: z.string() }),
])

export type Job = z.infer<typeof JobSchema>

const JobsFileSchema = z.object({ jobs: z.array(JobSchema) })

export const jobsPath = (stateDir: string) => join(stateDir, 'jobs.json')

/** Missing file means no jobs. A corrupt file throws rather than being silently overwritten. */
export function loadJobs(stateDir: string): Job[] {
  const path = jobsPath(stateDir)
  if (!existsSync(path)) return []
  return JobsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).jobs
}

export function saveJobs(stateDir: string, jobs: Job[]): void {
  writeJson(jobsPath(stateDir), JobsFileSchema.parse({ jobs }))
}
