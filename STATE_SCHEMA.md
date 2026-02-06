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
