/**
 * Inbound messages: text is routed to a built-in, a skill command or the
 * agent (008 FR8, FR10, FR11); media becomes a turn with its attachment
 * (001 FR6). Gated senders, pairing and the group context buffer (002, 003
 * FR12) are handled here before anything is queued.
 */

import type { Bot, Context } from 'grammy'
import type { Message, User } from 'grammy/types'
import { gate, groupVerdict, loadAccess } from '../../access.ts'
import { renderInbound, renderSkillInvocation } from '../../agent/inbound.ts'
import { authorised, route } from '../../commands/dispatch.ts'
import type { Command } from '../../commands/registry.ts'
import { loadTable } from '../../commands/skillMap.ts'
import { canStartTurn } from '../../policy/resolve.ts'
import { createGroupBuffer } from '../../sessions/groupBuffer.ts'
import { parseKey, sessionKey } from '../../sessions/key.ts'
import type { createParticipants } from '../../sessions/participants.ts'
import { createTopicNames } from '../../sessions/topics.ts'
import { type AttachmentMeta, downloadPhoto, safeName } from '../attachments.ts'
import { threadOpts } from '../send.ts'
import { isApprover, isOwner } from './ui.ts'

/** One inbound message waiting for its key's next turn. */
export type Inbound = { prompt: string; text: string; msgId?: number; queued?: boolean }

/** A handler that may consume a message; true when it did. */
type ReplyHandler = (ctx: Context, text: string) => Promise<boolean>

export type InboundDeps = {
  token: string
  enqueue: (key: string, item: Inbound) => void
  participants: ReturnType<typeof createParticipants>
  /** Hands a skill command's `<channel>` wrapper to its turn as hook context (008 FR5). */
  setSkillContext: (key: string, context: string) => void
  /** Interrupts the key's running turn when a new message arrives, if configured (001 FR8). */
  interrupt: (key: string) => void
  setReaction: (chatId: string, msgId: number, emoji: string | undefined) => void
  commandsFile: string
  skillsHere: (key: string) => { name: string }[]
  builtins: Map<string, Command>
  /** Answers to force-reply prompts; they get first look at text. */
  replies: ReplyHandler[]
  /** Sees every message before the gate. */
  beforeGate: ReplyHandler
  /** A typed approval answer; true if `text` was one. */
  textApproval: (ctx: Context, text: string) => boolean
}

/** Inbound meta shared by messages and skill buttons. */
function chatMeta(chat: Message['chat'], from: User, topic: string | undefined): Record<string, string> {
  return {
    chat_id: String(chat.id),
    chat_type: chat.type,
    ...('title' in chat && chat.title ? { chat_title: chat.title } : {}),
    ...(topic ? { topic } : {}),
    user: from.username ?? String(from.id),
    user_id: String(from.id),
  }
}

