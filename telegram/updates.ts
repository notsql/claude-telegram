/**
 * 📍 Updates chat (008 FR23): the one chat, group or forum topic where the
 * bot's automatic messages go (inbox summaries, digests and their setup,
 * health notices, deadline nudges, archive suggestions, install notices).
 * Unset means the owner DM. Set from ⚙️ Settings in the chat itself. The file
 * keeps its 013 name, `inbox-target.json`, so an existing choice carries over.
 */

import { rmSync } from 'fs'
import { join } from 'path'
import { readJson, writeJson } from '../util/files.ts'

/** A session key and the chat's title. */
export type UpdatesTarget = { key: string; title: string }

const path = (stateDir: string) => join(stateDir, 'inbox-target.json')
export const loadUpdatesTarget = (stateDir: string) => readJson<UpdatesTarget>(path(stateDir))
export const saveUpdatesTarget = (stateDir: string, t: UpdatesTarget) => writeJson(path(stateDir), t)
export const clearUpdatesTarget = (stateDir: string) => rmSync(path(stateDir), { force: true })

/** The session key automatic messages go to: the 📍 chat, else the owner DM. */
export const updatesKey = (stateDir: string, owner: string) => loadUpdatesTarget(stateDir)?.key ?? owner

/** "this chat", "your DM" or the chosen chat's title. */
export function updatesWhere(stateDir: string, here: string): string {
  const t = loadUpdatesTarget(stateDir)
  return !t ? 'your DM' : t.key === here ? 'this chat' : t.title
}
