# Supabase guest org provisioning and cloud sync queue

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan must be maintained in accordance with `buildflow/.agent/PLANS.md`.

## Purpose / Big Picture

After this change, a user can tap “Continue as Guest” and all edits persist to Supabase in a shared demo organization. The app shows clear cloud sync status with a real retry queue, last-synced time, and visible error instrumentation, so testers trust that edits are saved even when connectivity is spotty. Guests can also reset the demo data back to the seed baseline with a single action.

## Progress

- [x] (2026-02-04 20:35Z) Added Supabase SQL helper `public.ensure_guest_org()` and updated `public.reset_buildflow_seed()` to allow anonymous demo resets.
- [x] (2026-02-04 20:40Z) Updated guest sign-in flow to call `ensure_guest_org()` and hydrate profiles using the guest org fallback.
- [x] (2026-02-05 02:30Z) Implemented cloud queue processing with retry scheduling and error instrumentation.
- [x] (2026-02-05 02:30Z) Updated sync UI to display queue count, last sync, retry timing, and conflict handling; removed local test mode UI.
- [x] (2026-02-05 02:30Z) Allowed guest “Reset Remote Data to Seed” in UI and added cloud sync fields to seed state.
- [ ] (2026-02-05 02:30Z) Run lint and perform guest sync verification scenario.

## Surprises & Discoveries

- Observation: `localTestMode` references remain in `src/BuildFlow.jsx` but the variable is no longer defined, which will throw at runtime.
  Evidence: `rg -n "localTestMode" buildflow/src/BuildFlow.jsx` shows usages with no definition.
  Resolution: Removed the local test mode toggle and its UI references while replacing it with cloud queue status.

## Decision Log

- Decision: Use a single “latest snapshot” cloud queue entry rather than storing multiple full payload snapshots.
  Rationale: The Supabase sync writes full state, so syncing the newest state supersedes older snapshots and keeps local storage lean.
  Date/Author: 2026-02-04 (assistant).

- Decision: Guest users share a fixed demo org id and are provisioned via a Supabase security definer RPC.
  Rationale: This guarantees a consistent shared dataset for testing and lets anonymous users persist edits without managing separate orgs.
  Date/Author: 2026-02-04 (assistant).

## Outcomes & Retrospective

Work in progress. Cloud queue processing, sync UI updates, and guest reset allowance are implemented. Remaining work is linting and a guest sync verification walkthrough.

## Context and Orientation

The core UI and state live in `buildflow/src/BuildFlow.jsx`. Supabase SQL helpers live in `buildflow/supabase/sql/` and are executed in the Supabase SQL editor. The local app state contains a `sync` object (initially created in `buildflow/src/data/seed.js`) that stores pending local ops and will now store cloud queue metadata like `cloud_queue`, `cloud_last_synced_at`, and `cloud_last_error`.

“Cloud queue” here means a small persisted list of pending cloud sync attempts stored in the app state, with retry metadata (`attempts`, `next_retry_at`). The queue represents the need to push the latest full-state payload to Supabase. On success, the queue is cleared and timestamps are updated; on failure, the queue records the error and schedules a retry.

## Plan of Work

First, update `buildflow/src/data/seed.js` to initialize cloud sync metadata fields so new sessions have a consistent shape. Next, in `buildflow/src/BuildFlow.jsx`, complete the cloud queue processing: select the newest pending queue item, skip until `next_retry_at`, and call the existing `syncPayloadToSupabase` helper. On success, clear the queue and write `cloud_last_synced_at` and `cloud_last_synced_hash`. On failure, record `cloud_last_error`, increment attempts, and schedule a retry with exponential backoff.

Then, remove the unused local test mode UI and ensure the sync modal shows queue count, last cloud sync, next retry, and a short “last write wins” conflict note. Update the “Sync Now” action to clear `next_retry_at` and trigger the queue runner. Finally, allow guest sessions to run the reset-seed RPC and update the settings text accordingly.

## Concrete Steps

1. Edit `buildflow/src/data/seed.js` to add default `sync` keys: `cloud_queue`, `cloud_last_synced_at`, `cloud_last_synced_hash`, `cloud_last_queued_hash`, `cloud_last_error`, and `cloud_last_error_at`.
2. In `buildflow/src/BuildFlow.jsx`, add the cloud queue runner effect, retry timer effect, and update `syncNow` to trigger cloud retries.
3. Remove `localTestMode` references and update `OfflineStatusModal` to show cloud queue count, last cloud sync, last error, and conflict guidance.
4. Update `resetRemoteSeed` and the Supabase settings card to allow guest resets.
5. Run `npm run lint` from `buildflow/` and note any failures.

Expected command transcript (example):

    PS C:\Users\brade\Documents\Projects\BuildFlow\buildflow> npm run lint
    ...
    ✨  Done in <time>s.

## Validation and Acceptance

Start the app (`npm run dev`), choose “Continue as Guest”, edit a community name, refresh, and confirm the change persists from Supabase. Open the Sync Status modal and verify it shows queue count, last cloud sync time, and any error or retry messaging. Toggle offline/online and confirm pending changes show “Pending” and then “Synced” after reconnecting.

## Idempotence and Recovery

All code changes are additive and safe to re-run. If a sync error appears, use “Sync Now” to retry, or use “Reset Remote Data to Seed” to restore the demo dataset for guests and signed-in users.

## Artifacts and Notes

Key files:

    buildflow/src/BuildFlow.jsx
    buildflow/src/data/seed.js
    buildflow/supabase/sql/005_reset_seed_function.sql
    buildflow/supabase/sql/006_guest_org_function.sql

## Interfaces and Dependencies

The cloud sync runner uses the existing `syncPayloadToSupabase(pendingPayload)` function in `buildflow/src/BuildFlow.jsx` and `supabase` client methods. The queue items have the shape `{ id, hash, created_at, attempts, last_error, next_retry_at }` and are stored in `app.sync.cloud_queue`.

Plan Update Note: Updated progress and notes on 2026-02-05 to reflect cloud queue implementation, UI changes, and guest reset enablement.
