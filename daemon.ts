#!/usr/bin/env bun
/**
 * Headless daemon entry (FR1). Owns the grammY poller, the MCP and hook
 * endpoints, and runs each gated inbound message as a `claude -p` turn.
 * Access, pairing, approvals and attachments behave as in the legacy
 * `server.ts` channel (FR6), which stays runnable (FR13).
 */

import { Bot, GrammyError, type Context } from 'grammy'
import type { InlineKeyboardMarkup, ReactionTypeEmoji } from 'grammy/types'
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
import { addAlwaysAllow, canStartTurn, chatTypeOf, policyKey, removeAlwaysAllow, resolvePolicy } from './policy/resolve.ts'
import { scopeDecision } from './policy/scope.ts'
import { createAudit } from './policy/audit.ts'
import { CLOSE_CALLBACK, withClose } from './telegram/close.ts'
import { AGENT_CALLBACK, agentView } from './telegram/agentUi.ts'
import { EXTENSIONS_CALLBACK, extensionsView, mcpSwitchesView, pluginSwitchesView, skillOn, skillSwitchesView, toggleMcpServer, togglePlugin, toggleSkill } from './telegram/extensionsUi.ts'
import { installedPlugins, type Plugin } from './skills/plugins.ts'
import { createLoadedCache, mcpPrefix, probeInit, type Loaded } from './agent/loaded.ts'
import { alwaysRuleAt, applyPolicyEdit, EDITABLE, fieldView, label, permissionsView, POLICY_CALLBACK, policyView, resetPolicy, resetView, ruleLabel, rulesView, ruleView, type EditableField } from './telegram/policyUi.ts'
import { expandPath, isTrustedCwd, policyArgs, policySettings } from './policy/args.ts'
import { homedir } from 'os'
import { type AttachmentMeta, INBOX_DIR, safeName, downloadPhoto } from './telegram/attachments.ts'
import { startMcpServer } from './mcp/server.ts'
import { startHookServer } from './hooks/endpoint.ts'
import { writeHookSettings, CHANNEL_PLUGIN } from './hooks/settings.ts'
import { isMissingSession, runTurn, type RunTurnOpts, type TurnOutcome } from './agent/runner.ts'
import { parseKey, sessionKey } from './sessions/key.ts'
import { threadOpts } from './telegram/send.ts'
import { createSessionStore } from './sessions/store.ts'
import { createSessionLifecycle } from './sessions/lifecycle.ts'
import { resumeView, SESSIONS_CALLBACK, sessionsView } from './sessions/commands.ts'
import { createSessionTools, sessionStatus } from './agent/sessionTools.ts'
import { formatUsage, planUsage, USAGE_CALLBACK, usageKeyboard } from './agent/planUsage.ts'
import { createTurnQueue } from './sessions/queue.ts'
import { createGroupBuffer } from './sessions/groupBuffer.ts'
import { renderInbound, renderSkillInvocation } from './agent/inbound.ts'
import { createTopicNames } from './sessions/topics.ts'
import { startProgress } from './agent/progress.ts'
import { apiKeyRefusal, isLoggedIn } from './agent/auth.ts'
import { loadConfig, cliVersionRefusal, createTurnBudget } from './config.ts'
import { claudeDir, memoryRoot, userDir } from './memory/paths.ts'
import { installAssets } from './agents/install.ts'
import { openHistoryDb } from './history/db.ts'
import { startIndexer } from './history/indexer.ts'
import { createHistoryTools } from './history/tools.ts'
import { recall, withContext } from './history/recall.ts'
import { searchCommand } from './history/commands.ts'
import { createMemoryStore } from './memory/store.ts'
import { createMemoryTools } from './memory/tools.ts'
import { aboutYou, entryView, forget, MEMORY_CALLBACK, memoryView, remember, type CommandResult } from './memory/commands.ts'
import { createInjector } from './memory/inject.ts'
import { bridgePaths, importEnabled } from './memory/bridge.ts'
import { createNotices, noticeText } from './memory/notices.ts'
import { createReflectionWorker } from './reflection/worker.ts'
import { createApplier } from './reflection/apply.ts'
import { ProposalsSchema } from './reflection/prompt.ts'
import { runOneShot } from './agent/oneshot.ts'
import { createSkillStore, type SkillStore } from './skills/store.ts'
import { skillsRoot, takenNames } from './skills/paths.ts'
import { createSkillApplier } from './skills/apply.ts'
import { createSkillTools } from './skills/tools.ts'
import { parseSkillsArgs, SKILLS_CALLBACK, skillsView, skillView, type SkillAction, type SkillEntry } from './skills/commands.ts'
import { createSkillUsage, invokedSkill } from './skills/usage.ts'
import { createAgentUsage } from './agents/usage.ts'
import { availableAgents, chatAgents, setPolicyAgent } from './agents/available.ts'
import { AUTHOR, createAgentTools } from './agents/tools.ts'
import { createAgentApplier, learnedAgents } from './agents/apply.ts'
import { staleSkills, STALE_DAYS } from './skills/prune.ts'
import { archiveAgent, evalTargets, skillCreatorInstalled, staleAgents } from './agents/prune.ts'
import { createSkillNotices, skillNoticeText } from './skills/notices.ts'
import { RefinementSchema, refinementInput, skillsContext, type Proposals } from './reflection/prompt.ts'
import { toolCalls } from './reflection/transcript.ts'
import { search } from './history/search.ts'
import { registry, type Command } from './commands/registry.ts'
import { authorised, route } from './commands/dispatch.ts'
import { assign, discoverSkills, loadTable, saveTable } from './commands/skillMap.ts'
import { START_TEXT, helpText, pairingStatus } from './commands/help.ts'
import { buildMenus, createMenu } from './commands/menu.ts'
import { scopeFor } from './history/tools.ts'
import { createEngine } from './scheduler/engine.ts'
import { failureNotice, runJob } from './scheduler/run.ts'
import { createScheduleTools } from './scheduler/tools.ts'
import type { Job } from './scheduler/store.ts'
import { chatJobs, deleteJob, setJobEnabled } from './scheduler/manage.ts'
import { CRON_CALLBACK, CRON_NEW_CALLBACK, cronView, newJobView, whenFor, type CronAction } from './commands/cron.ts'
import { startSystemJobs, type SystemJobId } from './scheduler/system.ts'
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

