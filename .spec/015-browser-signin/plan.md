# 015 — Plan

## Modules
```
browser/
  server.ts    spawn/respawn the Playwright MCP server, argv, port; openTab(url) as an MCP client
  signin.ts    /signin command: URL normalising, owner gate, reply text
agent/runner.ts                         renderMcpConfig adds `browser` when a port is given
assets/skills/tg-capability-ladder/     web rung: login sites → mcp__browser__*, sign-in handoff
```

## Server
```
BUN_BE_BUN=1 <execPath> x --bun @playwright/mcp@0.0.83
  --host 127.0.0.1 --allowed-hosts 127.0.0.1:<port> --port <port>
  --browser webkit --user-data-dir STATE_DIR/browser/profile --shared-browser-context
  --output-dir STATE_DIR/browser/output
cwd: STATE_DIR/browser
```
- `<execPath>` is `dist/tgc` under launchd and `bun` in dev. `BUN_BE_BUN=1` makes a compiled Bun binary act as the Bun CLI, and `--bun` runs the package under Bun instead of Node.
- Before the first spawn: `… x --bun -p @playwright/mcp@0.0.83 playwright install webkit` (a no-op when the matching WebKit build is already present).
- `--allowed-hosts` is needed because the server checks the `Host` header against `localhost` even when bound to 127.0.0.1. Binding `localhost` instead listens on `::1` only, which Bun's fetch to `localhost` misses.
- The port is picked free at start (listen on 0, close, reuse the number).
- The version is pinned, so an upstream release can't change the tools under the agent.
- Session cookies live as long as the server process; persistent cookies survive restarts (checked live on 2026-10-15).

## /signin
`openTab(url)` connects with the MCP SDK's `StreamableHTTPClientTransport` and calls `browser_tabs {action: "new", url}`, so it doesn't take over a tab the agent is using.

## Risks
- **Sites that block automated browsers** (e.g. Google sign-in) may refuse the login. That's out of scope; the agent reports it.
- **The agent acting on logged-in sites**: tool calls still go through 003's permission prompts like any other MCP tool.
