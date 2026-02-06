---
name: buildflow-enterprise-sync
description: Offline-first multi-user sync, permissions, and attachment workflows for the BuildFlow repo. Use when changing Supabase schema/RLS/RPCs, implementing the local outbox + incremental sync v2, adding lot assignment/lot locks, handling conflicts (reject+rebase via row version), or making schedule/attachment flows safe for multiple superintendents.
---

# BuildFlow Enterprise Sync

## Overview

Implement and review BuildFlow's enterprise-grade offline sync and multi-superintendent collaboration: server-authoritative, client-optimistic, durable local outbox, explicit conflict handling, lot-level schedule locks, and attachment upload with on-device durability.

This repo is intentionally monolithic in `src/BuildFlow.jsx`. Make targeted edits and keep scheduling math in `src/lib/scheduleEngine.js` and `src/lib/date.js`.

## Repo Orientation (Fast)

Read these files first:

- `AGENTS.md` (repo working agreements).
- `.agent/EXECPLAN_enterprise_offline_sync_v2.md` (authoritative implementation plan).
- `ARCHITECTURE_MAP.md` (module map).
- `supabase/sql/008_sync_v2_foundations.sql` (server foundations: row versioning, tombstones, assignments, locks, notes/attachments tables, RLS helpers).

Run validation often:

- `npm run lint`
- `npm run dev` (smoke test: schedule timeline, Start Lot, photo/file paths)

## Default Workflows

### Server Changes (Supabase schema/RLS/RPC)

Prefer additive, idempotent migrations and server-side enforcement.

1. Add a new SQL file under `supabase/sql/` (avoid editing `supabase/sql/001_bootstrap_buildflow.sql` in place for upgrades).
2. Use idempotent patterns so migrations can be re-run safely.
3. Avoid breaking existing DB functions and types.
4. Prefer `bf_*` prefixed helpers for new auth and RLS logic (avoid name collisions with legacy functions).
5. Enforce demo vs production behavior in the database, not in client code:
6. Verify quickly using `references/supabase_smoke_queries.sql` (copy into Supabase SQL editor).

### Client Changes (Local DB + Outbox + Sync v2)

Implement optimistic UI on top of a durable outbox, then incrementally migrate off snapshot sync.

1. Persist core entities in IndexedDB entity tables (do not rely on saving the entire app graph to localStorage for correctness).
2. For each user write, apply the UI change immediately, persist locally, and enqueue an outbox operation.
3. Sync by pushing outbox ops and pulling server changes by cursor.
4. Do not mark any change as synced without server acknowledgment.
5. Handle conflicts with row `version` checks and reject+rebase (no silent last-writer-wins overwrites).

### Schedule-Edit Lot Locks

Use lot locks to reduce conflicts during schedule-changing actions.

1. Acquire a lot lock when entering schedule-changing actions (drag/reorder, reschedule, delay cascade, duration changes, parallelize, start-lot schedule generation).
2. Demo org: warn on lock conflict but allow schedule changes.
3. Non-demo org: block schedule changes on lock conflict by default (admin override allowed).
4. Offline: allow schedule edits without a lock; expect possible conflicts during later sync.

### Attachments (Photos/Docs)

Make attachments durable offline and safe to merge.

1. Store blobs locally via `src/lib/idb.js`.
2. Store attachment metadata as first-class rows (append-only when possible).
3. Upload flow: local blob saved -> metadata row created -> outbox `attachment_upload` -> storage upload -> server metadata upsert -> mark synced.

## Acceptance Scenarios (Manual)

Run these after any sync, permission, schedule, or attachment work:

1. Offline: make a schedule change, refresh, confirm it persists; reconnect, confirm it syncs.
2. Two browsers: edit the same task field as two users, confirm one conflicts and no silent overwrite occurs.
3. Lock: user A holds schedule lock, user B tries to reschedule same lot and is blocked (non-demo) or warned (demo).
4. Attachment: capture/import offline, refresh, confirm it is still visible and not marked synced; reconnect, confirm upload and cross-device visibility.

## Common Pitfalls

- Never fall back to unfiltered `select('*')` reads in production.
- Never mark photos/docs as synced on `online` events without server acknowledgment.
- Do not duplicate scheduling logic in `src/BuildFlow.jsx`; keep it in `src/lib/scheduleEngine.js` and `src/lib/date.js`.
- Do not log PII (phone/email/address) in console or persisted logs.