// 009 FR1: shipped tg agents and skills; user-edited files are kept.
try {
  const r = installAssets(claudeDir(), join(STATE_DIR, 'agents-installed.json'))
  for (const p of r.installed) log(`installed ${p}`)
  for (const p of r.updated) log(`updated ${p}`)
  for (const p of r.kept) log(`kept user-edited ${p}`)
} catch (err) {
  log(`agent install failed: ${err}`)
}
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
// Optimistic buttons: a tap is handled off the sequential update loop, so it
// never waits behind another update's throttled reply. Handlers answer the
// tap with the expected result first and only change it if the work fails.
bot.on('callback_query', (ctx, next) => { void next().catch(err => log(`callback handler error: ${err}`)) })
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
const agentUsage = createAgentUsage(join(STATE_DIR, 'agents-usage.json'))
// 009 T908: agent_* tools work only while tg-skill-author runs for the key, as a subagent or the main agent.
const authorRuns = new Map<string, Set<string>>()
const agentTools = createAgentTools(join(claudeDir(), 'agents'),
  key => policyOf(key).agent === AUTHOR || !!authorRuns.get(key)?.size)
// 009 FR8: learned agents proposed by reflection.
const agentApplier = createAgentApplier({
  dir: join(claudeDir(), 'agents'),
  policy: policyOf,
  notify: (key, text) => { const t = parseKey(key); void bot.api.sendMessage(t.chatId, text, threadOpts(t)).catch(() => {}) },
  ask: (key, text, id) => {
    const t = parseKey(key)
    void bot.api.sendMessage(t.chatId, text.slice(0, 4000), { ...threadOpts(t), reply_markup: { inline_keyboard: [[
      { text: '✅ Save', callback_data: `agt:save:${id}` }, { text: '✖ Skip', callback_data: `agt:skip:${id}` },
    ]] } }).catch(() => {})
  },
  log,
})
const isLearnedSkill = (key: string, name: string) => skillStoreFor(key).read(name)?.metadata.source === 'tg'

/** 006 FR7, FR8: record outcomes; a skill that keeps failing gets a refinement proposal for approval (AC6). */
async function skillOutcomes(key: string, outcomes: Proposals['skill_outcomes'], delta: string): Promise<void> {
  for (const { name, outcome } of outcomes) {
    if (!isLearnedSkill(key, name) || !skillUsage.outcome(name, outcome)) continue
    log(`skills: refining ${name} after repeated failures`)
    const p = await runOneShot('tg-reflector', refinementInput(skillStoreFor(key).text(name)!, delta), RefinementSchema)
    skillApplier.one(key, { ...p, op: 'patch', name, confidence: 1 }, true)
  }
}

