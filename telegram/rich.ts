/**
 * Formatted text as Telegram entities (013 T1320). Nothing here uses
 * `parse_mode`, so text from a message or a model can't break a send or inject
 * markup: third-party text stays literal unless the caller styles it.
 */

import type { MessageEntity } from 'grammy/types'

export type Rich = { text: string; entities: MessageEntity[] }
type Part = string | Rich

const styled = (type: 'bold' | 'italic') => (text: string): Rich =>
  ({ text, entities: text ? [{ type, offset: 0, length: text.length }] : [] })

export const bold = styled('bold')
export const italic = styled('italic')

/** Joins parts in order, shifting each part's entities. */
export function rich(...parts: Part[]): Rich {
  const out: Rich = { text: '', entities: [] }
  for (const p of parts) {
    const part = typeof p === 'string' ? { text: p, entities: [] } : p
    out.entities.push(...part.entities.map(e => ({ ...e, offset: e.offset + out.text.length })))
    out.text += part.text
  }
  return out
}

export const joined = (parts: Part[], separator: string): Rich => rich(...parts.flatMap((p, i) => (i ? [separator, p] : [p])))

/** At most `max` UTF-16 units, ending in `…`; entities are clipped with the text. */
export function capped(r: Rich, max: number): Rich {
  if (r.text.length <= max) return r
  const end = max - 1
  return {
    text: `${r.text.slice(0, end)}…`,
    entities: r.entities.filter(e => e.offset < end).map(e => ({ ...e, length: Math.min(e.length, end - e.offset) })),
  }
}

const INLINE = /`([^`\n]+)`|\*\*(.+?)\*\*|(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?![\s_])([^_\n]+?)(?<!\s)_(?![\w_])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g

function inline(line: string): Rich {
  const parts: Part[] = []
  let at = 0
  for (const m of line.matchAll(INLINE)) {
    parts.push(line.slice(at, m.index))
    at = m.index + m[0].length
    const [, code, strong, em, under, label, url] = m
    if (code) parts.push({ text: code, entities: [{ type: 'code', offset: 0, length: code.length }] })
    else if (strong) parts.push(bold(strong))
    else if (em || under) parts.push(italic((em ?? under)!))
    else parts.push({ text: label!, entities: [{ type: 'text_link', offset: 0, length: label!.length, url: url! }] })
  }
  parts.push(line.slice(at))
  return rich(...parts)
}

/**
 * The small Markdown subset the agent writes: `**bold**`, `*italic*`,
 * `_italic_`, `` `code` ``, fenced code, `[label](url)`, `- ` bullets and `#`
 * headings (as a bold line). Anything else stays as written.
 */
export function markdown(src: string): Rich {
  const out: Part[] = []
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i) out.push('\n')
    const line = lines[i]!
    if (line.startsWith('```')) {
      const end = lines.findIndex((l, j) => j > i && l.startsWith('```'))
      if (end > i) {
        const code = lines.slice(i + 1, end).join('\n')
        out.push({ text: code, entities: code ? [{ type: 'pre', offset: 0, length: code.length }] : [] })
        i = end
        continue
      }
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line)
    if (heading) out.push(bold(heading[1]!))
    else if (bullet) out.push(rich(`${bullet[1]}• `, inline(bullet[2]!)))
    else out.push(inline(line))
  }
  return rich(...out)
}
