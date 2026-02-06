# Turbo Enterprise Readiness Roadmap Plan

## Document Purpose
This plan defines how to evolve the current BuildFlow codebase into a reliable, production-ready iOS-first installed app (Capacitor-first), offline-capable system for a specific builder, with web as a secondary but important companion surface, starting with ~5 superintendent users and scaling safely to 20+ users without overengineering v1.

This version is explicitly optimized for accelerated execution by coding agents and subagents. It compresses delivery by maximizing parallel workstreams, strict scope control, and concrete packetized subtasks that can be handed to workers with minimal ambiguity.

It is grounded in the current implementation and provides:
- current-state assessment
- target-state architecture
- epics with detailed subtasks
- sequencing, dependencies, and acceptance criteria
- rollout and risk controls

Target delivery envelope in turbo mode:
- 8 weeks for business-ready iOS + backend + sync pilot
- 10-12 weeks for web parity hardening, analytics expansion, and rollout scale-up

---

## 1) Current-State Assessment (From Existing Code)

## 1.1 Product/Frontend Status (Strong Foundations)
- The app is already functionally rich and field-oriented:
  - schedule management (duration/reorder/parallel/dependencies)
  - punch list workflow with grouped messaging drafts
  - subcontractor management (primary + additional contacts)
  - inspections, daily logs, materials, documents/photos
  - admin settings (product types, plans, agencies, trades, custom fields)
- UI orchestration is centralized in `src/BuildFlow.jsx`.
- Domain constants and templates are separated (`src/data/*`).
- Core scheduling logic is separated (`src/lib/scheduleEngine.js`, `src/lib/date.js`).

## 1.2 Data and Persistence Status
- Local-first persistence exists today:
  - app graph in localStorage (`src/lib/storage.js`)
  - binary blobs in IndexedDB (`src/lib/idb.js`)
- Offline queue exists but is currently simulated:
  - pending sync ops tracked in `app.sync.pending`
  - connectivity events clear queue and mark records as synced
  - no real server push/pull protocol yet

## 1.3 Messaging/Media Constraints
- Current implementation heavily relies on web URI drafts (`sms:`, `mailto:`).
- This supports body prefill but not true SMS attachment injection in web.
- iOS installed-app message compose and attachment workflows are required for the primary mobile experience.

## 1.4 Architecture Constraints to Address
- `src/BuildFlow.jsx` is large and high-coupling.
- No backend or centralized source of truth yet.
- No authentication/authorization model.
- No audit trail or enterprise observability.
- No deterministic multi-user conflict resolution protocol.

## 1.5 Right-Sized v1 Scope (Pragmatic)
- Single business deployment (no full multi-tenant platform required in v1).
- Strong authentication and role permissions are required; MFA can be deferred.
- Keep auditability for critical schedule/punch/admin actions, but avoid heavy compliance overhead at launch.
- Focus first on reliability, sync correctness, and operational support for field use.

## 1.6 Reality Check (Tooling + Delivery)
- Local development currently has a known Node/runtime mismatch risk; standardize on Node 20 LTS before backend work starts.
- CI quality gates are not yet an enforced release blocker.
- The app is already feature-rich, so release safety is more important than adding net-new UI breadth.
- The near-term plan should prioritize stability, sync correctness, and operational predictability over additional feature expansion.

---

## 2) Target-State Architecture (Enterprise-Ready)

## 2.1 Principles
- Offline-first UX (field reliability) with eventual strong consistency.
- Server source of truth with deterministic sync protocol.
- Full auditability for schedule- and quality-critical changes.
- Security by default (authn/authz, encryption, least privilege).
- Incremental migration (no big-bang rewrite).
- Right-size complexity for a single builder v1 while preserving clear upgrade paths.

## 2.2 Target Components
- Client apps:
  - iOS-first installed app as primary field client (Capacitor shell + offline store + sync engine + feature UI)
  - web client as secondary companion surface (admin/reporting/desktop workflows)
- Supabase platform layer:
  - PostgreSQL (primary transactional store)
  - Auth (session/JWT + role claims)
  - Storage (photos/docs blobs)
  - Realtime events (change notifications; not source of truth for conflict resolution)
  - Edge Functions/RPC for sync orchestration where needed
- Sync and domain service layer:
  - authenticated push/pull sync contract for deterministic convergence
  - domain-specific validation and conflict policies
- Observability stack:
  - structured logs, metrics, traces, alerting

## 2.3 Recommended v1 Implementation Stack (Low-Overhead)
- Backend platform: Supabase (PostgreSQL + Auth + Storage + Realtime) with optional Edge Functions.
- Contract/type layer: shared Zod schemas for runtime validation at client boundaries.
- Hosting: managed web hosting for companion app + Apple TestFlight for iOS distribution.
- Mobile: prioritize Capacitor-first iOS delivery immediately; keep web as secondary companion.

Selection principle:
- Prefer managed services that minimize ops burden for a 5-20 user team.
- Keep abstractions portable so services can be swapped later if needed.

---

## 3) Delivery Strategy Overview

## 3.1 Phased Approach
- Phase A: Stabilize and prepare codebase
- Phase B: Build backend and data model
- Phase C: Capacitor iOS app foundation and offline client integration
- Phase D: Implement real offline sync + security controls
- Phase E: iOS pilot rollout
- Phase F: Web secondary hardening and scale operations

