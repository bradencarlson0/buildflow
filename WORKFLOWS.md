# Core Workflows

## 1) Start Lot -> Generate Schedule
1. User starts lot from community/lot context.
2. Template tasks are instantiated with dependencies.
3. `scheduleEngine` computes workday-aware start/end dates.
4. Lot tasks are saved to app state and persisted.

## 2) Edit Schedule (Delay / Duration / Reorder / Parallel)
1. User updates task timing in list/timeline.
2. BuildFlow handler calls `scheduleEngine` preview/apply helpers.
3. Engine accounts for dependencies + workdays/holidays.
4. Affected tasks are updated and persisted.

## 3) Punch List Flow
1. Open punch list from a lot.
2. Add/edit punch items by category.
3. Mark complete/incomplete to update progress.
4. Send-to-subs groups open items per subcontractor.
5. Draft opens in SMS/email client for final send by user.

## 4) Subcontractor Management
1. Open Subs tab.
2. Add or edit sub and contacts (primary + additional).
3. Trade assignment drives filtering in scheduling/punch flows.
4. Contact actions open phone/email/sms intents.

## 5) Photo/File Storage Flow
1. File selected in UI.
2. Binary stored via IndexedDB (`idb`).
3. Metadata with `blob_id` linked to lot/task/punch/doc entities.
4. Viewer resolves `blob_id` to show/open content.

## 6) Admin Configuration
1. Manage product types, plans, agencies, contact library, trades, custom fields.
2. Changes affect downstream forms, filtering, and setup flows.
3. Data persists locally immediately.

## 7) Report and Ops Flows
- Daily logs, inspections, materials, and report export are modal-driven.
- Most actions mutate lot-level arrays and queue notifications/messages where configured.

## Workflow Guardrails
- Keep schedule math in `scheduleEngine`.
- Keep workday logic in `date` helpers.
- Avoid duplicate domain logic in modal components.
