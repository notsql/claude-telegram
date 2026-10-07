#!/usr/bin/env bun
/**
 * Headless daemon entry (FR1). Owns the grammY poller, the MCP and hook
 * endpoints, and runs each gated inbound message as a `claude -p` turn.
 * Access, pairing, approvals and attachments behave as in the legacy
 * `server.ts` channel (FR6), which stays runnable (FR13).
 */

import { Bot, GrammyError, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { autoRetry } from '@grammyjs/auto-retry'
import { apiThrottler } from '@grammyjs/transformer-throttler'
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'fs'
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { join } from 'path'
import {
  STATE_DIR, initAccess, setBotUsername, loadAccess,
  gate, groupVerdict, dmCommandGate, checkApprovals, saveAccess,
} from './access.ts'
import { createApprovals, parseTextReply } from './policy/approvals.ts'
import { addAlwaysAllow, canStartTurn, chatTypeOf, policyKey, resolvePolicy } from './policy/resolve.ts'
import { scopeDecision } from './policy/scope.ts'
import { createAudit } from './policy/audit.ts'
import { applyPolicyEdit, policyKeyboard, renderPolicy } from './telegram/policyUi.ts'
import { expandPath, isTrustedCwd, policyArgs } from './policy/args.ts'
import { homedir } from 'os'
import { type AttachmentMeta, INBOX_DIR, safeName, downloadPhoto } from './telegram/attachments.ts'
import { startMcpServer } from './mcp/server.ts'
import { startHookServer } from './hooks/endpoint.ts'
import { writeHookSettings } from './hooks/settings.ts'
import { isMissingSession, runTurn, type RunTurnOpts, type TurnOutcome } from './agent/runner.ts'
import { parseKey, sessionKey } from './sessions/key.ts'
import { threadOpts } from './telegram/send.ts'
import { createSessionStore } from './sessions/store.ts'
import { createSessionLifecycle, formatCost, formatSessions, MODELS } from './sessions/lifecycle.ts'
import { createSessionTools, sessionStatus } from './agent/sessionTools.ts'
import { createTurnQueue } from './sessions/queue.ts'
import { createGroupBuffer } from './sessions/groupBuffer.ts'
import { renderInbound, renderSkillInvocation } from './agent/inbound.ts'
import { createTopicNames } from './sessions/topics.ts'
import { startProgress } from './agent/progress.ts'
import { apiKeyRefusal, isLoggedIn } from './agent/auth.ts'
import { loadConfig, cliVersionRefusal, createTurnBudget } from './config.ts'
import { claudeDir, memoryRoot, userDir } from './memory/paths.ts'
import { openHistoryDb } from './history/db.ts'
import { startIndexer } from './history/indexer.ts'
import { createHistoryTools } from './history/tools.ts'
import { recall, withContext } from './history/recall.ts'
import { searchCommand } from './history/commands.ts'
import { createMemoryStore } from './memory/store.ts'
import { createMemoryTools } from './memory/tools.ts'
import { forget, remember, showMemory, type CommandResult } from './memory/commands.ts'
import { createInjector } from './memory/inject.ts'
import { bridgePaths, importEnabled } from './memory/bridge.ts'
import { createNotices, noticeText } from './memory/notices.ts'
import { createReflectionWorker } from './reflection/worker.ts'
import { createApplier } from './reflection/apply.ts'
import { ProposalsSchema } from './reflection/prompt.ts'
import { runOneShot } from './agent/oneshot.ts'
import { createSkillStore, skillEvents, type SkillStore } from './skills/store.ts'
import { skillsRoot, takenNames } from './skills/paths.ts'
import { createSkillApplier } from './skills/apply.ts'
import { createSkillTools } from './skills/tools.ts'
import { listSkills, parseSkillsArgs, skillAction, type SkillAction } from './skills/commands.ts'
import { createSkillUsage, invokedSkill } from './skills/usage.ts'
import { pruneDue, staleSkills, STALE_DAYS } from './skills/prune.ts'
import { createSkillNotices, skillNoticeText } from './skills/notices.ts'
import { RefinementSchema, refinementInput, skillsContext, type Proposals } from './reflection/prompt.ts'
import { toolCalls } from './reflection/transcript.ts'
import { search } from './history/search.ts'
import { registry, type Command } from './commands/registry.ts'
import { authorised, route } from './commands/dispatch.ts'
import { assign, discoverSkills, loadTable, saveTable } from './commands/skillMap.ts'
import { START_TEXT, helpText, pairingStatus } from './commands/help.ts'
import { buildMenus, createMenu, type MenuSkill } from './commands/menu.ts'
import { scopeFor } from './history/tools.ts'
import { createEngine } from './scheduler/engine.ts'
import { failureNotice, runJob } from './scheduler/run.ts'
import { createScheduleTools } from './scheduler/tools.ts'
import { loadJobs, saveJobs, type Job } from './scheduler/store.ts'
import type { Policy } from './policy/schema.ts'
import type { StreamEvent } from './agent/stream.ts'

const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'daemon.pid')
const SETTINGS_FILE = join(STATE_DIR, 'hook-settings.json')
const COMMANDS_FILE = join(STATE_DIR, 'commands.json')
// 003 FR4 makes this configurable.
const APPROVAL_TIMEOUT_SEC = 60
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
// 002 plan risk: Telegram allows ~30 msgs/s overall and ~20/min per group. The
// throttler keeps sends under those limits; a 429 that still happens is retried.
bot.api.config.use(apiThrottler())
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }))
if (!STATIC) setInterval(() => checkApprovals(bot.api), 5000).unref()

