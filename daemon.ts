#!/usr/bin/env bun
/**
 * Headless daemon entry (FR1). Owns the grammY poller, the MCP and hook
 * endpoints, and runs each gated inbound message as a `claude -p` turn.
 * Access, pairing, approvals and attachments behave as in the legacy
 * `server.ts` channel (FR6), which stays runnable (FR13). The Telegram
 * buttons and commands live in `telegram/handlers/`; this file wires them up.
 */

import { Bot, GrammyError } from 'grammy'
import type { InlineKeyboardButton, ReactionTypeEmoji } from 'grammy/types'
import { autoRetry } from '@grammyjs/auto-retry'
import { apiThrottler } from '@grammyjs/transformer-throttler'
import { readFileSync, mkdirSync, rmSync } from 'fs'
import { killStale, writePidFile } from './util/proc.ts'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { STATE_DIR, initAccess, setBotUsername, loadAccess, dmCommandGate, checkApprovals, saveAccess } from './access.ts'
import { createApprovals } from './policy/approvals.ts'
import { addAlwaysAllow, policyKey, policyOf } from './policy/resolve.ts'
import { scopeDecision } from './policy/scope.ts'
import { createAudit } from './policy/audit.ts'
import { isTrustedCwd, policyArgs, policySettings } from './policy/args.ts'
import type { Policy } from './policy/schema.ts'
import { INBOX_DIR } from './telegram/attachments.ts'
import { startMcpServer } from './mcp/server.ts'
import { startBrowser } from './browser/server.ts'
import { registerSignin } from './browser/signin.ts'
import { startHookServer } from './hooks/endpoint.ts'
import { writeHookSettings } from './hooks/settings.ts'
import { inboxPath, insertItem, openInboxDb, type Item } from './watch/store.ts'
import { loadSources, recordItem, setEnabled, type Source } from './watch/registry.ts'
import { updatesKey } from './telegram/updates.ts'
import { createHealth, registerHealthButtons } from './watch/health.ts'
import { runSweep } from './watch/sweep.ts'
import { adapterFor, createSupervisor, type RunPoller } from './watch/supervisor.ts'
import { createIngestRoute } from './watch/ingest.ts'
import { runDigest } from './watch/digest.ts'
import { digestTitle, prefsOf, startDigestCrons } from './watch/digestPrefs.ts'
import { registerDigest } from './telegram/handlers/digest.ts'
import { createWatchTools, doPrompt, draftPrompt, registerDraftButtons } from './watch/tools.ts'
import { bunSendSpawn } from './watch/send.ts'
import { createTriage, type TriageRules } from './watch/triage.ts'
import { createDeliver, registerInboxButtons } from './watch/deliver.ts'
import { isMissingSession, runTurn, type RunTurnOpts, type TurnOutcome } from './agent/runner.ts'
import type { StreamEvent } from './agent/stream.ts'
import { parseKey } from './sessions/key.ts'
import { createSessionStore } from './sessions/store.ts'
import { createSessionLifecycle } from './sessions/lifecycle.ts'
import { createParticipants } from './sessions/participants.ts'
import { createSessionTools } from './agent/sessionTools.ts'
import { createTurnQueue } from './sessions/queue.ts'
import { renderInbound } from './agent/inbound.ts'
import { startProgress } from './agent/progress.ts'
import { apiKeyRefusal, isLoggedIn } from './agent/auth.ts'
import { ENV_FILE, loadConfig, loadEnvFile, cliVersionRefusal, createTurnBudget } from './config.ts'
import { claudeDir, memoryRoot, userDir } from './memory/paths.ts'
import { installAssets } from './agents/install.ts'
import { openHistoryDb } from './history/db.ts'
import { startIndexer } from './history/indexer.ts'
import { createHistoryTools, scopeFor } from './history/tools.ts'
import { recall, withContext } from './history/recall.ts'
import { search } from './history/search.ts'
import { createMemoryStore } from './memory/store.ts'
import { createMemoryTools } from './memory/tools.ts'
import { createInjector } from './memory/inject.ts'
import { bridgePaths, importEnabled } from './memory/bridge.ts'
import { createNotices } from './memory/notices.ts'
import { createReflectionWorker } from './reflection/worker.ts'
import { createApplier } from './reflection/apply.ts'
import { ProposalsSchema, RefinementSchema, refinementInput, skillsContext, type Proposals } from './reflection/prompt.ts'
import { toolCalls } from './reflection/transcript.ts'
import { runOneShot } from './agent/oneshot.ts'
import { createSkillStore, type SkillStore } from './skills/store.ts'
import { skillsRoot, takenNames } from './skills/paths.ts'
import { createSkillApplier } from './skills/apply.ts'
import { createSkillTools } from './skills/tools.ts'
import { createSkillUsage, invokedSkill } from './skills/usage.ts'
import { gapHint } from './capabilities/gap.ts'
import { createSkillNotices } from './skills/notices.ts'
import { createDiscovery } from './skills/discovery.ts'
import { createAgentUsage } from './agents/usage.ts'
import { AUTHOR, createAgentTools } from './agents/tools.ts'
import { createAgentApplier, learnedAgents } from './agents/apply.ts'
import { evalTargets, skillCreatorInstalled } from './agents/prune.ts'
import { registry, type Command } from './commands/registry.ts'
import { START_TEXT, helpText } from './commands/help.ts'
import { buildMenus, createMenu } from './commands/menu.ts'
import { createEngine } from './scheduler/engine.ts'
import { failureNotice, runJob } from './scheduler/run.ts'
import { createScheduleTools } from './scheduler/tools.ts'
import type { Job } from './scheduler/store.ts'
import { startSystemJobs, type SystemJobId } from './scheduler/system.ts'
import { registerClose, sendTo } from './telegram/handlers/ui.ts'
import { registerMemory } from './telegram/handlers/memory.ts'
import { registerSkills } from './telegram/handlers/skills.ts'
import { registerAgents } from './telegram/handlers/agents.ts'
import { registerCapabilities } from './telegram/handlers/capabilities.ts'
import { registerSources } from './telegram/handlers/sources.ts'
import { findBin } from './watch/onboard.ts'
import { addExample, examplesBlock, loadExamples } from './watch/prefs.ts'
import { createCapabilityRequests } from './capabilities/request.ts'
import { createCapabilityTools } from './capabilities/tools.ts'
import { runArgv } from './capabilities/install.ts'
import { createResumer } from './capabilities/resume.ts'
import { createCapabilityNotices } from './capabilities/notices.ts'
import { linkSkill, loadLedger, unlearned, useSkillName } from './capabilities/ledger.ts'
import { registerSessions } from './telegram/handlers/sessions.ts'
import { registerUsage } from './telegram/handlers/usage.ts'
import { registerSettings } from './telegram/handlers/settings.ts'
import { registerCron } from './telegram/handlers/cron.ts'
import { registerApprovals } from './telegram/handlers/approvals.ts'
import { registerInbound, type Inbound } from './telegram/handlers/inbound.ts'

