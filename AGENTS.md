# AGENTS.md

## Mission
- BuildFlow is a construction scheduling and community management app.
- Priorities: schedule accuracy, offline resilience, mobile usability, and clear admin workflows.

## Repo map (read before big changes)
- UI shell + state: src/BuildFlow.jsx (large single-file app).
- Data seeds/templates: src/data/seed.js, src/data/template.js, src/data/constants.js.
- Scheduling rules: src/lib/scheduleEngine.js, src/lib/date.js.
- Storage: src/lib/storage.js (localStorage), src/lib/idb.js (IndexedDB blobs).

## Working agreements
- Prefer small, targeted changes; avoid large rewrites of src/BuildFlow.jsx.
- Reuse existing helpers; do not duplicate scheduling logic outside scheduleEngine/date.
- Preserve offline-first behavior; avoid adding network dependencies without a clear need.
- Keep UI consistent with existing Tailwind styles and mobile patterns.

## Subagents
- ALWAYS wait for all subagents to complete before yielding.
- Spawn subagents when:
  - Parallelizable work (install + verify, lint + tests, multiple tasks from a plan).
  - Long-running or blocking tasks where a worker can run independently.
  - Isolation for risky changes or checks.

## Planning (ExecPlans)
- For multi-file changes, refactors, or new workflows, create an ExecPlan per .agent/PLANS.md before coding.
- Keep the plan updated as work proceeds (progress, discoveries, decisions, outcomes).

## Validation
- Run: npm run lint
- Smoke: npm run dev; verify schedule timeline + lot start + photo upload paths.
- If scheduling logic changes, verify task ordering and workday handling.

## Data and behavior constraints
- Workdays and holidays are source of truth for scheduling.
- Lots, communities, and templates must stay backward compatible (legacy fields tolerated).
- Photos and documents must be stored via IndexedDB; localStorage stores metadata only.

## Security and data handling
- Treat phone/email/address data as sensitive; avoid logging or exposing it in examples.
