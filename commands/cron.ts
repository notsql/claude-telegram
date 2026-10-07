/**
 * `/cron` inline manager (008 US4, 007 US5): this chat's jobs, one button row
 * each with ⏸ / ▶ / 🗑 / ▶️ Run now. A thin view over 007's functions.
 */

import { describeJob } from '../scheduler/describe.ts'
import { jobTitle } from '../scheduler/run.ts'
import type { Job } from '../scheduler/store.ts'

export type CronAction = 'pause' | 'resume' | 'del' | 'run'
export const CRON_CALLBACK = /^crn:(pause|resume|del|run):(j_[0-9a-f]+)$/

export function cronView(jobs: Job[], now = new Date()) {
  if (!jobs.length) return { text: 'No scheduled jobs in this chat. Ask me in plain words to schedule one.' }
  const text = jobs.map(j => `${j.enabled ? '' : '⏸ '}${j.id} "${jobTitle(j)}"${j.lastStatus ? ` (last: ${j.lastStatus})` : ''}\n${describeJob(j, now)}`).join('\n\n')
  const keyboard = { inline_keyboard: jobs.map(j => [
    j.enabled
      ? { text: `⏸ ${j.id}`, callback_data: `crn:pause:${j.id}` }
      : { text: `▶ ${j.id}`, callback_data: `crn:resume:${j.id}` },
    { text: '🗑', callback_data: `crn:del:${j.id}` },
    { text: '▶️ Run now', callback_data: `crn:run:${j.id}` },
  ]) }
  return { text, keyboard }
}