const PID_FILE = join(STATE_DIR, 'daemon.pid')
const SETTINGS_FILE = join(STATE_DIR, 'hook-settings.json')
const COMMANDS_FILE = join(STATE_DIR, 'commands.json')
// 003 FR4 makes this configurable.
const APPROVAL_TIMEOUT_SEC = 60
// FR9: the whole shutdown, including the child's SIGINT → SIGTERM → SIGKILL escalation (7s).
const SHUTDOWN_DEADLINE_MS = 9000

const log = (line: string) => process.stderr.write(`telegram daemon: ${line}\n`)

loadEnvFile()

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
// 011 FR4: the PID file holds `<pid> <start time>`, so an older poller is recognised
// however it was launched (bun daemon.ts, bun cli.ts start, compiled binary) and a
// reused PID never matches. An old plain-PID file has no start time: left alone.
{
  const stale = killStale(PID_FILE)
  if (stale) log(`replacing stale poller pid=${stale}`)
}
writePidFile(PID_FILE, process.pid)

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
bot.on('callback_query', (_, next) => { void next().catch(err => log(`callback handler error: ${err}`)) })
if (!STATIC) setInterval(() => checkApprovals(bot.api), 5000).unref()

// FR10: a missing login is reported, not fatal; the owner can log in without a restart.
if (!isLoggedIn()) {
  const msg = 'claude is not logged in. Run `claude auth login` on the daemon host.'
  log(msg)
  for (const owner of loadAccess().allowFrom) void bot.api.sendMessage(owner, msg).catch(() => {})
}

const mcpToken = randomBytes(32).toString('hex')
const hookToken = randomBytes(32).toString('hex')

/** Sends a proposal with its decision buttons to the key's chat. */
const propose = (key: string, text: string, buttons: InlineKeyboardButton[]) =>
  void sendTo(bot.api, key, text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text, { reply_markup: { inline_keyboard: [buttons] } })
