# Testing Guide

## Local Prerequisites
- Use Node version compatible with Vite/Eslint in `package.json` engines (Node 20+ recommended).
- Install deps in repo root (`buildflow/`): `npm install`.

## Baseline Commands
- Lint: `npm run lint`
- Dev server: `npm run dev`
- Mobile LAN test: `npm run dev -- --host`

## High-Value Smoke Checks (Before Push)
1. Navigation
   - Bottom nav + More menu behavior on mobile and desktop.
2. Schedule
   - Duration edit, reorder drag, parallel action, dependency-sensitive updates.
   - Workday behavior around weekends/holidays.
3. Punch List
   - Add/edit item, complete toggle, category counters/progress.
   - Send-to-subs grouping and draft opening.
4. Subs
   - Add sub, edit primary/additional contacts, phone formatting.
5. Admin
   - Product types, plans, agencies, contact library, custom trades edits persist.
6. Files/Docs
   - Upload/open/delete metadata-backed docs.
7. Persistence
   - Refresh app and ensure data survives reload.

## Mobile-Specific Checks
- Touch targets are usable.
- Modal open/close works reliably.
- Drag interactions do not lock after first action.
- SMS/email draft opens expected app on device.

## Regression Hotspots
- `src/BuildFlow.jsx` modal state interactions.
- `scheduleEngine` date/dependency math.
- Any change touching task ordering or dependency checks.

## Known Environment Pitfall
- Older Node runtimes (e.g., Node 14) will fail modern eslint/vite dependency expectations.

## Suggested Release Checklist
- Lint passes.
- Smoke checks complete on desktop + at least one phone.
- Architecture/index docs updated if core flows changed.
- Commit message documents major user-facing behavior changes.
