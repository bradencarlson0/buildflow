# Remove subcontractor capacity constraints

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan must be maintained in accordance with `buildflow/.agent/PLANS.md`.

## Purpose / Big Picture

Remove subcontractor capacity constraints from BuildFlow so that the app no longer calculates or surfaces “sub conflicts” based on maximum concurrent lots. This keeps early-stage scheduling simple: tasks can overlap for the same sub without warnings, and the UI no longer exposes or implies a capacity limit. A user should be able to drag, schedule, and view tasks without conflict banners or capacity fields.

## Progress

- [x] (2026-02-05 21:05Z) Removed capacity logic from scheduling and calendar drop status.
- [x] (2026-02-05 21:05Z) Removed capacity/conflict UI in dashboards and sub lists.
- [x] (2026-02-05 21:05Z) Removed capacity fields from reports and new-sub defaults.
- [x] (2026-02-05 21:08Z) Ran lint; only baseline warnings remain.

## Surprises & Discoveries

- Observation: Lint still reports existing hook-dependency warnings in `BuildFlow.jsx`.
  Evidence: `npm run lint` output lists only warnings, no errors.

## Decision Log

- Decision: Keep the subcontractor database column intact but remove all UI and logic that surfaces capacity in the app.
  Rationale: Capacity is not part of the current product stage, but may return later; removing UI/logic avoids confusion without destructive schema edits.
  Date/Author: 2026-02-05 (assistant + user).

## Outcomes & Retrospective

Completed. Subcontractor capacity is no longer used for scheduling, conflict detection, or UI display. The calendar now only shows valid/invalid drop states, and reports/sub lists no longer surface capacity. Lint passes with existing baseline warnings.

## Context and Orientation

Subcontractor capacity is currently modeled with a `max_concurrent_lots` field on subcontractor records. The app uses this in two places: scheduling assignment decisions (`buildflow/src/lib/scheduleEngine.js`) and UI conflict detection/visuals in the calendar (`buildflow/src/BuildFlow.jsx`). The home dashboard also surfaces “Sub Conflicts” based on this limit, and reports/export columns show capacity values. The goal is to remove all these user-facing and logic-based capacity references, while keeping the underlying database schema intact for future use.

## Plan of Work

First, update the scheduling engine to ignore subcontractor capacity when selecting subs so that availability is only blocked by blackout dates. Next, remove the calendar conflict preview logic and related drop-state styling that depends on capacity. Then remove the “Sub Conflicts” dashboard card and any capacity labels in the subcontractor list. Finally, remove the capacity column from the subcontractor performance report and clean the new-sub default object to avoid injecting a capacity field. Validate by running lint and ensuring no conflict banners or capacity text appear in the UI.

## Concrete Steps

1. Edit `buildflow/src/lib/scheduleEngine.js` to make `isAvailable` ignore capacity and only respect blackout dates.
2. Edit `buildflow/src/BuildFlow.jsx` to:
   - Remove the `subConflicts` calculation and dashboard card.
   - Remove `getSubConflictPreview` and the “conflict” drop status from calendar drag logic.
   - Remove capacity from the subcontractor list line and reports.
   - Remove `max_concurrent_lots` from the new-sub default object and from Supabase mapping if needed.
3. Run `npm run lint` from `buildflow/` and confirm no new warnings or errors were introduced.
4. Smoke-check the calendar drag UI: drop targets should show only valid/invalid states, and no conflict warnings should appear.

## Validation and Acceptance

- Calendar drag-and-drop no longer shows yellow conflict states; only valid/invalid highlighting remains.
- The home dashboard no longer shows a “Sub Conflicts Detected” card.
- Subcontractor list cards no longer mention capacity.
- Sub performance report no longer includes a capacity column.
- Lint completes with the same baseline warnings as before (no new errors).

## Idempotence and Recovery

These changes remove logic and UI references without altering stored data. If capacity returns later, the field and schema are still available and can be reintroduced in the UI and scheduling logic. Re-running lint and the UI checks are safe and repeatable.

## Artifacts and Notes

Key files to edit:

    buildflow/src/lib/scheduleEngine.js
    buildflow/src/BuildFlow.jsx

## Interfaces and Dependencies

No new dependencies are required. The change removes use of the subcontractor `max_concurrent_lots` field in scheduling and UI components.

Plan Update Note: Updated on 2026-02-05 to reflect completion and lint validation.
