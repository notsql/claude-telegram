/**
 * Skills in the chat (008 FR12, FR22): /skills with Run, Show, Archive,
 * Remove and + New skill; Save, Edit or Skip on proposed skills (006 FR6);
 * Show and Undo on skill notices (006 FR10); Archive or Keep on unused ones
 * (006 FR8). Archive, remove and approvals need the key's approvers (FR10, AC5).
 */

import type { Bot, Context } from 'grammy'
import type { InlineKeyboardMarkup, Message, User } from 'grammy/types'
import { loadAccess } from '../../access.ts'
import type { Command } from '../../commands/registry.ts'
import { policyOf } from '../../policy/resolve.ts'
import { sessionKey } from '../../sessions/key.ts'
import type { createSkillApplier } from '../../skills/apply.ts'
import { parseSkillsArgs, SKILLS_CALLBACK, skillsView, skillView, type SkillAction } from '../../skills/commands.ts'
import type { Discovery } from '../../skills/discovery.ts'
import { skillNoticeText, type createSkillNotices } from '../../skills/notices.ts'
import { staleSkills, STALE_DAYS } from '../../skills/prune.ts'
import type { SkillStore } from '../../skills/store.ts'
import type { createSkillUsage } from '../../skills/usage.ts'
import { withClose } from '../close.ts'
import { MAX_ARCHIVE_PROMPTS, registerArchivePrompts } from './archive.ts'
import { answer, appendLabel, canChange, createReplyPrompts, failed, isApprover, isOwner, keyOf, ownerOnly, sendTo } from './ui.ts'

export type SkillsDeps = {
  discovery: Discovery
  storeFor: (key: string) => SkillStore
  applier: ReturnType<typeof createSkillApplier>
  notices: ReturnType<typeof createSkillNotices>
  usage: ReturnType<typeof createSkillUsage>
  /** Runs `text` as a turn from `ctx`; `invocation` is a native `/<skill> <args>`. */
  runInbound: (ctx: Context, text: string, invocation?: string) => Promise<void>
  /** The Run button: as if the user had sent `/<skill>` in that chat. */
  runSkill: (msg: Message, from: User, name: string) => void
}

