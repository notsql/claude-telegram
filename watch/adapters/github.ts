/**
 * GitHub adapter (013 FR3): stdout of `gh api notifications --paginate`, one
 * JSON array per page (gh concatenates pages without merging them):
 *   [{id, unread, reason, updated_at, subject: {title, url, type}, repository: {full_name, html_url}}]
 * The cursor is the newest `updated_at` seen; the next poll asks for
 * `notifications?since=<cursor>`. A thread that updates again is a new item.
 */

import type { Item } from '../store.ts'

type Notification = {
  id: string
  reason: string
  updated_at: string
  subject: { title: string; url: string | null; type: string }
  repository: { full_name: string; html_url: string }
}

// Reasons that mean someone wants the owner specifically.
const TO_ME = new Set(['mention', 'team_mention', 'review_requested', 'assign', 'approval_requested'])

/** `https://api.github.com/repos/o/r/pulls/20` → `https://github.com/o/r/pull/20`. */
function htmlUrl(n: Notification): string {
  const api = n.subject.url
  if (!api) return n.repository.html_url
  return api.replace('https://api.github.com/repos/', 'https://github.com/').replace(/\/pulls\/(\d+)$/, '/pull/$1')
}

/** Adds `?since=<cursor>` to the `notifications` path argument. */
export function githubCommand(command: string[], cursor: string | null): string[] {
  if (!cursor) return command
  return command.map(a => a === 'notifications' ? `notifications?since=${encodeURIComponent(cursor)}` : a)
}

export function githubItems(source: string, stdout: string, cursor: string | null): { items: Item[]; cursor: string | null } {
  const text = stdout.trim()
  const list = (text ? JSON.parse(`[${text.replace(/\]\s*\[/g, '],[')}]`) : []).flat() as Notification[]
  let next = cursor
  const items = list.filter(n => n?.id && n.updated_at && n.subject).map(n => {
    if (!next || n.updated_at > next) next = n.updated_at
    const repo = n.repository.full_name
    return {
      source,
      extId: `${n.id}:${n.updated_at}`,
      ts: Date.parse(n.updated_at),
      from: { id: `repo:${repo}`, name: repo },
      chat: { id: `repo:${repo}`, name: repo, isGroup: true },
      text: `${n.subject.type} (${n.reason}): ${n.subject.title}`,
      url: htmlUrl(n),
      toMe: TO_ME.has(n.reason),
      fromMe: false,
      threadId: n.id,
    }
  })
  return { items, cursor: next }
}
