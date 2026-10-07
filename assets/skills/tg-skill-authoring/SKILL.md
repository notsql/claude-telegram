---
name: tg-skill-authoring
description: Guidance for writing and patching learned skills and agents. Preloaded by tg-skill-author.
user-invocable: false
---
<!-- source: tg · version: 1 -->
# Authoring skills and agents

## Skill or agent?
| Signal | Produce |
|---|---|
| A repeatable procedure (steps) | skill |
| A repeatable procedure that needs isolation or heavy tool use | skill with `context: fork` + `agent:` |
| A recurring role with its own judgement, tools, model or memory | agent |

## Skills
- Name: `[a-z0-9-]{1,48}`, not clashing with built-ins or installed skills.
- Description: one trigger-oriented sentence ("Use when ...").
- Use `arguments` / `argument-hint` when the skill takes input; refer to it as `$name`.
- Keep `allowed-tools` narrow. Use `disable-model-invocation: true` for side effects.
- Put long material in supporting files, not the body.

## Agents
- Names use the `tg-` prefix. List `tools` explicitly.
- Never use `permissionMode: bypassPermissions` or `auto`, and never define `mcpServers` inline.
- Patch only agents whose first body line marks `source: tg`.