## 3.2 Success Milestones
- M1: iOS single-user parity with backend storage
- M2: Multi-user sync with conflict handling on iOS core workflows (Capacitor app)
- M3: Role-secured production iOS pilot (5 users)
- M4: Scaled deployment readiness (20+ users) with web companion parity

## 3.3 Explicit v1 Scope Guardrails
In scope for v1:
- Single business org with role-based permissions.
- Real sync for core entities (communities, lots, tasks, punch, subs, media metadata).
- Audit logging for critical schedule, punch, and admin mutations.
- Reliable backup/restore and release rollback runbooks.

Out of scope for v1 (defer):
- Mandatory MFA for all users.
- Full multi-tenant isolation/billing model.
- Advanced BI warehouse/ML forecasting.
- Enterprise SSO federation across many external orgs.

## 3.4 Turbo Delivery Operating Rules
- One-week sprints with fixed acceptance artifacts; unfinished scope moves, not deadlines.
- No new feature requests enter sprint unless they remove a blocker.
- Every task packet must specify:
  - exact files/modules touched
  - test command proving completion
  - rollback path
- Parallel lanes run continuously:
  - Lane A: backend/data/sync contracts
  - Lane B: iOS Capacitor client + shared frontend/domain modularization
  - Lane C: QA, observability, release safety
- Merge policy:
  - at least one automated check must pass per packet
  - integration branch revalidated twice daily in turbo mode

## 3.5 Platform Decision Lock (v1)
- iOS delivery mode for v1 is fixed to **Capacitor-first**.
- The existing React domain/UI code is reused and packaged as an installed iOS app.
- Native capabilities are added through Capacitor plugins/bridges (camera, files, share/compose, lifecycle hooks).
- A full SwiftUI rewrite is explicitly out of scope for v1.

Revisit trigger (post-pilot only):
- Reevaluate SwiftUI/native rewrite only if measured pilot data shows unacceptable performance, platform limitations, or maintainability issues that cannot be addressed within Capacitor.

## 3.6 Backend Decision Lock (v1)
- Backend platform for v1 is fixed to **Supabase-first**.
- Do not run parallel framework implementation tracks (Fastify/Nest/Express) during v1 unless Supabase proves a hard blocker.
- Realtime events are advisory only; deterministic sync correctness comes from versioned pull/push contracts and conflict rules.
- Edge Functions are allowed only where necessary for sync orchestration, server-side validation, or background processing.

---

## 4) Epic Breakdown (Detailed)

## Epic 0 - Program Setup and Governance
Objective: Establish the foundation for predictable enterprise delivery.

Subtasks:
1. Define environment model: local, dev, staging, prod.
2. Define release cadence, branching strategy, and rollback SOP.
3. Define required SLAs for pilot and production.
4. Create risk register and incident response runbook.
5. Establish data ownership and retention policy with builder stakeholders.
6. Pin local/runtime baseline (Node 20 LTS, npm version, lockfile policy).
7. Add CI baseline (lint/test/build) and make it a required PR gate.

Deliverables:
- Delivery charter
- Environments + secrets strategy
- Ops ownership map

Exit Criteria:
- Team can deploy safely to staging and roll back within defined RTO.

---

## Epic 1 - Domain Model Canonicalization
Objective: Convert current flexible client shapes into a versioned server schema.

Subtasks:
1. Inventory current entities from `STATE_SCHEMA.md` and runtime usage.
2. Define canonical relational schema for:
   - organizations (single builder v1, tenant-ready schema)
   - users/roles
   - communities/lots
   - tasks/dependencies
   - punch lists/items
   - inspections/daily logs/materials
   - subcontractors/contacts
   - documents/photos metadata
3. Add cross-cutting columns:
   - `org_id` (and optional future `tenant_id`), `created_at`, `updated_at`, `updated_by`, `version`
4. Define audit event schema for all critical writes.
5. Define migration plan for existing local data into backend shape.

Deliverables:
- ERD + migration scripts
- Schema versioning policy

Exit Criteria:
- Canonical schema approved and migration tested on realistic sample data.

---

## Epic 2 - Backend Foundation (Supabase + Schema + Storage)
Objective: Create production-grade backend foundation with managed services.

Subtasks:
1. Stand up Supabase project(s) for dev/staging/prod.
2. Implement PostgreSQL schema migrations for core entities.
3. Configure Storage buckets and metadata model for files/photos.
4. Configure Row Level Security (RLS) baseline policies by org and role.
5. Implement basic health checks and environment diagnostics.
6. Add seed/fixture utilities for staging test data.
7. Add infrastructure/config docs for repeatable environment setup.

Deliverables:
- Running Supabase-backed staging environment
- DB + storage + baseline RLS integration

Exit Criteria:
- Client can create/read/update core entities in staging with role-scoped access rules.

---

## Epic 3 - Authentication and Authorization (Right-Sized)
Objective: Secure user access and data boundaries.

Subtasks:
1. Implement Supabase Auth identity (email/password for v1).
2. Add RBAC roles (superintendent, manager, admin).
3. Enforce org-level scoping for a single business deployment (keep schema future-ready for tenant expansion) via RLS + claims.
4. Add session/token lifecycle and refresh behavior in client.
5. Add login/logout + session expiration UX in client.
6. Add account provisioning flow for builder admins.
7. Document deferred controls (MFA/advanced SSO) and trigger conditions to enable later.

Deliverables:
- Auth service integration
- RBAC policy matrix

