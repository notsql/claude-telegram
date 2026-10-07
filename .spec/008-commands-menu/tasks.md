# 008 — Tasks
Depends on: 001–004 for the core set. Hooks into 005–007 as they land.

- [x] **T801** Spike: does the `claude -p` stream-json `system/init` event list the loaded skills or slash commands? Choose init-event discovery or the filesystem scan.
- [x] **T802** `skillMap.ts`: discovery, name normalisation, persistent collision table.
  *Verify:* AC4 with unit tests.
- [ ] **T803** `registry.ts` and `dispatch.ts`: built-in vs. skill vs. passthrough, `@botname` handling, approver checks.
  *Verify:* AC6, FR8, FR11.
- [ ] **T804** Session handlers and parity tools (`/new /resume /sessions /stop /model /compact /cost /status`).
  *Verify:* the US2 flows.
- [ ] **T805** Memory and history handlers (`/remember /forget /memory /search`) wired to 004 and 005.
  *Verify:* AC5.
- [ ] **T806** Skills handler (`/skills`) with show, rm and archive buttons, wired to 006.
- [ ] **T807** `/cron` inline manager wired to 007, and `/policy` wired to the 003 editor.
- [ ] **T808** `menu.ts`: per-scope lists, ranking, ≤100 commands, diff-and-debounce refresh on `skills-changed` and policy change.
  *Verify:* AC1, AC2.
- [ ] **T809** Skill command invocation with args.
  *Verify:* AC3.
- [ ] **T810** Move `/start /help /status` from `server.ts` and update the `/help` text to explain that plain language works for everything.
- [ ] **T811** Document the parity table in README and ACCESS.md.
