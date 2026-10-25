# 018 — Plan

## Modules
```
channels/
  store.ts    channels.json; match(item|task) → channel | undefined
  tools.ts    channel_open, channel_list, channel_route, channel_close
  home.ts     home-group checks (getChat is_forum, getChatMember can_manage_topics)
telegram/handlers/channels.ts   ⚙️ Settings → 🧵 Channels page, proposal buttons
```

## Touch points
- `sessions/topics.ts`: topic names come from the registry.
- `watch/deliver.ts`: `channels.match()` before the default updates chat.
- `watch/digest.ts`: the 🧵 activity line.
- `reflection/prompt.ts` + `reflection/apply.ts`: the `channel` proposal kind, with 30-day rejection suppression stored next to the 014 `pattern_rejections` if that exists, otherwise in `channels.json`.

## Risks
- **Too many topics**: one proposal per day at most, a high recurrence bar, and `channel_close` for cleanup.
- **Misrouting**: matching is explicit (keywords, contacts, source ids) and visible on the channel's page. When nothing matches, delivery goes to the main chat.