Exit Criteria:
- Unauthorized access across role boundaries is impossible in integration tests.

---

## Epic 4 - Real Offline Sync Engine
Objective: Replace simulated sync with deterministic bi-directional sync.

Subtasks:
1. Run pre-implementation sync design sprint and approve:
   - conflict resolution policy matrix by entity/field
   - offline operation queue model and ordering rules
   - schema/version compatibility strategy
   - sync error/recovery UX
2. Define sync protocol:
   - `pushChanges(batch)`
   - `pullChanges(cursor)`
   - per-entity version + conflict payloads
3. Implement durable client-side operation log.
4. Implement idempotent writes using client-generated IDs.
5. Implement conflict policies:
   - safe auto-merge for low-risk fields
   - explicit conflict states for critical schedule fields
6. Add retry/backoff and dead-letter handling.
7. Add sync status UI with actionable error details.

Deliverables:
- Production sync service and client adapter
- Conflict resolution UX

Exit Criteria:
- Multi-device edits converge reliably with no silent data loss.

---

## Epic 5 - File/Photo Pipeline Hardening
Objective: Make media enterprise-safe and scalable.

Subtasks:
1. Move binary storage to cloud object storage.
2. Keep local cache behavior for offline-read scenarios.
3. Add checksum, MIME validation, and size limits server-side.
4. Add background image processing (thumbnails, compression).
5. Add retention and deletion lifecycle policies.
6. Add data loss prevention checks for sensitive attachments.

Deliverables:
- Secure media pipeline
- Observed upload/download reliability metrics

Exit Criteria:
- File operations succeed under poor connectivity with safe retries.

---

## Epic 6 - App Modularization and Maintainability
Objective: Reduce risk from monolithic UI shell while preserving feature velocity.

Subtasks:
1. Carve `BuildFlow.jsx` into domain modules incrementally:
   - nav/layout
   - schedule
   - punch
   - subs
   - admin
2. Extract shared hooks for modal state patterns.
3. Introduce service adapters for API/sync.
4. Add typed schema contracts (TypeScript or runtime validators like Zod).
5. Add feature-level boundaries and folder conventions.

Deliverables:
- Module map + extracted components/hooks
- Reduced coupling in critical flows

Exit Criteria:
- Core features unchanged, but code ownership and testability improve measurably.

---

## Epic 7 - QA and Test Automation
Objective: Prevent regressions and ensure production confidence.

Subtasks:
1. Add unit tests for schedule engine and date helpers.
2. Add integration tests for sync + conflict flows.
3. Add E2E coverage for:
   - schedule edits
   - punch add/edit/send draft
   - sub add/edit contacts
   - admin trade management
4. Add staging smoke scripts + release gate checks.
5. Add synthetic uptime checks and alerting.

Deliverables:
- CI pipeline with automated quality gates
- Regression suite for critical workflows

Exit Criteria:
- Every release passes deterministic automated checks + manual smoke checklist.

---

## Epic 8 - Security, Auditability, and Operational Controls
Objective: Meet enterprise security expectations.

Subtasks:
1. Encrypt all transport and storage paths.
2. Implement audit logging for critical actions:
   - task schedule modifications
   - punch completion/edits
   - admin configuration changes
3. Add immutable audit trail query UI/export.
4. Add secure secrets management and rotation policy.
5. Conduct lightweight threat modeling and basic security testing for v1 release.

Deliverables:
- Security baseline report
- Audit trail and operational controls

Exit Criteria:
- Security baseline sign-off and audit log coverage for critical entities.

---

## Epic 9 - Reporting and Operational Analytics
Objective: Deliver manager-grade visibility and accountability.

Subtasks:
1. Move report generation to backend jobs.
2. Add metrics dashboards:
   - schedule variance
   - cycle times
   - sub performance
   - punch aging
3. Add export APIs and scheduled delivery.
4. Add domain event tracking for operational insights.

Deliverables:
- Production reporting pipeline
- KPI dashboard set

Exit Criteria:
- Leadership can self-serve key operational reports without manual data prep.

---

## Epic 10 - iOS Productization (Capacitor-First Primary Delivery Track)
Objective: Deliver iOS as the primary field experience through an installed Capacitor app with native integrations.

Subtasks:
1. Stand up Capacitor iOS project and repeatable mobile build pipeline.
2. Integrate camera/file/share/message compose capabilities via Capacitor plugins/bridges.
3. Integrate local storage + sync adapter in Capacitor runtime.
4. Add app lifecycle handling (background/foreground sync cues).
5. Build TestFlight distribution and feedback loops.
6. Validate field UX for one-handed use, large tap targets, and low-connectivity behavior.

Deliverables:
- TestFlight-ready app
- Mobile-specific UX polish and reliability checks

Exit Criteria:
- Field superintendents can run full core workflows from installed iOS app.

---

## Epic 11 - Pilot, Rollout, and Scale Operations
Objective: Deploy safely to builder users and scale support maturity.

Subtasks:
1. Select pilot superintendent cohort (5 users).
2. Run structured UAT scripts with observed telemetry.
3. Track defects by severity and close acceptance gaps.
4. Train pilot users and produce quick-start guides.
5. Expand rollout to 20+ users with phased enablement.
6. Stand up support/on-call process and incident SLAs.

Deliverables:
- Pilot completion report
- Production rollout checklist and runbook

