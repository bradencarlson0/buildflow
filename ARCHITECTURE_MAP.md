# BuildFlow Architecture Map (ASCII, Detailed)

```text
SYSTEM CONTEXT
==============

+-----------------------------------------------------------------------------------+
| Browser (Desktop + Mobile)                                                        |
| - React runtime                                                                    |
| - DOM / touch events                                                               |
| - URI handlers: sms:, mailto:, tel:                                                |
| - Storage engines: localStorage + IndexedDB                                        |
+--------------------------------------+--------------------------------------------+
                                       |
                                       v
+--------------------------------------+--------------------------------------------+
| src/main.jsx                                                                      |
| - Mounts App with StrictMode                                                       |
+--------------------------------------+--------------------------------------------+
                                       |
                                       v
+--------------------------------------+--------------------------------------------+
| src/App.jsx                                                                        |
| - Thin pass-through wrapper                                                         |
+--------------------------------------+--------------------------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------------+
| src/BuildFlow.jsx                                                                  |
| MONOLITHIC APP SHELL                                                               |
| - Global app data state                                                            |
| - UI navigation state                                                              |
| - Modal orchestration                                                              |
| - Feature workflows                                                                |
| - Integration with lib/* and data/*                                                |
+-----------------------------------------------------------------------------------+


STATIC + DOMAIN LAYERS
======================

+---------------------------+          +-------------------------------------------+
| src/data/constants.js     |          | src/data/template.js                      |
| - enums & taxonomies      |          | - schedule templates                      |
|   (trades, punch, photo)  |          | - task defaults/dependencies              |
| - message templates        |          +-------------------------------------------+
| - milestones/checklists    |
+-------------+-------------+
              |
              v
+---------------------------+
| src/data/seed.js          |
| - createSeedState()       |
| - initial communities,    |
|   lots, subs, org config  |
+---------------------------+


LOGIC + INFRA LAYERS
====================

+---------------------------------------+      +-------------------------------------+
| src/lib/scheduleEngine.js             |      | src/lib/date.js                     |
| - delay cascade                       |<---->| - workday + holiday date math       |
| - duration/reorder/parallel planning  |      | - parse/format helpers              |
| - completion/progress projections     |      +-------------------------------------+
+---------------------------------------+

+---------------------------------------+      +-------------------------------------+
| src/lib/storage.js                    |      | src/lib/idb.js                      |
| - load/save app state                 |      | - putBlob/getBlob/deleteBlob        |
| - localStorage adapter                |      | - file/photo binary storage         |
+---------------------------------------+      +-------------------------------------+

+---------------------------------------+      +-------------------------------------+
| src/lib/templating.js                 |      | src/lib/utils.js + uuid.js          |
| - fillTemplate()                      |      | - ranges, validation, ids           |
| - message body rendering              |      |                                     |
+---------------------------------------+      +-------------------------------------+


TOP-LEVEL STATE SHAPE (IN PRACTICE)
===================================

BuildFlow component keeps:

1) Domain state (`app`)
   - org
   - communities
   - lots (tasks, inspections, punch list, docs, photos metadata)
   - subcontractors
   - templates / product types / plans / agencies
   - contact libraries
   - messages / notifications / reports

2) Navigation state
   - tab (dashboard, calendar, communities, subs, sales, reports, admin)
   - selected community / selected lot
   - per-screen filters

3) View interaction state
   - schedule mode, calendar date, drag state
   - selection state for tasks/punch items

4) Modal state (many independent toggles)
   - usually one `id/object` per modal type
   - ex: `taskModal`, `delayModal`, `punchListLotId`, `photoViewer`, etc.


MODAL ARCHITECTURE (IMPORTANT)
==============================

Pattern
-------
- BuildFlow stores modal trigger state at top level.
- Render tree has a "modal portal section" near bottom of BuildFlow return.
- Each modal is conditionally rendered:

  if modal state is set:
    - resolve required entities (lot/community/task/sub)
    - render modal component with callbacks

- Modal callbacks mutate domain state and close modal state.

Shared Modal Wrapper
--------------------
- `Modal({ title, onClose, children, footer, zIndex? })`
- Locks body scroll while open.
- Handles consistent shell/header/close button/footer.
- zIndex override allows stacked modals (e.g., photo viewer above punch modal).

Modal Lifecycle
---------------
1) User clicks action button.
2) BuildFlow sets modal state (id/object).
3) Conditional block resolves data and renders modal.
4) Modal internal form state initializes from props.
5) Save/Apply callback mutates `app` (or lot/community slice) via top-level handlers.
6) Modal closes by setting modal state to `null`.

Modal Groups
------------
A) Scheduling
- Task detail modal
- Delay modal
- Reschedule modal
- Create task modal
- Inspection scheduling/result modals

B) Media
- Photo source/capture modals
- Photo timeline modal
- Photo viewer modal (single + gallery behavior)
- Lot files/site plan/document modals

C) Punch List
- Punch list parent modal
- Add/Edit punch item modal
- Send-to-subs modal
- Message draft modal

D) Ops/Admin
- Daily log modal
- Materials modal
- Change orders modal
- Report modals
- Sub contact/edit modals
- Community docs/spec/contact modals


PUNCH LIST SUB-ARCHITECTURE
===========================

+----------------------------+
| PunchListModal             |
| - category accordion state |
| - progress metrics         |
| - completion toggle        |
| - opens Add/Edit modal     |
| - opens Send modal         |
+-------------+--------------+
              |
    +---------+----------+
    |                    |
    v                    v
+------------------+   +----------------------+
| AddPunchItemModal|   | SendToSubsModal      |
| - category/task  |   | - group open items   |
| - filtered subs  |   |   by sub             |
| - save item      |   | - launch text/email  |
+--------+---------+   +----------+-----------+
         |                        |
         v                        v
   updates lot.punch_list      MessageDraftModal
                               - editable draft body
                               - opens native sms/mail clients


PERSISTENCE + OFFLINE FLOW
==========================

State data (JSON-like):
- persisted through storage helpers to localStorage.

Large binaries:
- photos/docs stored in IndexedDB.
- metadata references (`blob_id`) stored in app state.

On refresh:
- app rehydrates from localStorage.
- UI resolves blobs from IndexedDB when needed.


SCHEDULING FLOW DETAIL
======================

User schedule operation (delay/reorder/duration/parallel)
   -> handler in BuildFlow
      -> call scheduleEngine function
         -> consult date workday helpers
         -> produce affected tasks preview/result
      -> apply updates to lot.tasks
      -> optional notifications/messages
      -> persist state

Key property:
- schedule math stays mostly in `scheduleEngine.js`,
  while BuildFlow handles user intent + result application.


INTEGRATION TOUCHPOINTS (PRACTICAL)
===================================

- Sub contact paths:
  - Sub list card -> Sub edit/contact modals -> updates `app.subcontractors`

- Messaging paths:
  - Punch grouping -> draft modal -> sms/mailto URI open

- File/photo paths:
  - input file -> normalize/save blob -> metadata linked to lot/task/punch

- Admin config paths:
  - product types/plans/agencies/custom trades/custom fields
  - used by community setup + task/sub assignment flows


KNOWN ARCHITECTURAL TRADEOFF
============================

- Strength: rapid iteration in one integrated file.
- Cost: large `BuildFlow.jsx` raises coupling and cognitive load.
- Current architecture relies on strict helper boundaries
  (`scheduleEngine/date/storage/idb`) to keep critical logic reliable.
```
