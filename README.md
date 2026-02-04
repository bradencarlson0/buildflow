# BuildFlow

BuildFlow is a construction scheduling and community management app with offline-first behavior and mobile-first workflows.

## Read This First

For onboarding and safe changes, read docs in this order:

1. `EXECUTIVE_SUMMARY.md` - high-level enterprise roadmap summary
2. `AGENTS.md` - project guardrails and working agreements
3. `ARCHITECTURE_MAP.md` - ASCII topology + runtime flow map
4. `CODEBASE_INDEX.md` - practical file-by-file index
5. `STATE_SCHEMA.md` - entity shape and persistence model
6. `WORKFLOWS.md` - core user/feature flows
7. `KNOWN_ISSUES.md` - platform limits and current caveats
8. `TESTING_GUIDE.md` - smoke checks and release validation
9. `CONTRIBUTING.md` - coding and review expectations
10. `DECISIONS.md` - architecture decision context

## Development

- Install: `npm install`
- Lint: `npm run lint`
- Run dev server: `npm run dev`
- Run dev server on LAN (phone testing): `npm run dev -- --host`

## Core Architecture

- UI shell + orchestration: `src/BuildFlow.jsx`
- Data definitions/seeds: `src/data/constants.js`, `src/data/template.js`, `src/data/seed.js`
- Scheduling engine: `src/lib/scheduleEngine.js`
- Date/workday logic: `src/lib/date.js`
- State persistence: `src/lib/storage.js` (localStorage)
- Blob/file persistence: `src/lib/idb.js` (IndexedDB)

## Notes

- Scheduling should remain in `scheduleEngine`, not duplicated in UI handlers.
- Workday/holiday behavior is the source of truth for timeline math.
- Web SMS/email drafting supports message body prefill but not SMS photo attachments.