Exit Criteria:
- Production rollout complete with stable adoption and support metrics.

---

## 5) Turbo Sequencing (8-12 Week Envelope)

Week 0 (2-3 days, setup hard gate):
- lock Node/toolchain baseline
- make CI checks required for merges
- publish backend/sync contract draft and ownership map

Weeks 1-2 (parallel launch):
- Lane A: Epic 1 + Epic 2 foundation (schema, migrations, Supabase setup + RLS baseline)
- Lane B: Epic 10 iOS project scaffold + auth bootstrap + Epic 6 extraction prep
- Lane C: Epic 7 baseline tests (schedule/date unit coverage + smoke harness)

Week 2.5-3 (design hard gate):
- Lane A/B/C: sync design sprint (conflict matrix, queue model, cursor/version strategy, recovery UX)
- Hard gate: no sync implementation starts until sync design artifacts are approved.

Weeks 3-4 (core capability + gate):
- Lane A: Epic 3 auth/RBAC + org scoping
- Lane A: Epic 4 sync protocol implementation (push/pull cursor + idempotency)
- Lane B: shared client sync adapter + iOS integration of sync, drafts, camera/file flows
- Lane C: integration tests for sync happy path and retry behavior on iOS flows
- Week 4 go/no-go gate: proceed only if auth works end-to-end, sync reliability >= 95% in integration test runs, and no open P0 data-loss defects remain.
- If Week 4 gate fails: freeze non-critical scope (reporting, advanced admin polish, optional exports) and spend Weeks 5-6 on sync stabilization only.

Weeks 5-6 (stability hardening):
- Lane A: Epic 5 media pipeline hardening + signed URL flows
- Lane B: conflict UX + iOS UX polish + offline recovery + native compose reliability
- Lane C: Epic 8 audit logging + observability + backup/restore drills

Weeks 7-8 (pilot readiness):
- Epic 11 pilot package: UAT scripts, training docs, rollout support
- Epic 10 TestFlight rollout and field validation
- Epic 9 minimal operational dashboard (must-have KPIs only)
- production readiness review against go/no-go scorecard

Weeks 9-12 (optional extension):
- web secondary hardening and parity improvements
- deeper reporting and post-pilot enhancements

Note:
- This schedule is aggressive and assumes 4-6 contributors (human + coding agents) working in parallel lanes.
- If staffing drops below 4 active contributors, keep 8-week goal for iOS pilot and defer non-critical web/reporting scope.

---

## 6) Non-Functional Requirements (Target, Right-Sized for v1)

- Availability (pilot): 99.0% monthly
- Availability (scaled single business): 99.5% monthly
- Sync reliability: >99% successful sync operations within retry window
- Data durability: daily backups + point-in-time restore
- Security:
  - strong password policy and session controls for all users
  - role-based access controls by org
  - audited critical mutations
- Performance:
  - core screens interactive under 2s median on field LTE

---

## 7) Key Risks and Mitigations

1. Risk: Monolith changes introduce regressions
- Mitigation: Epic 6 modularization + Epic 7 regression coverage

2. Risk: Sync conflicts confuse field users
- Mitigation: simple conflict UX + role-based escalation for critical collisions

3. Risk: Media growth/latency
- Mitigation: object storage, thumbnails, cache policy, background processing

4. Risk: Security gaps in rapid growth
- Mitigation: enforce Epic 3 + Epic 8 gates before broad rollout

5. Risk: Scope creep from feature requests
- Mitigation: milestone-based backlog governance and acceptance criteria per epic

---

## 8) Immediate Next 30-Day Plan (Practical)

Day 1-3:
1. Lock runtime/tooling baseline (Node 20 LTS) and enforce CI required checks.
2. Publish canonical schema v1 and Supabase contract assumptions with acceptance examples.
3. Stand up Capacitor iOS shell and verify simulator boot.

Day 4-10:
4. Implement Supabase schema migrations + storage bucket strategy + baseline RLS.
5. Add auth + role scaffolding (single-org v1).
6. Continue modularization + core test coverage for schedule/date helpers.

Day 11-20:
7. Complete sync design sprint artifacts (conflict matrix + queue model + recovery UX).
8. Build first real sync slice for communities/lots/tasks/punch.
9. Integrate sync adapter in iOS runtime for offline edit/reconnect behavior.

Day 21-30:
10. Add automated tests for schedule engine + sync contract + one iOS E2E smoke path.
11. Validate camera/file/compose flows on iOS test devices.
12. Execute Week-4 style gate rehearsal and record blockers by severity.

---

## 9) Done Definition for "Enterprise Ready"

BuildFlow is considered enterprise-ready when all are true:
- multi-user sync is deterministic and monitored
- authz and role boundaries are enforced end-to-end
- audit trail exists for critical operational changes
- backup/restore and incident runbooks are proven
- regression suite protects scheduling, punch, subs, and admin workflows
- pilot users can operate full day without data-loss incidents

---

## 10) Mapping Current Code to Future Work

Current strengths to preserve:
- solid offline UX assumptions
- robust schedule engine separation
- rich real-world workflow coverage

Current gaps to close:
- simulated sync -> real sync protocol
- local-only storage -> centralized persistence
- no auth -> production auth/RBAC
- monolithic orchestration -> modular maintainability

This roadmap intentionally builds on existing strengths rather than rewriting from scratch.

---

## 11) Implementation Dependencies and Critical Path

