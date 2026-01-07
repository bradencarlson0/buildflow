Goal (incl. success criteria):
- Implement BuildFlow enhancements from `buildflow-enhancements.md` across data model, admin settings, community creation, lot start, views, inspections, sales, hybrid schedule, and dashboard; app runs with new flows and default seed data updated.
- Add continuity ledger behavior: maintain `CONTINUITY.md` each turn, include Ledger Snapshot in replies.
- Add requested UX enhancements: cascading filter options, calendar week timeline view across active jobs, and hybrid schedule work-week toggle.
- Provide direct email/SMS actions when messaging subcontractors in the Subs tab.
- Improve mobile schedule view width/usability and fix iOS photo upload "Use Photo" failure (invalid image error).

Constraints/Assumptions:
- Workspace: `/Users/bradencarlson/Documents/BuildingSchedule`; sandbox write only here; network restricted.
- Use ASCII in edits; avoid reverting unrelated changes.
- Community creation replaces blocks with sequential lots; lots assigned by product type and builder ranges.
- Admin-configurable product types/plans/agencies/custom fields drive new flows.

Key decisions:
- UNCONFIRMED: Whether to create `robust-coalescing-tulip.md` plan file referenced in `buildflow-enhancements.md`.
- Planned: Keep backward compatibility by tolerating legacy `block` fields on lots/communities while new flow uses `lot_number` only.

State:

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

Now:
- Verify mobile schedule view change on device.
- Re-test iOS job photo upload in Lot Photos tab after routing to modal flow.
- Confirm new Netlify URL and proceed with remaining app tasks.
- Push latest changes to GitHub to trigger Netlify redeploy.

Next:
- Validate calendar and sales filter behavior after cascade changes.
- Verify timeline rendering in lot detail and calendar week timeline.

Open questions (UNCONFIRMED if needed):
- Does the user still want `robust-coalescing-tulip.md` generated from the spec text?
- Confirm if the failing flow was Lot > Photos tab Take/Upload (now routed to modal), and whether it works after this change.

Key decisions:
- User wants 24/7 public access for remote testing.
- GitHub: `bradencarlson0/buildflow`, public, use GitHub CLI.

Done:
- Initialized git repo and created initial commit.
- Created and pushed GitHub repo: `https://github.com/bradencarlson0/buildflow`.
- Netlify deploy: `https://incandescent-dusk-f13a67.netlify.app`.
- Renamed Netlify site: `https://builderschedule.netlify.app`.
- Provided 24/7 public hosting guidance and completed deployment.

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