// 006 FR8: weekly archive proposals (a 007 system job) to the owners, for the skills their DMs learn into.
const MAX_PRUNE_PROPOSALS = 5
const archiveAsks = new Map<string, { key: string; name: string }>()
function proposeArchives(): void {
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
  // 009 T911: unused learned agents, kept under the 12-agent description budget.
  const owner = loadAccess().allowFrom[0]
  if (!owner) return
  const dir = join(claudeDir(), 'agents')
  for (const name of staleAgents(dir, agentUsage.all()).slice(0, MAX_PRUNE_PROPOSALS)) {
    const id = randomBytes(6).toString('hex')
    agentArchiveAsks.set(id, { dir, name })
    void bot.api.sendMessage(owner, `📦 Agent ${name} hasn't been used in ${STALE_DAYS} days. Archive it?`, {
      reply_markup: { inline_keyboard: [[
        { text: '📦 Archive', callback_data: `agt:arch:${id}` },
        { text: 'Keep', callback_data: `agt:keep:${id}` },
      ]] },
    }).catch(() => {})
  }
}
const agentArchiveAsks = new Map<string, { dir: string; name: string }>()

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
  reflect: input => runOneShot('tg-reflector', input, ProposalsSchema),
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
    return skillsContext(learned, toolCalls(delta), similarRequests(key, delta, payload.session_id), learnedAgents(join(claudeDir(), 'agents')))
  },
  apply: async (key, proposals, delta, payload) => {
    applier.apply(key, proposals)
    skillApplier.apply(key, proposals)
    if (proposals.agents.some(a => a.op !== 'none')) agentApplier.apply(key, proposals, similarRequests(key, delta, payload.session_id).length + 1)
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
const mcpServer = startMcpServer({ authToken: mcpToken, api: bot.api, botToken: TOKEN, memory: memoryTools, history: historyTools, skills: skillTools, agents: agentTools, session: sessionTools, scheduler: scheduleTools })
const audit = createAudit(join(STATE_DIR, 'audit.log'))
const approvals = createApprovals({
  api: bot.api,
  audit,
  timeoutSec: APPROVAL_TIMEOUT_SEC,
  sessionRule: (key, rule) => lifecycle.allow(key, rule),
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
    agentTools.startTurn(key)
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
  // 009 FR5, FR7: per-agent counts and durations.
  'subagent-start': (payload, key) => {
    agentUsage.start(payload)
    if (payload.agent_type === AUTHOR) (authorRuns.get(key) ?? authorRuns.set(key, new Set()).get(key)!).add(String(payload.agent_id))
  },
  'subagent-stop': (payload, key) => {
    authorRuns.get(key)?.delete(String(payload.agent_id))
    const run = agentUsage.stop(payload)
    if (run) log(`subagent ${run.type} for ${key} took ${Math.round(run.ms / 1000)}s`)
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
  run: (key, batch) => (key.startsWith(JOB_PREFIX) ? fireJob(key.slice(JOB_PREFIX.length))
    : key.startsWith(SYS_PREFIX) ? fireSystemJob(key.slice(SYS_PREFIX.length) as SystemJobId)
    : runBatch(key, batch))
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
  const cwd = policy.cwd ? expandPath(policy.cwd, homedir()) : config.cwd
  const outcome = await runInSession(key, prompt, firstMessage, {
    settingsFile: SETTINGS_FILE,
    mcpPort: mcpServer.port,
    mcpToken,
    hookToken,
    cwd,
    maxTurns: policy.maxTurns ?? config.maxTurns,
    policyArgs: policyArgs({ ...policy, model: lifecycle.model(key) ?? policy.model, alwaysAllow: [...policy.alwaysAllow ?? [], ...lifecycle.allowed(key)] }),
    settings: policySettings(policy),
    signal: AbortSignal.any([turnAbort.signal, turn.signal]),
    onEvent: progress.onEvent,
  }).finally(() => {
    progress.finish()
    if (runningTurns.get(key) === turn) runningTurns.delete(key)
  })
  if (outcome.init) loaded.record(cwd, outcome.init)
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
    settings: policySettings(policy),
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
  // Retry re-enables an auto-disabled job with a clean failure count.
  if (!setJobEnabled(STATE_DIR, id, action === 'retry')) return ctx.answerCallbackQuery({ text: 'Job is gone.' }).catch(() => {})
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

// 007 FR10: weekly maintenance, kept out of jobs.json and the agent's schedule_list.
const SYS_PREFIX = 'sys:'
const CONSOLIDATE_PROMPT = 'Run the weekly memory consolidation pass: merge duplicate or overlapping memories, drop stale ones, and keep the index within its line limit.'
  + ` Then do the same for each tg agent's own memory under ${join(claudeDir(), 'agent-memory')}/tg-*/ (MEMORY.md index plus fact files), if any exist.`
const evalPrompt = (t: { agents: string[]; skills: string[] }) =>
  'Run the weekly evals with the skill-creator plugin against these tg agents and skills, which have enough usage: '
  + [...t.agents.map(a => `agent ${a}`), ...t.skills.map(k => `skill ${k}`)].join(', ')
  + '. For any that underperform, delegate a fix to tg-skill-author with the eval results. Reply with a short summary of results and proposals.'

/** 009 FR12: skill-creator evals, only when that plugin is installed and something has enough runs. */
async function runEvals(): Promise<void> {
  const owner = loadAccess().allowFrom[0]
  if (!owner || !skillCreatorInstalled(claudeDir())) return
  const targets = evalTargets(agentUsage.all(), skillUsage.all())
  if (!targets.agents.length && !targets.skills.length) return
  const prompt = renderInbound(evalPrompt(targets), { origin: 'scheduler', chat_id: owner, job_title: 'Weekly evals', ts: new Date().toISOString() })
  const outcome = await jobTurn({ mode: 'fresh', sessionKey: owner } as Job, prompt, policyOf(owner), () => {})
  log(`evals: ${outcome.refused?.join('; ') ?? (outcome.result?.is_error ? 'error' : 'done')}`)
}

/** 004 FR8: a fresh turn in the first owner's DM, run as tg-curator (009). */
async function consolidateMemory(): Promise<void> {
  const owner = loadAccess().allowFrom[0]
  if (!owner) return
  const prompt = renderInbound(CONSOLIDATE_PROMPT, { origin: 'scheduler', chat_id: owner, job_title: 'Weekly memory consolidation', ts: new Date().toISOString() })
  const outcome = await jobTurn({ mode: 'fresh', sessionKey: owner } as Job, prompt, { ...policyOf(owner), agent: 'tg-curator' }, () => {})
  log(`memory consolidation: ${outcome.refused?.join('; ') ?? (outcome.result?.is_error ? 'error' : 'done')}`)
}

async function fireSystemJob(id: SystemJobId): Promise<void> {
  if (turnAbort.signal.aborted) return
  if (id === 'memory-consolidation') await consolidateMemory()
  else { proposeArchives(); await runEvals() }
}

const systemJobs = startSystemJobs({
  stateFile: join(STATE_DIR, 'system-jobs.json'),
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  run: id => turns.enqueue(SYS_PREFIX + id, { prompt: '', text: '' }),
})
if (systemJobs.caughtUp.length) log(`scheduler: catching up system jobs ${systemJobs.caughtUp.join(', ')}`)

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
  systemJobs.stop()
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

// 005 US4: owner-only like /stop, scoped by the chat's historyScope. 008 moves it into its handlers.
commands.push({ name: 'search', description: 'Search past conversations: /search <words>', menu: ['private', 'group'], handler: async (ctx, args) => {
  if (!isOwner(ctx)) return
  const key = sessionKey(ctx.msg!)
  await ctx.reply(searchCommand({ db: historyDb, sessions }, args, key, policyOf(key)), { link_preview_options: { is_disabled: true } })
} })

// 008 T805: memory curation over 004's command functions; writes get the Undo notice.
const memoryReply = async (ctx: Context, r: CommandResult) =>
  ctx.reply(r.text, r.change ? { reply_markup: notices.undoKeyboard(r.change) } : r.keyboard ? { reply_markup: withClose(r.keyboard) } : {})

// 008 FR13: /memory is the one entry point; Add, Forget and About you are buttons.
commands.push({ name: 'memory', description: 'See, add and forget what I remember', menu: ['private', 'group'], handler: async ctx => {
  if (!isOwner(ctx)) return
  await memoryReply(ctx, memoryView(memory, policyOf(sessionKey(ctx.msg!))))
} })

/** Add prompts awaiting a reply, by `<chat>:<message id>`, to their session key. */
const memoryAdds = new Map<string, string>()

bot.callbackQuery(MEMORY_CALLBACK, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!msg || !isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const key = sessionKey(msg as Parameters<typeof sessionKey>[0])
  const policy = policyOf(key)
  const [, action, arg] = ctx.match as unknown as [string, 'o' | 'd' | 'p' | 'a' | 'u', string]
  const edit = (r: CommandResult) => ctx.editMessageText(r.text, { reply_markup: withClose(r.keyboard) }).catch(() => {})
  if (action === 'd') {
    if (!canChange(ctx, key, msg.chat.type !== 'private')) return ctx.answerCallbackQuery({ text: 'Not authorised.' }).catch(() => {})
    void ctx.answerCallbackQuery({ text: '🧠 Forgotten' }).catch(() => {})
    const r = forget(memory, arg, policy)
    if (!r.change) return failed(ctx, r.text)
    await edit(memoryView(memory, policy))
    if (r.change) await bot.api.sendMessage(msg.chat.id, r.text, { ...threadOpts(parseKey(key)), reply_markup: notices.undoKeyboard(r.change) }).catch(() => {})
    return
  }
  await ctx.answerCallbackQuery().catch(() => {})
  if (action === 'o') return void await edit(entryView(memory, arg, policy))
  if (action === 'p') return void await edit(memoryView(memory, policy, Number(arg)))
  if (action === 'u') return void await edit(aboutYou(userStore(String(ctx.from.id)), policy))
  const sent = await bot.api.sendMessage(msg.chat.id, '🧠 What should I remember? Reply to this message.', {
    ...threadOpts(parseKey(key)),
    reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Something to remember' },
  }).catch(() => undefined)
  if (sent) memoryAdds.set(`${msg.chat.id}:${sent.message_id}`, key)
})

/** A reply to an Add prompt; true when `ctx` was one and has been handled. */
async function memoryAddReply(ctx: Context): Promise<boolean> {
  const to = ctx.message?.reply_to_message
  const id = to && `${ctx.chat!.id}:${to.message_id}`
  const key = id && memoryAdds.get(id)
  if (!key || !isOwner(ctx)) return false
  memoryAdds.delete(id)
  await memoryReply(ctx, remember(memory, ctx.message!.text ?? '', key, policyOf(key)))
  return true
}

// 008 T806: the chat's skills; archive and remove need an approver (FR10).
const canChange = (ctx: Context, key: string, isGroup: boolean) =>
  authorised({ requiresApprover: true }, isGroup, isApprover(key, ctx.from!.id), isOwner(ctx))

commands.push({ name: 'skills', description: 'Browse, run and manage skills', menu: ['private', 'group'], handler: async (ctx, args) => {
  if (!isOwner(ctx)) return
  const parsed = parseSkillsArgs(args)
  if (parsed === 'list') {
    const r = skillsView(skillsHere(sessionKey(ctx.msg!)))
    return void await ctx.reply(r.text, r.keyboard ? { reply_markup: withClose(r.keyboard) } : {})
  }
  const skill = skillsHere(sessionKey(ctx.msg!)).find(s => s.command === parsed.command || s.name === parsed.command)
  if (!skill) return void await ctx.reply(`No skill named ${parsed.command} is on here. Send /skills to see them all.`)
  await handleInbound(ctx, ctx.message!.text!, undefined, undefined, `/${skill.name}${parsed.args ? ` ${parsed.args}` : ''}`)
} })

// 008 FR12: the /skills buttons. Run starts the skill as a turn in this chat; archive and remove need an approver (FR10).
bot.callbackQuery(SKILLS_CALLBACK, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!msg || !isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const key = sessionKey(msg as Parameters<typeof sessionKey>[0])
  const [, action, arg] = ctx.match as unknown as [string, SkillAction | 'p', string]
  const edit = (r: { text: string; keyboard?: InlineKeyboardMarkup }) =>
    ctx.editMessageText(r.text, r.keyboard ? { reply_markup: withClose(r.keyboard) } : {}).catch(() => {})
  if (action === 'p') {
    await ctx.answerCallbackQuery().catch(() => {})
    return void await edit(skillsView(skillsHere(key), Number(arg)))
  }
  const skill = skillsHere(key).find(s => s.command === arg)
  if (!skill) return ctx.answerCallbackQuery({ text: 'That skill is gone.' }).catch(() => {})
  const store = skillStoreFor(key)
  const own = !!store.read(skill.name)
  if ((action === 'a' || action === 'd') && (!own || !canChange(ctx, key, msg.chat.type !== 'private'))) {
    return ctx.answerCallbackQuery({ text: 'Not authorised.' }).catch(() => {})
  }
  switch (action) {
    case 'o':
      await ctx.answerCallbackQuery().catch(() => {})
      return void await edit(skillView(skill, own))
    case 'r':
      await ctx.answerCallbackQuery({ text: `▶️ Running ${skill.name}` }).catch(() => {})
      return runSkillButton(msg, ctx.from, skill.name)
    case 's': {
      await ctx.answerCallbackQuery().catch(() => {})
      const text = own ? store.text(skill.name) : readSkillFile(skill.name)
      return void await bot.api.sendMessage(msg.chat.id, (text ?? 'Could not read that skill.').slice(0, 4000), threadOpts(parseKey(key))).catch(() => {})
    }
    case 'a':
    case 'd': {
      void ctx.answerCallbackQuery({ text: action === 'a' ? `📦 Archived ${skill.name}` : `🗑 Removed ${skill.name}` }).catch(() => {})
      try {
        if (action === 'a') store.archive(skill.name)
        else store.remove(skill.name)
      } catch (err) {
        return failed(ctx, err instanceof Error ? err.message : String(err))
      }
      return void await edit(skillsView(skillsHere(key)))
    }
  }
})

// 008 FR14: /sessions is the one entry point; New, Resume and Compact are buttons.
commands.push({ name: 'sessions', description: 'New, resume or compact this session', menu: ['private', 'group'], handler: async ctx => {
  if (!isOwner(ctx)) return
  const key = sessionKey(ctx.msg!)
  const r = sessionsView(sessionStatus(sessionDeps, key, policyOf(key)))
  await ctx.reply(r.text, { reply_markup: withClose(r.keyboard) })
} })

bot.callbackQuery(SESSIONS_CALLBACK, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!msg || !isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const key = sessionKey(msg as Parameters<typeof sessionKey>[0])
  const [, action, arg] = ctx.match as unknown as [string, 'n' | 'c' | 'l' | 'r' | 'b', string]
  const edit = (text: string, keyboard?: InlineKeyboardMarkup) =>
    ctx.editMessageText(text, keyboard ? { reply_markup: withClose(keyboard) } : {}).catch(() => {})
  await ctx.answerCallbackQuery().catch(() => {})
  switch (action) {
    case 'n':
      lifecycle.new(key)
      return void await edit('🆕 New session. The next message starts with no earlier context.')
    case 'c':
      if (!sessions.current(key)) return void await edit('No session to compact yet.')
      turns.enqueue(key, { prompt: '/compact', text: '/compact' })
      return void await edit('🗜 Compacting this session.')
    case 'l': {
      const r = resumeView(lifecycle.list(key), Number(arg))
      return void await edit(r.text, r.keyboard)
    }
    case 'r':
      try {
        const picked = lifecycle.resume(key, Number(arg))
        return void await edit(`⏪ Resumed: ${picked.title || '(untitled)'}`)
      } catch (err) {
        return void await edit((err as Error).message)
      }
    case 'b': {
      const r = sessionsView(sessionStatus(sessionDeps, key, policyOf(key)))
      return void await edit(r.text, r.keyboard)
    }
  }
})

// 008 FR1: the subscription's usage limits, from Claude Code's own /usage.
commands.push({ name: 'usage', description: 'Plan usage limits and when they reset', menu: ['private', 'group'], handler: async ctx => {
  if (!isOwner(ctx)) return
  void ctx.replyWithChatAction('typing').catch(() => {})
  try {
    const report = await planUsage()
    const sent = await ctx.reply(formatUsage(report).slice(0, 4000), { reply_markup: withClose(usageKeyboard(false)) })
    usageReports.set(`${sent.chat.id}:${sent.message_id}`, report)
  } catch (err) {
    await ctx.reply(`Couldn't read usage: ${err instanceof Error ? err.message : err}`)
  }
} })

/** The report behind each `/usage` message, so Learn more doesn't run `claude` again. Lost on restart. */
const usageReports = new Map<string, string>()

// 008 FR17: ℹ️ Learn more shows what's using the limits; « Back returns to the bars.
bot.callbackQuery(USAGE_CALLBACK, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!msg || !isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const id = `${msg.chat.id}:${msg.message_id}`
  let report = usageReports.get(id)
  if (!report) {
    void ctx.answerCallbackQuery({ text: 'Reading usage…' }).catch(() => {})
    try {
      usageReports.set(id, report = await planUsage())
    } catch (err) {
      return failed(ctx, `Couldn't read usage: ${err instanceof Error ? err.message : err}`)
    }
  } else await ctx.answerCallbackQuery().catch(() => {})
  const detail = ctx.match![1] === 'more'
  await ctx.editMessageText(formatUsage(report, detail).slice(0, 4000), { reply_markup: withClose(usageKeyboard(detail)) }).catch(() => {})
})

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