// FR10: a missing login is reported, not fatal; the owner can log in without a restart.
if (!isLoggedIn()) {
  const msg = 'claude is not logged in. Run `claude auth login` on the daemon host.'
  log(msg)
  for (const owner of loadAccess().allowFrom) void bot.api.sendMessage(owner, msg).catch(() => {})
}

const mcpToken = randomBytes(32).toString('hex')
const hookToken = randomBytes(32).toString('hex')
// 004: one shared memory, the workspace project's auto-memory dir (FR2).
const memory = createMemoryStore(memoryRoot(config.cwd))
const userStore = (id: string) => createMemoryStore(userDir(memory.dir, id))
const notices = createNotices(bot.api)
const memoryTools = createMemoryTools(memory, userStore, (key, change) => void notices.notify(key, change))
const injector = createInjector({ store: memory, userStore, indexImported: () => importEnabled(bridgePaths(memory.dir)) })
// 005: index Claude Code transcripts for history search (FR1, FR3).
const historyDb = openHistoryDb(join(STATE_DIR, 'history.db'))
const stopIndexer = startIndexer(historyDb, join(claudeDir(), 'projects'), log)
const sessions = createSessionStore(join(STATE_DIR, 'sessions.json'))
const historyTools = createHistoryTools({ db: historyDb, sessions })
const policyOf = (key: string) => resolvePolicy(loadAccess(), key, chatTypeOf(key))

// 004 FR3: whose user model to inject: the latest sender first, then others active recently.
const ACTIVE_MS = 2 * 60 * 60 * 1000
const seenUsers = new Map<string, Map<string, number>>()
function sawUser(key: string, userId: string): void {
  const m = seenUsers.get(key) ?? new Map<string, number>()
  m.delete(userId)
  m.set(userId, Date.now())
  seenUsers.set(key, m)
}
const participants = (key: string) =>
  [...seenUsers.get(key) ?? []].filter(([, t]) => Date.now() - t < ACTIVE_MS).map(([id]) => id).reverse()

// 006: learned skills, one store per root (user, or a chat's project cwd).
const skillStores = new Map<string, SkillStore>()
const skillStoreFor = (key: string) => {
  const root = skillsRoot(policyOf(key))
  let st = skillStores.get(root)
  if (!st) skillStores.set(root, st = createSkillStore(root))
  return st
}
const skillNotices = createSkillNotices(bot.api)
const skillApplier = createSkillApplier({
  store: skillStoreFor,
  taken: st => takenNames(st.root, [config.cwd]),
  policy: policyOf,
  sessionOf: key => sessions.current(key),
  notify: (key, change) => void skillNotices.notify(key, change),
  ask: (key, text, id, kind) => {
    const target = parseKey(key)
    const buttons = kind === 'diff'
      ? [{ text: '✅ Apply', callback_data: `skl:save:${id}` }, { text: '✖ Skip', callback_data: `skl:skip:${id}` }]
      : [{ text: '✅ Save', callback_data: `skl:save:${id}` }, { text: '✏️ Edit', callback_data: `skl:edit:${id}` }, { text: '✖ Skip', callback_data: `skl:skip:${id}` }]
    void bot.api.sendMessage(target.chatId, text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text, {
      ...threadOpts(target),
      reply_markup: { inline_keyboard: [buttons] },
    }).catch(() => {})
  },
  log,
})

const skillTools = createSkillTools(skillStoreFor, skillApplier)
const skillUsage = createSkillUsage(join(STATE_DIR, 'skills-usage.json'))
const isLearnedSkill = (key: string, name: string) => skillStoreFor(key).read(name)?.metadata.source === 'tg'

/** 006 FR7, FR8: record outcomes; a skill that keeps failing gets a refinement proposal for approval (AC6). */
async function skillOutcomes(key: string, outcomes: Proposals['skill_outcomes'], delta: string): Promise<void> {
  for (const { name, outcome } of outcomes) {
    if (!isLearnedSkill(key, name) || !skillUsage.outcome(name, outcome)) continue
    log(`skills: refining ${name} after repeated failures`)
    const p = await runOneShot(undefined, refinementInput(skillStoreFor(key).text(name)!, delta), RefinementSchema)
    skillApplier.one(key, { ...p, op: 'patch', name, confidence: 1 }, true)
  }
}

// 006 FR8: weekly archive proposals to the owners, for the skills their DMs learn into.
const MAX_PRUNE_PROPOSALS = 5
const archiveAsks = new Map<string, { key: string; name: string }>()
function proposeArchives(): void {
  if (!pruneDue(join(STATE_DIR, 'skills-prune.json'))) return
  for (const owner of loadAccess().allowFrom) {
    for (const name of staleSkills(skillStoreFor(owner), skillUsage).slice(0, MAX_PRUNE_PROPOSALS)) {
      const id = randomBytes(6).toString('hex')
      archiveAsks.set(id, { key: owner, name })
      void bot.api.sendMessage(owner, `📦 Skill ${name} hasn't been used in ${STALE_DAYS} days. Archive it?`, {
        reply_markup: { inline_keyboard: [[
          { text: '📦 Archive', callback_data: `skl:arch:${id}` },
          { text: 'Keep', callback_data: `skl:keep:${id}` },
        ]] },
      }).catch(() => {})
    }
  }
}
setInterval(proposeArchives, 24 * 60 * 60 * 1000).unref()