Critical-path order (must happen in sequence):
1. Canonical schema and backend/sync contracts finalized (Epic 1)
2. Supabase persistence stack running in staging with baseline RLS (Epic 2)
3. Auth + role boundaries implemented (Epic 3)
4. Sync design sprint artifacts approved (Epic 4 gate)
5. Real push/pull sync protocol operational (Epic 4)
6. iOS Capacitor client integration complete for core flows (Epic 10)
7. Regression and sync conflict test coverage in CI (Epic 7)
8. Pilot rollout with monitored telemetry (Epic 11)

Parallelizable workstreams:
- Epic 6 modularization can run in parallel with Epics 3-5.
- Epic 10 iOS shell starts in Sprint 1 and iterates continuously.
- Epic 9 reporting can start once API/storage are stable.
- web parity enhancements can start once iOS core flows are stable.

Blocking dependencies:
- Do not expand user rollout before Epic 3 + Epic 4 + Epic 8 core controls are in place.
- Do not proceed past Week 4 without passing the explicit auth + sync reliability gate.

---

## 12) Team Shape and Ownership Model (Recommended)

Lean v1 team (realistic):
- 1 full-stack lead (backend + sync + architecture ownership)
- 1 iOS/mobile engineer (primary field app ownership)
- 1 frontend/web engineer (secondary companion surface + shared UI/domain)
- 0.5 QA/automation support (can be shared or contractor)
- 0.25 DevOps support (infra/deploy/monitoring)
- 1 product owner / builder stakeholder representative

Turbo execution capacity target:
- run 3 concurrent lanes continuously using coding subagents for packetized implementation and validation
- human leads focus on architecture decisions, integration merges, and production readiness gates

Scale-up team (optional after pilot success):
- add second mobile engineer for faster native iteration
- add dedicated QA automation engineer for faster release cadence

Ownership boundaries:
- iOS/mobile: native UX, device capabilities, mobile sync behavior
- Frontend/web: companion workflows, admin/reporting UX, shared domain components
- Backend/data: API, PostgreSQL, object storage, background jobs
- Reliability/security: observability, incident response, audit controls

---

## 13) Data Governance and Compliance Baseline

Required controls for production readiness:
1. Data classification
   - sensitive: contact PII, addresses, notes, documents/photos
2. Retention policy
   - define retention windows for logs, media, and audit records
3. Access policy
   - role-based least privilege by org and feature scope
4. Audit policy
   - immutable event records for schedule, punch, admin changes
5. Backup policy
   - daily full + continuous WAL/PITR restore path verification
6. Incident policy
   - documented breach/escalation process with response SLAs

Compliance note:
- Start with practical controls for a private builder deployment; keep logs/structure compatible with future audit requirements.

---

## 14) Migration Strategy: Local-Only -> Centralized System

Migration goals:
- Preserve existing field data without blocking field operations.
- Avoid downtime for active superintendent workflows.

Phased migration approach:
1. Introduce backend alongside existing local-first app.
2. Enable dual-write for selected entities (non-destructive rollout).
3. Backfill historical local records into canonical backend schema.
4. Enable read-from-backend with local cache fallback.
5. Enable full sync enforcement and version conflict handling.
6. Retire simulation-only sync pathways.

Validation gates:
- record counts and checksums match between local export and backend import
- sampled task timelines and punch lists match expected state
- no-loss reconciliation test for offline edits during migration windows

---

## 15) KPI Scorecard for Go/No-Go Decisions

Pilot go-live KPIs:
- Sync success rate >= 99% over 7-day rolling window
- Conflict unresolved rate <= 1% of modified records
- P0/P1 defect count = 0 at release candidate
- Median core screen load < 2s on field LTE
- No data-loss incidents in pilot cohort

Scale-up KPIs (20+ users):
- API p95 latency < 300ms for core CRUD endpoints
- Background job success >= 99.5%
- Crash-free sessions >= 99.5%
- On-call MTTR < 60 minutes for Sev1 incidents

Governance KPI:
- 100% of critical mutations represented in audit trail checks

---

## 16) Practical Cost and Complexity Guardrails

To keep v1 business-ready without overbuilding:
1. Use managed DB/auth/storage first; avoid custom platform infrastructure unless metrics force it.
2. Keep one backend service + one worker service before introducing microservices.
3. Delay advanced security/compliance controls (beyond baseline) until post-pilot trigger metrics require them.
4. Require any new feature proposal to include:
   - operational impact
   - test impact
   - sync/offline impact
   - rollback plan
5. Protect roadmap focus: reliability and sync correctness take priority over cosmetic feature expansion.

---

## 17) Subagent-Ready Turbo Work Package Catalog

This section converts the roadmap into execution packets that can be delegated to coding subagents in parallel.

Packet contract (required for every packet):
- Packet ID and lane owner (A backend/data, B iOS/mobile + shared frontend/web, C quality/ops)
- Dependencies (which packets must land first)
- Exact repository paths to create/change
- Exact commands to run for validation
- Observable acceptance criteria (not just "code changed")
- Rollback note (what to revert/disable if packet regresses)

### 17.1 Sprint 0 Packets (Days 1-3)

Packet P-001 (Lane C) - Runtime Baseline Lock
- Goal: eliminate Node mismatch risk.
- Changes:
  - update `buildflow/package.json` engines to Node 20 LTS baseline.
  - add `.nvmrc` and optionally `.node-version` at repo root.
  - update `buildflow/README.md` setup section with explicit version commands.
