# 010 — Agent Teams (Deferred)

**Status: deferred.** Activate this spec when Claude Code supports spawning teammates in non-interactive (`-p`) mode.

## Why deferred
From [agent-teams docs](https://code.claude.com/docs/en/agent-teams) (checked 2026-10-03, CLI 2.1.288):
- Teams are experimental and enabled with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- *"Spawning teammates also requires an interactive session. In non-interactive mode with the `-p` flag … Claude doesn't spawn teammates, and a subagent that Claude names runs as an ordinary subagent."*
- Other limitations: in-process teammates aren't restored on resume, one team per session, no nested teams, and token usage is much higher.

The daemon is built on `claude -p` (constitution VIII), so teams can't be used today. [009](../009-subagents-skills/spec.md) covers parallel work with subagents in the meantime.

## Intended behaviour (when unblocked)
- **US1**: "Spawn a team to review PR #142: security, performance, tests." The daemon runs a team turn, and the chat gets a live roster ("🧑‍🤝‍🧑 3 teammates working…") and the lead's synthesis.
- **US2**: Teammate permission prompts reach Telegram through the same `PermissionRequest` hook as everything else (003).
- **US3**: The `TaskCreated`/`TaskCompleted`/`TeammateIdle` hooks feed progress edits and act as quality gates (for example "tests must pass before a task completes").
- **US4**: Teams can be used per chat only when the policy allows it (`teamsAllowed`, off by default in groups because of cost).

## Readiness checks (re-run on each CLI upgrade)
- [ ] The docs or `system/init` `capabilities` show teammate spawning in `-p` mode.
- [ ] Team hooks fire in `-p` and carry enough identity (team, teammate name).
- [ ] Teammates survive or are cleanly rebuilt across `--resume`.

## Possible interim approach (not planned)
An interactive `claude` lead could be hosted in a detached tmux session, with prompts sent through `tmux send-keys` and results read from transcripts and hooks. This was rejected for now because it is fragile, hard to test, and works against constitution VII.