/** 006 FR2: earlier user requests like this turn's first one, as hints that the task repeats. */
function similarRequests(key: string, delta: string, sessionId: unknown): string[] {
  const first = /^USER: ([\s\S]*?)(?:\n\n(?:USER|AGENT): |$)/.exec(delta)?.[1]?.replace(/<[^>]*>/g, ' ').trim()
  const scope = first && scopeFor(policyOf(key), key, sessions)
  if (!scope) return []
  return search(historyDb, first!, { scope, limit: 10, ...(typeof sessionId === 'string' && { excludeSessionId: sessionId }) })
    .filter(h => h.role === 'user').slice(0, 3).map(h => h.snippet.replace(/\s+/g, ' '))
}

// 004 FR6: learn from each finished turn.
const applier = createApplier({
  store: memory,
  userStore,
  policy: policyOf,
  notify: (key, change) => void notices.notify(key, change),
  ask: (key, text, id) => {
    const target = parseKey(key)
    void bot.api.sendMessage(target.chatId, text, {
      ...threadOpts(target),
      reply_markup: { inline_keyboard: [[
        { text: '✅ Save', callback_data: `mem:save:${id}` },
        { text: '✖ Skip', callback_data: `mem:skip:${id}` },
      ]] },
    }).catch(() => {})
  },
  log,
})
const reflection = createReflectionWorker({
  reflect: input => runOneShot(undefined, input, ProposalsSchema),
  existing: key => {
    const p = policyOf(key)
    if (p.memoryScope === 'none' || !p.autoLearn || p.autoLearn === 'off') return null
    const lines = memory.list().map(e => `${e.name} (${e.type}): ${e.description}`)
    for (const id of participants(key)) {
      for (const e of userStore(id).list()) lines.push(`user_model user_id=${id} ${e.name}: ${e.description}`)
    }
    return lines.join('\n')
  },
  skills: (key, delta, payload) => {
    const p = policyOf(key)
    if (!p.autoLearn || p.autoLearn === 'off') return null
    const learned = skillStoreFor(key).list().filter(s => s.metadata.source === 'tg')
    return skillsContext(learned, toolCalls(delta), similarRequests(key, delta, payload.session_id))
  },
  apply: async (key, proposals, delta) => {
    applier.apply(key, proposals)
    skillApplier.apply(key, proposals)
    await skillOutcomes(key, proposals.skill_outcomes, delta)
  },
  log,
})

// FR8: each key's running turn, so /stop or a new message (with the flag) can interrupt it.
const runningTurns = new Map<string, AbortController>()
const INTERRUPT_ON_NEW_MESSAGE = process.env.TELEGRAM_INTERRUPT_ON_NEW_MESSAGE === '1'
const lifecycle = createSessionLifecycle(sessions, key => runningTurns.get(key)?.abort())
// 008 FR9: the agent's parity path for /new, /resume, /model and /status.
const sessionDeps = { lifecycle, title: (key: string) => sessions.title(key), running: (key: string) => runningTurns.has(key) }
const sessionTools = createSessionTools(sessionDeps)
// 007 FR6: the scheduler is created further down, once the turn queue exists.
const scheduleTools = createScheduleTools({ stateDir: STATE_DIR, reload: () => scheduler.reload(), runNow: id => queueJob(id) })
const mcpServer = startMcpServer({ authToken: mcpToken, api: bot.api, botToken: TOKEN, memory: memoryTools, history: historyTools, skills: skillTools, session: sessionTools, scheduler: scheduleTools })
const audit = createAudit(join(STATE_DIR, 'audit.log'))
const approvals = createApprovals({
  api: bot.api,
  audit,
  timeoutSec: APPROVAL_TIMEOUT_SEC,
  saveRule: (key, rule) => {
    const access = loadAccess()
    addAlwaysAllow(access, policyKey(key), rule)
    saveAccess(access)
  },
})
// 008 FR5: a skill command's <channel> wrapper, handed to its turn as hook context.
const skillContext = new Map<string, string>()
const hookServer = startHookServer({ authToken: hookToken, log, handlers: {
  'permission-request': approvals.handle,
  'session-start': (payload, key) => injector.sessionStart(payload, policyOf(key), participants(key)),
  'user-prompt-submit': (payload, key) => {
    memoryTools.startTurn(key)
    skillTools.startTurn(key)
    const policy = policyOf(key)
    const out = injector.userPromptSubmit(payload, policy, participants(key))
    const t = performance.now()
    const recalled = recall({ db: historyDb, sessions }, payload, key, policy)
    if (recalled) log(`history: recalled for ${key} in ${Math.round(performance.now() - t)}ms`)
    const skill = skillContext.get(key) ?? ''
    skillContext.delete(key)
    return withContext(withContext(out, 'UserPromptSubmit', recalled), 'UserPromptSubmit', skill)
  },
  'stop': (payload, key) => { reflection.enqueue(key, payload) },
  'post-tool-use': (payload, key) => {
    const name = invokedSkill(payload)
    if (name && isLearnedSkill(key, name)) skillUsage.invoked(name)
  },
  'pre-compact': (payload, key) => { void reflection.enqueue(key, payload, true) },
  'pre-tool-use': (payload, key) => scopeDecision(payload, key, { policy: policyOf, trustedDirs: () => loadAccess().trustedDirs ?? [], extraDirs: [INBOX_DIR], confirm: approvals.confirm }),
} })
writeHookSettings(SETTINGS_FILE, { port: hookServer.port, approvalTimeoutSec: APPROVAL_TIMEOUT_SEC })


/**
 * Runs a turn in the key's session and stores the `session_id` from `init`,
 * since resume can return a new one (002 FR3). A session whose transcript is
 * gone is archived and the turn retried fresh, so the chat never gets stuck.
 */