- Validate:
  - `npm --prefix buildflow run lint`
  - `npm --prefix buildflow run build`
- Acceptance:
  - fresh clone on Node 20 can install/lint/build without engine warnings.
- Rollback:
  - revert engine pin and keep README warning if rollout blocked.

Packet P-002 (Lane C) - CI Hard Gate
- Goal: make regression detection non-optional.
- Changes:
  - add `.github/workflows/ci.yml` for lint/test/build.
  - fail PR when any gate fails.
- Validate:
  - run CI locally equivalent commands in `buildflow`.
- Acceptance:
  - branch cannot merge without passing checks.
- Rollback:
  - temporarily mark non-critical checks as informational, never remove lint/build checks.

Packet P-003 (Lane A) - Contract Freeze v1
- Goal: unblock parallel backend/client work.
- Changes:
  - add `docs/contracts/backend-v1.md` documenting Supabase schema/RLS boundaries and API assumptions.
  - add `docs/contracts/sync-v1.md` with push/pull payload shape, cursor rules, and conflict payloads.
- Validate:
  - architecture review sign-off from frontend + backend owners.
- Acceptance:
  - all downstream packets reference these docs and no longer define payloads ad hoc.
- Rollback:
  - retain previous contract version side-by-side as `v0` if needed.

### 17.2 Sprint 1 Packets (Weeks 1-2)

Packet P-101 (Lane A) - Supabase Project Bootstrap
- Goal: stand up production-path backend platform quickly.
- Changes:
  - create Supabase dev/staging projects and environment configuration.
  - configure baseline health diagnostics, project settings, and access controls.
- Validate:
  - verify staging project connectivity from local app and CI.
- Acceptance:
  - staging backend is reachable and configured for schema deployment.
- Rollback:
  - keep local-only mode behind feature flag until connectivity is stable.

Packet P-102 (Lane A) - PostgreSQL Schema + Migrations
- Goal: canonical source-of-truth schema for core entities.
- Changes:
  - create Supabase migration set for org, users, communities, lots, tasks, punch, subs, media metadata, audit_events.
  - add indexes for lot/task queries and sync cursors.
- Validate:
  - migration up/down on empty DB and seeded DB.
- Acceptance:
  - schema can be rebuilt from scratch via one documented command.
- Rollback:
  - migration rollback script tested in staging.

Packet P-103 (Lane A) - Data Access + CRUD Slice
- Goal: first usable backend feature slice.
- Changes:
  - implement CRUD access layer for communities, lots, tasks, punch items, subs against Supabase.
  - enforce org_id scoping via RLS and role claims.
- Validate:
  - integration tests for CRUD and org boundary leakage.
- Acceptance:
  - frontend can fetch and persist seeded lots/tasks from backend in staging.
- Rollback:
  - keep read fallback to local snapshot.

Packet P-104 (Lane B) - BuildFlow Modularization Pass 1
- Goal: reduce monolith risk while backend comes online.
- Changes:
  - extract sync and data access helpers from `src/BuildFlow.jsx` into `src/lib/*`.
  - extract modal orchestration helpers into `src/components/modals/*` (no UX behavior change).
- Validate:
  - `npm --prefix buildflow run lint`
  - `npm --prefix buildflow run build`
  - smoke test schedule + punch + subs.
- Acceptance:
  - no user-visible change; reduced file coupling and easier future packet boundaries.
- Rollback:
  - feature branch revert of extracted modules if regression appears.

Packet P-105 (Lane C) - Baseline Test Harness
- Goal: enforce minimum safety net.
- Changes:
  - add/expand unit tests for `src/lib/scheduleEngine.js` and `src/lib/date.js`.
  - add one UI smoke test for lot overview -> punch -> save item.
- Validate:
  - `npm --prefix buildflow run test` (or project test command once added).
- Acceptance:
  - known high-risk schedule/punch paths covered by repeatable automated tests.
- Rollback:
  - quarantine flaky tests with issue IDs; do not silently delete.

Packet P-106 (Lane B) - iOS Capacitor Shell and Build Pipeline
- Goal: establish iOS as first-class delivery target from Sprint 1.
- Changes:
  - create Capacitor iOS project scaffold and build scripts.
  - wire app boot, navigation shell, and environment config.
  - implement auth/session bootstrap in Capacitor runtime.
- Validate:
  - local iOS simulator build boots to authenticated app shell.
- Acceptance:
  - iOS app launches and reaches primary app navigation without web browser dependency.
- Rollback:
  - keep prior web workflow live while iOS branch stabilizes.

### 17.3 Sprint 2 Packets (Weeks 2.5-4)

Packet P-200 (Lane A/B/C) - Pre-Sync Design Sprint
- Goal: remove ambiguity before building sync.
- Changes:
  - publish conflict policy matrix in `docs/contracts/sync-conflict-policy-v1.md` (entity/field level, auto-merge vs manual resolution).
  - define offline operation queue model in `docs/contracts/sync-queue-v1.md` (ordering, retries, limits, idempotency keys).
  - define cursor/version format and schema compatibility rules in `docs/contracts/sync-v1.md`.
  - prototype conflict/error recovery UX for iOS.
- Validate:
  - architecture sign-off with written examples for normal, conflict, and retry flows.
- Acceptance:
  - sync implementation packets can proceed without unresolved protocol decisions.
