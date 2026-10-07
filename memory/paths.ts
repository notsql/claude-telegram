/**
 * Where the shared memory lives (004 FR2): Claude Code's auto-memory dir for
 * the daemon's workspace project, so `claude -p` there loads it natively
 * (T401 a). User-model files sit under `users/<telegram_user_id>/`.
 */

import { realpathSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Claude Code's project-dir name: every non-alphanumeric char of the real path becomes `-` (T401). */
export function projectDirName(cwd: string): string {
  let real = cwd
  try { real = realpathSync(cwd) } catch {}
  return real.replace(/[^A-Za-z0-9]/g, '-')
}

export function memoryRoot(cwd: string, home = homedir()): string {
  return join(home, '.claude', 'projects', projectDirName(cwd), 'memory')
}

export const usersDir = (root: string) => join(root, 'users')
export const userDir = (root: string, userId: string) => join(usersDir(root), userId)
