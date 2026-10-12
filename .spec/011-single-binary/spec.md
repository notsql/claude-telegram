# 011 — Single Binary (`tgc`)

## Problem
Running the daemon today means a git checkout, `bun install`, `node_modules` and a Bun on `PATH`. The service unit runs `bun daemon.ts` from the repo, and a few modules read files relative to the source tree. We want one self-contained executable that we can copy to a machine and run, with simple subcommands to manage it.

## User stories
- **US1**: Copy `tgc` to a Mac or Linux box that has `claude` installed and logged in, run `tgc install`, and the agent is up as a service. No Bun, no checkout.
- **US2**: `tgc start` runs the daemon in the foreground for debugging.
- **US3**: `tgc status`, `tgc stop`, `tgc restart` and `tgc logs` manage the service without remembering launchctl or systemctl syntax.
- **US4**: One build command produces binaries for macOS arm64 and Linux x64 from either machine.

## Functional requirements
- **FR1**: A single entry point `cli.ts` with subcommands:
  | Command | Does |
  |---|---|
  | `tgc start` | Run the daemon in the foreground (today's `bun daemon.ts`) |
  | `tgc install` | Write and load the launchd/systemd unit that runs `<this binary> start` |
  | `tgc uninstall` | Unload and remove the unit |
  | `tgc stop` / `tgc restart` / `tgc status` | Service control via launchctl or systemctl |
  | `tgc logs [-f]` | Tail `STATE_DIR/logs/daemon.{out,err}.log` |
  | `tgc reindex` | Today's `bun history/reindex.ts` |
  | `tgc memory <status\|enable\|disable\|session-start> …` | Today's `bun memory/bridge.ts …` |
  | `tgc help`, `tgc --version` | Usage and version |
  Unknown commands print usage and exit 2.
- **FR2**: The same `cli.ts` also runs from source (`bun cli.ts start`), and the existing `package.json` scripts call it. Tests keep running against source.
- **FR3**: No runtime reads from the source tree. Shipped agents and skills (`assets/`) and the service templates are embedded in the binary.
- **FR4**: Anything that re-invokes the program (the service unit, the memory-bridge `SessionStart` hook) calls the binary itself (`process.execPath`) when compiled, and `bun <script>` when run from source.
- **FR5**: The binary does not autoload `.env` or `bunfig.toml` from its working directory. Configuration still comes from `STATE_DIR/.env`, as it does today.
- **FR6**: The build is ESM with bytecode (`--compile --bytecode --format=esm`), minified with a sourcemap so stack traces still point at the `.ts` source.
- **FR7**: `bun run build` builds for the host. `bun run build:all` builds `bun-darwin-arm64` and `bun-linux-x64` into `dist/`. `dist/` is git-ignored.

## Non-goals
- Packaging the plugin-mode MCP server (`server.ts`). The Claude Code plugin still launches it with `bun` from the plugin checkout.
- Windows targets, code signing, notarisation and auto-update.
- Making the daemon faster at steady state. Bytecode only shortens startup, and the spawned `claude -p` dominates runtime anyway.

## Acceptance criteria
- **AC1** (FR1, FR3): Copy `dist/tgc` to a directory outside the repo, then run `tgc start`. The daemon polls, answers a DM, and installs the `tg-*` agents and skills into `~/.claude`.
- **AC2** (FR1, FR4): `tgc install` writes a unit whose program is the binary's absolute path plus `start`. `tgc status` reports it running, and `tgc restart` brings it back.
- **AC3** (FR4): After `tgc memory enable --hook`, the `SessionStart` hook command in settings is `"<binary>" memory session-start`, and an interactive `claude` session gets the user-model injection.
- **AC4** (FR2): `bun test` passes, and `bun cli.ts start` behaves like `bun daemon.ts` did.
- **AC5** (FR6, FR7): `bun run build:all` produces both targets. With `BUN_JSC_verboseDiskCache=1`, the host binary logs bytecode cache hits.

## Notes (Bun docs, checked 2026-10-12 against Bun 1.4.3)
- [Bytecode](https://bun.com/docs/bundler/bytecode): bytecode is architecture-independent, so cross-compiling is fine. It is **tied to the Bun version**: on a mismatch, Bun silently falls back to parsing the source, which is slower but still works. Build with the same Bun that is pinned for the project. ESM bytecode requires `--compile`. A CJS build fails here because of top-level `await` (`daemon.ts:1573`), so we must use `--format=esm`.
- [Executables](https://bun.com/docs/bundler/executables): `--asset <dir>` embeds a tree that is readable with `readdirSync`/`readFileSync` under `import.meta.dir`. Inside the binary, `import.meta.dir` is `/$bunfs/root` for **every** module, so paths like `join(import.meta.dir, '..', 'assets')` break (verified). `import.meta.main` is true only for the entry, so per-script `if (import.meta.main)` blocks don't run in the binary; `cli.ts` must call their `main()` functions. `Bun.isStandaloneExecutable` tells the two modes apart. `.env` and `bunfig.toml` autoload are on by default and need `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`. `bun:sqlite` is built in and works unchanged.