const button = (text: string, callback_data: string) => ({ text, callback_data })

// 004: one shared memory, the workspace project's auto-memory dir (FR2).
const memory = createMemoryStore(memoryRoot(config.cwd))
const userStore = (id: string) => createMemoryStore(userDir(memory.dir, id))
const notices = createNotices(bot.api)
const memoryTools = createMemoryTools(memory, userStore, (key, change) => void notices.notify(key, change))
const injector = createInjector({ store: memory, userStore, indexImported: () => importEnabled(bridgePaths(memory.dir)) })
const participants = createParticipants()
// 005: index Claude Code transcripts for history search (FR1, FR3).
const historyDb = openHistoryDb(join(STATE_DIR, 'history.db'))
const stopIndexer = startIndexer(historyDb, join(claudeDir(), 'projects'), log)
const sessions = createSessionStore(join(STATE_DIR, 'sessions.json'))
const historyTools = createHistoryTools({ db: historyDb, sessions })

// 006: learned skills, one store per root (user, or a chat's project cwd).
const skillStores = new Map<string, SkillStore>()
const skillStoreFor = (key: string) => {
  const root = skillsRoot(policyOf(key))
  let st = skillStores.get(root)
  if (!st) skillStores.set(root, st = createSkillStore(root))
  return st
}
// 012 FR9: a learned use-<name> skill links to its capability.
const skillNotices = createSkillNotices(bot.api, name => { linkSkill(STATE_DIR, name) })
const skillApplier = createSkillApplier({
  store: skillStoreFor,
  taken: st => takenNames(st.root, [config.cwd]),
  policy: policyOf,
  sessionOf: key => sessions.current(key),
  notify: (key, change) => void skillNotices.notify(key, change),
  ask: (key, text, id, kind) => propose(key, text, kind === 'diff'
    ? [button('✅ Apply', `skl:save:${id}`), button('✕ Skip', `skl:skip:${id}`)]
    : [button('✅ Save', `skl:save:${id}`), button('✏️ Edit', `skl:edit:${id}`), button('✕ Skip', `skl:skip:${id}`)]),
  log,
})
const skillTools = createSkillTools(skillStoreFor, skillApplier)
const skillUsage = createSkillUsage(join(STATE_DIR, 'skills-usage.json'))
const isLearnedSkill = (key: string, name: string) => skillStoreFor(key).read(name)?.metadata.source === 'tg'

// 009: subagents. agent_* tools work only while tg-skill-author runs for the key, as a subagent or the main agent (T908).
const agentUsage = createAgentUsage(join(STATE_DIR, 'agents-usage.json'))
const authorRuns = new Map<string, Set<string>>()
const agentTools = createAgentTools(join(claudeDir(), 'agents'),
  key => policyOf(key).agent === AUTHOR || !!authorRuns.get(key)?.size)
// 009 FR8: learned agents proposed by reflection.
const agentApplier = createAgentApplier({
  dir: join(claudeDir(), 'agents'),
  policy: policyOf,
  notify: (key, text) => void sendTo(bot.api, key, text),
  ask: (key, text, id) => propose(key, text, [button('✅ Save', `agt:save:${id}`), button('✕ Skip', `agt:skip:${id}`)]),
  log,
})

