# 017 — Deliverables

## Problem
When the agent produces something substantial, such as a research brief, a spreadsheet model, a slide deck or a dashboard, it ends up as a long chat message or a file somewhere on disk that I can't find again. Bigger work should come back as a **file** I can open on my phone, find again later, ask for changes to, and, for things like dashboards, have kept up to date.

## User stories
- **US1**: A 016 task finishes and I get `Q1-forecast.xlsx` as a Telegram document, with a three-line summary and **✏️ Change** / **🔁 Keep current** / **✅ Done**.
- **US2**: "Make the deck shorter and add a pricing slide." The agent edits the same file and sends version 2. The old version is kept.
- **US3**: ⚙️ Settings → 📁 Files lists what the agent has made recently. Tapping one sends the latest version again.
- **US4**: On the GitHub dashboard I tap 🔁 Keep current and pick *daily*. Every morning it is rebuilt from fresh data, and the new version is sent only if something changed.

## Functional requirements
- **FR1 — Work dir.** Deliverables live in `TELEGRAM_WORK_DIR` (default `~/Documents/tg-work`), one folder per deliverable: `<slug>/v<n>.<ext>` plus `latest.<ext>`. This is outside `STATE_DIR`, so `assertSendable()` still blocks state files (constitution IV). Turns and task runs get this dir as an allowed `Edit` path.
- **FR2 — Index.** `STATE_DIR/deliverables.json` holds `{id, slug, title, ext, versions[{n, at, bytes, note}], taskId?, chat, thread?, refresh?: {jobId, cron}}`. It is a cache that can be rebuilt from the folders (constitution II), except for `refresh`, which points at a 007 job.
- **FR3 — Tool.** `deliverable_save({path, title, note, id?})` copies the file into the work dir as the next version, updates the index, and sends it as a document to the chat or topic with the buttons from US1. Passing `id` adds a version to an existing deliverable. Formats are whatever the agent can produce with its tools and skills (md, pdf, xlsx, pptx, csv, html). The daemon doesn't convert anything.
- **FR4 — Change.** ✏️ Change asks for what to change as a reply, then starts a turn (a 016 task when `TELEGRAM_TASKS=1`) with the deliverable's latest path and the instruction. The result is saved as the next version.
- **FR5 — Keep current.** 🔁 Keep current offers *daily* / *weekly* / *off*. It creates or deletes a 007 job whose prompt is "rebuild <title> at <path> from fresh data; call deliverable_save only if the content changed". The job runs under the chat's policy, narrowed by `narrowPolicy`.
- **FR6 — Files page.** ⚙️ Settings → 📁 Files lists the 20 most recent deliverables. Each page offers 📤 Send latest, 🕘 Versions, 🔁 Keep current and 🗑 Delete. Delete removes the folder after a confirmation and is announced with no Undo (it is a file delete; 020 applies).
- **FR7 — Tools for autonomy.** `deliverable_list` lets the agent find earlier work ("update last week's deck") without the owner opening the page (constitution I).
- **FR8 — Flag.** Ships behind `TELEGRAM_DELIVERABLES=1`.

## Non-goals
- Rendering previews inside Telegram beyond what Telegram does itself.
- Syncing to Google Drive or Notion. The agent can do that with connectors when it is asked to.
- Collaborative editing.

## Acceptance criteria
- **AC1** (FR1, FR3): `deliverable_save` on a generated `.xlsx` sends it as a document in the same chat or topic and writes `v1` and `latest` into the work dir.
- **AC2** (FR4): ✏️ Change with "add a total row" produces `v2`, and `v1` is still on disk.
- **AC3** (FR5): 🔁 Keep current → daily creates one 007 job. A run with unchanged data sends nothing.
- **AC4** (FR6): The Files page lists the deliverable, and 📤 Send latest re-sends it.
- **AC5** (FR1): Trying to `deliverable_save` a file under `STATE_DIR` is refused.
- **AC6** (FR8): Without the flag, no tools, buttons or Files page appear.