- Rollback:
  - pause sync coding and keep simulated sync mode active until design is approved.

Packet P-201 (Lane A) - Auth + RBAC Core
- Goal: secure production access for single builder org.
- Changes:
  - implement Supabase Auth login/session and roles: superintendent, manager, admin.
  - enforce role checks via RLS and protected mutation policies.
- Validate:
  - auth integration tests for allow/deny matrix.
- Acceptance:
  - unauthorized writes are blocked end-to-end.
- Rollback:
  - read-only mode fallback if auth rollout blocks access.

Packet P-202 (Lane A) - Sync Push Endpoint
- Goal: durable write ingestion from offline clients.
- Changes:
  - implement sync push handler (Supabase RPC/Edge Function) with idempotency keys and per-record version checks.
  - persist operation journal for troubleshooting.
- Validate:
  - duplicate push test returns idempotent success.
- Acceptance:
  - re-sent client batches do not create duplicate records.
- Rollback:
  - disable push endpoint via config flag and keep local queueing active.

Packet P-203 (Lane A) - Sync Pull Endpoint
- Goal: deterministic change retrieval.
- Changes:
  - implement sync pull handler (Supabase RPC/Edge Function) returning changed records + new cursor.
  - add pagination and upper bounds to protect server.
- Validate:
  - incremental cursor tests and pagination tests.
- Acceptance:
  - client can recover full state from empty cache then continue incrementally.
- Rollback:
  - allow full snapshot fallback endpoint for emergency.

Packet P-204 (Lane B) - Client Sync Adapter Integration
- Goal: replace simulated sync in app flow.
- Changes:
  - introduce adapter module (`src/lib/syncClient.js` or equivalent).
  - route pending ops in `app.sync.pending` to push/pull protocol behind feature flag.
  - preserve offline queue UX indicators already in app.
- Validate:
  - offline edit -> reconnect -> synced state scenario.
- Acceptance:
  - lots/tasks/punch edits persist across two browsers/devices.
- Rollback:
  - feature flag back to simulation mode.

Packet P-205 (Lane B) - Conflict UX and Resolution Hooks
- Goal: prevent silent data loss on concurrent edits.
- Changes:
  - add conflict banner/modal for critical schedule fields.
  - add non-blocking auto-merge path for safe non-critical fields.
- Validate:
  - forced conflict scenario integration test.
- Acceptance:
  - user sees actionable conflict choice when required.
- Rollback:
  - force server-wins fallback with explicit user warning.

Packet P-206 (Lane C) - Sync Test Matrix
- Goal: harden sync before pilot.
- Changes:
  - add integration tests: offline create/update/delete, retries, duplicates, conflicts.
  - add nightly soak test against staging.
- Validate:
  - pass rate >= defined threshold for 7 consecutive runs.
- Acceptance:
  - sync reliability trend meets KPI runway before pilot.
- Rollback:
  - block release and auto-open defects by scenario.

Packet P-207 (Lane B) - iOS Core Workflow Parity
- Goal: make iOS the primary usable client for daily superintendent work.
- Changes:
  - implement lot list/detail, schedule edit, punch create/edit/complete, and sub contact workflows in iOS Capacitor runtime.
  - ensure offline queue visibility and sync status are shown in mobile-first UI.
- Validate:
  - execute full superintendent walkthrough in iOS simulator and physical device.
- Acceptance:
  - core field workflows are completed end-to-end from iOS without requiring desktop web.
- Rollback:
  - retain web companion path for affected workflows until parity defects are fixed.

Sprint 2 hard gate:
- At end of Week 4, proceed only if:
  - auth + role scoping is validated in integration tests
  - sync reliability >= 95% in test runs
  - no unresolved critical data-loss defects remain open

### 17.4 Sprint 3 Packets (Weeks 5-6)

Packet P-301 (Lane A) - Media Upload/Download Service
- Goal: production-safe file pipeline.
- Changes:
  - Supabase Storage signed upload/download flows and metadata persistence.
  - MIME/size/checksum validation.
- Validate:
  - upload/download tests with valid/invalid file types.
- Acceptance:
  - media works online and survives reconnect attempts.
- Rollback:
  - temporarily disable uploads while keeping existing data readable.

Packet P-302 (Lane A) - Audit Event Pipeline
- Goal: trace critical business changes.
- Changes:
  - write immutable audit records on schedule, punch, admin mutations (minimum v1 baseline).
  - expose internal query/report access for support debugging (full audit UI/export can be deferred post-pilot).
- Validate:
  - mutation tests confirm corresponding audit row.
- Acceptance:
  - 100% of critical mutations generate audit events.
- Rollback:
  - fail-closed on writes only for critical domains; alert ops.

Packet P-303 (Lane C) - Observability + Alerting
- Goal: production issue detection.
- Changes:
  - structured logs, request IDs, sync metrics, error-rate dashboards.
  - alerts for API 5xx spikes, sync failure spikes, storage errors.
- Validate:
  - synthetic failure triggers expected alert path.
- Acceptance:
  - on-call can detect and triage incidents quickly.
- Rollback:
  - keep logs if metrics sink fails; never disable server logging.

Packet P-304 (Lane C) - Backup/PITR Drill
- Goal: prove recoverability.
- Changes:
  - automate daily backup policy.
  - run and document restore drill from backup snapshot.
- Validate:
  - restoration into staging and checksum compare.
