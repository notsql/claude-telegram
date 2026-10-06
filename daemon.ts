#!/usr/bin/env bun
/**
 * Headless daemon entry (FR1). Owns the grammY poller, the MCP and hook
 * endpoints, and runs each gated inbound message as a `claude -p` turn.
 * Access, pairing, approvals and attachments behave as in the legacy
 * `server.ts` channel (FR6), which stays runnable (FR13).
 */

import { Bot, GrammyError, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'fs'
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { join } from 'path'
import {
  STATE_DIR, initAccess, setBotUsername, loadAccess,
  gate, dmCommandGate, checkApprovals,
} from './access.ts'
import { type AttachmentMeta, safeName, downloadPhoto } from './telegram/attachments.ts'
import { startMcpServer } from './mcp/server.ts'
import { startHookServer } from './hooks/endpoint.ts'
import { writeHookSettings } from './hooks/settings.ts'
import { isMissingSession, runTurn, type RunTurnOpts, type TurnOutcome } from './agent/runner.ts'
import { parseKey, sessionKey } from './sessions/key.ts'
import { threadOpts } from './telegram/send.ts'
import { createSessionStore } from './sessions/store.ts'
import { createTurnQueue } from './sessions/queue.ts'
import { createGroupBuffer, type BufferedMessage } from './sessions/groupBuffer.ts'
import { startProgress } from './agent/progress.ts'
import { apiKeyRefusal, isLoggedIn } from './agent/auth.ts'
import { loadConfig, cliVersionRefusal, createTurnBudget } from './config.ts'

const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'daemon.pid')
const SETTINGS_FILE = join(STATE_DIR, 'hook-settings.json')
// 003 FR4 makes this configurable.
const APPROVAL_TIMEOUT_SEC = 300
// FR9: the whole shutdown, including the child's SIGINT → SIGTERM → SIGKILL escalation (7s).
const SHUTDOWN_DEADLINE_MS = 9000

const log = (line: string) => process.stderr.write(`telegram daemon: ${line}\n`)

// Load the state-dir .env into process.env. Real env wins.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'
if (!TOKEN) {
  log(`TELEGRAM_BOT_TOKEN required\n  set in ${ENV_FILE}\n  format: TELEGRAM_BOT_TOKEN=123456789:AAH...`)
  process.exit(1)
}

// FR10: never let the CLI fall back to API-key billing.
const keyRefusal = apiKeyRefusal(process.env)
if (keyRefusal) {
  log(keyRefusal)
  process.exit(1)
}

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig(process.env)
} catch (err) {
  log(String(err instanceof Error ? err.message : err))
  process.exit(1)
}

// FR12: the stream-json and hook shapes are pinned to a minimum CLI version.
const versionRefusal = cliVersionRefusal(
  Bun.spawnSync(['claude', '--version'], { stdout: 'pipe', stderr: 'ignore' }).stdout?.toString() ?? '',
)
if (versionRefusal) {
  log(versionRefusal)
  process.exit(1)
}