// 003 T309, 008 FR15: owner-only settings for this chat; settings open their values, Permissions lists every rule.
const policyAt = (key: string) => resolvePolicy(loadAccess(), key, chatTypeOf(key))

commands.push({ name: 'settings', description: "This chat's settings and permissions", menu: ['private', 'group'], requiresApprover: true, handler: async ctx => {
  if (!isOwner(ctx)) return
  const here = sessionKey(ctx.msg!)
  const r = policyView(policyKey(here), policyAt(here))
  await ctx.reply(r.text, { reply_markup: withClose(r.keyboard) })
} })

bot.callbackQuery(POLICY_CALLBACK, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!isOwner(ctx) || !msg) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const here = sessionKey(msg as Parameters<typeof sessionKey>[0])
  const key = policyKey(here)
  const [, action, a, b] = ctx.match as unknown as [string, 'm' | 'p' | 'f' | 's' | 'c' | 'r' | 'x' | 'z' | 'y', string?, string?]
  const show = (r: { text: string; keyboard: InlineKeyboardMarkup }) =>
    ctx.editMessageText(r.text, { reply_markup: withClose(r.keyboard) }).catch(() => {})
  const user = String(ctx.from.id)
  switch (action) {
    case 's': {
      const access = loadAccess()
      try {
        const stored = applyPolicyEdit(access, key, a!, b!)
        saveAccess(access)
        audit({ event: 'policy', key, user, field: a!, value: stored ?? 'default' })
        menu.refresh()
      } catch (err) {
        return ctx.answerCallbackQuery({ text: (err as Error).message }).catch(() => {})
      }
      void ctx.answerCallbackQuery({ text: `${label(a!)}: ${label(b!)}` }).catch(() => {})
      return void await show(a === 'permissionMode' ? permissionsView(policyAt(here)) : policyView(key, policyAt(here)))
    }
    case 'x': {
      const access = loadAccess()
      const rule = alwaysRuleAt(resolvePolicy(access, key, chatTypeOf(key)), Number(a))
      if (!rule || !removeAlwaysAllow(access, key, rule)) return ctx.answerCallbackQuery({ text: 'That rule is gone.' }).catch(() => {})
      saveAccess(access)
      audit({ event: 'policy', key, user, field: 'alwaysAllow', value: `-${rule}` })
      void ctx.answerCallbackQuery({ text: `🗑 Removed ${ruleLabel(rule)}` }).catch(() => {})
      return void await show(rulesView(policyAt(here), 2, Math.floor(Number(a) / 8)))
    }
    case 'y': {
      const access = loadAccess()
      resetPolicy(access, key)
      if (here !== key) resetPolicy(access, here)
      saveAccess(access)
      audit({ event: 'policy', key, user, field: '*', value: 'default' })
      menu.refresh()
      void ctx.answerCallbackQuery({ text: '↺ Settings reset' }).catch(() => {})
      return void await show(policyView(key, policyAt(here)))
    }
  }
  await ctx.answerCallbackQuery().catch(() => {})
  const p = policyAt(here)
  if (action === 'm') return void await show(policyView(key, p))
  if (action === 'p') return void await show(permissionsView(p))
  if (action === 'c') return void await show(rulesView(p, Number(a), Number(b ?? 0)))
  if (action === 'r') return void await show(ruleView(p, Number(a), Number(b)))
  if (action === 'z') return void await show(resetView())
  if (a && a in EDITABLE) await show(fieldView(a as EditableField, p))
})

