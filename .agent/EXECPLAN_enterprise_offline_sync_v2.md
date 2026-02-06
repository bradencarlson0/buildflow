# Enterprise-Ready Offline Sync v2 (Supabase + Local DB + iOS Scaffold)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan must be maintained in accordance with `.agent/PLANS.md`. BuildFlow repo working agreements live in `AGENTS.md` and must be followed, especially: avoid large rewrites of `src/BuildFlow.jsx`, preserve offline-first behavior, and do not duplicate scheduling logic outside `src/lib/scheduleEngine.js` and `src/lib/date.js`.

## Purpose / Big Picture

After this change, BuildFlow supports multiple admins and superintendents using the app concurrently on multiple devices, including offline usage, without silent data loss or â€œlast writer winsâ€ overwrites. Users can edit immediately (optimistic UI), changes persist locally (durable outbox), and the server becomes the source of truth once sync completes. Unassigned supers can browse all lots read-only; admins can edit anything; supers can self-assign lots; and, long-term, only the assigned super (and admins) can edit a lotâ€™s tasks.

This plan intentionally does not â€œrewrite the app.â€ It introduces a thin persistence and sync layer behind the existing UI, then migrates features in place behind feature flags until the old snapshot-based sync can be removed safely. The end state is compatible with a future iOS app via Capacitor by keeping the sync protocol stable and swapping only the local storage adapter.

For the demo org, the app stays permissive for editing (any signed-in demo user can edit schedules), so you can continue proving workflows. The production architecture is still â€œrealâ€ during demos because the permissiveness is controlled by server-side flags and RLS, not client-side shortcuts.

## Authority Model (Demo vs Production)

The goal is to allow enterprise-safe collaboration without slowing down demo iteration.

In the demo org (`organizations.is_demo = true`), all authenticated users can edit any lot and its tasks. This is intentionally permissive so multiple people can test and validate the product. The demo behavior must be achieved via server-side configuration (RLS helpers that check `organizations.is_demo`) so the client code path stays identical between demo and production.

In non-demo orgs (`organizations.is_demo = false`), edits are restricted:

- Admins can create and edit everything (communities, lots, schedules, subs, templates, attachments).
- Supers can browse everything read-only, and can edit only lots they are assigned to.
- A super can â€œclaimâ€ an unassigned lot (self-assign) to begin work, unless the builder wants only admins to assign (we can toggle this later).
- Unassigned supers can browse all communities/lots/tasks read-only (including viewing attachments that are already synced).

Lot assignment is modeled by `public.lot_assignments` (server) and is enforced by RLS via `public.bf_can_edit_lot(lot_id)`.

## Conflict Rules (Server Authoritative, Client Optimistic)

BuildFlowâ€™s collaboration rule is: â€œthe server is the source of truth, but the user should never lose work locally.â€

- Every editable row carries a server-side integer `version` that increments on update.
- Every client update includes a `base_version`.
- The server accepts an update only if `base_version` equals the current row `version`, then increments `version`.
- If the versions differ, the server rejects with a conflict; the client keeps the userâ€™s intent locally and rebases the change onto the latest row (or prompts if it cannot be merged cleanly).

To reduce conflicts for schedule edits (which touch many tasks at once), we use a lot-level lease lock (`public.lot_locks`) as an advisory coordination tool:

- When online and starting a schedule edit session, the client attempts to acquire a lot lock for a short TTL (for example 5 minutes, auto-renewed while editing).
- If the lock cannot be acquired (another user is editing), the client shows the lot as read-only (admins can override).
- Offline schedule edits are still allowed because locks cannot be required offline; these edits will sync later and may conflict. The conflict policy remains reject+rebase, not silent overwrite.

Schedule edits are the set of actions that can shift task dates or ordering for a lot. In this repo, that includes:

- Start lot (initial schedule generation for the lot).
- Delay/reschedule operations.
- Drag/reorder operations.
- Duration changes that cause downstream task movement.
- Any â€œparallel planningâ€ operation that changes the scheduled window of tasks.

Non-schedule edits do not require a lot lock. Examples: task completion status, notes, photos, documents, punch list changes.

