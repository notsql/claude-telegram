/**
 * WhatsApp adapter (013 FR3): one webhook POST body from
 * `wacli sync --follow --webhook … --webhook-secret …` (wacli 0.20.0, docs/sync.md
 * "Webhook payloads", internal/app/webhook.go). Message payloads have no
 * `EventType`; receipts and chat presence carry one and are skipped:
 *   {"Chat":"…@s.whatsapp.net|…@g.us","ID":"3EB0…","SenderJID":"…","Timestamp":"RFC3339 Z",
 *    "FromMe":false,"Text":"hi","PushName":"Alice","ChatName":"Alice","ReplyToID":"","Media":null|{Type,Caption,…}}
 * Payloads with no text and no media (reactions, unhandled types) are skipped.
 * `ReplyToID` is a quote, not a thread, so it is not kept: a chat is one conversation.
 */

import type { Item } from '../store.ts'

type Payload = {
  EventType?: string
  Chat: string
  ID: string
  SenderJID?: string
  Timestamp: string
  FromMe: boolean
  Text?: string
  PushName?: string
  ChatName?: string
  ReplyToID?: string
  Media?: { Type?: string; Caption?: string } | null
}

const user = (jid: string) => jid.split('@')[0]!

export function wacliItem(source: string, body: unknown): Item | null {
  const p = body as Payload
  if (!p || p.EventType || typeof p.Chat !== 'string' || !p.ID) return null
  const text = p.Text || p.Media?.Caption || (p.Media?.Type ? `[${p.Media.Type}]` : '')
  if (!text) return null
  const isGroup = p.Chat.endsWith('@g.us')
  const sender = p.SenderJID || p.Chat
  return {
    source,
    extId: `${p.Chat}:${p.ID}`,
    ts: Date.parse(p.Timestamp) || Date.now(),
    from: p.FromMe ? { id: 'me', name: 'me' } : { id: sender, name: p.PushName || (isGroup ? '' : p.ChatName) || user(sender) },
    chat: { id: p.Chat, name: p.ChatName || user(p.Chat), isGroup },
    text,
    toMe: !isGroup && !p.FromMe,
    fromMe: p.FromMe,
  }
}