// 008 FR20, 009 FR3: 🤖 Agent replaces /agent. Set on the session key, so a forum topic can run as its own agent (US3).
bot.callbackQuery(AGENT_CALLBACK, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!isOwner(ctx) || !msg) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const here = sessionKey(msg as Parameters<typeof sessionKey>[0])
  const [, action, name] = ctx.match as unknown as [string, 'm' | 'u', string]
  const p = policyAt(here)
  const cwd = p.cwd ? expandPath(p.cwd, homedir()) : config.cwd
  if (action === 'u') {
    const access = loadAccess()
    try {
      setPolicyAgent(access, here, name || undefined, availableAgents(claudeDir(), cwd))
    } catch (err) {
      return ctx.answerCallbackQuery({ text: (err as Error).message }).catch(() => {})
    }
    saveAccess(access)
    audit({ event: 'policy', key: here, user: String(ctx.from.id), field: 'agent', value: name || 'default' })
    void ctx.answerCallbackQuery({ text: `🤖 ${name || 'Default assistant'}` }).catch(() => {})
  } else await ctx.answerCallbackQuery().catch(() => {})
  const r = agentView(policyAt(here).agent, chatAgents(claudeDir(), cwd))
  await ctx.editMessageText(r.text, { reply_markup: withClose(r.keyboard) }).catch(() => {})
})