Demo vs production lock behavior:

- Demo org: lock failures show a warning, but do not block schedule changes (to keep demos fluid).
- Non-demo org: lock failures block schedule changes by default, with an admin override.

For schedule operations, prefer batching updates as a single logical outbox operation per lot (one op contains N task updates). Server-side, apply the batch in one transaction and reject the entire batch if any task row conflicts, so we never partially apply a schedule change.

## Offline Guarantees (What We Promise)

These are explicit product guarantees we can demo and later enforce in production:

1. No silent data loss on the device: any user action that â€œsavesâ€ must be written to durable local storage before we show it as saved.
2. No silent overwrites across devices: if two users edit the same thing, we detect the conflict and surface it. We do not last-write-wins overwrite earlier changes without showing it.
3. Offline-first UX: users can browse cached data and make edits while offline; edits enqueue to an outbox and sync later.
4. Attachments captured offline are durable: a captured photo/document remains visible locally after refresh and is not marked â€œsyncedâ€ until the server acknowledges it.
5. Deletions are sync-safe: we use tombstones (`deleted_at`) so deletions propagate reliably, even when devices are offline.

## Attachments (Photos/Docs) Strategy

We keep attachments merge-safe and offline-friendly by making them first-class rows (append-only metadata rows) and storing binaries separately:

- Client stores binaries locally in IndexedDB (existing `src/lib/idb.js`), referenced by a stable `blob_id`.
- Client creates an attachment metadata row locally (lot id, optional task id, kind, caption, mime, size, created_at, created_by) and enqueues an outbox op.
- When online, the sync engine uploads the blob to Supabase Storage and then upserts the server-side metadata row in `public.attachments` with a `storage_path`.
- Viewing prefers local data: if the blob exists locally, show it immediately; otherwise fetch from storage on demand and cache it.

Caching and viewing defaults (tuned to your expected scale):

- Always generate and cache thumbnails (small) for fast timeline scrolling.
- Cache full-size images on-demand with an LRU cap; provide a â€œKeep offlineâ€ pin at the lot level that disables eviction for that lot.
- For docs (PDFs), render in-app on desktop; on iOS (Capacitor), consider native open/share if WebView PDF rendering is unreliable.

## Timezones (Central Now, Central/Eastern Later)

Scheduling is day-based, so we treat scheduled dates as org-local calendar days:

- Persist task schedule dates as ISO date strings (`YYYY-MM-DD`) that represent a day in the org timezone, not a timestamp.
- Compute â€œtodayâ€ and date grouping using `organizations.timezone` (default `America/Chicago`).
- Store server timestamps (`created_at`, `updated_at`) as UTC as usual; they are for auditing and sync cursors, not for schedule day math.

## Sizing Assumptions (For Performance and Storage)

These assumptions shape paging, indexing, and caching strategies:

- Communities: up to ~200-500 lots per community.
- Tasks: roughly current template size, plus ~10-20 tasks (so â€œper lotâ€ remains under a few hundred).
- Attachments: up to ~50-100 photos per lot at the high end.
- Users: ~20 total (5 admin, 10-15 field users), with peak concurrency up to ~20.

The plan prioritizes incremental sync (cursor-based pull), local DB indices (fetch-by-community and fetch-by-lot), and attachment thumbnail-first viewing so this stays responsive on iPhone/iPad.

## Clarifications to Lock In Before Implementing Milestone 3

These should be decided once and written down so implementation does not stall.

Already decided for this product:

- Roles are `admin` and `super` only.
- Supers can self-assign (claim) unassigned lots in production orgs.

Still to decide:

- Conflict UX: when a conflict occurs, do we default to â€œrefresh and re-apply my changeâ€ automatically, or prompt with a choice?
- Attachment retention: should old full-size photos be evicted automatically (LRU), or should we only store thumbs unless pinned?

## Progress

