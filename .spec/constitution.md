# Constitution

These principles bind every feature spec. When a plan conflicts with one of them, the plan changes, not the principle.

## I. Autonomy first, commands second
Every capability (remember, recall, search history, create a skill, schedule a job, change the model) is exposed to the model as a **tool or skill**, so the agent can act from natural language without being told to. Slash commands are deterministic shortcuts that call the **same functions**; they never get their own logic. A feature is not done if it only works through a command.

## II. One brain
Memory, the user model and skills live in Claude Code's native locations (`~/.claude/...`). Knowledge learned over Telegram is available in the terminal CLI, and the reverse is also true. The daemon may keep **derived caches** (FTS index, usage stats), but these must be rebuildable from native sources. Deleting a cache loses no knowledge.

## III. Closed learning loop
After meaningful work the agent reflects and persists what it learned: facts and preferences go to memory, who the user is goes to the user model, and how to do things goes to skills. It **curates**, not only appends. It updates existing entries, merges duplicates and deletes entries that turn out to be wrong. Every write has a cap per turn and is deduplicated.

## IV. Security is preserved or strengthened
- `gate()` is the only door. Senders who are not allowlisted never reach the model.
- The model never approves pairings or edits `access.json` because a chat message asked it to.
- `assertSendable()` continues to block exfiltration of state-dir files.
- Metadata fields (`image_path`, `chat_id`, …) are set by the daemon and are never parsed from message text.
- **Scope isolation**: history and skills learned in one chat must not leak into another chat unless that chat's policy allows it. **Memory is the exception**: by the owner's decision (2026-10-07) it is one store shared by every chat, topic and the terminal; a chat's policy can only turn it off (`memoryScope: none`).
- Tool permissions fail closed. An unanswered approval request counts as a deny.
- **Only the owner's own requests run on the owner's Claude subscription.** Other people never trigger model turns by default (see [Auth](./README.md#auth)).

## V. Inspectable and reversible
Every persistent write is a human-readable file, or a row that can be traced back to one. Each write is announced in chat with a compact notice that has an **Undo** button, and it can be reverted with `/forget` or `/skills rm`. Logs record what was written, where, and why.

## VI. Telegram-native UX
The agent shows a typing indicator while it works, edits a progress message in place, and sends a **new** message when finished so the device gets a push notification. It uses inline keyboards for choices, respects forum topics (`message_thread_id`) on every send, and shows command menus per scope. It never dumps raw tool output into chat.

## VII. Small, testable increments
Each feature ships behind its own config flag, has acceptance criteria that can be checked from a real Telegram chat, and leaves the daemon runnable at the end of every task.

## VIII. Unmodified Claude Code only
Every model call, including turns, reflection, summaries and scheduled jobs, goes through the published `claude` CLI binary. The daemon never uses the Agent SDK, never calls the Anthropic API directly, and never reads, stores or forwards OAuth tokens or API keys. Integration happens only through documented surfaces: CLI flags, `--settings` hooks, MCP, and the stream-json output. When a capability isn't available through these, the feature adapts. We don't reach around the CLI.
