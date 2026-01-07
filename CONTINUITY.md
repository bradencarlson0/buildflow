Goal (incl. success criteria):
- Implement BuildFlow enhancements from `buildflow-enhancements.md` across data model, admin settings, community creation, lot start, views, inspections, sales, hybrid schedule, and dashboard; app runs with new flows and default seed data updated.
- Add continuity ledger behavior: maintain `CONTINUITY.md` each turn, include Ledger Snapshot in replies.
- Add requested UX enhancements: cascading filter options, calendar week timeline view across active jobs, and hybrid schedule work-week toggle.
- Provide direct email/SMS actions when messaging subcontractors in the Subs tab.
- Improve mobile schedule view width/usability and fix iOS photo upload "Use Photo" failure (invalid image error).
- Align Community Specs UI/structure to subdivision spec expectations from `BrelandData/Grove Subdivision Specs.pdf`.
- Incorporate spec data from `BrelandData/Grove Sub Specs.xlsx`.
- Populate subcontractor list data from `BrelandData/Sub List Braden.xlsx`.
- Cross-check subcontractor list with `BrelandData/Sub List Braden-2.xlsx`.
- Incorporate scheduling cover sheet workflow from `BrelandData/Cover Sheets.xlsm`.
- Align schedule templates/UX to `BrelandData/Sample Construction Schedule.xlsx` and builder feedback about exterior work overlap.
- Keep exterior work manual/ad hoc with quick scheduling UI.

Constraints/Assumptions:
- Workspace: `/Users/bradencarlson/Documents/BuildingSchedule`; sandbox: danger-full-access; network enabled; approval policy: never.
- Use ASCII in edits; avoid reverting unrelated changes.
- Community creation replaces blocks with sequential lots; lots assigned by product type and builder ranges.
- Admin-configurable product types/plans/agencies/custom fields drive new flows.

Key decisions:
- UNCONFIRMED: Whether to create `robust-coalescing-tulip.md` plan file referenced in `buildflow-enhancements.md`.
- Planned: Keep backward compatibility by tolerating legacy `block` fields on lots/communities while new flow uses `lot_number` only.
- User wants 24/7 public access for remote testing.
- GitHub: `bradencarlson0/buildflow`, public, use GitHub CLI.

State:
- Latest long-press drag rescheduling changes committed and pushed.
- New request: allow drag across Work Week boundaries (auto flip to next/prev week while dragging).
- New request: freeze left task column and date header in schedule timeline while scrolling (both work week and week views).
- New request: make Month Overview show more descriptive visuals of activity.
- Latest schedule timeline and month overview updates committed and pushed.
- New request: keep dragged task visible when flipping weeks by pinning it as the top row.
- Uncommitted updates in `src/BuildFlow.jsx` for pinned drag row in Work Week timeline.

