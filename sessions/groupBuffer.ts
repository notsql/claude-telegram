/**
 * Recent group messages that weren't addressed to the bot, per session key
 * (002 FR8). Telegram has no history endpoint, so the next mentioned turn gets
 * these as context. In memory only; bounded by message count and characters.
 */

export type BufferedMessage = { ts: number; user: string; text: string }

export function createGroupBuffer({ maxMessages = 20, maxChars = 4000 } = {}) {
  const buffers = new Map<string, BufferedMessage[]>()

  return {
    push(key: string, msg: BufferedMessage): void {
      const buf = buffers.get(key) ?? []
      buf.push({ ...msg, text: msg.text.slice(0, maxChars) })
      let chars = buf.reduce((n, m) => n + m.text.length, 0)
      while (buf.length > maxMessages || chars > maxChars) chars -= buf.shift()!.text.length
      buffers.set(key, buf)
    },

    /** Returns and clears the key's messages, oldest first. */
    take(key: string): BufferedMessage[] {
      const buf = buffers.get(key) ?? []
      buffers.delete(key)
      return buf
    },
  }
}
