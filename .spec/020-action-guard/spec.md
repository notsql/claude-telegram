# 020 — Consequential-Action Guard

## Problem
003 asks before writes. But an **Always** rule, a permissive chat policy, or a job's narrowed policy can still let through actions that can't be taken back: sending a message or email, paying, signing a document, deleting files or data. With background tasks (016) and the shared browser (015), the agent does more of these while I'm away. Some actions should **always** need a tap that shows exactly what will happen, whatever rules exist. A few should never happen at all.

## User stories
- **US1**: A task wants to email the landlord. Even though `mcp__gmail__*` has an Always rule, I get "✉️ Send email to landlord@… · subject 'Lease renewal'" with the full text behind **Show**, and **Send** / **Cancel**.
- **US2**: In the shared browser the agent reaches a checkout. Before the final click it asks "💳 Pay S$84.20 to SP Group" with **Pay** / **Cancel**.
- **US3**: "Move $500 from savings to my brokerage and buy VWRA." The agent says it can't move money between accounts or trade securities, and offers to prepare the steps for me to do myself.
- **US4**: Approval cards for these actions never time out into an allow. Unanswered means cancelled (constitution IV).

## Functional requirements
- **FR1 — Classes.** There are four action classes: `send` (messages, email, posts, invites to other people), `pay` (purchases, payments, subscriptions), `sign` (e-signatures, accepting terms or contracts), and `delete` (files outside the work dir's old versions, emails, records, repos, cloud resources).
- **FR2 — Detection.** A `PreToolUse` check classifies each call:
  - **Tool patterns**: a shipped table in `policy/consequential.ts` matching tool names and arguments: `mcp__*__send*`, `*_delete*`/`*_trash*`, Bash `rm` outside `/tmp` and the work dir, `gh … delete`, `git push --force`, and so on. It reuses the `WRITE_VERB` parsing from `policy/readOnly.ts`.
  - **Declared actions**: the system prompt requires the agent to call `action_confirm({class, summary, details})` before any consequential step the table can't see, such as a browser click on Pay, Place order, Sign or Delete. A browser click right after a page that `action_confirm` was needed for, but not called, can't be detected reliably, so this rule relies on the prompt plus FR5 audit.
- **FR3 — Always ask.** A classified call skips Always rules, chat policy auto-allow and job policy. It always posts a card in the origin chat with the class icon, a one-line summary (recipient, amount, file count) and **Show** for the full payload. Unanswered within the 003 timeout means deny.
- **FR4 — Off-limits.** These are denied in `PreToolUse` and stated in the system prompt, with no approval possible: trading securities, moving money between the owner's accounts, and acting in an account that isn't the owner's. The agent explains and offers to prepare steps instead (US3).
- **FR5 — Audit.** Every classified call and its outcome (sent, cancelled, timed out, denied) is appended to the 003 audit log with its class. ⚙️ Settings → 🛡 Actions shows the last 50.
- **FR6 — Flag.** Ships behind `TELEGRAM_ACTION_GUARD=1` (constitution VII). It should be turned on before `TELEGRAM_TASKS` or `TELEGRAM_FOLLOWTHROUGH`, because it is the backstop for unattended work. A per-class `relax` setting isn't offered.

## Non-goals
- One-time payment cards or a payment provider integration.
- Classifying every possible tool perfectly. The table plus `action_confirm` plus the audit log is the bar.

## Acceptance criteria
- **AC1** (FR2, FR3): With an Always rule for a `send` tool, a call still posts the card, and Cancel blocks it.
- **AC2** (FR2): A task calling `action_confirm({class: 'pay', …})` posts the 💳 card. Pay lets the turn continue, and Cancel tells the agent to stop.
- **AC3** (FR3): An unanswered card denies after the timeout.
- **AC4** (FR4): A Bash or MCP call matching an off-limits pattern is denied with no card, and the agent's reply explains why.
- **AC5** (FR5): The 🛡 Actions page lists each of the above with its outcome.
- **AC6**: Read-only calls (003 FR14) and work-dir writes (017) still go through without a card.