export function registerSkills(bot: Bot, deps: SkillsDeps) {
  const { discovery, storeFor, applier, notices, usage } = deps
  const adds = createReplyPrompts<string>(bot.api)
  const edits = createReplyPrompts<string>(bot.api)

  const command: Command = { name: 'skills', description: 'Browse, run and manage skills', menu: ['private', 'group'], handler: async (ctx, args) => {
    if (!isOwner(ctx)) return
    const here = discovery.skillsHere(sessionKey(ctx.msg!))
    const parsed = parseSkillsArgs(args)
    if (parsed === 'list') {
      const r = skillsView(here)
      return void await ctx.reply(r.text, r.keyboard ? { reply_markup: withClose(r.keyboard) } : {})
    }
    const skill = here.find(s => s.command === parsed.command || s.name === parsed.command)
    if (!skill) return void await ctx.reply(`No skill named ${parsed.command} is on here. Send /skills to see them all.`)
    await deps.runInbound(ctx, ctx.message!.text!, `/${skill.name}${parsed.args ? ` ${parsed.args}` : ''}`)
  } }

  bot.callbackQuery(SKILLS_CALLBACK, async ctx => {
    const msg = ctx.callbackQuery.message
    if (!msg || !isOwner(ctx)) return ownerOnly(ctx)
    const key = keyOf(msg)
    const [, action, arg] = ctx.match as unknown as [string, SkillAction | 'p' | 'n', string]
    const edit = (r: { text: string; keyboard?: InlineKeyboardMarkup }) =>
      ctx.editMessageText(r.text, r.keyboard ? { reply_markup: withClose(r.keyboard) } : {}).catch(() => {})
    if (action === 'p') {
      await answer(ctx)
      return void await edit(skillsView(discovery.skillsHere(key), Number(arg)))
    }
    if (action === 'n') {
      if (!canChange(ctx, key)) return answer(ctx, 'Not authorised.')
      if ((policyOf(key).autoLearn ?? 'off') === 'off') return answer(ctx, 'Skill learning is off here. Turn on Auto learn in /settings.', true)
      await answer(ctx)
      return adds.ask(key, '🧩 What should the new skill do? Describe it in plain words and reply to this message; I\'ll draft it for you.', 'e.g. Summarise a PR and list its risks', key)
    }
    const skill = discovery.skillsHere(key).find(s => s.command === arg)
    if (!skill) return answer(ctx, 'That skill is gone.')
    const store = storeFor(key)
    const own = !!store.read(skill.name)
    if ((action === 'a' || action === 'd') && (!own || !canChange(ctx, key))) return answer(ctx, 'Not authorised.')
    switch (action) {
      case 'o':
        await answer(ctx)
        return void await edit(skillView(skill, own))
      case 'r':
        await answer(ctx, `▶️ Running ${skill.name}`)
        return deps.runSkill(msg, ctx.from, skill.name)
      case 's': {
        await answer(ctx)
        const text = own ? store.text(skill.name) : discovery.readSkill(skill.name)
        return void await sendTo(bot.api, key, (text ?? 'Could not read that skill.').slice(0, 4000))
      }
      case 'a':
      case 'd': {
        void answer(ctx, action === 'a' ? `📦 Archived ${skill.name}` : `🗑 Removed ${skill.name}`)
        try {
          if (action === 'a') store.archive(skill.name)
          else store.remove(skill.name)
        } catch (err) {
          return failed(ctx, err instanceof Error ? err.message : String(err))
        }
        return void await edit(skillsView(discovery.skillsHere(key)))
      }
    }
  })

  // Save / Edit / Skip on a proposed skill, or Apply / Skip on a diff.
  bot.callbackQuery(/^skl:(save|skip|edit):([0-9a-f]+)$/, async ctx => {
    const [, action, id] = ctx.match as unknown as [string, 'save' | 'skip' | 'edit', string]
    const p = applier.pending(id)
    if (!p) return answer(ctx, 'Already decided.')
    if (!isApprover(p.key, ctx.from.id)) return answer(ctx, 'Not authorised to approve.')
    if (action === 'edit') {
      await edits.ask(p.key, p.draft, 'Reply with the edited skill', id, false)
      return answer(ctx, 'Reply to the draft with your edited version.')
    }
    void answer(ctx, action === 'save' ? '✅ Saved' : 'Skipped')
    const r = applier.decide(id, action === 'save')
    if (!r || r.error) return failed(ctx, r?.error ?? 'already decided')
    if (r.change) await ctx.editMessageText(skillNoticeText(r.change), { reply_markup: notices.keyboard(p.key, r.change) }).catch(() => {})
    else await ctx.deleteMessage().catch(() => {})
  })

  // Show and Undo on a skill notice.
  bot.callbackQuery(/^skl:(show|undo):([0-9a-f]+)$/, async ctx => {
    const [, action, id] = ctx.match as unknown as [string, 'show' | 'undo', string]
    const key = notices.keyOf(id)
    if (!key || !isApprover(key, ctx.from.id)) return answer(ctx, key ? 'Not authorised.' : 'Gone.')
    if (action === 'show') {
      await answer(ctx)
      return void await sendTo(bot.api, key, notices.show(id)!)
    }
    const label = notices.undo(id)
    if (!label) return answer(ctx, 'Nothing to undo.')
    await answer(ctx, label)
    await appendLabel(ctx, label)
  })

  const askArchive = registerArchivePrompts<{ key: string; name: string }>(bot, 'skl', 'Skill', a => storeFor(a.key).archive(a.name))

  /** A reply to + New skill: the description goes to the agent as a turn, which drafts it with `skill_create` (so `autoLearn` and the name checks apply). */
  async function addReply(ctx: Context): Promise<boolean> {
    const key = adds.peek(ctx)
    if (!key || !canChange(ctx, key)) return false
    adds.done(ctx)
    await deps.runInbound(ctx, `Create a new skill with skill_create. Pick a short name and write the steps. What it should do: ${ctx.message!.text ?? ''}`)
    return true
  }

  /** ✏️ Edit: an approver's reply to the draft saves the edited skill. True if it was one. */
  async function editReply(ctx: Context, text: string): Promise<boolean> {
    const id = edits.peek(ctx)
    const p = id && applier.pending(id)
    if (!id || !p || !isApprover(p.key, ctx.from!.id)) return false
    const r = applier.edit(id, text)!
    if (r.error) {
      await ctx.reply(`Not saved: ${r.error}`).catch(() => {})
      return true
    }
    edits.done(ctx)
    if (r.change) void notices.notify(p.key, r.change)
    return true
  }

  /** Weekly: stale learned skills in each owner's DM store, offered for archiving in session key `to(owner)` (the 📍 Updates chat). */
  function proposeArchives(to: (owner: string) => string): void {
    for (const owner of loadAccess().allowFrom) {
      for (const name of staleSkills(storeFor(owner), usage).slice(0, MAX_ARCHIVE_PROMPTS)) askArchive(to(owner), { key: owner, name }, STALE_DAYS)
    }
  }

  return { command, addReply, editReply, proposeArchives }
}
