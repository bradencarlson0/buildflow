# BuildFlow Codebase Index (Detailed, In-Sync)

This index mirrors the architecture model in `ARCHITECTURE_MAP.md` and focuses on how each part behaves in production-like usage.

## 1) Runtime Entry Chain

### `src/main.jsx`
- React entrypoint.
- Renders `<App />` under `StrictMode`.
- Loads `index.css`.

### `src/App.jsx`
- Very thin composition layer.
- Returns `<BuildFlow />`.

### `src/BuildFlow.jsx`
- Primary orchestration module.
- Contains:
  - global app state
  - all major route/tab rendering logic
  - nearly all modal render and save flows
  - glue code to `data/*` and `lib/*`

Practical note:
- This file is intentionally central; changes should remain targeted to avoid regressions.

---

## 2) Domain Definition Layer (`src/data/*`)

### `src/data/constants.js`
Primary domain catalogs and static references, including:
- trades
- categories (tasks, photos, punch)
- milestones
- inspection types/checklists
- message templates
- statuses and option lists

Practical effect:
- Most dropdowns and labels in the UI derive from here.
- Changes here ripple broadly across forms and filters.

### `src/data/template.js`
- Schedule template definitions (task defaults, phases/tracks, dependencies).
- Used when creating/starting lots and generating baseline task timelines.

### `src/data/seed.js`
- `createSeedState()` factory for local-first bootstrap data.
- Provides initial org settings, communities/lots, subcontractors, etc.

Practical effect:
- First-run app behavior is controlled here.
- Useful for smoke testing complex flows without backend dependency.

---

## 3) Scheduling and Date Engine (`src/lib/*`)

### `src/lib/scheduleEngine.js`
Core schedule behavior:
- reschedule preview
- dependency validation/cascade
- duration impact propagation
- list reorder behavior
- parallel planning helpers
- progress and completion projections

Design boundary:
- Scheduling math should remain here, not duplicated in UI handlers.

### `src/lib/date.js`
- Workday-aware date helpers.
- Applies weekend/holiday logic based on org settings.

### `src/lib/utils.js`
- Shared utility operations (ranges, assignment validation, normalization).

### `src/lib/uuid.js`
- ID generation helper used across entities and modal drafts.

---

## 4) Persistence + Offline

### `src/lib/storage.js`
- App-state serialization/deserialization in localStorage.
- Contains load/save/clear entry points.

### `src/lib/idb.js`
- IndexedDB blob operations for files/photos.
- Keeps heavy binary payload out of localStorage.

Practical storage split:
- localStorage: metadata and app graph
- IndexedDB: binary blobs

---

## 5) Messaging and Templating

### `src/lib/templating.js`
- `fillTemplate` utility for outbound comms.

### Messaging behavior in `BuildFlow.jsx`
- Generates grouped punch communications by subcontractor.
- Opens SMS/email drafts via URI handlers.
- Uses contact resolution helpers for phone/email fallbacks.

Constraint:
- Web URI drafts can prefill text, but not SMS attachments.

---

## 6) Modal System (How It Works)

### Shared modal shell
- `Modal` component provides common structure:
  - title row + close
  - scrollable body area
  - optional footer actions
  - body scroll lock behavior
  - configurable z-index for stacked modals

### Global modal orchestration pattern
In `BuildFlow.jsx`:
1. A UI action sets a modal state key (`setXxxModal(...)`).
2. Render section conditionally mounts the modal.
3. Modal receives resolved entities (lot/task/sub/etc.).
4. Save/apply callbacks update app state, then close.

### Modal groups in practice
- Scheduling: task details, delays, reschedule, inspections
- Media: source/capture/viewer/timeline/file modals
- Punch list: list/add-edit/send/draft stack
- Ops: daily logs, materials, change orders
- Admin/config: specs, docs, contacts, reports, sub edit/contact

### Stacking behavior
- Some flows open a secondary modal over a primary modal (e.g., photo viewer over punch list).
- `zIndex` support in `Modal` handles this reliably.

---

## 7) Feature Clusters in `BuildFlow.jsx`

### A) Navigation + Layout
- Bottom nav with mobile "More" overflow behavior.
- Root tab routing and nested lot/community selection states.

### B) Communities + Lots
- Lot lifecycle management.
- Lot/task rendering and inline edits.
- Start lot / template application paths.

### C) Scheduling UX
- List/timeline views.
- Drag/reorder and dependency-sensitive updates.
- Duration and parallel task operations.

### D) Subcontractors
- Sub list cards with contact channels.
- Sub contact modal (message intents).
- Sub edit modal (primary + additional contacts, trade selection).

### E) Punch List
- Category accordion and progress indicators.
- Add/edit item modal with category/task/sub filtering.
- Send-to-subs grouping.
- Message draft preview and native handoff.

### F) Media + Files
- Photo capture/upload sources.
- Blob-backed preview and fullscreen flows.
- Lot-level/site plan/document file handling.

### G) Daily Logs / Inspections / Materials / Reports
- Operational tracking screens.
- Optional notifications and queueing behavior.

### H) Admin
- Product types, plans, agencies, contact library, custom fields, custom trades.

---

## 8) Data Mutation Strategy (Practical)

Typical mutation paths:
- `setApp(...)` for broad updates.
- targeted helpers (`updateLot`, `updateCommunity`) for scoped changes.

Why this matters:
- Keeps state transitions explicit.
- Makes modal save callbacks straightforward.

---

## 9) Typical End-to-End Flows

### Flow: schedule change
1. User action in list/timeline.
2. BuildFlow handler computes preview/result via `scheduleEngine`.
3. Task dates/order updated on lot state.
4. Optional notifications/messages generated.
5. Persisted to local storage layer.

### Flow: file/photo
1. File selected in modal.
2. Blob written via `idb` helper.
3. Metadata linked on lot/task/punch entity.
4. Viewer resolves `blob_id` and renders preview.

### Flow: punch comms
1. Open punch list.
2. Group open items by sub.
3. Build draft body.
4. Open sms/mail draft via URI.

---

## 10) Operational Constraints (Current)

- Local-first architecture; no required backend to run.
- Messaging on web cannot inject SMS attachments.
- `BuildFlow.jsx` remains a high-coupling integration point.
- Critical logic boundaries to preserve:
  - schedule math in `scheduleEngine`
  - workday logic in `date`
  - persistence adapters in `storage`/`idb`

---

## 11) Contributor Reading Path (Recommended)

1. `AGENTS.md` (project constraints + working agreements)
2. `ARCHITECTURE_MAP.md` (system-level map)
3. `src/BuildFlow.jsx` (UI orchestration)
4. `src/lib/scheduleEngine.js` + `src/lib/date.js` (timeline core)
5. `src/lib/storage.js` + `src/lib/idb.js` (persistence)
6. `src/data/constants.js` + `src/data/template.js` (domain model)

---

## 12) Keep-In-Sync Rules

When architecture changes, update BOTH docs:
- `ARCHITECTURE_MAP.md` (ASCII topology + flows)
- `CODEBASE_INDEX.md` (file-level behavioral index)

At minimum, update sections for:
- new/removed modal groups
- new admin modules
- changed scheduling behavior boundaries
- changed persistence responsibilities
- new feature cluster entry points
