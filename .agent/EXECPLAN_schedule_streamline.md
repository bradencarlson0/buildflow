# Streamline scheduling (no dependencies) + preview start + buffer days

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

This plan must be maintained in accordance with .agent/PLANS.md in the repository root.

## Purpose / Big Picture

The goal is to make BuildFlow scheduling simple and flexible for field users by removing dependency constraints, adding a schedule preview when starting a lot, and enabling buffer time between tasks. After this change, a superintendent can start a lot, preview and adjust the task order and durations before confirming, keep adjusting tasks after the lot is started, insert deliberate “dead space” between tasks, and reschedule without seeing dependency violations. Inspections no longer block or appear in the schedule, but inspection files can still be uploaded in the overview. The behavior is visible by opening a lot schedule, dragging tasks, changing durations, inserting buffer days, and seeing the Ready status update to the earliest task in each track.

## Progress

- [x] (2026-02-02 23:38:31Z) Drafted ExecPlan with required sections and repository context.
- [x] (2026-02-03 21:56:55Z) Confirmed dependency-free scheduling is already implemented in `src/lib/scheduleEngine.js` and no longer blocks reschedule/drag flows.
- [x] (2026-02-03 22:25:02Z) Implemented Start Lot schedule preview (reorder/duration/sub assignment/add/delete) and wired `draftTasks` into `startLotFromTemplate`.
- [x] (2026-02-03 22:25:02Z) Wired buffer-day insertion into the schedule UI via a modal using `applyBufferAfterTask`, with ready-status refresh.
- [x] (2026-02-03 22:25:02Z) Kept inspections in the Overview and removed inspection-based task gating (inspections no longer set tasks to blocked/complete).
- [x] (2026-02-03 22:25:02Z) Added task uncomplete + delete actions and implemented Supabase delete sync via `sync.deleted_task_ids` processed in `flushSupabaseWrite`.
- [x] (2026-02-03 22:25:02Z) Validated `npm run build` and `npm run lint` (lint warnings only; no lint errors).

## Surprises & Discoveries

- Observation: This ExecPlan’s checklist was behind the current worktree state (dependency removal already landed, but Progress was still unchecked).
  Evidence: `src/lib/scheduleEngine.js` `buildReschedulePreview` returns `dependency_violation: false` and `scheduleWithDependencies` schedules sequentially.
- Observation: Buffer-day shifting logic existed in the engine before UI wiring.
  Evidence: `src/lib/scheduleEngine.js` exports `applyBufferAfterTask` (now called from the schedule UI modal in `src/BuildFlow.jsx`).
- Observation: Inspections were previously coupled to task status transitions (blocked/complete) and needed decoupling for dependency-free scheduling.
  Evidence: `src/BuildFlow.jsx` previously set task status to `blocked` when scheduling an inspection and updated task status on inspection results; this coupling has now been removed.

## Decision Log

- Decision: Keep dependency data in storage but ignore it in scheduling and UI gating.
  Rationale: This removes user-facing dependency violations immediately while preserving the option to re-enable dependencies later without a migration.
  Date/Author: 2026-02-02 / Codex.
- Decision: Keep inspections only as Overview documentation (notes/files) and do not use inspections to block or gate scheduling/task completion.
  Rationale: Field users need scheduling to remain flexible; inspection capture can remain for records without affecting the schedule timeline or readiness.
  Date/Author: 2026-02-03 / Codex.

## Outcomes & Retrospective

Scheduling is now dependency-free and field-friendly. Starting a lot includes a true schedule preview where users can reorder tasks, change durations, adjust subcontractor assignments, and add/delete tasks before committing. After a lot is started, users can insert buffer days to create deliberate schedule gaps, and ready/pending statuses refresh after schedule-affecting operations. Inspections are kept for documentation in the Overview and no longer block scheduling or task completion. Deleted tasks are removed from Supabase via explicit delete sync rather than relying on upserts.

## Context and Orientation

BuildFlow is a single-file React app with schedule logic split into helper modules. The UI and state live in src/BuildFlow.jsx. Schedule logic is in src/lib/scheduleEngine.js, including reschedule previews, list reordering, and lot start generation. Tasks are stored per lot in app.lots[].tasks, and each task includes schedule fields (scheduled_start, scheduled_end, duration, track, phase) and a status field (ready, pending, in_progress, complete, delayed). Dependencies are stored on tasks (task.dependencies) and in Supabase’s task_dependencies table, but the goal of this change is to remove dependency constraints from scheduling and rescheduling. Inspections currently appear in schedule views and can block tasks; those gates must be removed for scheduling while leaving inspection document uploads in the overview tab.

Important files and where they are used:

