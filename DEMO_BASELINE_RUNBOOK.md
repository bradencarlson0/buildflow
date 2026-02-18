# BuildFlow Demo Baseline Runbook

## Goal
Preserve the currently tested dataset as canonical demo state (`demo_baseline_v1`), protect it from accidental destructive resets, and support fast rollback.

## Prerequisite SQL
1. Apply `supabase/sql/011_sync_v2_contract_hardening.sql` after existing sync v2 SQL files.
2. Apply `supabase/sql/012_sync_v2_reference_snapshot.sql` to enable cross-device reference sync (`communities`, `subs`, `product types`, etc.).
3. Confirm RPCs exist: `sync_pull`, `sync_push`, `sync_apply_reference_snapshot`, `acquire_lot_lock_v2`, `set_demo_baseline_protection`.

## Baseline Capture
1. Open BuildFlow, go to `More` tab.
2. In `Supabase / Demo Baseline`, click `Capture`.
3. Confirm `demo_baseline_v1` metadata is shown (checksum prefix visible).
4. Click `Export JSON` and save the artifact in team storage.

## Baseline Promotion (Shared Multi-Device)
1. Sign in to Supabase admin account in app.
2. Confirm `Sync v2` is enabled and RPC health is healthy.
3. Click `Promote` in `Demo Baseline`.
4. Wait for success toast (this also enables org-level baseline protection on Supabase).
5. On second clean device, refresh and verify counts/parity.

## Destructive Guardrail
- Baseline-protected mode blocks local reset and remote seed reset by default.
- Destructive operations require override token (`VITE_BASELINE_OVERRIDE_TOKEN`) and open a 15-minute override window.
- On Supabase, `reset_buildflow_seed` is blocked while org baseline protection is enabled unless explicit force override is passed.

## Rollback Drill
1. In app, click `Rollback to Baseline`.
2. App automatically captures a pre-rollback restore point.
3. Active baseline is restored locally.
4. If online and signed in, baseline is promoted back to Supabase.
5. Refresh second device and verify parity.

## RTO Target
- Target restore time objective: **5 minutes** for full rollback + shared rehydrate.

## Emergency Reset (Intentional Only)
- Use override token in app first, then call remote reset (app sends explicit force flag).
- If needed from SQL, temporarily disable protection with `set_demo_baseline_protection(false, null, null)` before reset, then re-enable after reseeding.

## Notes
- This flow intentionally avoids `reset_buildflow_seed` during demo validation.
- Sync status panel now reports canonical status fields: phase, pending count, last ack, RPC health, baseline protection.
