# Repo conventions

## Branches
- Name branches `<type>/<feature-area>-<topic>`, e.g. `feat/headless-daemon-stream-parser`, `fix/access-gate-topics`, `chore/drop-fixtures`.
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `spike`, `test`.
- Never use generated or random names (e.g. `claude/<adjective>-<name>`). If a session assigns one, ask before pushing and use a conventional name instead.

## Commits
- Conventional Commits: `<type>: <summary>`, with the spec task ID at the end when there is one, e.g. `feat: stream-json parser with contract test (T004)`.

## Spec workflow
- Work comes from `.spec/<feature>/tasks.md`; take the first unticked task and tick it when its *Verify* step passes.
