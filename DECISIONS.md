# Architecture Decisions (ADR-lite)

This file captures high-impact decisions and why they exist.

## D1: Single App Shell in `src/BuildFlow.jsx`
- Status: Active
- Decision: Keep most UI orchestration and modal coordination in one file.
- Why: Fast product iteration, easy cross-feature changes.
- Tradeoff: High coupling and larger blast radius for edits.
- Revisit when: Team size grows or regression risk rises.

## D2: Scheduling Logic Lives in `src/lib/scheduleEngine.js`
- Status: Active
- Decision: Keep schedule math out of UI handlers.
- Why: Workday/dependency logic is complex and needs central consistency.
- Tradeoff: UI devs must learn engine API boundaries.

## D3: Offline-First Local Persistence
- Status: Active
- Decision: App state in localStorage; files/photos in IndexedDB.
- Why: App remains usable on job sites with variable connectivity.
- Tradeoff: No server source-of-truth conflict resolution yet.

## D4: Modal-Driven Workflows
- Status: Active
- Decision: Use modal screens for task, punch, media, admin edits.
- Why: Fast contextual edits without full route changes.
- Tradeoff: Modal stacking/focus/z-index complexity.

## D5: Web-Native Message Drafting
- Status: Active
- Decision: Use `sms:` and `mailto:` for draft handoff.
- Why: Works broadly in web deployment.
- Tradeoff: Web cannot auto-attach SMS photos.
- Future: Native app shell can support message attachments.

## D6: Backward-Compatible Lot/Task/Punch Shapes
- Status: Active
- Decision: Tolerate legacy fields and mixed data versions.
- Why: Existing saved data should not break after updates.
- Tradeoff: More normalization logic in UI/helpers.

## D7: Custom Trades via Admin
- Status: Active
- Decision: Allow app-level custom trades merged with base trade catalog.
- Why: Builders can evolve domain categories without code changes.
- Tradeoff: Must keep dropdowns/filters in sync across screens.