// 008 FR19: 🧩 Skills & plugins, switched per chat and passed to turns as settings.
bot.callbackQuery(EXTENSIONS_CALLBACK, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!isOwner(ctx) || !msg) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const key = policyKey(sessionKey(msg as Parameters<typeof sessionKey>[0]))
  const [, action, a, b] = ctx.match as unknown as [string, 'm' | 's' | 't' | 'p' | 'u' | 'c' | 'v', string?, string?]
  const show = (r: { text: string; keyboard: InlineKeyboardMarkup }) =>
    ctx.editMessageText(r.text, { reply_markup: withClose(r.keyboard) }).catch(() => {})
  const p = policyAt(key)
  const cwd = cwdOf(p)
  // The first open in a cwd with no turn yet probes it (a few seconds).
  const toggles = action === 't' || action === 'u' || action === 'v'
  if (!toggles) void ctx.answerCallbackQuery().catch(() => {})
  const seen = await loaded.get(cwd)
  const plugins = pluginsFor(cwd, seen)
  const servers = seen.mcpServers.filter(x => x.name !== 'tg')
  if (toggles) {
    const skill = action === 't' ? allSkills().find(x => x.command === a) : undefined
    const plugin = action === 'u' ? plugins.find(x => x.id === a) : undefined
    const server = action === 'v' ? servers.find(x => mcpPrefix(x.name) === a) : undefined
    const name = skill?.name ?? plugin?.name ?? server?.name
    if (!name) return ctx.answerCallbackQuery({ text: 'That one is gone.' }).catch(() => {})
    const access = loadAccess()
    const on = skill ? toggleSkill(access, key, skill.name) : plugin ? togglePlugin(access, key, plugin) : toggleMcpServer(access, key, a!)
    saveAccess(access)
    const field = skill ? 'disabledSkills' : plugin ? 'plugins' : 'disabledMcpServers'
    audit({ event: 'policy', key, user: String(ctx.from.id), field, value: `${on ? '+' : '-'}${skill?.name ?? plugin?.id ?? a}` })
    void ctx.answerCallbackQuery({ text: `${on ? '✅' : '🚫'} ${name} ${on ? 'on' : 'off'} here` }).catch(() => {})
    const now = policyAt(key)
    return void await show(skill ? skillSwitchesView(now, allSkills(), Number(b ?? 0)) : plugin ? pluginSwitchesView(now, plugins) : mcpSwitchesView(now, servers))
  }
  if (action === 'm') return void await show(extensionsView(p, allSkills(), plugins, servers))
  if (action === 's') return void await show(skillSwitchesView(p, allSkills(), Number(a ?? 0)))
  if (action === 'c') return void await show(mcpSwitchesView(p, servers))
  await show(pluginSwitchesView(p, plugins))
})

// 008 T807, 007 US5: this chat's jobs with pause/resume, delete and run-now buttons.
commands.push({ name: 'cron', description: "Manage this chat's scheduled jobs", menu: ['private', 'group'], requiresApprover: true, handler: async ctx => {
  const { text, keyboard } = cronView(chatJobs(STATE_DIR, sessionKey(ctx.msg!)))
  await ctx.reply(text, { reply_markup: withClose(keyboard) })
} })

