# Contributing Guide

## Working Style
- Prefer small, targeted changes over broad rewrites.
- Preserve established UI patterns unless intentionally redesigning a flow.
- Keep scheduling logic in `src/lib/scheduleEngine.js` and date logic in `src/lib/date.js`.

## Branch + Commit Hygiene
- Keep commits focused by feature/fix.
- Use clear commit messages with user-facing intent.
- Do not mix unrelated refactors with behavior changes.

## Code Areas to Treat Carefully
- `src/BuildFlow.jsx`: central integration file.
- Modal state wiring and close/save behavior.
- Task dependency and workday calculations.
- Storage adapters and blob handling.

## Required Validation Before PR/Push
1. `npm run lint`
2. Manual smoke for affected feature(s)
3. Mobile sanity check for touch/modal interactions if UI changed
4. Data persistence check (reload after major edits)

## Documentation Expectations
When architecture or workflows change, update:
- `ARCHITECTURE_MAP.md`
- `CODEBASE_INDEX.md`
- Any affected workflow/spec docs (e.g., punch docs)

## Change Design Rules
- Reuse existing helpers when possible.
- Maintain backward compatibility for persisted local data.
- Avoid introducing network dependencies unless explicitly intended.

## If You’re an LLM/Coding Agent
- Read `AGENTS.md` first.
- Use `ARCHITECTURE_MAP.md` for topology.
- Use `CODEBASE_INDEX.md` for file-by-file behavior.
- Use `STATE_SCHEMA.md` before changing entity shapes.
- Check `KNOWN_ISSUES.md` before "fixing" known platform constraints.
