/**
 * Telegram account adapter (013 FR3): one NDJSON line from
 * `tgcli watch --output json` (gotd/cli v0.11.0, cmd/tg/watch.go + format.go):
 *   {"account"?: string, "peer": {id, type: user|chat|channel|unknown, name?, username?},
 *    "message": {id, date (unix s), out, from?: peerRef, text?, media?, reply_to?}}
 * `peer` is the chat; `message.from` is the sender, often absent in private chats.
 * `reply_to` is a quote, not a thread, so it is not kept: a chat is one conversation.
 * DM peers often arrive without a name; `tgcliChats` maps ids to names from
 * `tgcli chats list --output json` (`{data: {chats: [{peer}]}}`).
 */

import type { Item } from '../store.ts'

type PeerRef = { id: number; type: string; name?: string; username?: string }
type WatchEvent = {
  peer: PeerRef
  message: { id: number; date: number; out: boolean; from?: PeerRef; text?: string; media?: string; reply_to?: number }
}

const peerName = (p: PeerRef) => p.name || (p.username ? `@${p.username}` : String(p.id))

/** Chat id (`type:id`, as in items) → name, from `tgcli chats list --output json`. */
export function tgcliChats(stdout: string): Map<string, string> {
  const chats = (JSON.parse(stdout) as { data?: { chats?: { peer: PeerRef }[] } }).data?.chats ?? []
  return new Map(chats.filter(c => c.peer?.name).map(c => [`${c.peer.type}:${c.peer.id}`, c.peer.name!]))
}

export function tgcliItem(source: string, line: unknown): Item | null {
  const ev = line as WatchEvent
  if (!ev?.peer || !ev.message || typeof ev.message.id !== 'number') return null
  const { peer, message: m } = ev
  const text = m.text || (m.media ? `[${m.media}]` : '')
  if (!text) return null
  const isDm = peer.type === 'user'
  const from = m.from ?? peer
  const chatId = `${peer.type}:${peer.id}`
  return {
    source,
    // Channel message ids are only unique per chat, so key on chat + id.
    extId: `${chatId}:${m.id}`,
    ts: m.date * 1000,
    from: m.out ? { id: 'me', name: 'me' } : { id: `${from.type}:${from.id}`, name: peerName(from) },
    chat: { id: chatId, name: peerName(peer), isGroup: !isDm },
    text,
    url: peer.username ? `https://t.me/${peer.username}/${m.id}` : undefined,
    toMe: isDm && !m.out,
    fromMe: m.out,
  }
}
