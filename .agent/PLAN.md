# Supabase Bootstrap Slice (Auth + Org Read)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This file follows `.agent/PLANS.md`.

## Purpose / Big Picture

Add the first production-data bridge without breaking current offline behavior: connect the app to Supabase auth/session, load the signed-in user profile/org scope, and hydrate top-level entities when backend rows exist. Users should still be able to run locally with seed data when no backend records are present.

## Progress

- [x] (2026-02-02 00:00Z) Reviewed current `src/BuildFlow.jsx` state model and existing offline sync placeholders.
- [x] (2026-02-02 00:20Z) Added auth session bootstrap (`getSession` + `onAuthStateChange`) and sign-in/sign-out handlers.
- [x] (2026-02-02 00:33Z) Added org-scoped bootstrap read for profile/org plus key entities with safe local fallback.
- [x] (2026-02-02 00:40Z) Added dashboard Supabase status/auth card and validated `npm run build`.
- [x] (2026-02-02 00:42Z) Ran `npm run lint`; failure remains from existing pre-refactor hook-order issues in `src/BuildFlow.jsx`.
- [x] (2026-02-02 03:10Z) Hardened missing-table detection for Supabase PostgREST schema cache errors (`PGRST205`) so empty greenfield schemas fall back to local seed data instead of showing a fatal read error.

## Surprises & Discoveries

- Observation: `.agent/PLAN.md` was missing from the worktree.
  Evidence: `Test-Path .agent/PLAN.md` returned `False`.
- Observation: `npm run lint` still reports existing rule-of-hooks/no-unused-vars errors unrelated to this slice.
  Evidence: lint fails on pre-existing `buildParallelStartPlan` unused import and conditional hook usage near lines ~14100 in `src/BuildFlow.jsx`.
- Observation: Supabase may return missing-table errors as PostgREST schema-cache errors (`PGRST205`) instead of PostgreSQL `42P01`.
  Evidence: app status showed `Could not find the table 'public.product_types' in the schema cache` for greenfield tables not created yet.

## Decision Log

- Decision: Keep first hydration additive and non-destructive.
  Rationale: Preserve current single-file app behavior while introducing backend reads incrementally.
  Date/Author: 2026-02-02 / Codex

## Outcomes & Retrospective

Sprint-0 slice is functional: Supabase auth/session now boots in-app, users can sign in/sign out, and the app runs an org-scoped read pass for profile/org/core tables. Remote data is applied only when rows exist so the current local/offline behavior is preserved for empty greenfield databases.

## Context and Orientation

`src/BuildFlow.jsx` owns the entire UI/state graph. `src/lib/storage.js` persists app state to localStorage. `src/lib/supabaseClient.js` now provides a configured Supabase browser client.

## Plan of Work

Inject minimal auth/session state in `BuildFlow` component, wire sign-in/sign-out helpers, and add an effect that reads `profiles` and `organizations` for the current user. Extend the same effect to optionally read `communities`, `lots`, `tasks`, `task_dependencies`, `subcontractors`, and `subcontractor_contacts`; only replace local arrays when backend has rows, otherwise keep local seed arrays.

Expose a small dashboard card with auth inputs/actions and backend status text so setup can be verified quickly during Sprint 0.

## Concrete Steps

From repo root `buildflow/`:

1. Edit `src/BuildFlow.jsx` to add Supabase auth/bootstrap logic.
2. Run `npm run build`.
3. Run `npm run lint` and record known baseline issues if unrelated.

## Validation and Acceptance

- App starts and renders with no signed-in session (seed/offline behavior unchanged).
- User can sign in with Supabase email/password and see connected status.
- When backend tables are empty, app clearly reports connected/no remote rows and keeps local seed data.
- Build completes successfully.

## Idempotence and Recovery

Changes are additive and safe to rerun. If auth/bootstrap causes issues, reverting `src/BuildFlow.jsx` auth slice restores prior local-only behavior.

## Artifacts and Notes

To be filled after implementation.

## Interfaces and Dependencies

- Supabase JS client from `src/lib/supabaseClient.js`
- Supabase tables: `profiles`, `organizations`, `communities`, `lots`, `tasks`, `task_dependencies`, `subcontractors`, `subcontractor_contacts`

Revision note (2026-02-02): Updated this ExecPlan after implementation to record completed auth/bootstrap work, build/lint validation, and the lint baseline caveat so future contributors can resume from an accurate state.
Revision note (2026-02-02): Added missing-table handling coverage for PostgREST schema-cache errors so first-run Supabase onboarding is resilient before every table exists.