Done:
- Read repo structure and `buildflow-enhancements.md`.
- Created `CONTINUITY.md`.
- Updated data model foundations (constants, templates, seed data, storage migration).
- Added `src/lib/utils.js` for range parsing/validation.
- Rebuilt community creation wizard steps 1/2/4/5 for product types, lot ranges, agencies, realtors, inspectors, and builders with validation.
- Updated Start Lot flow to use product type templates, plan selection, job number, and custom fields.
- Updated schedule engine start to honor template build days and plan/job/custom fields.
- Enhanced community view with builder color legend, contacts quick access + edit modal, and spec applicability + bulk add/filtering.
- Added lot Photos tab with camera/upload, punch list optional photos + checkbox sign-off, and inspection checklist gating.
- Added admin settings tab, sales view, hybrid schedule timeline toggle, and dashboard summary cards.
- Revamped admin tab UI layout and section navigation for a more professional settings experience.
- Updated lot timeline view with Work Week day columns and clickable tasks (opens task modal).
- Added week-by-week navigation for Work Week timeline and constrained display to the active week.
- Improved Sales view summary and made filters cascade based on other selections.
- Fixed Work Week timeline crash from undefined `workdays` reference.
- Replaced free-text lot assignment with structured range pickers for product types and builders in community creation.
- Replaced free-text lot assignment in community contacts modal with structured range pickers.
- Builder assignment validation now counts builders with assigned lots even if contact fields are blank (fixes missing count updates).
- Added modal body scroll lock to prevent background scrolling under popups.
- Added subcontractor contact modal with Email/SMS actions for the Subs tab.
- Added responsive sizing for Hybrid Schedule view on small screens.
- Added image validation/normalization before saving photos to IndexedDB; guards null photo IDs in daily log/materials flows.
- Routed Lot Photos tab camera/upload actions through PhotoCaptureModal (same flow as Add Photos) for mobile reliability.
- Set default `type="button"` for shared buttons and explicit type on PhotoCaptureModal remove button to avoid form-submit quirks.
- Added step 5 community wizard blocker list and used it to gate Create.
- Added product type pills in community lots grid/list/kanban.
- Added persistent bottom nav styling for improved clickability while scrolling.
- Added Calendar Week Timeline view in Calendar tab.
- Updated Schedule Inspection modal with existing vs new inspector selection.
- Initialized git repo and created initial commit.
- Created and pushed GitHub repo: `https://github.com/bradencarlson0/buildflow`.
- Netlify deploy: `https://incandescent-dusk-f13a67.netlify.app`.
- Renamed Netlify site: `https://builderschedule.netlify.app`.
- Provided 24/7 public hosting guidance and completed deployment.
- Pushed latest changes to GitHub (commit: 3bfebae).
- Compared `Sub List Braden.xlsx` vs `Sub List Braden-2.xlsx`; found 3 added rows and one trade label change.
- Updated schedule templates to match the sample construction schedule and added flexible exterior gating.
- Added week timeline drag-and-drop rescheduling support with visual drop highlights.
- Replaced seed subcontractor list with merged Excel data + trade mappings; renamed IBP category to include wire shelving.
- Removed auto-scheduled exterior tasks from the base template; added an exterior quick-add modal for ad hoc scheduling.
- Updated exterior task sub assignment to fall back to all subs when no trade match is found.
- Pushed latest schedule/sub list/template updates (commit: 17e2e73).
- Confirmed `BrelandData/` stays local and is not pushed.
- Added shared reschedule preview/apply helper and updated reschedule modal to use it.
- Added long-press drag rescheduling in Lot > Schedule work-week timeline (with drop highlighting + dependency checks).
- Committed and pushed reschedule/drag updates (commit: 292fbc1).
- Added cross-week drag auto-flip logic and sticky schedule headers/columns.
- Enhanced Month Overview day cells with task/inspection summaries.
- Committed and pushed schedule timeline + Month Overview updates (commit: 1563446).
- Added pinned drag row support for cross-week dragging (uncommitted).

Now:
- Verify mobile schedule view change on device.
- Re-test iOS job photo upload in Lot Photos tab after routing to modal flow.
- Confirm new Netlify URL and proceed with remaining app tasks.
- Confirm Netlify redeploy completed and verify the new calendar/inspection updates on the hosted URL.
- Review subdivision specs PDF and update community specs workflow to match expectations.
- Review Grove specs Excel file and map it into community specs.
- Review scheduling cover sheet Excel macro file and map it into app workflow.
- Verify exterior ad hoc scheduling flow in the lot schedule view.
- Re-test exterior task sub dropdown with the trade fallback.

Next:
- Confirm scope for drag/drop scheduling (week view only, or across all schedule views).
- Validate calendar and sales filter behavior after cascade changes.
- Verify timeline rendering in lot detail and calendar week timeline.
- Decide on spec categories/template and implement community specs updates.
- Decide how Grove specs should seed community specs (template vs import).
- Define cover sheet fields and implement export/print flow for subs.
- Validate new schedule template + drag rescheduling UX against real usage.

Open questions (UNCONFIRMED if needed):
- Does the user still want `robust-coalescing-tulip.md` generated from the spec text?
- Confirm if the failing flow was Lot > Photos tab Take/Upload (now routed to modal), and whether it works after this change.
- Confirm preferred community spec format (categories/sections, required vs optional, template vs freeform).
- Confirm whether Grove specs should be auto-applied to specific community or stored as reusable template.
- Confirm how cover sheets should be generated (PDF export, email attachment, or in-app print view).
- Confirm scope for drag/drop scheduling (week view only, or across all schedule views).

Working set (files/ids/commands):
- `buildflow-enhancements.md`
- `src/BuildFlow.jsx`
- `src/data/seed.js`
- `src/data/constants.js`
- `src/data/template.js`
- `src/lib/scheduleEngine.js`
- `src/lib/storage.js`
- `src/lib/utils.js` (new)
- `CONTINUITY.md`
- `BrelandData/Grove Subdivision Specs.pdf`
- `BrelandData/Grove Sub Specs.xlsx`
- `BrelandData/Sub List Braden.xlsx`
- `BrelandData/Sub List Braden-2.xlsx`
- `BrelandData/Cover Sheets.xlsm`
- `BrelandData/Sample Construction Schedule.xlsx`
