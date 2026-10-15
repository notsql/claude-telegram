# 015 — Tasks
Depends on: 001 (runner), 008 (commands), 012 (ladder skill).

- [x] **T1501** `browser/server.ts`: start the Playwright MCP server behind `TELEGRAM_BROWSER=1`, install WebKit, respawn on exit, stop on shutdown; turns get the `browser` server (FR1, FR2, FR5).
  *Verify:* unit tests for argv and MCP config; AC2 and AC4 live.
- [ ] **T1502** `/signin` command (FR3).
  *Verify:* unit tests for URL handling; AC1 from Telegram.
- [ ] **T1503** Ladder skill web rung: login sites use `mcp__browser__*` with the sign-in handoff (FR4).
  *Verify:* skill test; AC3.
