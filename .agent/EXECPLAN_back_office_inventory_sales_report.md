# Back-Office Inventory Report Automation and Lot Classification

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This document follows `.agent/PLANS.md` from the repository root and must be maintained in accordance with that file.

## Purpose / Big Picture

Back-office users need a weekly inventory and sales sheet that is mostly auto-filled from lot, plan, and schedule data, while still allowing office-only manual updates for cost and pricing fields. After this change, users can generate an `Inventory & Sales` report directly from the Reports tab, classify lots as `vacant/spec/model/sold`, and maintain plan-based square-foot defaults that prefill report output.

## Progress

- [x] (2026-02-18 00:00Z) Mapped current lot/report/plan flows and identified backward-compatible persistence path using lot `custom_fields`.
- [x] (2026-02-18 00:27Z) Implemented lot type normalization and UI controls in Start Lot and Sales views (`vacant/spec/model/sold`) with default fallback to `vacant`.
- [x] (2026-02-18 00:31Z) Implemented admin-editable plan total sqft metadata and plan-linked sqft display in Start Lot and Sales.
- [x] (2026-02-18 00:35Z) Implemented `inventory_sales` report type and exposed it in one-off and scheduled report selectors.
- [x] (2026-02-18 00:38Z) Ran lint and confirmed no errors (existing baseline warnings remain in large `BuildFlow.jsx`).

## Surprises & Discoveries

- Observation: Supabase schema does not currently include dedicated `lot_type` or separate `sq_ft_heated`/`sq_ft_total` columns.
  Evidence: `supabase/sql/001_bootstrap_buildflow.sql` defines `lots.custom_fields` and `plans.sq_ft` only.

## Decision Log

- Decision: Persist lot classification in `lot.custom_fields` (with a mirrored convenience field in client state) instead of adding a new DB column immediately.
  Rationale: This avoids breaking sync for deployments that have not run new SQL migrations while still enabling immediate UX/report automation.
  Date/Author: 2026-02-18 / Codex

- Decision: Keep `plans.sq_ft` as heated sqft and store editable total sqft metadata in org settings (`org.plan_sq_ft_total`) for this iteration.
  Rationale: It is backward-compatible with current schema and allows admin-driven prepopulation now.
  Date/Author: 2026-02-18 / Codex

## Outcomes & Retrospective

Implemented the requested automation baseline without introducing DB-breaking schema requirements. Lot classification is now explicit and editable, office-only cost fields are editable in Sales, and a dedicated `Inventory & Sales` export now compiles lot/plan/sales data with manual overrides and realistic estimated fillers when values are blank. Plan heated/total sqft linkage is visible during lot start and configurable in Admin.

Remaining gap for a later phase: if multi-device cloud-level persistence is required for plan total sqft as a first-class database column, a Supabase migration and sync contract update should be added. The current approach keeps compatibility by storing total sqft metadata in org settings.

## Context and Orientation

`src/BuildFlow.jsx` is the main app shell and contains state, report generation, admin screens, start-lot workflow, and sales workflow. `src/data/seed.js` provides initial org/plan/lot defaults. `src/lib/storage.js` performs app-state migration and should normalize old snapshots so new fields do not require manual data cleanup.

The report export pipeline has two key stages in `src/BuildFlow.jsx`: `buildReportData` (builds report rows by type) and `generateReportExport` (writes CSV/Excel/PDF). Adding a report type requires adding its branch in `buildReportData` and exposing the type in `GenerateReportModal` and `ScheduledReportsModal`.

## Plan of Work

Update shared constants and helpers in `src/BuildFlow.jsx` to normalize lot type, read/write office custom field keys, and resolve plan sqft values. Extend lot mapping and migration logic to ensure `vacant` is the default classification when missing.

Modify `StartLotModal` in `src/BuildFlow.jsx` to include a lot type selector and display plan-linked heated/total sqft. Ensure start actions persist lot type into `custom_fields`.

Modify the Sales tab in `src/BuildFlow.jsx` to let office users quickly edit lot type and manual cost fields. Keep changes backward-compatible by storing values in `lot.custom_fields`.

Modify Admin > Plans in `src/BuildFlow.jsx` to support editing total sqft metadata and preserve it under org settings. Keep existing plan `sq_ft` behavior as heated sqft.

Add `inventory_sales` report logic in `buildReportData`, with realistic fallback estimates only in generated rows when office fields are blank. Add the report option in one-off and scheduled report modals.

Update seed and migration defaults in `src/data/seed.js` and `src/lib/storage.js` so existing and new data include default lot type and plan total sqft metadata scaffolding.

## Concrete Steps

From `buildflow-clone`:

1. Edit `src/BuildFlow.jsx` for helpers, modal/UI updates, and report branch.
2. Edit `src/data/seed.js` for default office/report-oriented seed fields.
3. Edit `src/lib/storage.js` migration to backfill missing default fields.
4. Run `npm run lint`.

Expected lint outcome: zero errors.

## Validation and Acceptance

1. Open the app, go to Admin > Plans, and verify each plan has editable `Heated Sq Ft` and `Total Sq Ft`.
2. Start a lot and verify default `Lot Type` is `Vacant`; change it and confirm it persists.
3. In Sales, change lot type and edit lot cost/construction cost/purchase price values; confirm values persist on refresh.
4. Generate `Inventory & Sales` report and verify rows include community, lot, plan, sqft, lot type, sold status, and office fields.
5. Add a scheduled report and verify `Inventory & Sales` appears as an available type.

## Idempotence and Recovery

All changes are additive and can be re-run safely. State migration backfills missing fields without mutating unrelated data. If a UI regression appears, revert only the touched files and rerun lint.

## Artifacts and Notes

Lint transcript (summary):

  npm run lint
  Result: 0 errors, 33 warnings (warnings are pre-existing react-hooks warnings in `src/BuildFlow.jsx`).

## Interfaces and Dependencies

Use existing React state and helper patterns in `src/BuildFlow.jsx`; no new runtime dependencies are required. Keep report output format in the existing `{ title, sheets: [{ name, rows }] }` contract expected by `generateReportExport`.

Revision note (2026-02-18): Updated this plan from design-only to implementation-complete after shipping the lot type workflow, admin sqft metadata, and inventory/sales reporting. Added lint evidence and captured the compatibility rationale for storing new fields without a mandatory DB migration.