/** 006 FR7, FR8: record outcomes; a skill that keeps failing gets a refinement proposal for approval (AC6). */
async function skillOutcomes(key: string, outcomes: Proposals['skill_outcomes'], delta: string): Promise<void> {
  for (const { name, outcome } of outcomes) {
    if (!isLearnedSkill(key, name) || !skillUsage.outcome(name, outcome)) continue
    log(`skills: refining ${name} after repeated failures`)
    const p = await runOneShot('tg-reflector', refinementInput(skillStoreFor(key).text(name)!, delta), RefinementSchema)
    skillApplier.one(key, { ...p, op: 'patch', name, confidence: 1 }, true)
  }
}

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
  ask: (key, text, id) => propose(key, text, [button('✅ Save', `mem:save:${id}`), button('✕ Skip', `mem:skip:${id}`)]),
  log,
})
const reflection = createReflectionWorker({
  reflect: input => runOneShot('tg-reflector', input, ProposalsSchema),
  existing: key => {
    const p = policyOf(key)
    if (p.memoryScope === 'none' || !p.autoLearn || p.autoLearn === 'off') return null
    const lines = memory.list().map(e => `${e.name} (${e.type}): ${e.description}`)
    for (const id of participants.active(key)) {
      for (const e of userStore(id).list()) lines.push(`user_model user_id=${id} ${e.name}: ${e.description}`)
    }
    return lines.join('\n')
  },
  skills: (key, delta, payload) => {
    const p = policyOf(key)
    if (!p.autoLearn || p.autoLearn === 'off') return null
    const learned = skillStoreFor(key).list().filter(s => s.metadata.source === 'tg')
    return skillsContext(learned, toolCalls(delta), similarRequests(key, delta, payload.session_id), learnedAgents(join(claudeDir(), 'agents')),
      unlearned(loadLedger(STATE_DIR)).map(c => `${useSkillName(c)}: ${c.kind} ${c.name}`))
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
// 012 FR5: capability requests go to the owner DM; the daemon runs the install.
const capabilityRequests = createCapabilityRequests({
  api: bot.api,
  stateDir: STATE_DIR,
  owners: () => loadAccess().allowFrom,
  sender: key => participants.active(key)[0],
  install: argv => runArgv(argv),
  generation: key => sessions.generation(key),
  onInstalled: (origin, req, entry) => {
    void capabilityNotices.notify(updatesKey(STATE_DIR, loadAccess().allowFrom[0]!), entry)
    return resumer.installed(origin, req.candidate.name, req.resume, req.candidate.auth)
  },
})
// 012 FR10: install notices with Undo; the skill is archived from the owner DM's store, where FR9 learned it.
const capabilityNotices = createCapabilityNotices({
  api: bot.api,
  stateDir: STATE_DIR,
  uninstall: argv => runArgv(argv),
  archiveSkill: name => { skillStoreFor(loadAccess().allowFrom[0]!).archive(name) },
})
// 012 FR7/FR8: login handoff, then a follow-up turn queued in the origin session (same runInSession path as `mode: session` jobs).
const resumer = createResumer({
  api: bot.api,
  owners: () => loadAccess().allowFrom,
  generation: key => sessions.generation(key),
  run: (key, text) => turns.enqueue(key, {
    prompt: renderInbound(text, { origin: 'capability', chat_id: parseKey(key).chatId, ts: new Date().toISOString() }),
    text,
  }),
})
// 013 FR9: inbox/source/draft tools, owner DM only. Sends run only from the owner's Send tap.
const inboxDb = config.watch ? openInboxDb(inboxPath(STATE_DIR)) : undefined
const watchTools = inboxDb && createWatchTools({
  db: inboxDb, stateDir: STATE_DIR, api: bot.api, spawn: bunSendSpawn, audit: e => audit(e),
  isOwnerDm: key => { const t = parseKey(key); return t.threadId == null && loadAccess().allowFrom.includes(t.chatId) },
  // T1308: add/pause/resume/remove reach the running supervisor (created below).
  live: { start: s => watch?.supervisor.startSource(s), stop: id => watch?.supervisor.stopSource(id) },
  // 013 FR16: the first source added offers the digest setup; settings changes reschedule it.
  added: () => digestUi?.offer().catch(e => log(`digest setup: ${e}`)),
  digestChanged: () => digestCrons?.reload(),
})
const mcpServer = startMcpServer({ authToken: mcpToken, api: bot.api, botToken: TOKEN, memory: memoryTools, history: historyTools, skills: skillTools, agents: agentTools, session: sessionTools, scheduler: scheduleTools, capabilities: createCapabilityTools(capabilityRequests), watch: watchTools })
const audit = createAudit(join(STATE_DIR, 'audit.log'))
const browser = config.browser ? startBrowser({ dir: join(STATE_DIR, 'browser'), log }) : undefined
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
// 008 FR23: automatic messages go to the 📍 Updates chat picked on ⚙️ Settings, else the owner DM.
const BOT_ID = TOKEN.split(':')[0]
const inboxTarget = (owner: string): { chatId: string; threadId?: number } => parseKey(updatesKey(STATE_DIR, owner))
const updatesTo = () => { const owner = loadAccess().allowFrom[0]; return owner && updatesKey(STATE_DIR, owner) }
// 013 FR1, FR12: source watchers, only with TELEGRAM_WATCH=1. Items land in inbox.db,
// go through triage, and urgent/action items ping the owner (first allowFrom).
// Mutes and VIPs are in-memory until 014 makes them memory.
const watch = config.watch ? (() => {
  const db = inboxDb!
  const rules: TriageRules = { mutedChats: [], mutedSenders: [], vips: [] }
  const examples = () => examplesBlock(loadExamples(STATE_DIR))
  const triage = createTriage({ db, rules, log, run: runOneShot, budget: { take: () => budget.take() }, examples })
  const owner = loadAccess().allowFrom[0]
  const deliver = owner ? createDeliver({ db, api: bot.api, target: () => inboxTarget(owner), vips: rules.vips, log, run: runOneShot, budget: { take: () => budget.take() }, examples,
    dislike: r => addExample(STATE_DIR, { itemId: r.id, text: r.text, want: false, at: Date.now() }), mute: (_source, fromId) => void rules.mutedSenders.push(fromId),
    // Do it: a turn in the owner DM that carries out the task (T1314).
    act: r => turns.enqueue(owner, {
      prompt: renderInbound(doPrompt(r), { origin: 'inbox', chat_id: owner, ts: new Date().toISOString() }),
      text: 'Do it',
    }),
    // Draft reply: a turn in the owner DM that calls draft_reply (T1307).
    draft: r => turns.enqueue(owner, {
      prompt: renderInbound(draftPrompt(r), { origin: 'inbox', chat_id: owner, ts: new Date().toISOString() }),
      text: 'Draft reply',
    }),
  }) : undefined
  if (!owner) log('watch: no owner in allowFrom; pings disabled')
  const insert = (source: Source, item: Item) => {
    // The owner's Telegram account also sees this bot's own messages; don't triage them.
    if (item.from.id === `user:${BOT_ID}`) return
    const id = insertItem(db, item)
    if (id === null) return
    recordItem(STATE_DIR, source.id, Date.now())
    triage.add(id)
  }
  const store = (source: Source, payload: unknown) => {
    const item = adapterFor(source)?.map(source.id, payload)
    if (item) insert(source, item)
  }
  let sources: Source[] = []
  try { sources = loadSources(STATE_DIR) } catch (err) { log(`watch: sources.json unreadable: ${err}`) }
  const runPoller: RunPoller = (input, schema, tools) => budget.take()
    ? runOneShot('tg-poller', input, schema, tools)
    : Promise.reject(new Error('daily turn budget spent'))
  const supervisor = createSupervisor({
    stateDir: STATE_DIR, sources, onPayload: store, onItem: insert, log, pidDir: join(STATE_DIR, 'watch'), runPoller,
  })
  const route = createIngestRoute({
    secretOf: supervisor.secretOf,
    header: id => adapterFor(supervisor.source(id)!)?.signatureHeader ?? 'x-signature',
    store: (id, payload) => store(supervisor.source(id)!, payload),
    log,
  })
  // FR10: one Fix/Pause notice per failing or silent source.
  const health = owner ? createHealth({
    stateDir: STATE_DIR, api: bot.api, target: () => inboxTarget(owner), log,
    fix: prompt => turns.enqueue(owner, {
      prompt: renderInbound(prompt, { origin: 'inbox', chat_id: owner, ts: new Date().toISOString() }),
      text: 'Fix source',
    }),
    pause: id => { setEnabled(STATE_DIR, id, false); supervisor.stopSource(id) },
  }) : undefined
  return { db, supervisor, route, triage, deliver, health, examples, runPoller }
})() : undefined
const hookServer = startHookServer({ authToken: hookToken, log, ingest: watch?.route, handlers: {
  'permission-request': approvals.handle,
  'session-start': (payload, key) => injector.sessionStart(payload, policyOf(key), participants.active(key)),
  'user-prompt-submit': (payload, key) => {
    memoryTools.startTurn(key)
    skillTools.startTurn(key)
    agentTools.startTurn(key)
    const policy = policyOf(key)
    const out = injector.userPromptSubmit(payload, policy, participants.active(key))
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
    return gapHint(payload)
  },
  'post-tool-use-failure': payload => gapHint(payload),
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

// 008 FR4, FR19: the skills, plugins and MCP servers each chat can use.
const discovery = createDiscovery({
  defaultCwd: config.cwd,
  commandsFile: COMMANDS_FILE,
  settingsFile: SETTINGS_FILE,
  reserved: () => builtins.keys(),
  usage: () => skillUsage.all(),
})

const turnAbort = new AbortController()
// FR10: set when a turn hits a usage limit; queued turns wait until then.
let pausedUntil = 0
const budget = createTurnBudget(config.dailyTurnBudget)
// After `budget`: agent-poll and triage take from it.
void watch?.supervisor.start(hookServer.port)
watch?.triage.start()
watch?.deliver?.start()
watch?.health?.start()

const pauseMessage = (until: number) => `Usage limit reached. Paused until ${new Date(until).toLocaleString()}.`

// Telegram only allows reactions from a fixed set, which has no hourglass.
const QUEUED_REACTION = '🫡'

const setReaction = (chatId: string, msgId: number, emoji: string | undefined) =>
  void bot.api.setMessageReaction(chatId, msgId, emoji ? [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }] : []).catch(() => {})

/** Why a turn can't run under `policy`: an untrusted cwd (FR13) or a spent daily budget (FR11). */
function turnRefusal(policy: Policy): string | undefined {
  if (policy.cwd && !isTrustedCwd(policy.cwd, loadAccess().trustedDirs)) return `cwd ${policy.cwd} is not in trustedDirs; add it with /telegram:access`
  if (!budget.take()) return `daily turn budget (${config.dailyTurnBudget}) is used up; try again tomorrow`
}

function turnOpts(policy: Policy, signal: AbortSignal, onEvent: (ev: StreamEvent) => void): RunTurnOpts {
  return {
    settingsFile: SETTINGS_FILE,
    mcpPort: mcpServer.port,
    browserPort: browser?.port,
    mcpToken,
    hookToken,
    cwd: discovery.cwdOf(policy),
    maxTurns: policy.maxTurns ?? config.maxTurns,
    policyArgs: policyArgs(policy),
    settings: policySettings(policy),
    signal,
    onEvent,
  }
}

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

// 002 FR5/FR6: serial per key, up to N keys at once, mid-turn messages batched.
const turns = createTurnQueue<Inbound>({
  concurrency: config.maxConcurrentSessions,
  // 007 FR9: scheduled runs share the slots, keyed `job:<id>` so one job never overlaps itself.
  run: (key, batch) => (key.startsWith(JOB_PREFIX) ? fireJob(key.slice(JOB_PREFIX.length))
    : key.startsWith(SYS_PREFIX) ? fireSystemJob(key.slice(SYS_PREFIX.length) as SystemJobId | 'digest')
    : runBatch(key, batch))
    .catch(err => { log(`turn failed: ${err}`) }),
  onQueued: (key, item) => {
    item.queued = true
    if (item.msgId != null) setReaction(parseKey(key).chatId, item.msgId, QUEUED_REACTION)
  },
})

async function runBatch(key: string, batch: Inbound[]): Promise<void> {
  const chatId = parseKey(key).chatId
  const notify = (text: string) => sendTo(bot.api, key, text)
  if (turnAbort.signal.aborted) return
  // The queued reaction goes back to the ack (or none) once the turn starts.
  const ack = loadAccess().ackReaction
  for (const m of batch) if (m.queued && m.msgId != null) setReaction(chatId, m.msgId, ack)
  if (pausedUntil > Date.now()) {
    await notify(`${pauseMessage(pausedUntil)} Your message will run then.`)
    await new Promise<void>(r => {
      const t = setTimeout(r, pausedUntil - Date.now())
      turnAbort.signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true })
    })
    if (turnAbort.signal.aborted) return
  }
  const policy = policyOf(key)
  const refusal = turnRefusal(policy)
  if (refusal) return void await notify(`Turn refused: ${refusal}.`)
  const turn = new AbortController()
  runningTurns.set(key, turn)
  const progress = startProgress(bot.api, parseKey(key))
  // /model and session-scoped Allow apply on top of the chat's policy.
  const session = { ...policy, model: lifecycle.model(key) ?? policy.model, alwaysAllow: [...policy.alwaysAllow ?? [], ...lifecycle.allowed(key)] }
  const prompt = batch.map(m => m.prompt).join('\n\n')
  const outcome = await runInSession(key, prompt, batch[0]!.text, turnOpts(session, AbortSignal.any([turnAbort.signal, turn.signal]), progress.onEvent))
    .finally(() => {
      progress.finish()
      if (runningTurns.get(key) === turn) runningTurns.delete(key)
    })
  if (outcome.init && discovery.record(discovery.cwdOf(policy), outcome.init)) menu.refresh()
  if (outcome.result) lifecycle.recordTurn(outcome.result.session_id, outcome.result.total_cost_usd)
  if (turn.signal.aborted && !turnAbort.signal.aborted) await notify('Stopped.')
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

// Telegram commands and buttons (008).
const memoryUi = registerMemory(bot, { memory, userStore, notices, applier })
const skillsUi = registerSkills(bot, {
  discovery,
  storeFor: skillStoreFor,
  applier: skillApplier,
  notices: skillNotices,
  usage: skillUsage,
  runInbound: (ctx, text, invocation) => inbound.handle(ctx, text, undefined, undefined, invocation),
  runSkill: (msg, from, name) => inbound.runSkill(msg, from, name),
})
const agentsUi = registerAgents(bot, { applier: agentApplier, usage: agentUsage })
const sessionsUi = registerSessions(bot, {
  ...sessionDeps,
  runningTurns,
  hasSession: key => !!sessions.current(key),
  compact: key => turns.enqueue(key, { prompt: '/compact', text: '/compact' }),
})
const usageCommand = registerUsage(bot)
const settingsCommand = registerSettings(bot, { discovery, audit, refreshMenu: () => menu.refresh(), sources: !!watch, signin: !!browser, stateDir: STATE_DIR })
const signinUi = browser && registerSignin(bot, { open: url => browser.open(url), log })
const cronUi = registerCron(bot, { stateDir: STATE_DIR, tools: scheduleTools, reload: () => scheduler.reload(), runNow: id => queueJob(id) })
registerClose(bot)
if (watch?.deliver) registerInboxButtons(bot, watch.deliver)
if (watch?.health) registerHealthButtons(bot, watch.health)
const capsUi = registerCapabilities(bot, capabilityRequests, resumer, capabilityNotices)
const draftReply = watchTools && registerDraftButtons(bot, watchTools)
const sourcesUi = watch && registerSources(bot, { stateDir: STATE_DIR, db: watch.db, live: { start: s => watch.supervisor.startSource(s), stop: id => watch.supervisor.stopSource(id) }, which: findBin,
  owner: () => loadAccess().allowFrom[0],
  setup: (prompt, text) => {
    const owner = loadAccess().allowFrom[0]
    if (owner) turns.enqueue(owner, { prompt: renderInbound(prompt, { origin: 'inbox', chat_id: owner, ts: new Date().toISOString() }), text })
  },
  added: () => digestUi?.offer().catch(e => log(`digest setup: ${e}`)),
})
// 013 FR16: 🗞 Digest pages and the one-time setup message.
const digestUi = watch && registerDigest(bot, { stateDir: STATE_DIR, to: () => updatesTo() || undefined, reload: () => digestCrons?.reload() })
// The approval buttons catch all other callback data, so they go last.
const textApproval = registerApprovals(bot, approvals, (ctx, emoji) => {
  if (ctx.chat && ctx.message) setReaction(String(ctx.chat.id), ctx.message.message_id, emoji)
})

// Built-ins, routed ahead of the agent, in menu and /help order. /start and /help are DM-only, as in the channel server: no pairing-code leaks to groups.
const commands: Command[] = [
  sessionsUi.stop,
  memoryUi.command,
  skillsUi.command,
  sessionsUi.sessions,
  usageCommand,
  { name: 'start', description: 'Welcome and setup guide', menu: ['private'], handler: async ctx => {
    if (dmCommandGate(ctx)) await ctx.reply(START_TEXT)
  } },
  { name: 'help', description: 'What this bot can do', menu: ['private'], handler: async ctx => {
    if (dmCommandGate(ctx)) await ctx.reply(helpText(commands))
  } },
  settingsCommand,
  cronUi.command,
  capsUi.command,
]
const builtins = registry(commands)
// 008 FR6: the / menu holds the built-ins only; skills live under /skills (FR12).
const menu = createMenu(
  () => buildMenus(commands),
  (scope, cmds) => bot.api.setMyCommands(cmds, { scope: { type: scope } }),
)

const inbound = registerInbound(bot, {
  token: TOKEN,
  enqueue: (key, item) => turns.enqueue(key, item),
  participants,
  setSkillContext: (key, context) => skillContext.set(key, context),
  interrupt: key => { if (INTERRUPT_ON_NEW_MESSAGE) runningTurns.get(key)?.abort() },
  setReaction,
  commandsFile: COMMANDS_FILE,
  skillsHere: key => discovery.skillsHere(key),
  builtins,
  replies: [memoryUi.addReply, cronUi.addReply, skillsUi.addReply, ...draftReply ? [draftReply] : [], ...sourcesUi ? [sourcesUi.addReply] : [], ...digestUi ? [digestUi.noteReply] : [], ...signinUi ? [signinUi.siteReply] : []],
  beforeGate: skillsUi.editReply,
  textApproval,
})

// 007: scheduled jobs. A run goes through the turn queue like a message.
const JOB_PREFIX = 'job:'

/** FR4: fresh by default; `mode: session` resumes the chat's session. */
async function jobTurn(job: Job, prompt: string, policy: Policy, onEvent: (ev: StreamEvent) => void): Promise<TurnOutcome> {
  const refusal = turnRefusal(policy)
  if (refusal) return { refused: [refusal], exitCode: 1 }
  const opts = turnOpts(policy, turnAbort.signal, onEvent)
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
    post: (key, text) => sendTo(bot.api, key, text),
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

/** A fresh scheduled turn in the first owner's DM, logged as `what: done|error|<refusal>`. */
async function ownerTurn(what: string, title: string, text: string, policy?: Partial<Policy>): Promise<void> {
  const owner = loadAccess().allowFrom[0]
  if (!owner) return
  const prompt = renderInbound(text, { origin: 'scheduler', chat_id: owner, job_title: title, ts: new Date().toISOString() })
  const outcome = await jobTurn({ mode: 'fresh', sessionKey: owner } as Job, prompt, { ...policyOf(owner), ...policy }, () => {})
  log(`${what}: ${outcome.refused?.join('; ') ?? (outcome.result?.is_error ? 'error' : 'done')}`)
}

async function fireSystemJob(id: SystemJobId | 'digest'): Promise<void> {
  if (turnAbort.signal.aborted) return
  // 013 FR8: a one-shot summary, no turn; FR16: at the owner's times, with their choices.
  if (id === 'digest') {
    const owner = loadAccess().allowFrom[0]
    if (watch && owner) await runDigest({ db: watch.db, api: bot.api, to: inboxTarget(owner), title: digestTitle(new Date().getHours()), run: runOneShot, budget: { take: () => budget.take() }, examples: watch.examples, prefs: prefsOf(STATE_DIR), log })
    return
  }
  // 013 FR14: findings become `action` items; delivery sends them to the inbox target.
  if (id === 'attention-sweep') {
    if (!watch) return
    const n = await runSweep({ db: watch.db, sources: loadSources(STATE_DIR), runPoller: watch.runPoller, log })
    log(`attention sweep: ${n} new task(s)`)
    if (n) await watch.deliver?.tick()
    return
  }
  // 004 FR8: run as tg-curator (009).
  if (id === 'memory-consolidation') return ownerTurn('memory consolidation', 'Weekly memory consolidation', CONSOLIDATE_PROMPT, { agent: 'tg-curator' })
  skillsUi.proposeArchives(owner => updatesKey(STATE_DIR, owner))
  const to = updatesTo()
  if (to) agentsUi.proposeArchives(to)
  // 009 FR12: skill-creator evals, only when that plugin is installed and something has enough runs.
  const targets = evalTargets(agentUsage.all(), skillUsage.all())
  if (skillCreatorInstalled(claudeDir()) && (targets.agents.length || targets.skills.length)) await ownerTurn('evals', 'Weekly evals', evalPrompt(targets))
}

const systemJobs = startSystemJobs({
  stateFile: join(STATE_DIR, 'system-jobs.json'),
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  watch: config.watch,
  run: id => turns.enqueue(SYS_PREFIX + id, { prompt: '', text: '' }),
})
if (systemJobs.caughtUp.length) log(`scheduler: catching up system jobs ${systemJobs.caughtUp.join(', ')}`)
// 013 FR16: digest times come from digest-prefs.json and are rebuilt on change.
const digestCrons = watch ? startDigestCrons({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, prefs: () => prefsOf(STATE_DIR), run: () => turns.enqueue(SYS_PREFIX + 'digest', { prompt: '', text: '' }) }) : undefined
// An install that already has sources gets the setup once.
if (watch && (() => { try { return loadSources(STATE_DIR).length } catch { return 0 } })()) void digestUi?.offer().catch(e => log(`digest setup: ${e}`))

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
  digestCrons?.stop()
  stopIndexer()
  watch?.supervisor.stop()
  watch?.triage.stop()
  watch?.deliver?.stop()
  watch?.health?.stop()
  browser?.stop()
  void Promise.all([Promise.resolve(bot.stop()).catch(() => {}), turns.idle()]).finally(() => {
    mcpServer.stop()
    hookServer.stop()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

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