bot.callbackQuery(CRON_CALLBACK, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!msg) return ctx.answerCallbackQuery().catch(() => {})
  const key = sessionKey(msg as Parameters<typeof sessionKey>[0])
  if (!canChange(ctx, key, msg.chat.type !== 'private')) return ctx.answerCallbackQuery({ text: 'Not authorised.' }).catch(() => {})
  const [, action, id] = ctx.match as unknown as [string, CronAction, string]
  if (!chatJobs(STATE_DIR, key).some(j => j.id === id)) return ctx.answerCallbackQuery({ text: 'Job is gone.' }).catch(() => {})
  void ctx.answerCallbackQuery({ text: { run: '▶️ Running now', del: '🗑 Deleted', pause: '⏸ Paused', resume: '▶ Resumed' }[action] }).catch(() => {})
  try {
    if (action === 'run') queueJob(id)
    else {
      if (action === 'del') deleteJob(STATE_DIR, id)
      else setJobEnabled(STATE_DIR, id, action === 'resume')
      scheduler.reload()
    }
  } catch (err) {
    return failed(ctx, err instanceof Error ? err.message : String(err))
  }
  const { text, keyboard } = cronView(chatJobs(STATE_DIR, key))
  await ctx.editMessageText(text, { reply_markup: withClose(keyboard) }).catch(() => {})
})

// 008 FR18: ➕ New job steps through how often, day and hour, then asks for what to do.
bot.callbackQuery(CRON_NEW_CALLBACK, async ctx => {
  const msg = ctx.callbackQuery.message
  if (!msg) return ctx.answerCallbackQuery().catch(() => {})
  const key = sessionKey(msg as Parameters<typeof sessionKey>[0])
  if (!canChange(ctx, key, msg.chat.type !== 'private')) return ctx.answerCallbackQuery({ text: 'Not authorised.' }).catch(() => {})
  await ctx.answerCallbackQuery().catch(() => {})
  const [, action, spec] = ctx.match as unknown as [string, 'list' | 'w', string]
  const show = (r: { text: string; keyboard?: InlineKeyboardMarkup }) =>
    ctx.editMessageText(r.text, { reply_markup: withClose(r.keyboard) }).catch(() => {})
  if (action === 'list') return void await show(cronView(chatJobs(STATE_DIR, key)))
  const step = newJobView(spec)
  if (step !== 'ready') return void await show(step)
  const { when, label } = whenFor(spec)
  await ctx.editMessageText(`➕ New job, ${label}.`).catch(() => {})
  const sent = await bot.api.sendMessage(msg.chat.id, `⏰ ${label[0]!.toUpperCase()}${label.slice(1)}. What should I do then? Reply to this message.`, {
    ...threadOpts(parseKey(key)),
    reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'e.g. Send me a summary of the news' },
  }).catch(() => undefined)
  if (sent) cronAdds.set(`${msg.chat.id}:${sent.message_id}`, { key, when })
})

/** New job prompts awaiting a reply, by `<chat>:<message id>`. */
const cronAdds = new Map<string, { key: string; when: string }>()

/** A reply to a New job prompt; true when `ctx` was one and has been handled. */
async function cronAddReply(ctx: Context): Promise<boolean> {
  const to = ctx.message?.reply_to_message
  const id = to && `${ctx.chat!.id}:${to.message_id}`
  const pending = id && cronAdds.get(id)
  if (!pending || !canChange(ctx, pending.key, ctx.chat!.type !== 'private')) return false
  cronAdds.delete(id)
  const r = scheduleTools.call('schedule_create', { when: pending.when, prompt: ctx.message!.text ?? '' }, pending.key, policyOf(pending.key))!
  const text = r.content.map(c => c.text).join('\n')
  if (r.isError) await ctx.reply(`⚠️ Not scheduled: ${text}`)
  else await ctx.reply(`✅ ${text}`, { reply_markup: withClose(cronView(chatJobs(STATE_DIR, pending.key)).keyboard) })
  return true
}

// 008 FR16: ✖ Close on any menu; owner only, like the menus.
bot.callbackQuery(CLOSE_CALLBACK, async ctx => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  await ctx.answerCallbackQuery().catch(() => {})
  await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {}))
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
  const save = ctx.match[1] === 'save'
  void ctx.answerCallbackQuery({ text: save ? '✅ Saved' : 'Skipped' }).catch(() => {})
  const r = applier.decide(ctx.match[2]!, save)
  if (!r || r.error) return failed(ctx, r?.error ?? 'already decided')
  if (r.change) await ctx.editMessageText(noticeText(r.change), { reply_markup: notices.undoKeyboard(r.change) }).catch(() => {})
  else await ctx.deleteMessage().catch(() => {})
})

/** An optimistic tap that didn't work out: the message says why and keeps its buttons. */
async function failed(ctx: Context, reason: string): Promise<void> {
  const msg = ctx.callbackQuery?.message
  if (!msg || !('text' in msg) || !msg.text) return
  await ctx.editMessageText(`${msg.text}\n\n⚠️ Not done: ${reason}`, { entities: msg.entities, reply_markup: msg.reply_markup }).catch(() => {})
}