async function runInSession(key: string, prompt: string, firstMessage: string, opts: RunTurnOpts): Promise<TurnOutcome> {
  let since = sessions.generation(key)
  let outcome = await runTurn(key, prompt, { ...opts, resume: sessions.current(key) })
  if (isMissingSession(outcome)) {
    log(`session for ${key} is gone, starting fresh`)
    sessions.new(key)
    since = sessions.generation(key)
    outcome = await runTurn(key, prompt, opts)
  }
  if (outcome.init) sessions.record(key, outcome.init.session_id, firstMessage, since)
  return outcome
}

const turnAbort = new AbortController()
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
  // 007 FR9: scheduled runs share the slots, keyed `job:<id>` so one job never overlaps itself.
  run: (key, batch) => (key.startsWith(JOB_PREFIX) ? fireJob(key.slice(JOB_PREFIX.length)) : runBatch(key, batch))
    .catch(err => log(`turn failed: ${err}`)),
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
  const access = loadAccess()
  const policy = resolvePolicy(access, key, chatTypeOf(key))
  // FR13: never run a turn in a cwd the owner hasn't trusted.
  if (policy.cwd && !isTrustedCwd(policy.cwd, access.trustedDirs)) {
    await notify(`Turn refused: cwd ${policy.cwd} is not in trustedDirs. Add it with /telegram:access.`)
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
    cwd: policy.cwd ? expandPath(policy.cwd, homedir()) : config.cwd,
    maxTurns: policy.maxTurns ?? config.maxTurns,
    policyArgs: policyArgs({ ...policy, model: lifecycle.model(key) ?? policy.model }),
    signal: AbortSignal.any([turnAbort.signal, turn.signal]),
    onEvent: progress.onEvent,
  }).finally(() => {
    progress.finish()
    if (runningTurns.get(key) === turn) runningTurns.delete(key)
  })
  const reported = outcome.init?.skills?.filter(n => !loadedSkills.has(n)) ?? []
  if (reported.length) {
    for (const n of reported) loadedSkills.add(n)
    menu.refresh()
  }
  if (outcome.result) lifecycle.recordTurn(outcome.result.session_id, outcome.result.total_cost_usd)
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

// 007: scheduled jobs. A run goes through the turn queue like a message.
const JOB_PREFIX = 'job:'
const notifyKey = (key: string, text: string) => {
  const target = parseKey(key)
  return bot.api.sendMessage(target.chatId, text, threadOpts(target)).catch(() => {})
}

/** FR4: fresh by default; `mode: session` resumes the chat's session. */
async function jobTurn(job: Job, prompt: string, policy: Policy, onEvent: (ev: StreamEvent) => void): Promise<TurnOutcome> {
  const access = loadAccess()
  if (policy.cwd && !isTrustedCwd(policy.cwd, access.trustedDirs)) return { refused: [`cwd ${policy.cwd} is not in trustedDirs`], exitCode: 1 }
  // FR11: jobs count toward the daily budget.
  if (!budget.take()) return { refused: [`daily turn budget (${config.dailyTurnBudget}) used up`], exitCode: 1 }
  const opts: RunTurnOpts = {
    settingsFile: SETTINGS_FILE,
    mcpPort: mcpServer.port,
    mcpToken,
    hookToken,
    cwd: policy.cwd ? expandPath(policy.cwd, homedir()) : config.cwd,
    maxTurns: policy.maxTurns ?? config.maxTurns,
    policyArgs: policyArgs(policy),
    signal: turnAbort.signal,
    onEvent,
  }
  return job.mode === 'session' ? runInSession(job.sessionKey, prompt, `⏰ ${job.title ?? job.prompt}`, opts) : runTurn(job.sessionKey, prompt, opts)
}

async function fireJob(id: string): Promise<void> {
  if (turnAbort.signal.aborted) return
  let deferUntil = 0
  const status = await runJob(id, {
    stateDir: STATE_DIR,
    policy: policyOf,
    turn: async (job, prompt, policy, onEvent) => {
      const outcome = await jobTurn(job, prompt, policy, onEvent)
      if (outcome.pausedUntil) pausedUntil = deferUntil = outcome.pausedUntil
      return outcome
    },
    post: notifyKey,
    // FR8: the owner hears about each failure, with Retry and Disable.
    onFailure: (job, reason) => {
      const { text, keyboard } = failureNotice(job, reason)
      return Promise.all(loadAccess().allowFrom.map(owner => bot.api.sendMessage(owner, text, { reply_markup: keyboard }).catch(() => {})))
    },
  })
  if (status) log(`job ${id}: ${status}`)
  // FR11: a run stopped by the usage limit runs again after the reset.
  if (deferUntil) setTimeout(() => queueJob(id), deferUntil - Date.now()).unref()
  scheduler.reload()
}

bot.callbackQuery(/^sch:(retry|off):(j_[0-9a-f]+)$/, async ctx => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const [, action, id] = ctx.match as unknown as [string, 'retry' | 'off', string]
  const jobs = loadJobs(STATE_DIR)
  const job = jobs.find(j => j.id === id)
  if (!job) return ctx.answerCallbackQuery({ text: 'Job is gone.' }).catch(() => {})
  // Retry re-enables an auto-disabled job with a clean failure count.
  if (action === 'retry') Object.assign(job, { enabled: true, failures: 0 })
  else job.enabled = false
  saveJobs(STATE_DIR, jobs)
  scheduler.reload()
  if (action === 'retry') queueJob(id)
  const label = action === 'retry' ? '🔁 Retrying' : '⏸ Disabled'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
})

