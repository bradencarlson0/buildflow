# Schedule Editing, Manual Tasks, Files, and Mobile UX Improvements

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

This plan must be maintained in accordance with buildflow/.agent/PLANS.md.

## Purpose / Big Picture

After this change, superintendents can fine‑tune schedules in place: adjust a task’s duration in the list view and automatically cascade dependent tasks, drag tasks in both timeline and list views with tactile feedback, and align multiple tasks to run in parallel with an optional dependency‑clearing override. Manual tasks can be added as a universal “Create Task” flow with category selection. Lot and task files are organized with labels and descriptions, and the bottom navigation fits on mobile. Subcontractor cards surface the primary contact name and email actions behave predictably with Outlook defaults. The result is a schedule experience that is fast, editable, and realistic without losing dependency safety.

## Progress

- [x] (2026-01-31 00:00Z) Create this ExecPlan and confirm scope, assumptions, and UX decisions.
- [x] Implement duration editing and cascading schedule updates in list view.
- [x] Enable multi‑task parallelization flow with validation, override option, and reschedule logic.
- [x] Extend drag‑and‑drop scheduling to be usable on mobile and desktop (timeline + list), with haptic feedback.
- [x] Replace “Exterior Task” with “Create Task” and add category selection plus preset updates.
- [x] Add lot‑level and task‑level Files with labels and descriptions; update photo/file labeling visibility.
- [x] Fix bottom navigation layout on phones; surface sub contact name in list; clarify email behavior.
- [ ] Validate UX flows and update documentation snippets in this plan.

## Surprises & Discoveries

`npm run lint` failed on Node 14 because eslint 9 requires Node >=18.18 and relies on the `node:` module prefix. Upgraded to Node 24 and disabled strict React compiler lint rules (`react-hooks/set-state-in-effect`, `react-hooks/preserve-manual-memoization`) to align with existing patterns.

## Decision Log

- Decision: Use mailto as the default email action and optionally provide a secondary “Outlook Web” action.
  Rationale: Browsers cannot reliably force Outlook Desktop; mailto respects the OS default mail client and Outlook Web deep links are the only portable alternative.
  Date/Author: 2026-01-31 / Codex

- Decision: Duration edits will recalculate the task end date using workday rules and shift downstream tasks by the net workday delta.
  Rationale: This preserves existing dependencies and keeps the change scoped to the tasks affected by the edited task.
  Date/Author: 2026-01-31 / Codex

- Decision: Parallelize will offer an override that clears dependencies between selected tasks when the user explicitly chooses it.
  Rationale: This matches the request to run tasks simultaneously while still protecting the default path; the override is explicit and reversible by editing dependencies later.
  Date/Author: 2026-01-31 / Codex

- Decision: Manual task creation will support categories mapped to track values: foundation, structure, interior, exterior, final, and misc.
  Rationale: Tracks are already core to schedule views; a misc track keeps ad‑hoc tasks visible without forcing them into existing phases.
  Date/Author: 2026-01-31 / Codex

- Decision: Duration dropdown will offer 1–10 days.
  Rationale: This matches the requested range and keeps the inline control compact.
  Date/Author: 2026-01-31 / Codex

- Decision: List‑view drag will reorder tasks within the visible track and update sort_order, then reschedule the dragged task to the drop target’s start date to keep dates aligned with the new order.
  Rationale: This keeps list order consistent with the user’s drag intent while relying on the existing reschedule cascade for downstream dates.
  Date/Author: 2026-01-31 / Codex

- Decision: Task‑level files will be stored on each task as task.documents, distinct from lot.documents.
  Rationale: This keeps lot‑level files general while allowing task‑specific documentation and audit trails.
  Date/Author: 2026-01-31 / Codex

## Outcomes & Retrospective

Implemented schedule list duration edits with cascading updates, parallelize with dependency override, list-view drag reorder with haptics, universal Create Task with category presets, lot/task file uploads with labels/descriptions, photo captions in grids, sub contact name surfacing, Outlook Web email option, and a scrollable bottom nav for mobile. Lint passes with warnings only.

## Context and Orientation

BuildFlow is a single‑page React app. Most UI and state live in src/BuildFlow.jsx, with schedule logic in src/lib/scheduleEngine.js and workday helpers in src/lib/date.js. Schedule list view and timeline view are rendered in the lot schedule section of BuildFlow.jsx. Manual exterior tasks are created through AddExteriorTaskModal in BuildFlow.jsx. Bottom navigation lives in BuildFlow.jsx and is styled in src/index.css. Lot documents are stored in lot.documents and persisted in IndexedDB via src/lib/idb.js; photos are stored similarly but displayed in the Photos tab and Photo Timeline modal. Subcontractor cards are rendered in BuildFlow.jsx under the “subs” tab.

## Plan of Work

First, add a schedule duration editing flow for list view tasks. This will add a small duration dropdown (1–10 days) near the existing date range line in the list view row. Changing the dropdown will call a new schedule helper that recalculates the edited task’s scheduled_end based on workdays and shifts downstream tasks (same track after sort_order, plus dependent tasks) by the net workday delta. The helper will return a preview and be applied through updateLot so the change is reflected immediately. The UI will remain simple and inline, with a small “Duration” label for clarity.

Second, implement multi‑task parallelization in the list view by adding selection controls (checkboxes) and an action bar. The action will compute the latest earliest start date across the selected tasks (using the same dependency logic used for rescheduling) and attempt to move each selected task to that date with dependency validation. If any selected tasks depend on each other, show a clear blocking message and offer an explicit override that removes dependencies between the selected tasks before aligning their start date. This provides a safe default with a deliberate override path.