- [x] (2026-02-05 23:30Z) Authored initial ExecPlan for enterprise-ready offline sync v2 and recorded initial decisions.
- [x] (2026-02-05 23:40Z) Added `supabase/sql/008_sync_v2_foundations.sql` (row versioning + tombstones + org timezone + demo flag + assignments + lot locks + notes/attachments tables + RLS scaffolding + `claim_lot`/lock RPCs).
- [x] (2026-02-05 23:55Z) Applied `supabase/sql/008_sync_v2_foundations.sql` to Supabase and verified new columns/tables/policies/functions exist.
- [x] (2026-02-06) Wired `organizations.timezone` + `organizations.is_demo` into client org state; normalized holidays between local `{ date, name }` objects and Supabase `text[]` date strings; added client-side schedule edit lock acquisition + gating for schedule-impacting actions (start lot, delay, reschedule, reorder, duration/start changes, buffer ops, parallelize).
- [ ] Verify behavior with a non-admin â€œsuperâ€ user in a non-demo org (should be read-only until self-assign/assignment).
- [x] (2026-02-06) Added server RPC script `supabase/sql/009_sync_v2_rpc.sql` (cursor pull + transactional push with optimistic concurrency; initial support: `tasks_batch` with optional lot patch).
- [x] (2026-02-06 00:10Z) Added `src/lib/localDb.js` (IndexedDB entity stores + durable outbox + meta helpers; not wired into UI yet).
- [x] (2026-02-06) Implemented a one-time import from the localStorage snapshot into `localDb` (normalized entity stores + outbox mirror) and mirrored newly enqueued sync ops into the IndexedDB outbox (best-effort; does not change UI behavior yet).
- [x] (2026-02-06) Added IndexedDB snapshot mirroring + boot-time restore fallback (for iOS/localStorage eviction resilience); hydrated `lot_assignments`, added “Claim Lot” UX for non-demo supers, and gated schedule edits + transitional snapshot sync to assigned lots only for non-demo `super` users.
- [ ] Wire the app to read/write through `localDb` behind a feature flag (keep localStorage snapshot as fallback during migration).
- [x] (2026-02-06) Implemented sync engine v2 (push durable outbox + pull cursor) behind a feature flag (`VITE_SYNC_V2=1` or local flag `bf:sync_v2`). Old snapshot sync is disabled when v2 is enabled to avoid double writes.
- [x] (2026-02-06) Converted core schedule flows to enqueue v2 lot-batch ops (`tasks_batch`): start lot, reschedule, delay cascade, drag reorder, duration/start date edits, add task, buffer insert/create, delete task, parallelize, and unstart/reset lot.
- [ ] Implement attachment pipeline: offline capture -> local blob -> background upload -> server acknowledged metadata; add caching strategy (thumbs always, full-size LRU).
- [ ] Remove unsafe production fallbacks (unfiltered reads, env org fallback) and retire snapshot sync after parity.
- [ ] Optional: Capacitor spike to validate camera + filesystem durability on iOS simulator/device while keeping sync protocol unchanged.

## Surprises & Discoveries

- Supabase bootstrap schema stores `organizations.holidays` as `text[]`, while local seed/UI uses `{ date, name }` objects. Client now normalizes to local objects and converts to date strings for Supabase sync to preserve schedule accuracy.

## Decision Log

- Decision: Server is authoritative, client is optimistic with a durable local outbox.
  Rationale: Preserves offline UX and prevents silent overwrites as soon as multiple users edit concurrently.
  Date/Author: 2026-02-05 / Codex (GPT-5).

- Decision: Conflicts use reject + rebase (optimistic concurrency via row `version`), not blind last-write-wins.
  Rationale: â€œLWW by accidentâ€ loses data and is unacceptable for enterprise scheduling. Rebase is predictable and can be progressively improved in UX.
  Date/Author: 2026-02-05 / Codex (GPT-5).

- Decision: Notes/photos/docs are append-only child rows (each row has its own id/version) rather than JSON arrays on `lots`/`tasks`.
  Rationale: Append-only rows merge naturally across clients; JSON arrays are conflict magnets.
  Date/Author: 2026-02-05 / Codex (GPT-5).

- Decision: Authorization model is â€œdemo permissive by role, not architecture.â€
  Rationale: Keeps the production path real (RLS + assignments) while allowing guest/demo flows by granting demo users an admin role in the demo org.
  Date/Author: 2026-02-05 / Codex (GPT-5).

