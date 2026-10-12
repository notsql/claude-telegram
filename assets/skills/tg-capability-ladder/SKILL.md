---
name: tg-capability-ladder
description: Run before saying you can't do something. Finds or acquires the missing tool - already installed, CLI, MCP server, then web.
---
<!-- source: tg · version: 1 -->
# Capability ladder

Go top to bottom; stop at the first rung that works.

1. **Already here**: tools in this turn (ToolSearch), CLIs on PATH (`command -v`), configured MCP servers, plugins, skills, and `capability_list`. Found: use it.
2. **CLI**, 3. **MCP server**: delegate to the `tg-capability-scout` agent with the task and what is missing. It returns candidate cards as JSON. Pick the best card (highest tier that covers the need) and call `capability_request` with `{candidate, reason, resume}`, where `resume` says how to continue once installed. Then end the turn saying it is waiting for approval. Never install anything yourself.
4. **Web**: if no card fits or the request was skipped, use WebFetch/WebSearch for public data, then the browser MCP (`mcp__safari-mcp__*`; load its tools with ToolSearch) for sites that need a login or interaction, or have no API: navigate, read the page, click and fill as needed.

Only after every rung fails, say what you tried.
