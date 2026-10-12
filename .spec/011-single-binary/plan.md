# 011 — Plan

## Modules
```
cli.ts              argv dispatch → start | install | uninstall | stop | restart | status | logs | reindex | memory | help | --version
daemon.ts           unchanged top-level body; `tgc start` does `await import('./daemon.ts')`
service/install.ts  main() exported; templates via `import tmpl from './launchd.plist.tmpl' with { type: 'text' }`;
                    unit runs [execPath, 'start'] when compiled, [bun, ROOT/cli.ts, 'start'] from source;
                    + uninstall/stop/restart/status (thin launchctl/systemctl wrappers)
agents/install.ts   ASSETS_DIR = Bun.isStandaloneExecutable ? join(import.meta.dir, 'assets') : join(import.meta.dir, '..', 'assets')
memory/bridge.ts    hook command = compiled ? `"<execPath>" memory session-start` : `bun "<script>" session-start`
                    HOOK_MARK matches both forms so enable/disable stays idempotent across the switch
history/reindex.ts  export main(); keep `if (import.meta.main)` for source use
```

## Build
```sh
bun build cli.ts --compile --bytecode --format=esm --minify --sourcemap \
  --asset ./assets \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  [--target=bun-darwin-arm64|bun-linux-x64] --outfile dist/tgc[-<target>]
```
`package.json`: `build` (host) and `build:all` (both targets). The existing `start:daemon`, `install-service` and `reindex` scripts become `bun cli.ts <cmd>`.

## Mode switch
One helper, `selfCommand(args)` in `util/self.ts`, returns `[process.execPath, ...args]` when `Bun.isStandaloneExecutable` is true, and otherwise `[bun, join(ROOT, 'cli.ts'), ...args]`. Both the service installer and the memory bridge use it, so FR4 lives in one place.

## Risks
- Bun version drift between build and run only costs startup speed (bytecode fallback), not correctness.
- A unit installed from source and later reinstalled from the binary is overwritten by `tgc install`; the label stays `com.claude.telegram`.
- The binary is about 70 MB, mostly the Bun runtime. That's acceptable.