- Decision: Use `organizations.is_demo` to keep the demo org permissive while enforcing stricter RLS for non-demo orgs.
  Rationale: Prevents the production authorization model from being weakened by â€œtemporary demo exceptionsâ€ in client code.
  Date/Author: 2026-02-05 / Codex (GPT-5).

- Decision: Timezone support is Central now, with scaffolding for Central and Eastern.
  Rationale: â€œTodayâ€ and date rendering must be org-consistent across devices; task dates remain date-only strings so scheduling math stays stable.
  Date/Author: 2026-02-05 / Codex (GPT-5).

- Decision: Lot-level locks are advisory (help coordination) and cannot be required for offline edits.
  Rationale: Locks reduce conflict frequency for large schedule edits, but offline-first behavior requires that users can still edit without a lock.
  Date/Author: 2026-02-06 / Codex (GPT-5).

- Decision: Schedule edits sync as a per-lot batch operation, applied transactionally on the server.
  Rationale: A schedule edit typically touches many tasks; batching avoids partial application and makes conflict handling understandable.
  Date/Author: 2026-02-06 / Codex (GPT-5).

- Decision: The only roles are `admin` and `super`. Unassigned supers are read-only because writes are gated by lot assignment, not by role proliferation.
  Rationale: Keeps the permission model simple while still enforcing â€œonly the assigned super edits this lotâ€ in production.
  Date/Author: 2026-02-06 / Codex (GPT-5).

- Decision: Supers can self-assign (claim) unassigned lots in production orgs via `public.claim_lot(lot_id)`.
  Rationale: Matches superintendent workflows in the field and avoids requiring an admin step for every new start. Assignment remains enforceable and auditable server-side.
  Date/Author: 2026-02-06 / Codex (GPT-5).

## Outcomes & Retrospective

- Not started. Populate after each milestone ships and again at completion.

## Context and Orientation

BuildFlow today is a local-first React app with optional Supabase â€œcloud sync.â€ Most app logic and UI lives in the large file `src/BuildFlow.jsx`. Local persistence is done by saving a full â€œapp state graphâ€ JSON snapshot into localStorage via `src/lib/storage.js`. Photo/document binaries are stored in IndexedDB as blobs via `src/lib/idb.js`, while their metadata lives in the app state.

Scheduling logic is implemented as pure-ish helpers in `src/lib/scheduleEngine.js` and `src/lib/date.js`. The schedule engine currently schedules tasks sequentially by track and uses org workdays/holidays as the source of truth.

Supabase integration currently â€œhydratesâ€ by reading whole tables (with a best-effort org filter) and â€œsyncsâ€ by upserting a full snapshot payload whenever the app state changes. This is good for demoing, but it will lose data with multiple editors and is not enterprise-safe.

Key terms used in this plan:

- Outbox: A durable local queue of user operations (create/update/delete/upload) that must eventually be applied to the server. â€œDurableâ€ means it survives reloads and app restarts.
- Cursor: A value stored locally that tells sync â€œwhat was the latest server change I have seen.â€ Pulling uses the cursor to fetch only changes since last pull.
- Tombstone / soft delete: Instead of hard-deleting a row, set `deleted_at` so other clients can learn the deletion during sync.
- Optimistic concurrency / row version: Each row has an integer `version`. Updates include `base_version`. The server only applies updates if the rowâ€™s current `version` equals `base_version`, then increments `version`. If it does not match, the server rejects with a conflict.
- Lease lock (lot lock): A short-lived server record that indicates â€œthis user is currently editing this lotâ€™s schedule.â€ It reduces conflicts but cannot be required for offline work.

## Plan of Work

This plan is written as a story of milestones. Each milestone produces observable user-facing value and is independently verifiable.

Parallelization guidance (subagents): server SQL/RLS/RPC work can run in parallel with client local DB/outbox scaffolding. Attachment pipeline work can start once the outbox exists. iOS/Capacitor research can run in parallel once the sync protocol is specified, because the goal is to keep the protocol unchanged and only swap the storage adapter later.

### Milestone 1: Server Foundations (Schema + RLS + RPC)

