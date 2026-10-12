/**
 * Learned agents in the chat: Save or Skip on a proposed agent (009 FR8), and
 * Archive or Keep on unused ones (009 T911).
 */

import type { Bot } from 'grammy'
import { join } from 'path'
import { loadAccess } from '../../access.ts'
import type { createAgentApplier } from '../../agents/apply.ts'
import { archiveAgent, staleAgents } from '../../agents/prune.ts'
import type { createAgentUsage } from '../../agents/usage.ts'
import { claudeDir } from '../../memory/paths.ts'
import { STALE_DAYS } from '../../skills/prune.ts'
import { MAX_ARCHIVE_PROMPTS, registerArchivePrompts } from './archive.ts'
import { answer, failed, isOwner, ownerOnly } from './ui.ts'

export type AgentsDeps = {
  applier: ReturnType<typeof createAgentApplier>
  usage: ReturnType<typeof createAgentUsage>
}

export function registerAgents(bot: Bot, { applier, usage }: AgentsDeps) {
  bot.callbackQuery(/^agt:(save|skip):([0-9a-f]+)$/, async ctx => {
    if (!isOwner(ctx)) return ownerOnly(ctx)
    const save = ctx.match[1] === 'save'
    void answer(ctx, save ? '✅ Saved' : 'Skipped')
    const r = applier.decide(ctx.match[2]!, save)
    if (!r || r.error) return failed(ctx, r?.error ?? 'already decided')
    if (r.text) await ctx.editMessageText(r.text).catch(() => {})
    else await ctx.deleteMessage().catch(() => {})
  })

  const askArchive = registerArchivePrompts<{ dir: string; name: string }>(bot, 'agt', 'Agent', a => archiveAgent(a.dir, a.name))

  return {
    /** Weekly: unused learned agents, offered to the first owner, kept under the 12-agent description budget. */
    proposeArchives(): void {
      const owner = loadAccess().allowFrom[0]
      if (!owner) return
      const dir = join(claudeDir(), 'agents')
      for (const name of staleAgents(dir, usage.all()).slice(0, MAX_ARCHIVE_PROMPTS)) askArchive(owner, { dir, name }, STALE_DAYS)
    },
  }
}