const queueJob = (id: string) => turns.enqueue(JOB_PREFIX + id, { prompt: '', text: '' })
const scheduler = createEngine({ stateDir: STATE_DIR, fire: queueJob })
try {
  const { due, missed } = scheduler.boot()
  if (due.length) log(`scheduler: catching up ${due.join(', ')}`)
  if (missed.length) log(`scheduler: skipped runs missed beyond the catch-up window: ${missed.join(', ')}`)
} catch (err) {
  log(`scheduler: could not load jobs.json: ${err}`)
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
  scheduler.stop()
  stopIndexer()
  void Promise.all([Promise.resolve(bot.stop()).catch(() => {}), turns.idle()]).finally(() => {
    mcpServer.stop()
    hookServer.stop()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

const isOwner = (ctx: Context) => !!ctx.from && loadAccess().allowFrom.includes(String(ctx.from.id))

// 008 T803: built-ins, routed by dispatch() ahead of the agent.
const commands: Command[] = []

// FR8: owners can interrupt the turn running in this chat or topic.
commands.push({ name: 'stop', description: 'Interrupt the running turn here', menu: ['private', 'group'], handler: async ctx => {
  if (!isOwner(ctx)) return
  const turn = runningTurns.get(sessionKey(ctx.msg!))
  if (!turn) {
    await ctx.reply('Nothing is running here.')
    return
  }
  turn.abort()
} })

// 002 FR9, owner-only like /stop. 008 moves these into its command handlers.
commands.push({ name: 'new', description: 'Start a fresh session', menu: ['private', 'group'], handler: async ctx => {
  if (!isOwner(ctx)) return
  lifecycle.new(sessionKey(ctx.msg!))
  await ctx.reply('New session. The next message starts with no earlier context.')
} })

// 005 US4: owner-only like /stop, scoped by the chat's historyScope. 008 moves it into its handlers.
commands.push({ name: 'search', description: 'Search past conversations: /search <words>', menu: ['private', 'group'], handler: async (ctx, args) => {
  if (!isOwner(ctx)) return
  const key = sessionKey(ctx.msg!)
  await ctx.reply(searchCommand({ db: historyDb, sessions }, args, key, policyOf(key)), { link_preview_options: { is_disabled: true } })
} })

// 008 T805: memory curation over 004's command functions; writes get the Undo notice.
const memoryReply = async (ctx: Context, r: CommandResult) =>
  ctx.reply(r.text, r.change ? { reply_markup: notices.undoKeyboard(r.change) } : {})

commands.push({ name: 'remember', description: 'Remember something: /remember <text>', menu: ['private', 'group'], handler: async (ctx, args) => {
  if (!isOwner(ctx)) return
  const key = sessionKey(ctx.msg!)
  await memoryReply(ctx, remember(memory, args, key, policyOf(key)))
} })

commands.push({ name: 'forget', description: 'Forget a memory: /forget <name or words>', menu: ['private', 'group'], requiresApprover: true, handler: async (ctx, args) => {
  if (!isOwner(ctx)) return
  await memoryReply(ctx, forget(memory, args, policyOf(sessionKey(ctx.msg!))))
} })

commands.push({ name: 'memory', description: 'Show what I remember', menu: ['private', 'group'], handler: async ctx => {
  if (!isOwner(ctx)) return
  await memoryReply(ctx, showMemory(memory, userStore(String(ctx.from!.id)), policyOf(sessionKey(ctx.msg!))))
} })

// 008 T806: the chat's skills; archive and remove need an approver (FR10).
const canChange = (ctx: Context, key: string, isGroup: boolean) =>
  authorised({ requiresApprover: true }, isGroup, isApprover(key, ctx.from!.id), isOwner(ctx))

commands.push({ name: 'skills', description: 'List skills: /skills [show|rm] <name>', menu: ['private', 'group'], handler: async (ctx, args) => {
  if (!isOwner(ctx)) return
  const key = sessionKey(ctx.msg!)
  const parsed = parseSkillsArgs(args)
  if (!parsed) return void await ctx.reply('Usage: /skills, /skills show <name>, /skills rm <name>')
  if (parsed === 'list') {
    const r = listSkills(skillStoreFor(key))
    return void await ctx.reply(r.text, r.keyboard ? { reply_markup: r.keyboard } : {})
  }
  if (parsed.action !== 'show' && !canChange(ctx, key, ctx.chat!.type !== 'private')) return void await ctx.reply('Only approvers can remove skills here.')
  await ctx.reply(skillAction(skillStoreFor(key), parsed.action, parsed.name).text)
} })

bot.callbackQuery(/^skc:(show|arch|rm):([a-z0-9-]{1,48})$/, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!msg || !isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const key = sessionKey(msg as Parameters<typeof sessionKey>[0])
  const action = ctx.match[1] as SkillAction
  if (action !== 'show' && !canChange(ctx, key, msg.chat.type !== 'private')) return ctx.answerCallbackQuery({ text: 'Not authorised.' }).catch(() => {})
  const r = skillAction(skillStoreFor(key), action, ctx.match[2]!)
  await ctx.answerCallbackQuery(r.changes ? { text: r.text } : {}).catch(() => {})
  if (r.changes) {
    const list = listSkills(skillStoreFor(key))
    await ctx.editMessageText(list.text, list.keyboard ? { reply_markup: list.keyboard } : {}).catch(() => {})
  } else {
    await bot.api.sendMessage(msg.chat.id, r.text, threadOpts(parseKey(key))).catch(() => {})
  }
})

commands.push({ name: 'sessions', description: 'List past sessions', menu: ['private', 'group'], handler: async ctx => {
  if (!isOwner(ctx)) return
  await ctx.reply(formatSessions(lifecycle.list(sessionKey(ctx.msg!))))
} })

commands.push({ name: 'resume', description: 'Resume a past session: /resume <n>', menu: ['private', 'group'], handler: async (ctx, args) => {
  if (!isOwner(ctx)) return
  const key = sessionKey(ctx.msg!)
  const arg = args.trim()
  if (!arg) {
    await ctx.reply(`${formatSessions(lifecycle.list(key))}\n\nSend /resume <n> to switch.`)
    return
  }
  try {
    const picked = lifecycle.resume(key, Number(arg))
    await ctx.reply(`Resumed: ${picked.title || '(untitled)'}`)
  } catch (err) {
    await ctx.reply((err as Error).message)
  }
} })

// 008 FR1, US4: bare /model opens a picker; the choice lasts for this session.
const modelKeyboard = () => ({ inline_keyboard: [[...MODELS, 'default'].map(m => ({ text: m, callback_data: `mdl:${m}` }))] })

commands.push({ name: 'model', description: 'Pick the model for this session', menu: ['private', 'group'], requiresApprover: true, handler: async (ctx, args) => {
  const key = sessionKey(ctx.msg!)
  if (!args) {
    await ctx.reply(`Model: ${lifecycle.model(key) ?? policyOf(key).model ?? 'default'}. Pick one for this session:`, { reply_markup: modelKeyboard() })
    return
  }
  try {
    lifecycle.setModel(key, args.toLowerCase())
    await ctx.reply(`Model for this session: ${args.toLowerCase()}.`)
  } catch (err) {
    await ctx.reply((err as Error).message)
  }
} })

bot.callbackQuery(/^mdl:(\w+)$/, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!msg) return ctx.answerCallbackQuery().catch(() => {})
  const key = sessionKey(msg as Parameters<typeof sessionKey>[0])
  if (!authorised({ requiresApprover: true }, msg.chat.type !== 'private', isApprover(key, ctx.from.id), isOwner(ctx))) {
    return ctx.answerCallbackQuery({ text: 'Not authorised.' }).catch(() => {})
  }
  lifecycle.setModel(key, ctx.match[1]!)
  await ctx.editMessageText(`Model for this session: ${ctx.match[1]}.`).catch(() => {})
  await ctx.answerCallbackQuery().catch(() => {})
})