// FR7: one getUpdates consumer per token. Replace a stale daemon, verifying
// the PID still belongs to one (PIDs get recycled).
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(config.cwd, { recursive: true })
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0)
    const cmd = execFileSync('ps', ['-p', String(stale), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (cmd.includes('daemon.ts')) {
      log(`replacing stale poller pid=${stale}`)
      process.kill(stale, 'SIGTERM')
    }
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

// Without these the process dies silently on any unhandled rejection.
process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

initAccess({ static: STATIC })
const bot = new Bot(TOKEN)
if (!STATIC) setInterval(() => checkApprovals(bot.api), 5000).unref()

// FR10: a missing login is reported, not fatal; the owner can log in without a restart.
if (!isLoggedIn()) {
  const msg = 'claude is not logged in. Run `claude auth login` on the daemon host.'
  log(msg)
  for (const owner of loadAccess().allowFrom) void bot.api.sendMessage(owner, msg).catch(() => {})
}

const mcpToken = randomBytes(32).toString('hex')
const hookToken = randomBytes(32).toString('hex')
const mcpServer = startMcpServer({ authToken: mcpToken, api: bot.api, botToken: TOKEN })
const hookServer = startHookServer({ authToken: hookToken, log })
writeHookSettings(SETTINGS_FILE, { port: hookServer.port, approvalTimeoutSec: APPROVAL_TIMEOUT_SEC })

const sessions = createSessionStore(join(STATE_DIR, 'sessions.json'))

/**
 * Runs a turn in the key's session and stores the `session_id` from `init`,
 * since resume can return a new one (002 FR3). A session whose transcript is
 * gone is archived and the turn retried fresh, so the chat never gets stuck.
 */
async function runInSession(key: string, prompt: string, firstMessage: string, opts: RunTurnOpts): Promise<TurnOutcome> {
  let outcome = await runTurn(key, prompt, { ...opts, resume: sessions.current(key) })
  if (isMissingSession(outcome)) {
    log(`session for ${key} is gone, starting fresh`)
    sessions.new(key)
    outcome = await runTurn(key, prompt, opts)
  }
  if (outcome.init) sessions.record(key, outcome.init.session_id, firstMessage)
  return outcome
}

const turnAbort = new AbortController()
// FR8: each key's running turn, so /stop or a new message (with the flag) can interrupt it.
const runningTurns = new Map<string, AbortController>()
const INTERRUPT_ON_NEW_MESSAGE = process.env.TELEGRAM_INTERRUPT_ON_NEW_MESSAGE === '1'
// FR10: set when a turn hits a usage limit; queued turns wait until then.
let pausedUntil = 0
const budget = createTurnBudget(config.dailyTurnBudget)

const pauseMessage = (until: number) => `Usage limit reached. Paused until ${new Date(until).toLocaleString()}.`

/** One inbound message waiting for its key's next turn. */
type Inbound = { prompt: string; text: string; msgId?: number; queued?: boolean }

// Telegram only allows reactions from a fixed set, which has no hourglass.
const QUEUED_REACTION = '🫡'

const setReaction = (chat_id: string, msgId: number, emoji: string | undefined) =>
  bot.api.setMessageReaction(chat_id, msgId, emoji ? [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }] : [])
    .catch(() => {})

// 002 FR5/FR6: serial per key, up to N keys at once, mid-turn messages batched.
const turns = createTurnQueue<Inbound>({
  concurrency: config.maxConcurrentSessions,
  run: (key, batch) => runBatch(key, batch).catch(err => log(`turn failed: ${err}`)),
  onQueued: (key, item) => {
    item.queued = true
    if (item.msgId != null) void setReaction(parseKey(key).chatId, item.msgId, QUEUED_REACTION)
  },
})

async function runBatch(key: string, batch: Inbound[]): Promise<void> {
  const target = parseKey(key)
  const { chatId: chat_id } = target
  // 002 FR4: daemon notices land in the key's forum topic.
  const notify = (text: string) => bot.api.sendMessage(chat_id, text, threadOpts(target)).catch(() => {})
  if (turnAbort.signal.aborted) return
  // The queued reaction goes back to the ack (or none) once the turn starts.
  const ack = loadAccess().ackReaction
  for (const m of batch) if (m.queued && m.msgId != null) void setReaction(chat_id, m.msgId, ack)
  const prompt = batch.map(m => m.prompt).join('\n\n')
  const firstMessage = batch[0]!.text
  if (pausedUntil > Date.now()) {
    await notify(`${pauseMessage(pausedUntil)} Your message will run then.`)
    await new Promise<void>(r => {
      const t = setTimeout(r, pausedUntil - Date.now())
      turnAbort.signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true })
    })
    if (turnAbort.signal.aborted) return
  }
  if (!budget.take()) {
    await notify(`Daily turn budget (${config.dailyTurnBudget}) used up. Try again tomorrow.`)
    return
  }
  const turn = new AbortController()
  runningTurns.set(key, turn)
  const progress = startProgress(bot.api, target)
  const outcome = await runInSession(key, prompt, firstMessage, {
    settingsFile: SETTINGS_FILE,
    mcpPort: mcpServer.port,
    mcpToken,
    hookToken,
    cwd: config.cwd,
    maxTurns: config.maxTurns,
    signal: AbortSignal.any([turnAbort.signal, turn.signal]),
    onEvent: progress.onEvent,
  }).finally(() => {
    progress.finish()
    if (runningTurns.get(key) === turn) runningTurns.delete(key)
  })
  if (turn.signal.aborted && !turnAbort.signal.aborted) {
    await notify('Stopped.')
  }
  if (outcome.refused) {
    log(`turn refused (never bare): ${outcome.refused.join('; ')}`)
    await notify(`Turn refused: ${outcome.refused.join('; ')}`)
  } else if (outcome.pausedUntil) {
    pausedUntil = outcome.pausedUntil
    log(pauseMessage(pausedUntil))
    await notify(pauseMessage(pausedUntil))
  } else if (outcome.result?.is_error) {
    log(`turn ended with error result (exit ${outcome.exitCode})`)
  }
}

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  try {
    if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) rmSync(PID_FILE)
  } catch {}
  setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref()
  turnAbort.abort()
  void Promise.all([Promise.resolve(bot.stop()).catch(() => {}), turns.idle()]).finally(() => {
    mcpServer.stop()
    hookServer.stop()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// FR8: owners can interrupt the turn running in this chat or topic.
bot.command('stop', async ctx => {
  if (!ctx.from || !loadAccess().allowFrom.includes(String(ctx.from.id))) return
  const turn = runningTurns.get(sessionKey(ctx.msg!))
  if (!turn) {
    await ctx.reply('Nothing is running here.')
    return
  }
  turn.abort()
})

// The rest are DM-only, as in the channel server: no pairing-code leaks to groups.

bot.command('start', async ctx => {
  if (!dmCommandGate(ctx)) return
  await ctx.reply(
    `This bot bridges Telegram to a Claude Code session.\n\n` +
    `To pair:\n` +
    `1. DM me anything: you'll get a 6-char code\n` +
    `2. In Claude Code: /telegram:access pair <code>\n\n` +
    `After that, DMs here reach that session.`
  )
})

bot.command('help', async ctx => {
  if (!dmCommandGate(ctx)) return
  await ctx.reply(
    `Messages you send here route to a paired Claude Code session. ` +
    `Text and photos are forwarded; replies and reactions come back.\n\n` +
    `/start: pairing instructions\n` +
    `/status: check your pairing state\n` +
    `/stop: interrupt the running turn in this chat`
  )
})

bot.command('status', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  const { access, senderId } = gated
  if (access.allowFrom.includes(senderId)) {
    const name = ctx.from!.username ? `@${ctx.from!.username}` : senderId
    await ctx.reply(`Paired as ${name}.`)
    return
  }
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(`Pending pairing: run in Claude Code:\n\n/telegram:access pair ${code}`)
      return
    }
  }
  await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
})

