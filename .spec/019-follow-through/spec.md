# 019 — Follow-through

## Problem
013 tells me what needs me, and 014 learns when to tell me. The agent still stops at telling. I want it to **do the first step** before I look: have a reply drafted when the morning digest arrives. It should also notice the other half of open loops, where I asked someone for something and they went quiet. And I want to say in plain words how often I hear about each kind of thing.

## User stories
- **US1**: The 08:30 digest lists "🔴 Boss · wants the deck before 3pm" with **📝 Draft ready**. Tapping it shows the draft with **Send** / **Edit** / **Cancel**, the same as 013 US4. The agent wrote it before the digest went out.
- **US2**: I emailed the contractor for a quote four working days ago and got nothing back. The evening digest has a "⏳ Waiting on others" section: "Contractor · quote for kitchen (4d)" with **📝 Nudge** / **Drop**. Nudge drafts a polite follow-up.
- **US3**: "Only tell me about GitHub in the evening digest, and never about newsletters." From then on GitHub items skip pings, and newsletters skip both pings and digests. The change is announced with **Undo**.
- **US4**: "How often do you message me?" The agent lists the current rules and offers to change them.

## Functional requirements
- **FR1 — Prepared drafts.** Before a digest is sent, the daemon takes up to `TELEGRAM_PREP_MAX` (default 3) `urgent`/`action` items whose suggested step is a reply. For each, it runs a background draft turn: a 016 `quick` task, or a one-shot when tasks are off. The draft is stored with the item. The digest shows **📝 Draft ready** on those items. Sending still needs the owner's tap through the 013 send path, so nothing goes out on its own (constitution IV; 020).
- **FR2 — Prep budget.** Prep drafts run only when the daily turn budget has at least 25% left and no plan limit is active. Skipped prep is not mentioned.
- **FR3 — Waiting on others.** The triager gets a third loop kind, `awaiting_them`: a `fromMe` item that asks for something (a quote, a decision, a file). The loop closes when a `toMe` item comes in on the same thread or from the same contact and the triager judges it an answer. Open `awaiting_them` loops older than `TELEGRAM_NUDGE_DAYS` (default 3 working days) appear in the evening digest under ⏳ with **📝 Nudge** / **Drop**. Nudge drafts through the FR1 path.
- **FR4 — Notification rules.** `notify_rule({subject, level})`, where `subject` is a source id, a contact, a channel (018) or a keyword, and `level` is `now | digest | off`. Rules are stored as `type: feedback` memory files with `metadata: {source: tg, notify: <level>, subject}`, so they are inspectable and shared with the terminal (constitution II, V). They are announced with **Undo**. 013 triage reads them before its own urgency. `off` drops the item from pings and digests, but it is still stored and searchable (013 US5). Rules made from 014 `vip`/`mute` patterns are the same files, so the two don't fight.
- **FR5 — Listing.** `notify_rule_list` answers US4. ⚙️ Settings → 📡 Sources → 🔔 Rules shows the same list with 🗑 per rule.
- **FR6 — Flag.** Ships behind `TELEGRAM_FOLLOWTHROUGH=1` and needs `TELEGRAM_WATCH=1`.

## Non-goals
- Sending a nudge or reply without a tap.
- Prep for anything other than replies in v1, e.g. booking or buying. Those are 016 tasks the owner starts.

## Acceptance criteria
- **AC1** (FR1): With three seeded `action` items, the digest shows 📝 Draft ready on each. Tapping one shows the draft, and nothing was sent.
- **AC2** (FR2): With the budget under 25%, the digest goes out with no drafts and no prep turns run.
- **AC3** (FR3): A seeded `fromMe` request with no answer for 4 working days shows under ⏳. A seeded answer closes it.
- **AC4** (FR4): "Never tell me about newsletters" writes one memory file. The next newsletter item makes no ping and no digest line, and Undo removes the file.
- **AC5** (FR5): `notify_rule_list` and the 🔔 Rules page show the same rules.
- **AC6** (FR6): Without the flag, digests look the same as under 013.