At the end of this milestone, Supabase has the tables and policies needed for enterprise-safe sync: org membership, lot assignments, row versioning, tombstones, and timezone. The app can still run in demo mode, but the database no longer relies on unsafe client fallbacks (like unfiltered reads) for production behavior.

Work to do:

1. Create new SQL migration scripts in `supabase/sql/` (do not modify the existing bootstrap script in place; add a new script that can be applied to existing environments).
2. Add required columns across core tables used by sync:
   - `version integer not null default 1`
   - `updated_by uuid` (references `auth.users(id)` indirectly; store as uuid)
   - `deleted_at timestamptz`
3. Add org timezone:
   - `organizations.timezone text not null default 'America/Chicago'`
   - Optionally allow community override later; for now, only org-level.
4. Add assignment model:
   - Prefer a flexible join table `lot_assignments` so future multiple-supers is supported without schema churn. For now, enforce â€œat most one active assigned superâ€ via a partial unique index.
5. Add lot locks:
   - Table `lot_locks` with `lot_id`, `locked_by`, `token`, `expires_at`.
6. Add append-only child tables for collaboration-safe data:
   - `task_notes` (append-only)
   - `attachments` (metadata only; blob stored locally and uploaded to Supabase Storage)
   - If needed later: `lot_notes`, `daily_logs` as first-class rows, etc.
7. Implement RPC functions (stored procedures) for:
   - `claim_lot(lot_id)` for supers to self-assign if unassigned.
   - `acquire_lot_lock(lot_id)` and `release_lot_lock(token)` for schedule edit sessions.
   - `sync_pull` and `sync_push` are intentionally deferred to Milestone 3 so they can match the finalized outbox op format.
8. Tighten RLS:
   - Everyone in org can `select` core rows.
   - Writes require either role `admin` or assignment on that lot (plus admin override).
   - Demo/guest users remain role `admin` via the existing `ensure_guest_org()` behavior.

Acceptance (human verifiable):

1. In Supabase SQL editor, queries confirm required columns exist and RLS blocks unassigned supers from writes when enforcement is enabled.
2. RPC calls work for a signed-in user and return scoped data.
3. Existing demo flows still work when using admin role.

### Milestone 2: Local Persistence v2 (Entity Store + Outbox)

At the end of this milestone, the app no longer depends on saving the entire app graph into localStorage for correctness. Instead, core entities are stored in IndexedDB tables (communities, lots, tasks, subcontractors, etc.), with localStorage reserved for small preferences only. A durable outbox exists and records every user action that must sync to the server.

Work to do:

1. Add a new local database module (for example `src/lib/localDb.js`) that provides:
   - Schema versioning (increment when tables change).
   - Tables for each entity and an `outbox` table for ops.
   - A small `sync_state` table for cursor and health.
2. Keep `src/lib/idb.js` blob store, but add metadata links:
   - Attachment metadata row stores `blob_key` (how to read the blob from IndexedDB).
3. Add a migration that imports existing localStorage app state into IndexedDB once:
   - After successful import, mark a flag so it does not repeat.
   - Keep localStorage snapshot temporarily behind a flag for rollback during early migration.
4. Refactor `src/BuildFlow.jsx` gradually:
   - Stop reading app state from localStorage snapshot as the source of truth.
   - Replace with â€œload from localDb on bootâ€ into in-memory UI state.

Acceptance:

1. Turn off network, refresh the app, and verify it still loads lots/tasks from localDb (not from Supabase).
2. Make an edit offline, refresh, and verify the edit is still present (durable).
3. Verify localStorage size does not grow with app usage (prefs only).

### Milestone 3: Sync Engine v2 (Push Outbox + Pull Cursor)

At the end of this milestone, sync is incremental and safe for multiple users. The app pushes only queued operations (outbox), and pulls only changes since its last cursor. Conflicts are detected via row `version` and handled as reject + rebase rather than silent overwrites.

Work to do:

1. Define the outbox operation format (in code, not just docs). Each op must include:
   - `op_id` (uuid), `entity_type`, `entity_id`, `op_type` (create/update/delete/upload)
   - `base_version` for updates
   - `payload` (minimal fields changed)
   - `created_at`, `attempts`, `last_error`, `next_retry_at`