- src/BuildFlow.jsx: main UI, schedule list, reschedule modal, task modal, start-lot modal, and Supabase sync.
- src/lib/scheduleEngine.js: functions like buildReschedulePreview, scheduleWithDependencies, buildLotTasksFromTemplate, applyListReorder, deriveTaskStatus, and startLotFromTemplate.
- supabase/sql/001_bootstrap_buildflow.sql: schema shows tasks.status is text; task_dependencies is a separate table.

“Dependency” means a relationship where one task cannot start until another finishes (FS, SS, FF, SF). This plan removes that scheduling gate. “Ready status” means the next task a superintendent should start. After this change, the earliest scheduled task in each track (that is not complete or in progress) is marked ready; all other not-started tasks are pending.

“Buffer days” means a gap inserted between tasks without marking a task delayed. It shifts scheduled dates forward while keeping statuses and delay fields unchanged.

## Plan of Work

First, remove dependency constraints in scheduleEngine and BuildFlow. In src/lib/scheduleEngine.js, update buildReschedulePreview so it no longer calculates earliest_start from dependencies and never marks dependency_violation. Update scheduleWithDependencies to schedule sequentially within a track without consulting dependencies. Update canStartTask and deriveTaskStatus to remove dependency and inspection gating; these functions will rely on explicit statuses and the ready-status refresh. In src/BuildFlow.jsx, remove dependency-based checks in getEarliestStartIso, getCalendarDropStatus, and RescheduleTaskModal so the “Dependency Violation” message and earliest-start blocking are gone. Ensure applyReschedule does not return invalid due to dependency_violation.

Second, add a schedule preview step to Start Lot. In StartLotModal (src/BuildFlow.jsx), create local preview state when a lot and start date are selected. Build draft tasks using startLotFromTemplate or buildLotTasksFromTemplate and then apply a schedule preview (sequential by track) so each task has scheduled_start and scheduled_end. Add a preview section that renders the draft task list, supports drag-and-drop reordering within a track, allows inline duration edits, and has an “Add Task” action (reuse AddTaskModal with the same presets used elsewhere). When the user clicks “Start Lot & View Schedule,” pass the draft tasks into the start flow so those edited tasks are saved. After the lot is started, the existing schedule list should still allow drag/drop, duration edits, and task additions as it does today.

Third, implement buffer days between tasks. Add a new action in the task modal or schedule list called “Insert Buffer Days.” This should open a small modal asking for a number of days. When confirmed, shift the selected task and all later tasks in the same track by that number of workdays. Use workday helpers so weekends and holidays are skipped. Update scheduled_start and scheduled_end only; do not mark tasks as delayed. Record the change in schedule_changes with a reason like “Buffer inserted.” After shifting, refresh ready status so the earliest task in each track is ready.

Fourth, remove inspections from the schedule. In the task modal UI, remove the “Inspection” button and any “Complete & Schedule Inspection” label. In the calendar and schedule list, stop showing inspection entries and remove inspection blocking logic in deriveTaskStatus and canStartTask. Inspection documents should remain in the overview tab (existing file upload in task modal and lot overview stays). The underlying inspection data structures can remain but are no longer tied to scheduling or task readiness.

Fifth, add uncomplete and delete for tasks. Add a “Mark Incomplete” action when a task is complete; this should set status back to pending or ready (after ready-status refresh), clear actual_end, and optionally clear actual_start if the user wants a full reset. Add a “Delete Task” action in the task modal that removes the task from the lot and removes any dependencies that pointed to it. Update Supabase sync so deletions persist: keep a list of deleted task IDs in app state (persisted in localStorage), delete those IDs from the tasks table during the next sync before upserts, and then clear the list once the delete succeeds. This ensures deleted tasks do not reappear after a refresh.

Finally, add a ready-status refresh helper and call it after schedule changes. Implement a helper (either in scheduleEngine or BuildFlow) that sorts tasks by track and scheduled_start, marks the earliest not-complete/not-in-progress task in each track as ready, and sets all other not-started tasks to pending. Call this helper after drag/drop reorder, duration edits, reschedules, buffer inserts, task additions, task deletions, and when starting a lot. This ensures the “ready” status stays aligned with the visible schedule order.

## Concrete Steps

Work in the repository root: C:\Users\brade\Documents\Projects\BuildFlow\buildflow.

1) Locate dependency gating and reschedule UI.
   - Run: rg -n "dependency_violation|getEarliestStartIso|RescheduleTaskModal" src/BuildFlow.jsx
   - Run: rg -n "buildReschedulePreview|scheduleWithDependencies|canStartTask|deriveTaskStatus" src/lib/scheduleEngine.js
   You should see buildReschedulePreview in scheduleEngine and RescheduleTaskModal in BuildFlow.