// 009 FR8: Save or Skip a proposed learned agent.
bot.callbackQuery(/^agt:(save|skip):([0-9a-f]+)$/, async ctx => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  const save = ctx.match[1] === 'save'
  void ctx.answerCallbackQuery({ text: save ? '✅ Saved' : 'Skipped' }).catch(() => {})
  const r = agentApplier.decide(ctx.match[2]!, save)
  if (!r || r.error) return failed(ctx, r?.error ?? 'already decided')
  if (r.text) await ctx.editMessageText(r.text).catch(() => {})
  else await ctx.deleteMessage().catch(() => {})
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
  void ctx.answerCallbackQuery({ text: action === 'save' ? '✅ Saved' : 'Skipped' }).catch(() => {})
  const r = skillApplier.decide(id!, action === 'save')
  if (!r || r.error) return failed(ctx, r?.error ?? 'already decided')
  if (r.change) await ctx.editMessageText(skillNoticeText(r.change), { reply_markup: skillNotices.keyboard(p.key, r.change) }).catch(() => {})
  else await ctx.deleteMessage().catch(() => {})
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

// 009 T911: Archive or Keep an unused learned agent.
bot.callbackQuery(/^agt:(arch|keep):([0-9a-f]+)$/, async ctx => {
  const a = agentArchiveAsks.get(ctx.match[2]!)
  if (!a) return ctx.answerCallbackQuery({ text: 'Already decided.' }).catch(() => {})
  if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Owner only.' }).catch(() => {})
  agentArchiveAsks.delete(ctx.match[2]!)
  let label = `Kept ${a.name}`
  if (ctx.match[1] === 'arch') {
    try { archiveAgent(a.dir, a.name); label = `📦 Archived ${a.name}` } catch (err) { label = (err as Error).message }
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
    await ctx.editMessageText(approvals.details(id)!, { reply_markup: kb, parse_mode: 'HTML' }).catch(() => {})
    return ctx.answerCallbackQuery().catch(() => {})
  }
  const label = { allow: '✅ Allowed for this session', deny: '❌ Denied', always: '♾ Always allowed' }[action]
  void ctx.answerCallbackQuery({ text: label }).catch(() => {})
  if (!approvals.decide(id, action, String(ctx.from.id))) return failed(ctx, 'already decided')
  const msg = ctx.callbackQuery.message
  // Appending keeps the existing entities' offsets valid, so a See more code block stays formatted.
  if (msg && 'text' in msg && msg.text) await ctx.editMessageText(`${msg.text}\n\n${label}`, { entities: msg.entities }).catch(() => {})
})

// 008 FR8, FR10, FR11: built-in, skill, ignored (another bot's) or plain text.
const builtins = registry(commands)

// 008 T808: skills found on disk (narrowed to the ones turns report loaded), named for Telegram.
const loadedSkills = new Set<string>()
function discovered() {
  const chats = Object.values(loadAccess().chats ?? {})
  const cwds = new Set([config.cwd, ...chats.flatMap(c => c.policy?.cwd ? [expandPath(c.policy.cwd, homedir())] : [])])
  return discoverSkills(claudeDir(), [...cwds]).filter(s => !loadedSkills.size || loadedSkills.has(s.name))
}
function allSkills(): SkillEntry[] {
  const found = discovered()
  const table = assign(loadTable(COMMANDS_FILE), found.map(s => s.name), builtins.keys())
  saveTable(COMMANDS_FILE, table)
  const usage = skillUsage.all()
  return found.map(s => ({ name: s.name, command: table[s.name]!, description: s.description, uses: usage[s.name]?.count ?? 0 }))
}
// 008 FR19: plugins and MCP servers that turns in a cwd load, from their init events.
const loaded = createLoadedCache(cwd => probeInit(cwd, SETTINGS_FILE))
const cwdOf = (p: Policy) => p.cwd ? expandPath(p.cwd, homedir()) : config.cwd

/** Installed plugins plus any a turn loaded that aren't installed (synced ones); never the channel plugin or Claude Code's built-ins. */
function pluginsFor(cwd: string, seen: Loaded): Plugin[] {
  const installed = installedPlugins(claudeDir(), cwd)
  const extra = seen.plugins
    .filter(id => !id.endsWith('@builtin') && !installed.some(x => x.id === id))
    .map(id => ({ id, name: id.split('@')[0]!, on: true }))
  return [...installed, ...extra].filter(x => x.id !== CHANNEL_PLUGIN).sort((a, b) => a.name.localeCompare(b.name))
}

/** 008 FR19: the skills on in this chat or topic; switched-off ones are hidden and refused. */
function skillsHere(key: string): SkillEntry[] {
  const p = policyOf(key)
  const plugins = pluginsFor(cwdOf(p), loaded.peek(cwdOf(p)))
  return allSkills().filter(s => skillOn(p, s.name, plugins))
}
function readSkillFile(name: string): string | undefined {
  const path = discovered().find(s => s.name === name)?.path
  try { return path ? readFileSync(path, 'utf8') : undefined } catch { return undefined }
}

/** 008 FR12: the Run button, as if the owner had sent `/<skill>` in this chat. */
function runSkillButton(msg: NonNullable<Context['callbackQuery']>['message'] & {}, from: Context['from'] & {}, name: string): void {
  const key = sessionKey(msg as Parameters<typeof sessionKey>[0])
  const chat = msg.chat
  const topic = topicNames.get(key)
  const meta = {
    chat_id: String(chat.id),
    chat_type: chat.type,
    ...('title' in chat && chat.title ? { chat_title: chat.title } : {}),
    ...(topic ? { topic } : {}),
    user: from.username ?? String(from.id),
    user_id: String(from.id),
    ts: new Date().toISOString(),
  }
  const skill = renderSkillInvocation(`/${name}`, meta)
  skillContext.set(key, skill.context)
  turns.enqueue(key, { prompt: skill.prompt, text: `/${name}` })
}

// 008 FR6: the / menu holds the built-ins only; skills live under /skills (FR12).
const menu = createMenu(
  () => buildMenus(commands),
  (scope, cmds) => bot.api.setMyCommands(cmds, { scope: { type: scope } }),
)
bot.on('message:text', async ctx => {
  const text = ctx.message.text
  if (await memoryAddReply(ctx)) return
  if (await cronAddReply(ctx)) return
  const r = route(text, ctx.me.username, builtins, loadTable(COMMANDS_FILE))
  if (r.kind === 'ignore') return
  if (r.kind === 'skill') {
    const name = r.text.slice(1).split(/\s/)[0]!
    if (!skillsHere(sessionKey(ctx.msg!)).some(s => s.name === name)) return void await ctx.reply(`${name} is off in this chat. Turn it on in /settings → 🧩 Skills, plugins & MCP.`)
    return handleInbound(ctx, text, undefined, undefined, r.text)
  }
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