2. Add a schedule operation type that batches task updates for a lot:
   - Example: `op_type = 'lot_schedule_patch'` with `{ lot_id, task_patches: [{ task_id, base_version, patch }, ...] }`.
   - Server must apply this op in one transaction and reject the whole op if any task conflicts.
3. Implement a sync loop module (for example `src/sync/syncEngine.js`) that:
   - Pushes ops in order with retry/backoff.
   - Pulls changes by cursor after successful push (and periodically even without local changes).
   - Updates localDb tables with server-canonical rows.
4. Put sync v2 behind a feature flag:
   - Allow enabling it for the demo org first.
   - Keep old snapshot sync code path until parity is proven, then remove it.
5. Implement conflict handling:
   - On conflict response from server, fetch latest row, attempt to reapply the user intent, retry once.
   - If still conflicting, surface a UI error state on that entity and keep the op in outbox until resolved.
6. Add â€œsync healthâ€ UI:
   - Pending ops count, last sync time, last error, and a â€œsync nowâ€ action.

Acceptance:

1. Open two browsers with different users on the same org. Edit the same task field on both. Verify:
   - One succeeds; the other sees a conflict and is prompted to refresh/retry.
   - No silent overwrite happens.
2. Go offline, make edits, close the tab, reopen, confirm edits persist and outbox retains pending ops.
3. Go online, confirm outbox drains and server state matches local.

### Milestone 4: Attachments v2 (Offline Capture + Upload + Cache)

At the end of this milestone, supers can capture photos/documents offline, see them immediately, and they sync when online with reliable server acknowledgment. Thumbnails are always cached; full-size content is cached on-demand with an eviction policy.

Work to do:

1. Add attachment metadata tables on server (from Milestone 1) and storage buckets/policies in Supabase Storage.
2. In client:
   - On capture/import: store blob in local blob store, create metadata row locally, enqueue `attachment_upload` op.
   - On upload: read blob by key, upload to storage, then upsert metadata row to server and mark local status `synced`.
3. Viewing:
   - Always show local thumbnail if available.
   - Download full-size on demand and cache with LRU limit.
   - Add â€œKeep offlineâ€ toggle per lot (pin, do not evict).
4. Optional but recommended: image normalization pipeline:
   - Generate a small thumbnail for timeline/list views.
   - Normalize full-size images (resize/compress) to keep storage and upload times predictable on cellular.

Acceptance:

1. Offline: capture a photo, refresh, photo still present and marked â€œpending uploadâ€.
2. Online: sync runs, upload completes, photo becomes â€œsyncedâ€, and the same photo is visible from a second device.

### Milestone 5: Production Hardening (Remove Demo Shortcuts, Add Guardrails)

At the end of this milestone, production behavior is locked down: no unfiltered reads fallback, no env org fallback, no simulated â€œsynced on online event.â€ The demo org still exists, but the production path is the default and is enforceable via RLS and server functions.

Work to do:

1. Remove any â€œfallback to select * without org filterâ€ behavior for production builds.
2. Remove snapshot sync and any â€œmark as synced without server ackâ€ behavior.
3. Add auditability hooks:
   - Server-side: capture `updated_by`, and optionally add `task_change_log` for schedule edits (future-friendly).
4. Add timezone correctness:
   - Ensure â€œtodayâ€ uses `organizations.timezone` rather than device timezone for core views.
5. Expand validation and test coverage:
   - Automated tests for schedule engine invariants and sync conflict behavior where feasible in this repo.

Acceptance:

1. A non-admin user cannot edit unassigned lots/tasks; an admin can.
2. No data is marked synced without server acknowledgment.
3. â€œTodayâ€ is consistent across devices set to different local timezones (Central vs Eastern) when org timezone is Central.

### Optional Milestone 6: Capacitor iOS Spike (Validate the Path)

At the end of this milestone, there is a working iOS build that can:
1) sign in, 2) view cached data offline, 3) capture a photo, 4) persist it locally, and 5) upload it when back online. The sync protocol remains unchanged. Only local persistence is adapted if needed.