- Acceptance:
  - restore procedure works within target RTO/RPO.
- Rollback:
  - keep manual backup scripts as fallback.

Packet P-305 (Lane B) - BuildFlow Modularization Pass 2
- Goal: isolate high-change features for maintainability.
- Changes:
  - extract punch flows and sub management screens into domain modules.
  - centralize shared form utilities and validation.
- Validate:
  - existing smoke suite + manual mobile checks.
- Acceptance:
  - core user flows unchanged; code ownership boundaries clarified.
- Rollback:
  - module-level reverts without touching sync/auth layers.

Packet P-306 (Lane B) - iOS Capacitor Device Integrations
- Goal: deliver native-feeling field interactions where web is limited, using Capacitor plugins/bridges.
- Changes:
  - implement camera capture, gallery selection, and file attach flow via Capacitor integrations.
  - implement SMS/email compose handoff for draft review (no auto-send) via Capacitor integrations.
  - validate gesture performance and offline resume behavior.
- Validate:
  - on-device scenario: capture photo, save to punch item, open draft compose with populated message.
- Acceptance:
  - iOS flows match field expectations and remove web URI limitations for primary use cases.
- Rollback:
  - gracefully fall back to text-only drafts and file metadata preservation.

### 17.5 Sprint 4 Packets (Weeks 7-8)

Packet P-401 (Lane A/C) - Local-to-Server Migration Utility
- Goal: move real field data safely.
- Changes:
  - add export/import utility for localStorage/IndexedDB metadata into canonical schema.
  - reconciliation report with counts and mismatch flags.
- Validate:
  - dry-run on seeded and real anonymized samples.
- Acceptance:
  - migration can be repeated idempotently with no data loss.
- Rollback:
  - keep pre-migration snapshot and revert plan documented.

Execution note:
- If deployment is confirmed greenfield with no legacy production records, skip P-401 and reallocate capacity to sync hardening/performance.

Packet P-402 (Lane B/C) - Pilot UAT Toolkit
- Goal: make pilot repeatable and measurable.
- Changes:
  - scripted UAT checklist for schedule, punch, subs, admin.
  - in-app feedback capture for pilot users.
- Validate:
  - at least one full rehearsal run with internal users.
- Acceptance:
  - pilot execution can be run by non-engineers with clear pass/fail outputs.
- Rollback:
  - revert to manual checklist if automation tool blocks execution.

Packet P-403 (Lane C) - Go/No-Go Dashboard
- Goal: objective launch decision.
- Changes:
  - dashboard for sync success, conflict rate, P0/P1 count, performance metrics.
  - release checklist referencing Section 15 KPIs.
- Validate:
  - simulated data updates dashboard and release checklist rendering.
- Acceptance:
  - launch decision can be made from current data, not ad hoc judgment.
- Rollback:
  - CSV export fallback from logs if dashboard service unavailable.

Packet P-404 (Lane B/C) - TestFlight Pilot Readiness
- Goal: ship iOS pilot build as the primary field deployment channel.
- Changes:
  - finalize iOS signing, build pipeline, and TestFlight distribution.
  - create pilot install guide and field validation checklist.
- Validate:
  - pilot cohort installs build and completes core UAT script.
- Acceptance:
  - iOS pilot is executable end-to-end without browser dependency for core workflows.
- Rollback:
  - keep previous stable TestFlight build active while hotfixing regressions.

### 17.6 Optional Extension Packets (Weeks 9-12, Web Secondary + Scale)

Packet P-501 (Lane B) - Web Companion Parity Pass
- Goal: keep browser workflows strong as secondary surface.
- Changes:
  - align web admin/reporting flows with finalized iOS domain behavior.
  - remove stale web-only UX paths replaced by native-first flows.
- Validate:
  - web smoke suite for admin + reporting + read-only field views.
- Acceptance:
  - web remains fully usable for office workflows and cross-checking field data.

Packet P-502 (Lane B/C) - Reporting and Export Expansion
- Goal: improve manager visibility after iOS pilot stabilization.
- Changes:
  - add deeper exports and scheduled reporting jobs.
  - add dashboard polish for variance, aging, and sub performance.
- Validate:
  - reporting integration tests and scheduled job dry-runs.
- Acceptance:
  - leadership can access recurring metrics without manual data pulls.

Packet P-503 (Lane A/C) - Post-Pilot Scale Hardening
- Goal: prepare for 20+ user growth.
- Changes:
  - query/index optimization, queue tuning, rate limiting.
  - support runbook and incident rotations.
- Validate:
  - load test and incident simulation exercise.
- Acceptance:
  - platform remains stable under expected team growth load.

### 17.7 Subagent Spawn Guidance (Operational)

Recommended parallel spawn pattern per sprint:
1. Spawn Lane B (iOS/mobile) and Lane A (backend) immediately after contract freeze.
2. Spawn Lane C quality packet as soon as first code packet opens.
3. Re-sync all lanes at least twice per day with:
   - merged integration branch
   - rerun smoke suite
   - publish packet status and blockers

Packet completion checklist:
- code merged
- tests passing
- docs updated (`README.md`, `KNOWN_ISSUES.md`, or relevant contract doc)
- rollback note recorded in PR description

Fast failure policy:
- if packet is blocked > 4 hours, split packet into unblocker + deferred scope
- if packet risks schedule core or sync correctness, freeze non-critical UI work until resolved
