/**
 * Inbound attachment handling: inbox downloads and filename sanitising.
 * Extracted verbatim from server.ts.
 */

import type { Api } from 'grammy'
import type { PhotoSize } from 'grammy/types'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../access.ts'

export const INBOX_DIR = join(STATE_DIR, 'inbox')

export type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

// Filenames and titles are uploader-controlled. They land inside the <channel>
// notification — delimiter chars would let the uploader break out of the tag
// or forge a second meta entry.
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// Downloads the largest size of an inbound photo into the inbox. Returns
// undefined on any failure so the message is still delivered without it.
export async function downloadPhoto(api: Api, token: string, photos: PhotoSize[]): Promise<string | undefined> {
  // Largest size is last in the array.
  const best = photos[photos.length - 1]
  try {
    const file = await api.getFile(best.file_id)
    if (!file.file_path) return undefined
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const res = await fetch(url)
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = file.file_path.split('.').pop() ?? 'jpg'
    const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
    mkdirSync(INBOX_DIR, { recursive: true })
    writeFileSync(path, buf)
    return path
  } catch (err) {
    process.stderr.write(`telegram channel: photo download failed: ${err}\n`)
    return undefined
  }
}

// Backs the download_attachment tool. Throws on failure so the tool reports it.
export async function downloadAttachment(api: Api, token: string, file_id: string): Promise<string> {
  const file = await api.getFile(file_id)
  if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // file_path is from Telegram (trusted), but strip to safe chars anyway
  // so nothing downstream can be tricked by an unexpected extension.
  const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}