This milestone is a prototype. It should be kept minimal: enough to confirm that iOS storage and camera APIs behave as expected.

## Concrete Steps

All commands below assume PowerShell in repo root `C:\\Users\\brade\\Documents\\Projects\\BuildFlow\\buildflow`.

1. Read the repo working agreements:
   - Open `AGENTS.md` and `.agent/PLANS.md` and follow them.
2. Local validation commands (run often):
   - `npm run lint`
   - `npm run dev`
3. Server SQL application (choose one approach and stick to it for consistency in this repo):
   - Supabase SQL Editor: paste and run the numbered SQL scripts in `supabase/sql/` in order.
   - Or Supabase MCP tooling (if configured): apply migrations via the MCP server.
4. Manual acceptance scenarios (repeat after each milestone):
   - Two-browser conflict scenario.
   - Offline edit + refresh + online sync scenario.
   - Attachment capture offline + upload on reconnect.

Expected â€œsuccess indicatorsâ€:

1. No FK/constraint sync errors due to cross-table ordering (outbox ops are idempotent and ordered).
2. Conflicts are visible and do not silently discard changes.
3. Offline actions survive reload and synchronize later.

## Validation and Acceptance

This repoâ€™s validation expectations (from `AGENTS.md`) apply:

1. Run `npm run lint` and fix all issues introduced by changes in each milestone.
2. Smoke test via `npm run dev`:
   - Verify schedule timeline.
   - Verify lot start.
   - Verify photo upload paths (now: offline capture -> upload).
3. If scheduling logic changes:
   - Verify task ordering and workday handling.

In addition, this planâ€™s enterprise acceptance tests must pass (two-browser conflicts, offline durability, attachment reliability).

## Idempotence and Recovery

Server SQL changes must be designed to be re-runnable:

- Use `create table if not exists`/`alter table ... add column if not exists` patterns where possible.
- If destructive changes are required (dropping legacy columns/tables), do them only after the client no longer reads/writes them, and include a recovery path (backup/export).

Client migrations must be safe and restartable:

- Local DB migrations must be versioned. A partially completed migration should be retryable on next boot.
- Keep a feature flag to temporarily fall back to the old localStorage snapshot path during early milestones, but remove it by Milestone 5.

## Artifacts and Notes

Keep these artifacts as you implement:

- A short â€œsync debugâ€ log in the UI (last pull cursor, last push op id, last error).
- A small set of SQL queries in a note section inside the migration scripts to verify rows/versions/tombstones.

Do not log sensitive PII (phone/email/address) to console or to persistent logs.

## Interfaces and Dependencies

Client modules to introduce (names are suggestions, but the end state must separate responsibilities clearly):

1. Local DB:
   - `src/lib/localDb.js` (entity tables + outbox + sync_state; schema versioning; migrations)
   - Continue using `src/lib/idb.js` for blobs, but ensure it is invoked by the attachment pipeline rather than ad-hoc UI code.
2. Sync engine:
   - `src/sync/syncEngine.js` (push/pull orchestration, retry/backoff, cursor updates)
   - `src/sync/outbox.js` (op creation helpers and op typing)
   - `src/sync/conflicts.js` (rebase helpers and UI-friendly conflict objects)
3. Domain helpers:
   - `src/lib/timezone.js` (compute â€œtodayâ€ in org timezone; Central now, Central/Eastern compatible)
4. Server:
   - SQL scripts in `supabase/sql/` for schema, RLS policies, RPC functions.

Server dependencies are limited to what Supabase provides (Postgres, RLS, Storage). Avoid introducing new external services until the sync protocol is stable.

---

Plan created: 2026-02-05. Update `Progress`, `Decision Log`, and acceptance notes as implementation proceeds so this document remains sufficient to restart the work from scratch.

Plan updated: 2026-02-06. Added explicit authority model (demo vs production), conflict rules (reject+rebase + lot locks), offline guarantees, attachments strategy, timezone expectations, and sizing assumptions based on the intended enterprise use case. These additions make the plan more implementation-ready and reduce ambiguity before starting sync RPC work.

