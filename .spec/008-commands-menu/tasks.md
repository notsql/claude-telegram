# 008 — Tasks
Depends on: 001–004 for the core set. Hooks into 005–007 as they land.

- [x] **T801** Spike: does the `claude -p` stream-json `system/init` event list the loaded skills or slash commands? Choose init-event discovery or the filesystem scan.
- [x] **T802** `skillMap.ts`: discovery, name normalisation, persistent collision table.
  *Verify:* AC4 with unit tests.
- [x] **T803** `registry.ts` and `dispatch.ts`: built-in vs. skill vs. passthrough, `@botname` handling, approver checks.
  *Verify:* AC6, FR8, FR11.
- [x] **T804** Session handlers and parity tools (`/new /resume /sessions /stop /model /compact /cost /status`).
  *Verify:* the US2 flows.
- [x] **T805** Memory and history handlers (`/remember /forget /memory /search`) wired to 004 and 005.
  *Verify:* AC5.
- [x] **T806** Skills handler (`/skills`) with show, rm and archive buttons, wired to 006.
- [x] **T807** `/cron` inline manager wired to 007, and `/policy` wired to the 003 editor.
- [x] **T808** `menu.ts`: per-scope lists, ranking, ≤100 commands, diff-and-debounce refresh on `skills-changed` and policy change.
  *Verify:* AC1, AC2.
- [x] **T809** Skill command invocation with args.
  *Verify:* AC3.
- [x] **T810** Move `/start /help /status` from `server.ts` and update the `/help` text to explain that plain language works for everything.
- [x] **T811** Document the parity table in README and ACCESS.md.
- [x] **T812** `/skills` button browser with Run / Show / Archive / Remove; skills leave the `/` menu (FR6, FR12).
  *Verify:* `test/skillCommands.test.ts` and `test/menu.test.ts` pass.
- [x] **T813** `/memory` buttons with Add, Forget and About you, replacing `/remember` and `/forget` (FR13).
  *Verify:* `test/memoryCommands.test.ts` passes.
- [x] **T814** `/sessions` buttons with New, Resume and Compact, replacing `/new`, `/resume` and `/compact`; drop `/model` and `/cost` (FR1, FR14).
  *Verify:* `test/sessionCommands.test.ts` passes.
- [x] **T815** `/usage` from `claude -p /usage`; `/settings` replaces `/policy` with per-setting pages and a 🔐 Permissions page (FR1, FR15).
  *Verify:* `test/policyUi.test.ts` passes and `planUsage()` returns the usage report.
- [x] **T816** `/usage` bars; `/settings` describes each setting and value, adds ↺ Reset, and pages permissions by kind (FR1, FR15).
  *Verify:* `test/policyUi.test.ts` and `test/planUsage.test.ts` pass.
- [x] **T817** `/settings` ↺ Reset also clears every permission rule (allowed, blocked, always) on the chat (FR15).
  *Verify:* `test/policyUi.test.ts` passes.
- [x] **T818** ✖ Close on every inline menu page (FR16).
  *Verify:* `test/close.test.ts` passes.
- [x] **T819** `/usage` shows only the limits; contributors move behind ℹ️ Learn more (FR17).
  *Verify:* `test/planUsage.test.ts` passes.
