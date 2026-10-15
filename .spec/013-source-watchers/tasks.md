# 013 — Tasks
Depends on: 001 (runner, budget), 003 (approvals), 004 (memory), 007 (system jobs), 012 (acquiring new connectors).

- [x] **T1301** `watch/registry.ts` + `store.ts` (`inbox.db` schema, FTS5, dedupe), plus the `TELEGRAM_WATCH` flag (FR1, FR2, FR12).
  *Verify:* unit tests; inserting the same item twice keeps one row.
- [ ] **T1302** `supervisor.ts` + `ingest.ts` + adapters for `tgcli watch` (stream) and `wacli` (webhook, HMAC), run read-only (FR1, FR3, FR4).
  *Verify:* live messages on both accounts land in `inbox.db` within 10s.
- [ ] **T1303** `poll` kind + GitHub adapter; `agent-poll` kind using `runOneShot` with a schema and a cursor (FR1, FR3).
  *Verify:* GitHub notifications and today's calendar events land as items.
- [x] **T1304** `triage.ts`: rules stage, plus the shipped `tg-triager` with batching and budget (FR5, FR6, FR11).
  *Verify:* AC2, AC5, AC8.
- [x] **T1305** `deliver.ts`: ping cards with buttons, quiet hours, `pingsPerHour`, snooze (FR7).
  *Verify:* AC1.
- [x] **T1306** `digest.ts`: morning and evening system jobs, open-loop detection and closure (FR8).
  *Verify:* AC3.
- [x] **T1307** `tools.ts` + `send.ts`: `inbox_*`, `source_*`, `draft_reply` with Send/Edit/Cancel (FR4, FR9).
  *Verify:* AC4, and US5 answered from the store.
- [x] **T1308** `source_add` onboarding through 012, plus health notices with Fix/Pause (FR9, FR10).
  *Verify:* AC6, AC7.
- [x] **T1309** ⚙️ Settings → 📡 Sources fallback page (008). (`/inbox` dropped 2026-10-13.)
- [ ] **T1310** Summary delivery: chat context in triage, stricter `tg-triager`, `tg-summarizer` importance check and one "📥 Needs you" message per send, 📍 Send updates here, and the bot's own messages dropped (FR6, FR7).
  *Verify:* AC1 in a group chosen with 📍; a family-chat logistics question that someone else answered sends nothing.
- [ ] **T1311** Feedback: task-focused prompts, 🔕 Not like this, 🎯 Tune page, examples in both Haiku passes (FR13).
  *Verify:* after marking "want go?"-style chat questions 🔕, similar ones stop being sent while a "pay the bill by Friday" message still is.
- [x] **T1312** Digest triage and feedback: the digest summarises through `tg-summarizer` and sends only worthwhile conversations, each with ✍️ Reply, ✅ Done and 🔕 Not like this (FR8, FR13).
  *Verify:* with a newsletter, a casual chat and a "review the PR" message pending, the digest lists only the last, with buttons, and the other two never reappear.
- [x] **T1313** `sweep.ts`: the `attention-sweep` system job finds tasks still waiting on the owner (GitHub `gh search`, `agent-poll` connectors) and hands them to delivery; health notices go to the delivery chat (FR10, FR14).
  *Verify:* unit tests; a PR awaiting review shows up once in the 📍 group after a sweep, and not again on the next one.
- [x] **T1314** 🤖 Do it on every summarised conversation and deadline nudges for loops with a `due` (FR7, FR15).
  *Verify:* unit tests; tapping 🤖 Do it on "pay the bill by Friday" starts a DM turn, and a task due in 2h gets one ⏰ Due soon message.
- [x] **T1315** Dated digest: the summarizer judges staleness from message dates against now, and each conversation is its own dated message with buttons (FR8).
  *Verify:* unit tests; a two-day-old party invite is dropped and "pay the bill by Friday" arrives as its own message dated by the message.
