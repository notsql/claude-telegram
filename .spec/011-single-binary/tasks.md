# 011 — Tasks
Depends on: 001 (daemon, service), 004 (memory bridge), 005 (reindex), 009 (assets).

- [ ] **T1101** `cli.ts` dispatcher with `start`, `reindex`, `memory`, `help`, `--version`; `selfCommand()`; package.json scripts go through it. The stale-poller check recognises the daemon by a marker both modes share, not by `daemon.ts` in the command line (FR1, FR2, FR4).
  *Verify:* `test/cli.test.ts` passes (dispatch, unknown command exits 2), and `bun cli.ts start` polls like `bun daemon.ts` and replaces a running one.
- [ ] **T1102** Embed assets and templates: `ASSETS_DIR` mode switch, text-imported service templates (FR3).
  *Verify:* `bun test` passes, and a compiled binary run from `/tmp` installs the `tg-*` agents and skills.
- [ ] **T1103** Service commands `install`, `uninstall`, `stop`, `restart`, `status`, `logs [-f]`; the unit runs `selfCommand(['start'])` (FR1, FR4).
  *Verify:* AC2 on macOS.
- [ ] **T1104** Memory-bridge hook uses `selfCommand(['memory', 'session-start'])`; `HOOK_MARK` matches old and new forms (FR4).
  *Verify:* AC3.
- [ ] **T1105** `build` / `build:all` scripts with bytecode, ESM, assets, autoload off; `dist/` in `.gitignore`; README section (FR5–FR7).
  *Verify:* AC1 and AC5.
