/**
 * Per-source send templates (013 FR4): the argv that replies to a stored item
 * through the source's own CLI. Run without a shell, and only from the owner's
 * Send tap (tools.ts); nothing here is reachable from a watcher or the model.
 * The binary is the source command's own `command[0]`. Argv from `--help`:
 *   wacli send text --to <jid> --message <text> [--reply-to <id> --reply-to-sender <jid>]
 *   tgcli send --peer id:<n> [text]   (no reply-to flag)
 * Values use `--flag=value` and tgcli's text follows `--`, so text starting
 * with `-` can't be read as a flag.
 */

import { basename } from 'path'
import type { Source } from './registry.ts'

/** The stored item fields a template needs. */
export type ReplyTarget = { ext_id: string; chat_id: string | null; from_id: string | null; is_group: number }

/** The argv replying `text` to `item` on `source`, or null when the source has no send template. */
export function sendArgv(source: Source, item: ReplyTarget, text: string): string[] | null {
  const cmd = (source.config as { command?: unknown }).command
  if (!Array.isArray(cmd) || typeof cmd[0] !== 'string' || !item.chat_id) return null
  const bin = cmd[0]
  switch (basename(bin)) {
    case 'wacli': {
      // extId is `<ChatJID>:<ID>`.
      const prefix = `${item.chat_id}:`
      const msgId = item.ext_id.startsWith(prefix) ? item.ext_id.slice(prefix.length) : undefined
      return [
        bin, 'send', 'text', `--to=${item.chat_id}`, `--message=${text}`,
        ...(msgId ? [`--reply-to=${msgId}`] : []),
        ...(msgId && item.is_group && item.from_id && item.from_id !== 'me' ? [`--reply-to-sender=${item.from_id}`] : []),
      ]
    }
    case 'tgcli': {
      // chat_id is `<peerType>:<peerId>`.
      const m = /^[a-z]+:(-?\d+)$/.exec(item.chat_id)
      return m ? [bin, 'send', `--peer=id:${m[1]}`, '--', text] : null
    }
    default:
      return null
  }
}

export type SendResult = { ok: boolean; error?: string }
export type SendSpawner = (argv: string[]) => Promise<SendResult>

/** Runs `argv` without a shell; fails on a non-zero exit with its stderr. */
export const bunSendSpawn: SendSpawner = async argv => {
  const p = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
  return code === 0 ? { ok: true } : { ok: false, error: err.trim().slice(0, 300) || `exit ${code}` }
}
