# 012 — Tasks
Depends on: 001 (runner), 003 (approvals, policy), 006 (skills, reflection), 009 (shipped agents/skills).

- [x] **T1201** `capabilities/ledger.ts` with zod schema and atomic IO, plus `capabilityAcquisition` in the policy schema (FR10, FR11).
  *Verify:* unit tests; defaults are `ask` in DM and `off` in groups.
- [ ] **T1202** `templates.ts` + `install.ts`: validate names, build argv, spawn without a shell with a timeout, and pair each install with its uninstall (FR6).
  *Verify:* unit tests, including AC4's injected name being rejected.
- [ ] **T1203** `request.ts` + `tools.ts`: `capability_request` posts a card to the owner DM with Install/Details/Skip; approval is remembered per `kind:name`; Skip lasts 30 days; timeout skips (FR5, FR11).
  *Verify:* AC2 and AC8 with a stubbed installer.
- [ ] **T1204** Auth handoff and `resume.ts` follow-up turn (FR7, FR8).
  *Verify:* AC5; after a fake install, the origin session gets the continue turn.
- [ ] **T1205** Ship `tg-capability-scout` and `tg-capability-ladder`; the ladder rule goes in the appended system prompt (FR1, FR3, FR4).
  *Verify:* AC1 end to end on macOS with `imagemagick`.
- [ ] **T1206** `gap.ts`: `PostToolUse` `Bash` matcher returns `additionalContext` on exit 127 (FR2).
  *Verify:* AC3.
- [ ] **T1207** Web rung: check the browser MCP loads in daemon turns, and that the ladder skill covers WebFetch → browser (FR1.4).
  *Verify:* AC6.
- [ ] **T1208** Ledger notices with Undo (uninstall + archive skill), `/caps` in 008, and a skill proposal after the first successful use (FR9, FR10).
  *Verify:* AC7.
