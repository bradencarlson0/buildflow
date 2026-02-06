# Known Issues and Limitations

## Web Platform Constraints
1. SMS attachments are not supported via `sms:` URI on web.
   - App can prefill message body only.
2. Email attachment prefill is also limited via `mailto:`.
   - User may need to attach files manually in mail client.

## Architecture Constraints
1. `src/BuildFlow.jsx` is large and highly integrated.
   - Risk: broad regressions from seemingly small edits.
2. Modal-heavy flows can introduce z-index/focus edge cases if not tested.

## Data/Persistence Constraints
1. Local-first storage only (localStorage + IndexedDB).
   - No server reconciliation strategy yet.
2. Corrupt/cleared browser storage can reset local app state.

## Operational Caveats
1. Node version mismatch can break lint/dev tooling.
2. Device/browser differences may affect URI intent handling (`sms:`, `mailto:`).

## Product Decisions Currently Applied
1. Punch photo upload UI is feature-flagged off (`ENABLE_PUNCH_PHOTOS = false`).
2. Punch messaging drafts currently emphasize concise item descriptions.

## Maintenance Notes
- If adding new trade-dependent features, include both base trades and `custom_trades` merge logic.
- Keep backward compatibility for legacy task/punch fields.
