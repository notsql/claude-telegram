/**
 * Telegram tools (reply, react, download_attachment, edit_message), shared by
 * the legacy stdio channel (server.ts) and the daemon's HTTP MCP server.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { InputFile, type Api } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { statSync } from 'fs'
import { extname } from 'path'
import { loadAccess, assertAllowedChat } from '../access.ts'
import { MAX_CHUNK_LIMIT, MAX_ATTACHMENT_BYTES, PHOTO_EXTS, assertSendable, chunk, threadOpts } from '../telegram/send.ts'
import { parseKey } from '../sessions/key.ts'
import { downloadAttachment } from '../telegram/attachments.ts'
import { visibleTools } from '../policy/tools.ts'
import type { Policy } from '../policy/schema.ts'

/**
 * `key` is the session the daemon's MCP request is bound to; replies to its
 * chat land in its forum topic (002 FR4). The stdio channel passes none.
 * `policy` is the session's resolved policy; tools it doesn't allow are hidden.
 */
/** More tools on the same server (004 memory); `call` returns undefined for names it doesn't own. */
export type ExtraTools = {
  list: () => object[]
  call: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown
}

export function registerTelegramTools(mcp: Server, api: Api, token: string, key?: string, policy: Policy = {}, extra?: ExtraTools): void {
  const bound = key ? parseKey(key) : undefined
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools([
      {
        name: 'reply',
        description:
          'Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            text: { type: 'string' },
            reply_to: {
              type: 'string',
              description: 'Message ID to thread under. Use message_id from the inbound <channel> block.',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each.',
            },
            format: {
              type: 'string',
              enum: ['text', 'markdownv2'],
              description: "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",
            },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'react',
        description: 'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string' },
            emoji: { type: 'string' },
          },
          required: ['chat_id', 'message_id', 'emoji'],
        },
      },
      {
        name: 'download_attachment',
        description: 'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
          },
          required: ['file_id'],
        },
      },
      {
        name: 'edit_message',
        description: 'Edit a message the bot previously sent. Useful for interim progress updates. Edits don\'t trigger push notifications — send a new reply when a long task completes so the user\'s device pings.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string' },
            text: { type: 'string' },
            format: {
              type: 'string',
              enum: ['text', 'markdownv2'],
              description: "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",
            },
          },
          required: ['chat_id', 'message_id', 'text'],
        },
      },
    ], policy).concat(extra?.list() ?? []),
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const handled = await extra?.call(req.params.name, args)
    if (handled) return handled as never
    try {
      switch (req.params.name) {
        case 'reply': {
          const chat_id = args.chat_id as string
          const text = args.text as string
          const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
          const files = (args.files as string[] | undefined) ?? []
          const format = (args.format as string | undefined) ?? 'text'
          const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : undefined

          assertAllowedChat(chat_id)
          const thread = bound?.chatId === chat_id ? threadOpts(bound) : {}

          for (const f of files) {
            assertSendable(f)
            const st = statSync(f)
            if (st.size > MAX_ATTACHMENT_BYTES) {
              throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
            }
          }

          const access = loadAccess()
          const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
          const mode = access.chunkMode ?? 'length'
          const replyMode = access.replyToMode ?? 'first'
          const chunks = chunk(text, limit, mode)
          const sentIds: number[] = []

          try {
            for (let i = 0; i < chunks.length; i++) {
              const shouldReplyTo =
                reply_to != null &&
                replyMode !== 'off' &&
                (replyMode === 'all' || i === 0)
              const sent = await api.sendMessage(chat_id, chunks[i], {
                ...thread,
                ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
                ...(parseMode ? { parse_mode: parseMode } : {}),
              })
              sentIds.push(sent.message_id)
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(
              `reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`,
            )
          }

          // Files go as separate messages (Telegram doesn't mix text+file in one
          // sendMessage call). Thread under reply_to if present.
          for (const f of files) {
            const ext = extname(f).toLowerCase()
            const input = new InputFile(f)
            const opts = {
              ...thread,
              ...(reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : {}),
            }
            if (PHOTO_EXTS.has(ext)) {
              const sent = await api.sendPhoto(chat_id, input, opts)
              sentIds.push(sent.message_id)
            } else {
              const sent = await api.sendDocument(chat_id, input, opts)
              sentIds.push(sent.message_id)
            }
          }

          const result =
            sentIds.length === 1
              ? `sent (id: ${sentIds[0]})`
              : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
          return { content: [{ type: 'text', text: result }] }
        }
        case 'react': {
          assertAllowedChat(args.chat_id as string)
          await api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
            { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
          ])
          return { content: [{ type: 'text', text: 'reacted' }] }
        }
        case 'download_attachment': {
          const path = await downloadAttachment(api, token, args.file_id as string)
          return { content: [{ type: 'text', text: path }] }
        }
        case 'edit_message': {
          assertAllowedChat(args.chat_id as string)
          const editFormat = (args.format as string | undefined) ?? 'text'
          const editParseMode = editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined
          const edited = await api.editMessageText(
            args.chat_id as string,
            Number(args.message_id),
            args.text as string,
            ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
          )
          const id = typeof edited === 'object' ? edited.message_id : args.message_id
          return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
        }
        default:
          return {
            content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
            isError: true,
          }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
        isError: true,
      }
    }
  })
}