2) Update scheduleEngine to ignore dependencies and inspections.
   - Edit src/lib/scheduleEngine.js functions:
     - buildReschedulePreview: remove dependency loop, always set dependency_violation to false, and skip earliest_start gating.
     - scheduleWithDependencies: replace with sequential scheduling that does not read task.dependencies.
     - canStartTask and deriveTaskStatus: remove dependency and inspection gating so status is driven by explicit state and ready-refresh.
   Keep workday normalization intact.

3) Update reschedule and drag/drop validation in BuildFlow.
   - In src/BuildFlow.jsx:
     - Remove dependency checks from getEarliestStartIso and getCalendarDropStatus.
     - Update applyReschedule to no longer block on preview.dependency_violation.
     - Remove the dependency warning block in RescheduleTaskModal and allow reschedule when a normalized date exists.

4) Add schedule preview to StartLotModal.
   - In src/BuildFlow.jsx, update StartLotModal:
     - Build draft tasks when a lot and start date are present, and store them in local state.
     - Render a preview list with drag handles and duration inputs.
     - Add an “Add Task” button that opens AddTaskModal and appends to the draft list.
     - Update the onStart handler to use draft tasks instead of regenerating on submit.

5) Add buffer days insertion.
   - Add a new modal component (or reuse an existing small modal pattern) in src/BuildFlow.jsx that asks for buffer days.
   - Implement a helper that shifts scheduled_start/scheduled_end for the selected task and later tasks in the same track by N workdays.
   - Call the ready-status refresh helper after applying the buffer.

6) Remove inspections from schedule UI and gating.
   - In TaskModal, remove the inspection button and any “Complete & Schedule Inspection” label.
   - In schedule/calendar views, stop rendering inspection entries.
   - In scheduleEngine, remove inspection gating from canStartTask and deriveTaskStatus.

7) Add uncomplete and delete task actions.
   - In TaskModal, add actions for “Mark Incomplete” and “Delete Task” with confirmation.
   - Implement new handlers in BuildFlow to update lot.tasks and clear actual_end for uncomplete.
   - Track deleted task IDs in app state and ensure Supabase sync deletes those tasks before upserts.

8) Add ready-status refresh helper and wire it into schedule changes.
   - Implement a helper that reassigns ready/pending by track based on scheduled_start.
   - Call it after: drag/drop reorder, duration change, reschedule, buffer insert, add task, delete task, and start lot.

## Validation and Acceptance

Run npm run lint and fix any errors. Start the dev server with npm run dev and verify the following manual checks:

- Starting a lot shows a schedule preview list where tasks can be reordered, durations edited, and tasks added before confirming.
- Reschedule modal no longer shows “Dependency violation” and allows any valid workday date.
- Dragging tasks in the schedule does not show earliest-start dependency errors.
- Inserting buffer days shifts later tasks and maintains a visible gap on the schedule timeline.
- The “Ready” status updates so the earliest task per track is ready after any schedule change.
- Tasks can be started, completed, and reverted to incomplete.
- Deleting a task removes it from the lot and it does not return after reload (Supabase sync removes it).
- Inspections no longer appear in schedule views and do not block task readiness or completion.

## Idempotence and Recovery

All changes are safe to run multiple times. If a modal or helper is added, ensure it is only mounted when used. If Supabase deletes fail, keep deleted task IDs in the pending delete list so they can be retried on the next sync. If a task is deleted by mistake, rerun the seed reset function or re-add the task using Add Task.

## Artifacts and Notes

Include any useful validation outputs here during implementation, such as a short lint transcript or a before/after snippet of the reschedule modal showing the dependency warning removed.

## Interfaces and Dependencies

Use existing modules and helpers:

- In src/lib/scheduleEngine.js, continue using makeWorkdayHelpers for workday-aware date math.
- In src/BuildFlow.jsx, use updateLot for all lot/task mutations, and reuse AddTaskModal for adding tasks in preview.
- For Supabase sync deletions, extend the current flushSupabaseWrite flow to accept a list of deleted task IDs and call supabase.from('tasks').delete().in('id', ids) before upserts.

Any new helper for ready-status refresh should accept (lot, org) or (tasks, org) and return a new tasks array with updated status values.

---
Revision note: Initial plan created to capture dependency removal, start-lot preview, buffer days, inspection removal, task delete/uncomplete, and ready-status refresh. It is aligned to .agent/PLANS.md requirements.
Revision note (2026-02-03): Updated Progress/Decision Log to reflect the actual current worktree state (dependencies already ignored) and clarified the inspections scope (Overview-only, non-gating) plus the Start Lot preview expectations.
Revision note (2026-02-03): Implemented the remaining milestones (Start Lot preview, buffer insertion UI, inspection decoupling, uncomplete/delete, Supabase delete sync) and updated this ExecPlan to reflect the real status and validation results.
