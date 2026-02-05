# Remove task dependencies across BuildFlow

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan must be maintained in accordance with `buildflow/.agent/PLANS.md`.

## Purpose / Big Picture

This change removes task dependencies everywhere in BuildFlow so the app no longer generates, stores, or syncs dependency data. The immediate user impact is more reliable syncing (no foreign key errors), simpler scheduling behavior, and a clearer mental model while the product is still early. A one‑time cleanup removes any existing dependency rows so legacy data does not continue to cause sync failures.

## Progress

- [x] (2026-02-05 19:45Z) Removed dependency logic from the schedule engine and BuildFlow mapping.
- [x] (2026-02-05 19:45Z) Templates now strip dependency fields at runtime so new lots/tasks are dependency‑free.
- [x] (2026-02-05 19:45Z) Added one‑time cleanup to strip dependencies from local state and a Supabase SQL cleanup file.
- [ ] (2026-02-05 19:45Z) Validate scheduling + sync flow and push.

## Surprises & Discoveries

- Observation: The template file still contains legacy `dependencies` entries, but they are stripped at runtime via `stripDependenciesFromTask`.
  Evidence: `buildflow/src/data/template.js` now applies a strip before use.

## Decision Log

- Decision: Fully remove dependencies from templates, schedule engine, and sync rather than partially disabling sync.
  Rationale: Dependencies are not a product requirement yet and are causing FK sync failures; removing them avoids future confusion.
  Date/Author: 2026-02-05 (assistant + user).

## Outcomes & Retrospective

Work in progress. Remaining work is validation and pushing the changes.

## Context and Orientation

Dependency data currently enters the system via task templates (`buildflow/src/data/template.js`) and is rewritten into task instances by the schedule engine (`buildflow/src/lib/scheduleEngine.js`). The main UI and sync logic lives in `buildflow/src/BuildFlow.jsx`, including Supabase mapping for tasks and dependency rows. The goal is to remove dependency generation and ensure that any existing dependency data is stripped from both local state and Supabase.

## Plan of Work

First, remove all `dependencies` entries from task templates so new lots never include dependency metadata. Next, remove dependency rewrite/cleanup logic in the schedule engine and stop attaching dependencies to task objects. Then update BuildFlow mapping to stop normalizing, loading, or syncing dependencies. After that, add a one‑time cleanup that clears dependency arrays from local tasks and optionally removes all rows from the Supabase `task_dependencies` table. Finally, validate that scheduling still works, tasks can be reordered, and sync does not error.

## Concrete Steps

1. Edit `buildflow/src/data/template.js` to remove or empty the `dependencies` fields for all tasks.
2. Edit `buildflow/src/lib/scheduleEngine.js` to remove dependency rewrite logic and any dependency cleanups.
3. Edit `buildflow/src/BuildFlow.jsx` to:
   - Remove dependency normalization/mapping helpers.
   - Stop reading `task_dependencies` from Supabase.
   - Ensure task objects always have `dependencies: []`.
4. Add a one‑time local cleanup that strips dependencies from existing lot tasks during app load or migration.
5. Provide a Supabase SQL snippet to delete all rows from `task_dependencies` (or run it if tooling is available).
6. Run `npm run lint` and verify sync + scheduling flow in the UI.

## Validation and Acceptance

- Starting a lot creates tasks with no dependency data.
- Reordering tasks and manual start dates work as expected.
- Sync completes without foreign key errors.
- Supabase `task_dependencies` table is empty after cleanup.

## Idempotence and Recovery

All changes are additive or deletions of unused dependency features. If needed later, dependency support can be reintroduced by re‑adding template fields and schedule logic. The cleanup SQL can be re‑run safely.

## Artifacts and Notes

Key files:

    buildflow/src/data/template.js
    buildflow/src/lib/scheduleEngine.js
    buildflow/src/BuildFlow.jsx

## Interfaces and Dependencies

No new dependencies are required. The change removes the app’s dependency mapping and references to `task_dependencies` in Supabase.

Plan Update Note: Updated on 2026-02-05 to reflect completed code removals and cleanup additions.