bot.on('message:text', ctx => handleInbound(ctx, ctx.message.text, undefined))

bot.on('message:photo', ctx => handleInbound(
  ctx, ctx.message.caption ?? '(photo)', () => downloadPhoto(ctx.api, TOKEN, ctx.message.photo),
))

bot.on('message:document', ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  return handleInbound(ctx, ctx.message.caption ?? `(document: ${name ?? 'file'})`, undefined, {
    kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name,
  })
})

bot.on('message:voice', ctx => {
  const voice = ctx.message.voice
  return handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined, {
    kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type,
  })
})

bot.on('message:audio', ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  return handleInbound(ctx, ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`, undefined, {
    kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name,
  })
})

bot.on('message:video', ctx => {
  const video = ctx.message.video
  return handleInbound(ctx, ctx.message.caption ?? '(video)', undefined, {
    kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name),
  })
})

bot.on('message:video_note', ctx => {
  const vn = ctx.message.video_note
  return handleInbound(ctx, '(video note)', undefined, { kind: 'video_note', file_id: vn.file_id, size: vn.file_size })
})

bot.on('message:sticker', ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  return handleInbound(ctx, `(sticker${emoji})`, undefined, { kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size })
})

const groupBuffer = createGroupBuffer()

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5)

/**
 * The `<channel>` wrapper the system prompt describes; meta lives in attributes
 * so the body can't forge it. `recent` is unaddressed group chatter (002 FR8).
 */
function renderChannelMessage(text: string, meta: Record<string, string>, recent: BufferedMessage[] = []): string {
  const attrs = Object.entries(meta).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('')
  const context = recent.length
    ? `<recent_context>\n${recent.map(m => escapeXml(`[${hhmm(m.ts)}] ${m.user}: ${m.text}`)).join('\n')}\n</recent_context>\n`
    : ''
  return `<channel source="telegram"${attrs}>${context}${escapeXml(text)}</channel>`
}

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  const result = gate(ctx)
  if (result.action === 'drop') {
    if (result.unmentioned) {
      groupBuffer.push(sessionKey(ctx.msg!), {
        ts: ctx.msg!.date * 1000,
        user: ctx.from!.username ?? String(ctx.from!.id),
        text,
      })
    }
    return
  }
  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead}: run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return
  }

  const access = result.access
  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  const key = sessionKey(ctx.msg!)
  void bot.api.sendChatAction(chat_id, 'typing', threadOpts(parseKey(key))).catch(() => {})
  if (access.ackReaction && msgId != null) {
    void bot.api
      .setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ])
      .catch(() => {})
  }

  if (INTERRUPT_ON_NEW_MESSAGE) runningTurns.get(key)?.abort()
  const imagePath = downloadImage ? await downloadImage() : undefined
  const prompt = renderChannelMessage(text, {
    chat_id,
    ...(msgId != null ? { message_id: String(msgId) } : {}),
    user: from.username ?? String(from.id),
    user_id: String(from.id),
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachment ? {
      attachment_kind: attachment.kind,
      attachment_file_id: attachment.file_id,
      ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
      ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
      ...(attachment.name ? { attachment_name: attachment.name } : {}),
    } : {}),
  }, groupBuffer.take(key))
  turns.enqueue(key, { prompt, text, msgId })
}

// Without this, any throw in a handler stops polling permanently.
bot.catch(err => log(`handler error (polling continues): ${err.error}`))

// Poll with backoff on any error; 409 means another poller holds the token.
for (let attempt = 1; ; attempt++) {
  try {
    await bot.start({
      onStart: info => {
        attempt = 0
        setBotUsername(info.username)
        log(`polling as @${info.username}`)
        void bot.api.setMyCommands(
          [
            { command: 'start', description: 'Welcome and setup guide' },
            { command: 'help', description: 'What this bot can do' },
            { command: 'status', description: 'Check your pairing status' },
            { command: 'stop', description: 'Interrupt the running turn in this chat' },
          ],
          { scope: { type: 'all_private_chats' } },
        ).catch(() => {})
      },
    })
    break
  } catch (err) {
    if (shuttingDown) break
    if (err instanceof Error && err.message === 'Aborted delay') break
    const is409 = err instanceof GrammyError && err.error_code === 409
    if (is409 && attempt >= 8) {
      log(`409 Conflict persists after ${attempt} attempts; another poller holds the token. Exiting.`)
      shutdown()
      break
    }
    const delay = Math.min(1000 * attempt, 15000)
    log(`${is409 ? '409 Conflict' : `polling error: ${err}`}, retrying in ${delay / 1000}s`)
    await new Promise(r => setTimeout(r, delay))
  }
}
