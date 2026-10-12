# 014 — Pattern Learning

## Problem
The reflection pass (004/006) learns facts and procedures from single conversations. It doesn't see **patterns over time**: when I'm active, who I always answer fast, which pings I ignore, or what I ask for every Monday. Those patterns are what make the agent proactive in the right way. It can ping only about what I care about, stay quiet when I'm busy, and offer to automate what I keep doing by hand.

## User stories
- **US1**: After two weeks, the agent notices I always reply to my manager within 10 minutes and always snooze a certain newsletter. My manager becomes a VIP and the newsletter is muted. Both changes are announced once with **Undo**.
- **US2**: "📈 You've asked for a GitHub PR summary on 4 of the last 4 Monday mornings. Schedule it for Mondays 9:00?" with **Yes** / **No** / **Not now**. Yes creates the 007 job.
- **US3**: Quiet hours follow my real sleep pattern instead of the default, and the morning digest arrives about 15 minutes after I usually become active.
- **US4**: "What have you learned about my habits?" lists the patterns with confidence and evidence counts, and I can delete any of them.

## Functional requirements
- **FR1 — Signals.** Collected by the daemon without model calls into `signals` in `inbox.db` (013), as `{ts, kind, subject, value}`. Kinds:
  - `owner_active`: the owner messaged the bot, or a `fromMe` item appeared on any source.
  - `reply_latency`: time from a `toMe` item to my reply, per contact.
  - `ping_feedback`: Open, Draft, Snooze, Mute or Done on 013 pings, or no response within 2h.
  - `request`: a turn's first user message, already indexed by 005 history.
  - `job_feedback`: 007 job results that were read or ignored.
- **FR2 — Mining.** A weekly system job (Sunday 04:00), plus a light daily one (04:00), runs `tg-pattern-miner`, a one-shot with `StructuredOutput` only, on Sonnet. Its input is aggregated stats (not raw messages): an active-hours histogram, per-contact latency and feedback counts, and clusters of recurring requests from 005. It returns proposals `{kind, subject, claim, evidence: {n, window}, confidence, action}`, of these kinds:
  - `active_hours` → sets quiet hours and digest times.
  - `vip` / `mute` → 013 triage rules.
  - `routine` → a schedule proposal (007).
  - `preference` → a memory entry, e.g. "prefers bullet digests".
  - `skill` → a 006 proposal for a repeated multi-step request.
- **FR3 — Thresholds.** A proposal needs `n ≥ 5` observations, a window of at least 7 days, and confidence ≥ 0.7. There are at most 5 proposals per pass. Patterns that were rejected aren't proposed again for 30 days.
- **FR4 — Applying.**
  - `active_hours`, `vip`, `mute` and `preference` apply automatically in the owner DM, with a notice and **Undo** (constitution V). Each is written as a memory file of `type: user` (habits) or `type: feedback` (mute/VIP), with frontmatter `metadata: {source: tg, pattern: <kind>, evidence, confidence}`. This makes them part of the one brain and visible to the terminal CLI (constitution II).
  - `routine` and `skill` are **always proposed with buttons** and never applied silently, because they create jobs that spend usage.
- **FR5 — Use.** 013 triage reads `vip`/`mute` and quiet hours from these memory files, and the digest times come from `active_hours`. The `SessionStart` hook already injects memory, so turns see the habits too (004).
- **FR6 — Decay.** Each pass re-checks the patterns it already holds. A pattern whose evidence fell below the threshold over the last 30 days is proposed for deletion. Contradicting feedback (pinging a muted sender's message gets a reply within 5 min) lowers confidence straight away.
- **FR7 — Tools.** `pattern_list` and `pattern_forget({id})`, in the owner DM only. US4 is answered through these.
- **FR8 — Privacy.** The miner sees counts, latencies and request summaries, never raw message bodies from other people. Patterns name contacts by display name and source ID only.
- **FR9 — Flag.** Ships behind `TELEGRAM_PATTERNS=1`. It needs 013 for message signals, but works on bot turns and history alone when 013 is off.

## Non-goals
- Predicting what I'll do next, or acting on predictions without asking.
- Learning patterns about people other than the owner beyond how the owner treats them (VIP or mute).

## Acceptance criteria
- **AC1** (FR1, FR2, FR4): With seeded signals (a contact answered in under 10 min, 8 times in 14 days), a pass creates a VIP memory file with evidence, and the notice has **Undo**.
- **AC2** (FR2, FR4): Seeded recurring Monday requests produce a schedule proposal. **Yes** creates a 007 job, and **No** suppresses it for 30 days.
- **AC3** (FR3): 3 observations produce no proposal.
- **AC4** (FR5): After a `mute` is applied, that sender's messages are triaged as `noise` without a model call.
- **AC5** (FR6): Replying fast to a muted sender, twice, leads to an un-mute proposal at the next pass.
- **AC6** (FR8): The miner input in the debug log contains no message bodies.
- **AC7** (FR7): "forget that I'm a night owl" removes the `active_hours` memory, and quiet hours go back to the default.