export function registerInbound(bot: Bot, deps: InboundDeps) {
  const { textApproval } = deps
  const groupBuffer = createGroupBuffer()
  const topicNames = createTopicNames()

  async function handle(
    ctx: Context,
    text: string,
    downloadImage?: () => Promise<string | undefined>,
    attachment?: AttachmentMeta,
    /** 008 FR5: set for a skill command, the native `/<skill> <args>` invocation. */
    invocation?: string,
  ): Promise<void> {
    if (ctx.from && ctx.chat && await deps.beforeGate(ctx, text)) return
    const result = gate(ctx)
    const bufferContext = () => {
      topicNames.learn(ctx.msg!)
      deps.participants.saw(sessionKey(ctx.msg!), String(ctx.from!.id))
      groupBuffer.push(sessionKey(ctx.msg!), { ts: ctx.msg!.date * 1000, user: ctx.from!.username ?? String(ctx.from!.id), text })
    }
    // 003 FR5: answers count without an @mention, so they work in groups too.
    if (result.action === 'drop') {
      if (result.unmentioned && !textApproval(ctx, text)) bufferContext()
      return
    }
    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      await ctx.reply(`${lead}: run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      return
    }

    const from = ctx.from!
    const chat = ctx.chat!
    const msgId = ctx.message?.message_id
    const key = sessionKey(ctx.msg!)
    if (textApproval(ctx, text)) return

    // 003 FR12: non-owners in groups feed the context buffer but never start a turn.
    if (!canStartTurn(result.access, key, String(from.id))) return bufferContext()

    topicNames.learn(ctx.msg!)
    deps.participants.saw(key, String(from.id))
    void bot.api.sendChatAction(chat.id, 'typing', threadOpts(parseKey(key))).catch(() => {})
    if (result.access.ackReaction && msgId != null) deps.setReaction(String(chat.id), msgId, result.access.ackReaction)

    deps.interrupt(key)
    const imagePath = downloadImage ? await downloadImage() : undefined
    const meta = {
      ...chatMeta(chat, from, topicNames.get(key)),
      ...(msgId != null ? { message_id: String(msgId) } : {}),
      ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(attachment ? {
        attachment_kind: attachment.kind,
        attachment_file_id: attachment.file_id,
        ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
        ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
        ...(attachment.name ? { attachment_name: attachment.name } : {}),
      } : {}),
    }
    let prompt = renderInbound(text, meta, groupBuffer.take(key))
    if (invocation) {
      const skill = renderSkillInvocation(invocation, meta)
      prompt = skill.prompt
      deps.setSkillContext(key, skill.context)
    }
    deps.enqueue(key, { prompt, text, msgId })
  }

  bot.on('message:text', async ctx => {
    const text = ctx.message.text
    for (const reply of deps.replies) if (await reply(ctx, text)) return
    const r = route(text, ctx.me.username, deps.builtins, loadTable(deps.commandsFile))
    if (r.kind === 'ignore') return
    if (r.kind === 'skill') {
      const name = r.text.slice(1).split(/\s/)[0]!
      if (!deps.skillsHere(sessionKey(ctx.msg)).some(s => s.name === name)) return void await ctx.reply(`${name} is off in this chat. Turn it on in /settings → 🧩 Skills, plugins & MCP.`)
      return handle(ctx, text, undefined, undefined, r.text)
    }
    if (r.kind === 'text') return handle(ctx, text)
    if (!authorised(r.command, ctx.chat.type !== 'private', isApprover(sessionKey(ctx.msg), ctx.from.id), isOwner(ctx))) {
      return void await ctx.reply(`Only approvers can use /${r.command.name} here.`)
    }
    await r.command.handler(ctx, r.args)
  })

  bot.on('message:photo', ctx => handle(ctx, ctx.message.caption ?? '(photo)', () => downloadPhoto(ctx.api, deps.token, ctx.message.photo)))

  bot.on('message:document', ctx => {
    const doc = ctx.message.document
    const name = safeName(doc.file_name)
    return handle(ctx, ctx.message.caption ?? `(document: ${name ?? 'file'})`, undefined, {
      kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name,
    })
  })

  bot.on('message:voice', ctx => {
    const voice = ctx.message.voice
    return handle(ctx, ctx.message.caption ?? '(voice message)', undefined, {
      kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type,
    })
  })

  bot.on('message:audio', ctx => {
    const audio = ctx.message.audio
    const name = safeName(audio.file_name)
    return handle(ctx, ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`, undefined, {
      kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name,
    })
  })

  bot.on('message:video', ctx => {
    const video = ctx.message.video
    return handle(ctx, ctx.message.caption ?? '(video)', undefined, {
      kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name),
    })
  })

  bot.on('message:video_note', ctx => {
    const vn = ctx.message.video_note
    return handle(ctx, '(video note)', undefined, { kind: 'video_note', file_id: vn.file_id, size: vn.file_size })
  })

  bot.on('message:sticker', ctx => {
    const sticker = ctx.message.sticker
    const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
    return handle(ctx, `(sticker${emoji})`, undefined, { kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size })
  })

  // Names only from senders who could talk to the bot in this group (constitution IV).
  bot.on(['message:forum_topic_created', 'message:forum_topic_edited'], ctx => {
    if (groupVerdict(loadAccess().groups[String(ctx.chat.id)], String(ctx.from?.id), () => true) !== 'drop') topicNames.learn(ctx.msg)
  })

  return {
    handle,
    /** 008 FR12: the Run button, as if the user had sent `/<skill>` in this chat. */
    runSkill(msg: Message, from: User, name: string): void {
      const key = sessionKey(msg)
      const skill = renderSkillInvocation(`/${name}`, { ...chatMeta(msg.chat, from, topicNames.get(key)), ts: new Date().toISOString() })
      deps.setSkillContext(key, skill.context)
      deps.enqueue(key, { prompt: skill.prompt, text: `/${name}` })
    },
  }
}