// Claude Code compacts on its own; this forces it in the key's session.
commands.push({ name: 'compact', description: "Compact this session's context", menu: ['private', 'group'], handler: async ctx => {
  if (!isOwner(ctx)) return
  const key = sessionKey(ctx.msg!)
  if (!sessions.current(key)) {
    await ctx.reply('No session to compact yet.')
    return
  }
  turns.enqueue(key, { prompt: '/compact', text: '/compact' })
  await ctx.reply('Compacting this session.')
} })

commands.push({ name: 'cost', description: 'What this session has cost', menu: ['private', 'group'], handler: async ctx => {
  if (!isOwner(ctx)) return
  await ctx.reply(formatCost(lifecycle.stats(sessionKey(ctx.msg!))))
} })

// The rest are DM-only, as in the channel server: no pairing-code leaks to groups.

commands.push({ name: 'start', description: 'Welcome and setup guide', menu: ['private'], handler: async ctx => {
  if (dmCommandGate(ctx)) await ctx.reply(START_TEXT)
} })

commands.push({ name: 'help', description: 'What this bot can do', menu: ['private'], handler: async ctx => {
  if (dmCommandGate(ctx)) await ctx.reply(helpText(commands))
} })

commands.push({ name: 'status', description: 'Session, model and cost', menu: ['private', 'group'], handler: async ctx => {
  const key = sessionKey(ctx.msg!)
  // 008 FR1: in groups, owners get this chat's session status.
  if (ctx.chat!.type !== 'private') {
    if (isOwner(ctx)) await ctx.reply(sessionStatus(sessionDeps, key, policyOf(key)))
    return
  }
  const gated = dmCommandGate(ctx)
  if (!gated) return
  const name = ctx.from!.username ? `@${ctx.from!.username}` : gated.senderId
  await ctx.reply(pairingStatus(gated.access, gated.senderId, name, () => sessionStatus(sessionDeps, key, policyOf(key))))
} })

// 003 T309: owner-only policy editor for this chat or topic.
const showPolicy = (key: string) => {
  const p = resolvePolicy(loadAccess(), key, chatTypeOf(key))
  return [renderPolicy(key, p), { reply_markup: policyKeyboard(p) }] as const
}

commands.push({ name: 'policy', description: "View or edit this chat's policy", menu: ['private', 'group'], requiresApprover: true, handler: async ctx => {
  if (!isOwner(ctx)) return
  const [text, opts] = showPolicy(policyKey(sessionKey(ctx.msg!)))
  await ctx.reply(text, opts)
} })

bot.callbackQuery(/^pol:(\w+):(\w+)$/, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!isOwner(ctx) || !msg) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const key = policyKey(sessionKey(msg as Parameters<typeof sessionKey>[0]))
  const [, field, value] = ctx.match
  const access = loadAccess()
  try {
    const stored = applyPolicyEdit(access, key, field!, value!)
    saveAccess(access)
    audit({ event: 'policy', key, user: String(ctx.from.id), field: field!, value: stored ?? 'default' })
    menu.refresh()
  } catch (err) {
    return ctx.answerCallbackQuery({ text: (err as Error).message }).catch(() => {})
  }
  const [text, opts] = showPolicy(key)
  await ctx.editMessageText(text, opts).catch(() => {})
  await ctx.answerCallbackQuery({ text: `${field} → ${value}` }).catch(() => {})
})