Third, expand drag‑and‑drop scheduling so it is available on desktop and mobile in both timeline and list views. The HybridScheduleView already supports long‑press drag in work‑week mode; extend it to week mode and add haptic feedback on drag start via navigator.vibrate when available. Add list‑view drag handles that allow reordering within a track and trigger rescheduling to the drop target’s start date. Ensure touch interactions remain smooth by preventing unintended scroll during active drag. The drag should continue to respect dependency validation and display the existing drop preview states.

Fourth, replace AddExteriorTaskModal with a universal Create Task modal. The button label and modal title should change, and the modal should include a Category dropdown with Foundation, Structure, Interior Track, Exterior Track, Final, and Miscellaneous. The task should be saved with the correct track and a reasonable phase value aligned to the chosen category, and its dates should be computed with workday logic. Update presets to move Garage Door to an interior preset, add Pest Control under exterior, and add Siding/Soffit as an exterior option. Update OUTDOOR_TASK_NAMES so Garage Door is no longer classified as outdoor.

Fifth, remove Change Orders, Daily Log, and Materials from the lot overview quick actions. Replace with a “Files” action that opens a new Lot Files modal. The modal will support uploading PDFs, images, Word, Excel, and CSV files, and each file will capture a label and description. The files list should display the label and description alongside the file name. Add a task‑level Files section inside TaskModal with the same label/description fields and file upload, stored on task.documents. Update photo grid views to show each photo’s caption under the thumbnail so labels are visible at a glance.

Finally, address the mobile bottom navigation by allowing items to wrap or scroll so all tabs remain visible on narrow screens, and add padding to the main content to match the nav height. In the subcontractor list cards, show the primary contact name above the phone number. Update the sub contact modal to include both “Email (Default)” and “Outlook Web” actions, with a short helper text explaining that the default email app is controlled by the device settings.

## Concrete Steps

Work in the repository root (buildflow). Use rg to locate the schedule list view, AddExteriorTaskModal, HybridScheduleView, and bottom nav. Implement helper functions in src/lib/scheduleEngine.js for duration changes, parallelize logic (with override), and list‑view reorder/reschedule behavior, then wire them in src/BuildFlow.jsx. Update constants in src/data/constants.js for task presets and outdoor task names. Add a new LotFilesModal and connect it to overview actions, plus new state for its modal toggle, and add task‑level document fields + UI in TaskModal.

Example commands and expected output:

    cd c:\Users\brade\Documents\Projects\BuildFlow\buildflow
    rg -n "Add Exterior Task|HybridScheduleView|lotDetailTab === 'overview'|scheduleView === 'list'" src\BuildFlow.jsx

    npm run lint
    # expect: no lint errors

## Validation and Acceptance

Start the app with npm run dev. Open a lot schedule in list view, change a task duration via dropdown (1–10 days), and verify that the task end date updates and downstream tasks shift. Drag a task in timeline week mode on mobile and drag with mouse on desktop; verify haptic feedback on supported devices and dependency violations still block invalid moves. Drag a task in list view to reorder within a track and confirm the list order changes and the dragged task reschedules to the drop target’s date. Select multiple tasks in list view and use the parallelize action; confirm it aligns start dates when valid, blocks with a clear message when dependencies exist, and succeeds when the override is chosen (dependencies removed). Use Create Task to add tasks in each category and confirm they appear under the correct track with the right start/end dates. Confirm Garage Door appears in interior presets and Pest Control/Siding‑Soffit appear under exterior. In Lot overview, confirm Files replaces Change Orders, Daily Log, and Materials, and that uploaded lot files show labels and descriptions. In TaskModal, upload task files and verify labels/descriptions display. In Photos views, captions should be visible under thumbnails. On a narrow mobile viewport, the bottom nav should show the Admin button without overlap. Subcontractor cards should show the contact name above the phone number. Email actions should open the system default client via mailto and optionally open Outlook Web when selected.

## Idempotence and Recovery

Changes are additive and UI‑only; re‑running steps will not corrupt stored data. If duration or parallelization logic misbehaves, revert the helper functions and the list‑view wiring; existing schedules remain in localStorage. The new files modals add metadata to lot.documents and task.documents, so removing them leaves existing documents intact.

## Artifacts and Notes

No artifacts yet.

## Interfaces and Dependencies

Add new schedule helpers in src/lib/scheduleEngine.js:

    export const previewDurationChange = (lot, taskId, nextDuration, orgSettings) => {
      // returns { affected, oldCompletion, newCompletion, newEnd }
    }

    export const applyDurationChange = (lot, taskId, nextDuration, orgSettings) => {
      // returns updated lot with shifted tasks
    }

    export const canParallelizeTasks = (lot, taskIds) => {
      // returns { ok, reason }
    }

    export const buildParallelStartPlan = (lot, taskIds, orgSettings, options = {}) => {
      // returns { targetStartIso, previewsById, blockedDependencies }
      // options.overrideDependencies === true clears dependencies between selected tasks
    }

    export const applyListReorder = (lot, dragTaskId, dropTaskId, orgSettings) => {
      // returns updated lot with new sort_order and rescheduled dates for drag task
    }

These helpers must use makeWorkdayHelpers for date math and preserve dependency checks consistent with buildReschedulePreview.

Plan change note (2026-01-31): Updated to allow a dependency-clearing override for parallelization, add list-view drag reorder, support task-level files, switch duration range to 1–10 days, and specify checkbox-based multi-select UI per user feedback.

