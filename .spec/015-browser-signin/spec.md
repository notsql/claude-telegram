# 015 — Browser Sign-in

## Problem
012's web rung drives sites through the browser MCP, but the configured one (`safari-mcp`, Apple's `safaridriver --mcp`) can't keep a login:
- Every MCP process starts a throwaway session, and each turn spawns its own process. A cookie set in one session was gone in the next (checked live on 2026-10-15).
- Safari covers automation windows with a glass pane. Clicking or typing in one offers to stop the session, so the owner can't sign in there.
- The MCP has no add-cookie tool, and `document.cookie` can't set the HttpOnly cookies that logins use.

So "check my bill on the SP portal" can only work if the owner pastes a password into chat for every turn, which 012 FR7 forbids.

## User stories
- **US1**: In ⚙️ Settings → 🌐 Browser sign-in I tap 🔑 Sign in to a site and reply `portal.spgroup.com.sg`. A browser window opens on my Mac at that site. I sign in there myself, 2FA included. From then on the agent reads my bill without asking me for anything.
- **US2**: I ask "what's my SP bill?" and the agent lands on a login page. It opens that page in the same browser and tells me to sign in there and say when I'm done. It never asks me for the password.
- **US3**: After the daemon or the Mac restarts, I'm still signed in.

## Functional requirements
- **FR1 — One shared browser.** The daemon runs one Playwright MCP server (`@playwright/mcp`, WebKit engine, headed) over HTTP on 127.0.0.1, with a persistent profile in `STATE_DIR/browser/profile` and one browser context shared by every client. It runs through the daemon's own Bun (`BUN_BE_BUN=1`), so it needs no Node on launchd's PATH. It installs WebKit on first start, and restarts after a crash.
- **FR2 — Every turn gets it.** The turn's `--mcp-config` adds a `browser` server next to `tg`, so its tools appear as `mcp__browser__*`. `safari-mcp` stays configured for public pages.
- **FR3 — ⚙️ Settings → 🌐 Browser sign-in.** An owner-only settings page, in DMs and in groups and topics alike, shown when the browser runs. 🔑 Sign in to a site asks for the site as a reply, opens it (`https://` is added when there's no scheme) in a new tab of the shared browser, and replies with what to do. A reply that isn't a web address is asked again. (Was a `/signin` command until 2026-10-15; moved into Settings like 🤖 Agent.)
- **FR4 — The agent asks for a sign-in.** The ladder skill's web rung says: for sites that need a login, use `mcp__browser__*`. On a login page, never ask for credentials in chat. Leave the page open, tell the owner to sign in in the browser window on their Mac (or open ⚙️ Settings → 🌐 Browser sign-in), and end the turn.
- **FR5 — Flag.** On only when `TELEGRAM_BROWSER=1` (constitution VII).

## Non-goals
- Reusing the owner's everyday Safari logins. Safari's cookie store is private to Safari and can't be read.
- Running the browser on a headless server (Linux systemd unit). A sign-in needs a screen.
- Storing or typing passwords. The owner signs in themselves; the browser profile keeps the session.

## Acceptance criteria
- **AC1** (FR1, FR3): Settings → 🌐 Browser sign-in → 🔑 Sign in to a site, replying `example.com`, opens a visible WebKit window at `https://example.com`.
- **AC2** (FR1): A persistent cookie set through the browser is still there after the daemon restarts.
- **AC3** (FR2, FR4): In a turn, the agent can load `mcp__browser__*` with ToolSearch, and on a login page it asks the owner to sign in in the window instead of asking for a password.
- **AC4** (FR5): Without `TELEGRAM_BROWSER=1`, no browser process starts, and turns get no `browser` server.