// 004 FR9: Undo on a memory notice.
bot.callbackQuery(/^mem:undo:([0-9a-f]+)$/, async ctx => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const label = notices.undo(ctx.match[1]!)
  if (!label) return ctx.answerCallbackQuery({ text: 'Nothing to undo.' }).catch(() => {})
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
})

// 004 FR6: Save or Skip a proposed memory (autoLearn: propose).
bot.callbackQuery(/^mem:(save|skip):([0-9a-f]+)$/, async ctx => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const r = applier.decide(ctx.match[2]!, ctx.match[1] === 'save')
  if (!r) return ctx.answerCallbackQuery({ text: 'Already decided.' }).catch(() => {})
  await ctx.answerCallbackQuery({ text: r.error ?? (r.change ? 'Saved' : 'Skipped') }).catch(() => {})
  if (r.change) await ctx.editMessageText(noticeText(r.change), { reply_markup: notices.undoKeyboard(r.change) }).catch(() => {})
  else if (!r.error) await ctx.deleteMessage().catch(() => {})
})

const isApprover = (key: string, userId: number) =>
  (resolvePolicy(loadAccess(), key, chatTypeOf(key)).approvers ?? []).includes(String(userId))

// 006 FR6: Save / Edit / Skip on a proposed skill, or Apply / Skip on a diff. The key's approvers decide (AC5).
const skillEdits = new Map<string, string>()
bot.callbackQuery(/^skl:(save|skip|edit):([0-9a-f]+)$/, async ctx => {
  const [, action, id] = ctx.match as unknown as [string, 'save' | 'skip' | 'edit', string]
  const p = skillApplier.pending(id!)
  if (!p) return ctx.answerCallbackQuery({ text: 'Already decided.' }).catch(() => {})
  if (!isApprover(p.key, ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Not authorised to approve.' }).catch(() => {})
  if (action === 'edit') {
    const target = parseKey(p.key)
    const sent = await bot.api.sendMessage(target.chatId, p.draft, { ...threadOpts(target), reply_markup: { force_reply: true, input_field_placeholder: 'Reply with the edited skill' } }).catch(() => undefined)
    if (sent) skillEdits.set(`${target.chatId}:${sent.message_id}`, id!)
    return ctx.answerCallbackQuery({ text: 'Reply to the draft with your edited version.' }).catch(() => {})
  }
  const r = skillApplier.decide(id!, action === 'save')!
  await ctx.answerCallbackQuery({ text: r.error ?? (r.change ? 'Saved' : 'Skipped') }).catch(() => {})
  if (r.change) await ctx.editMessageText(skillNoticeText(r.change), { reply_markup: skillNotices.keyboard(p.key, r.change) }).catch(() => {})
  else if (!r.error) await ctx.deleteMessage().catch(() => {})
})

/** ✏️ Edit: an approver's reply to the draft saves the edited skill. True if it was one. */
async function skillEditReply(ctx: Context, text: string): Promise<boolean> {
  const replyTo = ctx.message?.reply_to_message?.message_id
  const editKey = replyTo != null && `${ctx.chat!.id}:${replyTo}`
  const id = editKey && skillEdits.get(editKey)
  const p = id && skillApplier.pending(id)
  if (!id || !p || !isApprover(p.key, ctx.from!.id)) return false
  const r = skillApplier.edit(id, text)!
  if (r.error) {
    await ctx.reply(`Not saved: ${r.error}`).catch(() => {})
    return true
  }
  skillEdits.delete(editKey as string)
  if (r.change) void skillNotices.notify(p.key, r.change)
  return true
}

// 006 FR8: Archive or Keep a stale skill.
bot.callbackQuery(/^skl:(arch|keep):([0-9a-f]+)$/, async ctx => {
  const a = archiveAsks.get(ctx.match[2]!)
  if (!a) return ctx.answerCallbackQuery({ text: 'Already decided.' }).catch(() => {})
  if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  archiveAsks.delete(ctx.match[2]!)
  let label = `Kept ${a.name}`
  if (ctx.match[1] === 'arch') {
    try { skillStoreFor(a.key).archive(a.name); label = `📦 Archived ${a.name}` } catch (err) { label = (err as Error).message }
  }
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  await ctx.editMessageText(label).catch(() => {})
})

// 006 FR10: Show and Undo on a skill notice.
bot.callbackQuery(/^skl:(show|undo):([0-9a-f]+)$/, async ctx => {
  const [, action, id] = ctx.match as unknown as [string, 'show' | 'undo', string]
  const key = skillNotices.keyOf(id!)
  if (!key || !isApprover(key, ctx.from.id)) return ctx.answerCallbackQuery({ text: key ? 'Not authorised.' : 'Gone.' }).catch(() => {})
  if (action === 'show') {
    await ctx.answerCallbackQuery().catch(() => {})
    const target = parseKey(key)
    await bot.api.sendMessage(target.chatId, skillNotices.show(id!)!, threadOpts(target)).catch(() => {})
    return
  }
  const label = skillNotices.undo(id!)
  if (!label) return ctx.answerCallbackQuery({ text: 'Nothing to undo.' }).catch(() => {})
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
})

// Approval buttons: `perm:<allow|deny|always|more>:<id>` (003 FR2). Only the
// key's approvers may answer (FR3); the first tap wins.
bot.on('callback_query:data', async ctx => {
  const m = /^perm:(allow|deny|always|more):([a-km-z]{5})$/.exec(ctx.callbackQuery.data)
  if (!m) return ctx.answerCallbackQuery().catch(() => {})
  const [, action, id] = m as unknown as [string, 'allow' | 'deny' | 'always' | 'more', string]
  const key = approvals.keyOf(id)
  if (!key) return ctx.answerCallbackQuery({ text: 'Already decided.' }).catch(() => {})
  if (!isApprover(key, ctx.from.id)) {
    return ctx.answerCallbackQuery({ text: 'Not authorised to approve.' }).catch(() => {})
  }
  if (action === 'more') {
    const kb = approvals.keyboard(id)
    kb.inline_keyboard[0]!.shift()
    await ctx.editMessageText(approvals.details(id)!, { reply_markup: kb }).catch(() => {})
    return ctx.answerCallbackQuery().catch(() => {})
  }
  if (!approvals.decide(id, action, String(ctx.from.id))) return ctx.answerCallbackQuery({ text: 'Already decided.' }).catch(() => {})
  const label = { allow: '✅ Allowed', deny: '❌ Denied', always: '♾ Always allowed in this chat' }[action]
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
})

// 008 FR8, FR10, FR11: built-in, skill, ignored (another bot's) or plain text.
const builtins = registry(commands)

// 008 T808: skills found on disk (narrowed to the ones turns report loaded), named for Telegram.
const loadedSkills = new Set<string>()
function menuSkills(): MenuSkill[] {
  const chats = Object.values(loadAccess().chats ?? {})
  const cwds = new Set([config.cwd, ...chats.flatMap(c => c.policy?.cwd ? [expandPath(c.policy.cwd, homedir())] : [])])
  const found = discoverSkills(claudeDir(), [...cwds]).filter(s => !loadedSkills.size || loadedSkills.has(s.name))
  const table = assign(loadTable(COMMANDS_FILE), found.map(s => s.name), builtins.keys())
  saveTable(COMMANDS_FILE, table)
  const usage = skillUsage.all()
  return found.map(s => ({ command: table[s.name]!, description: s.description, uses: usage[s.name]?.count ?? 0 }))
}
const menu = createMenu(
  () => buildMenus(commands, menuSkills()),
  (scope, cmds) => bot.api.setMyCommands(cmds, { scope: { type: scope } }),
)
// 006 T611 → FR7: a learned skill reaches the menu within a minute.
skillEvents.on('skills-changed', () => menu.refresh(30_000))
bot.on('message:text', async ctx => {
  const text = ctx.message.text
  const r = route(text, ctx.me.username, builtins, loadTable(COMMANDS_FILE))
  if (r.kind === 'ignore') return
  if (r.kind === 'skill') return handleInbound(ctx, text, undefined, undefined, r.text)
  if (r.kind === 'text') return handleInbound(ctx, text, undefined)
  const key = sessionKey(ctx.msg)
  if (!authorised(r.command, ctx.chat.type !== 'private', isApprover(key, ctx.from.id), isOwner(ctx))) {
    await ctx.reply(`Only approvers can use /${r.command.name} here.`)
    return
  }
  await r.command.handler(ctx, r.args)
})

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
const topicNames = createTopicNames()

// Names only from senders who could talk to the bot in this group (constitution IV).
bot.on(['message:forum_topic_created', 'message:forum_topic_edited'], ctx => {
  if (groupVerdict(loadAccess().groups[String(ctx.chat.id)], String(ctx.from?.id), () => true) !== 'drop') {
    topicNames.learn(ctx.msg)
  }
})

/**
 * FR5: `yes abcde` answers a pending approval through the same resolver as
 * the buttons. Only the request's approvers count. True if it was handled.
 */
function textApproval(ctx: Context, text: string): boolean {
  const reply = parseTextReply(text)
  const key = reply && approvals.keyOf(reply.id)
  if (!reply || !key || !isApprover(key, ctx.from!.id)) return false
  if (!approvals.decide(reply.id, reply.decision, String(ctx.from!.id))) return false
  const msgId = ctx.message?.message_id
  if (msgId != null) void setReaction(String(ctx.chat!.id), msgId, reply.decision === 'allow' ? '👍' : '👎')
  return true
}

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
  /** 008 FR5: set for a skill command, the native `/<skill> <args>` invocation. */
  invocation?: string,
): Promise<void> {
  if (ctx.from && ctx.chat && await skillEditReply(ctx, text)) return
  const result = gate(ctx)
  const bufferContext = () => {
    topicNames.learn(ctx.msg!)
    sawUser(sessionKey(ctx.msg!), String(ctx.from!.id))
    groupBuffer.push(sessionKey(ctx.msg!), {
      ts: ctx.msg!.date * 1000,
      user: ctx.from!.username ?? String(ctx.from!.id),
      text,
    })
  }
  // FR5: answers count without an @mention, so they work in groups too.
  if (result.action === 'drop') {
    if (result.unmentioned && !textApproval(ctx, text)) bufferContext()
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
  if (textApproval(ctx, text)) return

  // 003 FR12: non-owners in groups feed the context buffer but never start a turn.
  if (!canStartTurn(access, key, String(from.id))) {
    bufferContext()
    return
  }

  topicNames.learn(ctx.msg!)
  sawUser(key, String(from.id))
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
  const chat = ctx.chat!
  const topic = topicNames.get(key)
  const meta = {
    chat_id,
    chat_type: chat.type,
    ...('title' in chat && chat.title ? { chat_title: chat.title } : {}),
    ...(topic ? { topic } : {}),
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
  }
  let prompt = renderInbound(text, meta, groupBuffer.take(key))
  if (invocation) {
    const skill = renderSkillInvocation(invocation, meta)
    prompt = skill.prompt
    skillContext.set(key, skill.context)
  }
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
        menu.refresh()
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
