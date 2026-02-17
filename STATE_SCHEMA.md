# State Schema (Practical)

This is a working schema map for the current local-first app state.

## Root `app`
- `org`: organization settings (workdays/holidays, branding, custom fields)
- `communities[]`: community records
- `lots[]`: lot records (tasks + ops data)
- `subcontractors[]`: subs and contacts
- `templates[]`: schedule templates
- `product_types[]`, `plans[]`, `agencies[]`
- `messages[]`, `notifications[]`, `scheduled_reports[]`
- `sync`: local/cloud sync metadata (queue + baseline protection)
- `contact_library_realtors[]`, `contact_library_builders[]`
- `custom_trades[]` (admin-managed)

## Community (typical)
- `id`, `name`, address fields
- `builders[]`, `realtors[]`, `inspectors[]`
- `documents[]`, `specs[]`

## Lot (typical)
- `id`, `community_id`, `lot_number`, `block`, `address`
- `tasks[]`
- `photos[]` (metadata only; binary in IndexedDB)
- `documents[]`
- `inspections[]`, `daily_logs[]`, `material_orders[]`
- `punch_list` (nullable)
- status/progress/completion fields

## Task (typical)
- `id`, `lot_id`, `name`, `trade`, `phase`, `track`
- `sub_id`
- `duration`
- `scheduled_start`, `scheduled_end`
- `actual_start`, `actual_end`
- `dependencies[]`
- `status`

## Dependency Item
- `depends_on_task_id`
- `type` (FS/SS/FF/SF)
- `lag_days`

## Punch List
- `id`, `created_at`
- `items[]`

## Punch Item (current-tolerant)
- `id`
- `category`
- `task_type` and/or legacy `subcategory`
- `description`
- `trade`, `sub_id`
- `status` (open/closed/verified)
- `created_at`, `updated_at`, `completed_at`
- optional media refs (`photo_id` / `photo_ids` tolerated)

## Subcontractor
- `id`, `company_name`, `trade`, `secondary_trades[]`
- `primary_contact`: `{ name, phone, email }`
- `additional_contacts[]`: same shape
- operational fields (capacity, notes, status, metrics)

## Photo Metadata
- `id`, `lot_id`
- relation ids: `task_id`, `inspection_id`, `punch_item_id`, `daily_log_id`
- `blob_id` (IndexedDB lookup key)
- `file_name`, `mime`, `file_size`
- `caption`, `location`, timestamps

## Document Metadata
- `id`, `type`, `blob_id`, `file_name`, `mime`, `file_size`, timestamps

## Persistence Notes
- localStorage stores app graph + metadata.
- IndexedDB stores binary blobs for photos/docs.
- Schema is backward-compatible: code tolerates missing/legacy fields.

## Sync Metadata (`app.sync`)
- `pending[]`: pending mutation summaries (local)
- `cloud_queue[]`: snapshot-sync queue entries
- `cloud_last_synced_at`, `cloud_last_error`, retry metadata
- `baseline_meta`: `{ baseline_id, created_at, checksum, source_device, org_id, restore_point }`
- `baseline_protection`: `{ enabled, baseline_id, checksum, mode }`

## Canonical Contracts (Runtime)
- `SyncStatus`: `{ phase, pending_count, last_ack_at, last_error, rpc_health, baseline_protection }`
- `MutationOp`: `{ op_id, entity, entity_id, op_type, payload, base_version, actor_id, created_at }`
- `sync_pull` response: `{ server_time, cursor, versions, lots, tasks, lot_assignments, attachments }`
- `sync_push` response: `{ server_time, results[], applied[], conflicts[] }` where each result carries `{ id, status, conflict_code, conflict_reason, applied_at }`
- `acquire_lot_lock_v2` response: `{ ok, code, message, token, expires_at, locked_by }`

## Supabase Org Baseline Fields
- `organizations.baseline_protection_enabled` (boolean)
- `organizations.baseline_id` (text)
- `organizations.baseline_checksum` (text)
- `organizations.baseline_protected_at` (timestamptz)
- `organizations.baseline_protected_by` (uuid)
