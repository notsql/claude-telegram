# 008 — Plan

## Modules
```
src/commands/
  registry.ts    { name, scope[], requiresApprover, handler, description } for built-ins
  skillMap.ts    discover skills → telegram-safe names, collision table (commands.json)
  menu.ts        build per-scope command lists (≤100, ranked) → setMyCommands; debounced refresh
  handlers/      session.ts memory.ts history.ts skills.ts cron.ts policy.ts help.ts
  dispatch.ts    bot.on('message:text') pre-router: parse /cmd[@bot] args → built-in | skill | passthrough
src/agent/sessionTools.ts   session_new/resume/set_model/status tools (parity)
```

## Discovery of skills
Scan these locations:
- `~/.claude/skills/*/SKILL.md`
- `<cwd>/.claude/skills/*/SKILL.md` for each distinct chat `cwd`
- the installed plugin skill dirs (`~/.claude/plugins/cache/**/skills/*/SKILL.md`)

Only `name` and `description` are parsed. If the stream-json `system/init` event from `claude -p` lists the loaded skills or slash commands, prefer that (the runner caches it from the latest turn per cwd) and keep the filesystem scan as a fallback (check in T801).

**T801 result (Claude Code 2.1.292, 2026-10-07):** yes. The `system/init` event carries `skills` (names only, plugin skills as `plugin:skill`), `slash_commands` (skills plus built-ins such as `clear`, `compact`, `model`, `context`, and internal ones prefixed `__`), `agents` and `plugins`. It has no descriptions. Decision: the init event is the source of truth for *which* skills are loaded in a cwd (the runner caches it from the latest turn per cwd); the filesystem scan above is kept only to read each listed skill's `description` for the Telegram menu, and as the fallback before any turn has run in that cwd. Built-ins come from 008's own registry, not from `slash_commands`.

## Name mapping
```
deploy-blog          → deploy_blog
telegram:access      → telegram_access
very-long-skill-name-exceeding-32-chars → very_long_skill_name_exceeding_3 (+ _2 on collision)
```
Mappings persist in `commands.json`, so a name stays stable once assigned.

## Dispatch
`dispatch.ts` runs after `gate()` (or `dmCommandGate()` for DMs):
1. Built-in command → handler.
2. Mapped skill → `router.dispatch(key, "/<original-skill-name> <args>")`. The prompt starts with the native slash invocation, which `claude -p` expands (headless docs: "Include `/skill-name` in the prompt string").
3. Otherwise → pass to the router as plain text.

The current `bot.command('start' | 'help' | 'status')` handlers move into `handlers/help.ts`.

## Risks
- **Telegram API rate limits on `setMyCommands`**: handled by the debounce and by diffing against the last pushed list.
- **Plugin skill names that are meaningless to users**: allow `commands.json` to hide names or set aliases.
