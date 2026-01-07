# BuildFlow Specification v2.0
## Part 3: Features 5.16-5.20, UI Specs, API Specs, Security

---

## 5.16 Change Order Management

### 5.16.1 Change Order Types

| Type | Source | Typical Impact |
|------|--------|----------------|
| Buyer Upgrade | Buyer | + Cost, + Time |
| Buyer Downgrade | Buyer | - Cost, ± Time |
| Design Change | Architect/Engineer | ± Cost, + Time |
| Field Condition | Site issue discovered | + Cost, + Time |
| Builder Initiated | Builder decision | ± Cost, ± Time |
| Code Requirement | Inspector/Code | + Cost, + Time |

### 5.16.2 Change Order Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                   CHANGE ORDER WORKFLOW                     │
└─────────────────────────────────────────────────────────────┘

  REQUEST           REVIEW            APPROVE           EXECUTE
     │                │                  │                 │
     ▼                ▼                  ▼                 ▼
┌──────────┐    ┌──────────┐      ┌──────────┐      ┌──────────┐
│  BUYER   │    │  SUPER   │      │ MANAGER  │      │  SUPER   │
│    or    │    │          │      │          │      │          │
│  SUPER   │    │ • Review │      │ • Final  │      │ • Update │
│          │───▶│ • Estimate│─────▶│   approval│─────▶│   schedule│
│ • Submit │    │   impact │      │ • Sign   │      │ • Notify │
│   request│    │ • Get    │      │          │      │   subs   │
│          │    │   quotes │      │          │      │ • Track  │
└──────────┘    └──────────┘      └──────────┘      └──────────┘
                     │                  │
                     │    IF DECLINED   │
                     │◀─────────────────┘
                     │
                     ▼
               ┌──────────┐
               │ DECLINED │
               │          │
               │ • Reason │
               │ • Notify │
               │   buyer  │
               └──────────┘

Status Flow:
DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED/DECLINED → IN_PROGRESS → COMPLETE
```

### 5.16.3 Change Order Data Model

```typescript
interface ChangeOrder {
  id: UUID;
  lot_id: UUID;
  
  // Identification
  co_number: string;               // "CO-2024-001"
  
  // Request Details
  title: string;                   // "Add covered patio"
  description: string;             // Full description of change
  category: ChangeOrderCategory;
  
  // Requestor
  requested_by: 'buyer' | 'builder' | 'architect' | 'field';
  requestor_name: string;
  requestor_email: string;
  request_date: Date;
  
  // Impact Assessment
  cost_impact: {
    labor: number;
    materials: number;
    permits: number;
    other: number;
    total: number;
    margin: number;                // Builder markup
    buyer_price: number;           // Total to buyer
  };
  
  schedule_impact: {
    days_added: number;
    tasks_affected: UUID[];
    critical_path_impact: boolean;
    new_completion_date: Date;
  };
  
  // Quotes
  quotes: {
    sub_id: UUID;
    sub_name: string;
    trade: string;
    amount: number;
    quote_date: Date;
    quote_document: Document;
    notes: string;
  }[];
  
  // Approval
  status: ChangeOrderStatus;
  approved_by: UUID | null;
  approved_date: Date | null;
  approval_signature: string | null;
  decline_reason: string | null;
  
  // Buyer Signature (if buyer-initiated)
  buyer_signature: string | null;
  buyer_signed_date: Date | null;
  
  // Execution
  work_started: Date | null;
  work_completed: Date | null;
  final_cost: number | null;
  
  // Documentation
  documents: Document[];
  photos_before: Photo[];
  photos_after: Photo[];
  
  // Notes
  internal_notes: string;
  buyer_visible_notes: string;
  
  // Metadata
  created_at: DateTime;
  updated_at: DateTime;
  created_by: UUID;
}

type ChangeOrderCategory = 
  | 'structural'
  | 'electrical'
  | 'plumbing'
  | 'hvac'
  | 'exterior'
  | 'interior_finish'
  | 'appliances'
  | 'landscaping'
  | 'other';

type ChangeOrderStatus = 
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'pending_buyer_approval'
  | 'approved'
  | 'declined'
  | 'in_progress'
  | 'complete'
  | 'cancelled';
```

### 5.16.4 Change Order UI

**Create Change Order:**
```
┌─────────────────────────────────────────┐
│  New Change Order                   ✕   │
│  The Grove A-4                          │
├─────────────────────────────────────────┤
│                                         │
│  Title:                                 │
│  [Add covered patio 12x16            ]  │
│                                         │
│  Category:                              │
│  [Exterior                         ▼]   │
│                                         │
│  Description:                           │
│  [Buyer requests 12x16 covered patio ]  │
│  [off master bedroom with ceiling   ]   │
│  [fan and recessed lighting.        ]   │
│                                         │
│  Requested By:                          │
│  [● Buyer] [○ Builder] [○ Field Issue]  │
│                                         │
│  ─────────────────────────────────────  │
│  COST ESTIMATE                          │
│  ─────────────────────────────────────  │
│                                         │
│  Labor:      [$2,500              ]     │
│  Materials:  [$3,200              ]     │
│  Electrical: [$800                ]     │
│  Permits:    [$150                ]     │
│  ──────────────────────────────────     │
│  Subtotal:   $6,650                     │
│  Margin 20%: $1,330                     │
│  ──────────────────────────────────     │
│  Buyer Price: $7,980                    │
│                                         │
│  ─────────────────────────────────────  │
│  SCHEDULE IMPACT                        │
│  ─────────────────────────────────────  │
│                                         │
│  Days Added: [5                   ]     │
│  Tasks Affected:                        │
│  • Exterior Paint (shift +5 days)      │
│  • Landscaping (shift +5 days)         │
│  • Final Clean (shift +5 days)         │
│                                         │
│  New Completion: Dec 20 → Dec 27        │
│  ⚠️ Impacts critical path               │
│                                         │
│  ─────────────────────────────────────  │
│  ATTACHMENTS                            │
│  [+ Add Sketch] [+ Add Quote]           │
│                                         │
│  [   Save Draft   ] [   Submit   ]      │
│                                         │
└─────────────────────────────────────────┘
```

---

## 5.17 Material & Lead Time Tracking

### 5.17.1 Long-Lead Items

| Item | Typical Lead Time | Order Trigger |
|------|-------------------|---------------|
| Windows | 3-6 weeks | After framing starts |
| Exterior Doors | 2-4 weeks | After framing starts |
| Cabinets | 4-8 weeks | After drywall ordered |
| Countertops | 2-3 weeks | After cabinets installed |
| Appliances | 1-4 weeks | After cabinets ordered |
| HVAC Equipment | 1-2 weeks | After rough-in scheduled |
| Flooring (hardwood) | 2-4 weeks | After drywall complete |
| Trusses | 2-4 weeks | Before framing |
| Garage Door | 1-2 weeks | After framing |
| Fireplace | 2-4 weeks | Before framing |

### 5.17.2 Material Order Tracking

```typescript
interface MaterialOrder {
  id: UUID;
  lot_id: UUID;
  
  // Item Info
  item_category: MaterialCategory;
  item_name: string;               // "Kitchen Cabinets"
  item_description: string;        // "Shaker style, white, per plan"
  manufacturer: string;            // "KraftMaid"
  model_number: string;
  color_finish: string;
  quantity: number;
  unit: string;
  
  // Vendor
  vendor_name: string;
  vendor_contact: string;
  vendor_phone: string;
  vendor_email: string;
  
  // Order Info
  po_number: string;
  order_date: Date;
  order_confirmation: Document;
  
  // Pricing
  unit_price: number;
  total_price: number;
  tax: number;
  shipping: number;
  grand_total: number;
  
  // Timing
  lead_time_days: number;
  estimated_ship_date: Date;
  estimated_delivery: Date;
  actual_ship_date: Date | null;
  actual_delivery: Date | null;
  
  // Task Association
  task_id: UUID;                   // Task that needs this material
  needed_by_date: Date;            // When task starts
  buffer_days: number;             // Days before task to have on site
  
  // Status
  status: MaterialStatus;
  
  // Tracking
  tracking_numbers: {
    carrier: string;
    tracking: string;
    url: string;
  }[];
  
  // Delivery
  delivery_location: 'job_site' | 'warehouse' | 'other';
  delivery_instructions: string;
  received_by: string;
  received_date: Date | null;
  delivery_condition: 'good' | 'damaged' | 'partial' | 'wrong';
  delivery_notes: string;
  delivery_photos: Photo[];
  
  // Issues
  issues: {
    type: 'backorder' | 'damaged' | 'wrong_item' | 'short' | 'quality';
    description: string;
    reported_date: Date;
    resolution: string;
    resolved_date: Date | null;
  }[];
  
  // Alerts
  is_at_risk: boolean;             // Delivery may miss needed date
  days_until_needed: number;
  
  // Metadata
  created_at: DateTime;
  updated_at: DateTime;
  created_by: UUID;
}

type MaterialCategory = 
  | 'windows'
  | 'doors_exterior'
  | 'doors_interior'
  | 'cabinets'
  | 'countertops'
  | 'appliances'
  | 'hvac_equipment'
  | 'flooring'
  | 'trusses'
  | 'roofing'
  | 'siding'
  | 'fixtures'
  | 'lighting'
  | 'hardware'
  | 'other';

type MaterialStatus = 
  | 'not_ordered'
  | 'quote_requested'
  | 'ordered'
  | 'order_confirmed'
  | 'in_production'
  | 'ready_to_ship'
  | 'shipped'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'installed'
  | 'backordered'
  | 'cancelled';
```

### 5.17.3 Material Dashboard

```
┌─────────────────────────────────────────┐
│  📦 Material Tracking                   │
│  The Grove A-4                          │
├─────────────────────────────────────────┤
│                                         │
│  ⚠️ NEEDS ATTENTION (2)                 │
│  ─────────────────────────────────────  │
│                                         │
│  🔴 Kitchen Cabinets - AT RISK          │
│     Needed: Dec 15 | ETA: Dec 18        │
│     Status: In Production               │
│     ⚠️ May delay Cabinet Install task   │
│     [View Details] [Contact Vendor]     │
│                                         │
│  🟡 Windows - MONITOR                   │
│     Needed: Dec 10 | ETA: Dec 8         │
│     Status: Shipped                     │
│     Tracking: 1Z999AA10123456784       │
│     [Track Package]                     │
│                                         │
│  ─────────────────────────────────────  │
│  ✅ ON TRACK (6)                        │
│  ─────────────────────────────────────  │
│                                         │
│  Appliances - Delivered ✓               │
│  HVAC Equipment - Delivered ✓           │
│  Countertops - Ordered, ETA Dec 20     │
│  Flooring - Ordered, ETA Dec 12        │
│  Interior Doors - Ordered, ETA Dec 5   │
│  Garage Door - Not yet ordered         │
│                                         │
│  [+ Add Material Order]                 │
│                                         │
└─────────────────────────────────────────┘
```

### 5.17.4 Automatic Alerts

```typescript
function checkMaterialAlerts(orders: MaterialOrder[]): Alert[] {
  const alerts: Alert[] = [];
  const today = new Date();
  
  for (const order of orders) {
    const daysUntilNeeded = daysBetween(today, order.needed_by_date);
    const daysUntilDelivery = order.estimated_delivery 
      ? daysBetween(today, order.estimated_delivery) 
      : null;
    
    // Not yet ordered, but should be
    if (order.status === 'not_ordered') {
      const shouldOrderBy = subtractDays(order.needed_by_date, order.lead_time_days + 7);
      if (today >= shouldOrderBy) {
        alerts.push({
          type: 'material_not_ordered',
          severity: daysUntilNeeded < 14 ? 'critical' : 'warning',
          message: `${order.item_name} needs to be ordered! ` +
                   `Lead time: ${order.lead_time_days} days. ` +
                   `Needed by: ${formatDate(order.needed_by_date)}`,
          order_id: order.id,
          lot_id: order.lot_id,
        });
      }
    }
    
    // Ordered but delivery at risk
    if (order.status !== 'delivered' && order.status !== 'installed') {
      if (daysUntilDelivery !== null && daysUntilDelivery > daysUntilNeeded) {
        alerts.push({
          type: 'material_at_risk',
          severity: 'critical',
          message: `${order.item_name} may not arrive in time! ` +
                   `ETA: ${formatDate(order.estimated_delivery)}. ` +
                   `Needed: ${formatDate(order.needed_by_date)}`,
          order_id: order.id,
          lot_id: order.lot_id,
        });
      }
    }
    
    // Backordered
    if (order.status === 'backordered') {
      alerts.push({
        type: 'material_backordered',
        severity: 'critical',
        message: `${order.item_name} is BACKORDERED. Contact vendor for update.`,
        order_id: order.id,
        lot_id: order.lot_id,
      });
    }
  }
  
  return alerts;
}
```

---

## 5.18 Notification System

### 5.18.1 Notification Types & Channels

| Notification | Push | SMS | Email | In-App |
|--------------|------|-----|-------|--------|
| Task due tomorrow | ✅ | ✅ | ❌ | ✅ |
| Task overdue | ✅ | ✅ | ✅ | ✅ |
| Schedule changed | ✅ | ✅ | ✅ | ✅ |
| Delay logged | ✅ | ✅ | ✅ | ✅ |
| Inspection scheduled | ✅ | ❌ | ✅ | ✅ |
| Inspection failed | ✅ | ✅ | ✅ | ✅ |
| Punch item assigned | ✅ | ✅ | ❌ | ✅ |
| Sub no-show | ✅ | ❌ | ✅ | ✅ |
| Weather warning | ✅ | ❌ | ❌ | ✅ |
| Milestone reached | ✅ | ❌ | ✅ | ✅ |
| Material at risk | ✅ | ✅ | ✅ | ✅ |
| Insurance expiring | ❌ | ❌ | ✅ | ✅ |
| Change order status | ✅ | ❌ | ✅ | ✅ |
| Weekly report ready | ❌ | ❌ | ✅ | ✅ |

### 5.18.2 Notification Data Model

```typescript
interface Notification {
  id: UUID;
  
  // Recipient
  user_id: UUID;
  user_type: 'superintendent' | 'manager' | 'sub';
  
  // Content
  type: NotificationType;
  title: string;
  body: string;
  
  // Context
  entity_type: 'lot' | 'task' | 'inspection' | 'sub' | 'material' | 'change_order';
  entity_id: UUID;
  lot_id: UUID | null;
  
  // Delivery
  channels: {
    push: { sent: boolean; sent_at: DateTime | null; delivered: boolean };
    sms: { sent: boolean; sent_at: DateTime | null; delivered: boolean };
    email: { sent: boolean; sent_at: DateTime | null; opened: boolean };
    in_app: { created: boolean };
  };
  
  // Status
  read: boolean;
  read_at: DateTime | null;
  actioned: boolean;                // User took action
  actioned_at: DateTime | null;
  
  // Timing
  priority: 'low' | 'normal' | 'high' | 'urgent';
  scheduled_for: DateTime | null;   // Future delivery
  expires_at: DateTime | null;      // Auto-dismiss after
  
  // Metadata
  created_at: DateTime;
}

type NotificationType = 
  | 'task_reminder'
  | 'task_overdue'
  | 'schedule_change'
  | 'delay_logged'
  | 'inspection_scheduled'
  | 'inspection_result'
  | 'punch_assigned'
  | 'sub_no_show'
  | 'weather_warning'
  | 'milestone_reached'
  | 'material_alert'
  | 'compliance_expiring'
  | 'change_order_update'
  | 'report_ready'
  | 'system_announcement';
```

### 5.18.3 Notification Preferences

```typescript
interface NotificationPreferences {
  user_id: UUID;
  
  // Global settings
  quiet_hours: {
    enabled: boolean;
    start: string;        // "22:00"
    end: string;          // "07:00"
    timezone: string;
  };
  
  // Per-type settings
  preferences: {
    [key in NotificationType]: {
      enabled: boolean;
      channels: {
        push: boolean;
        sms: boolean;
        email: boolean;
        in_app: boolean;
      };
      frequency: 'immediate' | 'hourly_digest' | 'daily_digest';
    };
  };
  
  // Override for urgent
  always_notify_urgent: boolean;
}
```

### 5.18.4 Notification UI

**Notification Center:**
```
┌─────────────────────────────────────────┐
│  🔔 Notifications                    ✕  │
│  3 unread                               │
├─────────────────────────────────────────┤
│                                         │
│  TODAY                                  │
│  ─────────────────────────────────────  │
│                                         │
│  🔴 10:30 AM                            │
│  Inspection Failed - The Grove A-4     │
│  Rough MEP inspection failed. 2 items   │
│  need correction.                       │
│  [View Details]                         │
│                                         │
│  🟡 9:15 AM                             │
│  Weather Alert                          │
│  Rain forecast for Wed-Thu. 3 outdoor   │
│  tasks may be affected.                 │
│  [Review Tasks]                         │
│                                         │
│  🔵 8:00 AM                             │
│  Milestone Reached - Ovation A-1       │
│  Dried-In milestone complete! 27%       │
│  [View Lot]                             │
│                                         │
│  YESTERDAY                              │
│  ─────────────────────────────────────  │
│                                         │
│  ✓ 4:30 PM                              │
│  Sub confirmed - Mike's Framing        │
│  Confirmed for A-7 framing starting    │
│  Monday.                                │
│                                         │
│  [Mark All Read]                        │
│                                         │
└─────────────────────────────────────────┘
```

---

## 5.19 Offline Mode

### 5.19.1 Offline Requirements

**Must Work Offline:**
- View today's schedule
- View lot details & task list
- Update task status
- Log delays (queued)
- Take photos (queued)
- Add daily log entries (queued)
- Add punch items (queued)
- View sub contact info
- View community specs
- View documents (cached)

**Requires Connection:**
- Generate new schedules
- Send notifications
- Export reports
- Upload documents
- Real-time sync
- Weather updates

### 5.19.2 Sync Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     OFFLINE ARCHITECTURE                    │
└─────────────────────────────────────────────────────────────┘

   MOBILE APP                                    SERVER
   ──────────                                    ──────
       │                                            │
       │  ┌─────────────┐                          │
       │  │   LOCAL     │                          │
       │  │  DATABASE   │                          │
       │  │             │                          │
       │  │ • Lots      │                          │
       │  │ • Tasks     │                          │
       │  │ • Subs      │                          │
       │  │ • Docs      │                          │
       │  │ • Photos    │                          │
       │  └─────────────┘                          │
       │         │                                  │
       │         ▼                                  │
       │  ┌─────────────┐                          │
       │  │   CHANGE    │                          │
       │  │   QUEUE     │                          │
       │  │             │                          │
       │  │ • Pending   │                          │
       │  │   updates   │                          │
       │  │ • Photos    │                          │
       │  │   to upload │                          │
       │  └─────────────┘                          │
       │         │                                  │
       │         │   ┌─────────────────────────┐   │
       │         │   │   SYNC MANAGER          │   │
       │         │   │                         │   │
       │         │   │ • Detect connectivity   │   │
       │         ├──▶│ • Push local changes    │──▶│
       │         │   │ • Pull server changes   │   │
       │         │   │ • Resolve conflicts     │◀──│
       │         │   │ • Update local DB       │   │
       │         │   └─────────────────────────┘   │
       │                                            │
       │  ┌─────────────┐                          │
       │  │   OFFLINE   │                          │
       │  │  INDICATOR  │                          │
       │  │             │                          │
       │  │ "⚡ Online" │                          │
       │  │ "📴 Offline │                          │
       │  │  (3 pending)│                          │
       │  └─────────────┘                          │
       │                                            │
```

### 5.19.3 Conflict Resolution

```typescript
enum ConflictResolution {
  SERVER_WINS = 'server_wins',     // Server version overwrites local
  CLIENT_WINS = 'client_wins',     // Local version overwrites server
  MERGE = 'merge',                 // Combine changes
  MANUAL = 'manual',               // Ask user
}

interface SyncConflict {
  entity_type: string;
  entity_id: UUID;
  local_version: any;
  server_version: any;
  local_modified: DateTime;
  server_modified: DateTime;
  resolution: ConflictResolution;
}

// Default resolutions by entity type
const DEFAULT_RESOLUTIONS: Record<string, ConflictResolution> = {
  'task_status': 'client_wins',      // Field user is source of truth
  'task_dates': 'server_wins',       // Server has authoritative schedule
  'daily_log': 'client_wins',        // Field entry takes precedence
  'photo': 'merge',                  // Keep both
  'delay': 'client_wins',            // Field user logged it
  'punch_item': 'merge',             // Keep both versions
};
```

### 5.19.4 Offline UI Indicators

```
┌─────────────────────────────────────────┐
│  📴 You're Offline                      │
│  Changes will sync when connected       │
│  ─────────────────────────────────────  │
│  3 changes pending                      │
│  • Task status update (A-4)            │
│  • 2 photos to upload                  │
│  ─────────────────────────────────────  │
│  Last synced: 10 min ago               │
└─────────────────────────────────────────┘
```

### 5.19.5 Data Caching Strategy

| Data Type | Cache Duration | Size Limit |
|-----------|----------------|------------|
| Lot list | Until sync | - |
| Active lot details | Until sync | - |
| Task schedules | Until sync | - |
| Sub contacts | 7 days | - |
| Community specs | 7 days | - |
| Plat maps | 30 days | 50 MB each |
| Site plans | 30 days | 50 MB each |
| Recent photos | 7 days | 500 MB total |
| Documents | On-demand | 200 MB total |

---

## 5.20 Photo Documentation

### 5.20.1 Photo Categories

| Category | Purpose | When |
|----------|---------|------|
| Progress | Document task completion | Each task |
| Issue | Document problems | As needed |
| Delivery | Document material arrival | On delivery |
| Inspection | Document inspection items | At inspection |
| Punch | Before/after for punch items | Punch process |
| Daily | General daily documentation | Daily log |
| Milestone | Mark major milestones | At milestone |
| Safety | Document safety issues | As needed |

### 5.20.2 Photo Data Model

```typescript
interface Photo {
  id: UUID;
  
  // Context
  lot_id: UUID;
  task_id: UUID | null;
  inspection_id: UUID | null;
  punch_item_id: UUID | null;
  daily_log_id: UUID | null;
  
  // Category
  category: PhotoCategory;
  
  // File Info
  file_url: string;                // S3 URL
  thumbnail_url: string;           // Smaller version
  file_size: number;
  width: number;
  height: number;
  
  // Metadata
  caption: string;
  location: string;                // "Master bedroom, north wall"
  tags: string[];                  // ["framing", "issue"]
  
  // Device Info
  taken_at: DateTime;
  device_type: string;             // "iPhone 14 Pro"
  gps_lat: number | null;
  gps_lng: number | null;
  
  // Upload
  uploaded_at: DateTime;
  uploaded_by: UUID;
  upload_source: 'camera' | 'gallery' | 'desktop';
  
  // Sync
  synced: boolean;
  sync_error: string | null;
}
```

### 5.20.3 Photo Features

**Quick Capture Mode:**
```
┌─────────────────────────────────────────┐
│                                         │
│                                         │
│                                         │
│          [ CAMERA VIEWFINDER ]          │
│                                         │
│                                         │
│                                         │
├─────────────────────────────────────────┤
│                                         │
│  Category: [Progress         ▼]         │
│                                         │
│  Task: [Framing              ▼]         │
│                                         │
│  Location: [Great room, west wall  ]    │
│                                         │
│         ┌─────────────────┐             │
│         │       📷        │             │
│         │     CAPTURE     │             │
│         └─────────────────┘             │
│                                         │
│  [Gallery] [Recent: 3 photos]           │
│                                         │
└─────────────────────────────────────────┘
```

**Photo Timeline:**
```
┌─────────────────────────────────────────┐
│  📷 Photos - The Grove A-4              │
│  Filter: [All Categories ▼]             │
├─────────────────────────────────────────┤
│                                         │
│  December 5, 2024                       │
│  ─────────────────────────────────────  │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐      │
│  │     │ │     │ │     │ │     │      │
│  │ 📷  │ │ 📷  │ │ 📷  │ │ 📷  │      │
│  │     │ │     │ │     │ │     │      │
│  └─────┘ └─────┘ └─────┘ └─────┘      │
│  Framing  Framing Issue   Delivery     │
│                                         │
│  December 4, 2024                       │
│  ─────────────────────────────────────  │
│  ┌─────┐ ┌─────┐                       │
│  │     │ │     │                       │
│  │ 📷  │ │ 📷  │                       │
│  │     │ │     │                       │
│  └─────┘ └─────┘                       │
│  Framing  Framing                       │
│                                         │
│  [+ Take Photo]                         │
│                                         │
└─────────────────────────────────────────┘
```

### 5.20.4 Photo Requirements by Task

```typescript
const PHOTO_REQUIREMENTS: Record<string, PhotoRequirement> = {
  'Foundation': {
    min_photos: 2,
    required_angles: ['overview', 'detail'],
    milestone_photo: true,
  },
  'Framing': {
    min_photos: 4,
    required_angles: ['front', 'back', 'interior', 'roof'],
    milestone_photo: true,
  },
  'Roofing': {
    min_photos: 2,
    required_angles: ['front_elevation', 'detail'],
    milestone_photo: true,
  },
  'Rough Inspection': {
    min_photos: 3,
    required_angles: ['electrical', 'plumbing', 'hvac'],
    milestone_photo: false,
  },
  'Drywall': {
    min_photos: 2,
    required_angles: ['before_texture', 'after_texture'],
    milestone_photo: true,
  },
  'Final Inspection': {
    min_photos: 6,
    required_angles: ['front', 'back', 'kitchen', 'master', 'living', 'garage'],
    milestone_photo: true,
  },
};
```

---

# 6. USER INTERFACE SPECIFICATIONS

## 6.1 Design Principles

1. **Mobile-First**: Designed for one-handed phone use on job sites
2. **Thumb Zone**: Primary actions within easy thumb reach
3. **Large Tap Targets**: Minimum 44x44pt touch targets
4. **High Contrast**: Readable in bright sunlight
5. **Offline Indication**: Always clear when offline
6. **Progressive Disclosure**: Show summary, reveal details on tap
7. **Consistent Navigation**: Same patterns throughout

## 6.2 Color System

```css
/* Primary */
--blue-600: #2563EB;      /* Primary actions, links */
--blue-700: #1D4ED8;      /* Hover states */

/* Status */
--green-500: #22C55E;     /* Success, complete, on-track */
--yellow-500: #EAB308;    /* Warning, in-progress */
--red-500: #EF4444;       /* Error, delayed, critical */
--orange-500: #F97316;    /* Alert, attention needed */

/* Neutral */
--gray-50: #F9FAFB;       /* Background */
--gray-100: #F3F4F6;      /* Card background */
--gray-200: #E5E7EB;      /* Borders */
--gray-500: #6B7280;      /* Secondary text */
--gray-900: #111827;      /* Primary text */

/* Semantic */
--foundation: #8B5CF6;    /* Purple - Foundation phase */
--framing: #3B82F6;       /* Blue - Framing phase */
--mechanical: #10B981;    /* Green - MEP phase */
--finishes: #F59E0B;      /* Amber - Finishes phase */
--exterior: #06B6D4;      /* Cyan - Exterior track */
```

## 6.3 Typography

```css
/* Font Family */
font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;

/* Scale */
--text-xs: 12px;          /* Labels, metadata */
--text-sm: 14px;          /* Secondary text */
--text-base: 16px;        /* Body text */
--text-lg: 18px;          /* Subheadings */
--text-xl: 20px;          /* Section headers */
--text-2xl: 24px;         /* Page titles */
--text-3xl: 30px;         /* Large numbers */

/* Weights */
--font-normal: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;
```

## 6.4 Component Library

### Cards
```
┌─────────────────────────────────────────┐
│  Standard Card                          │
│  • 16px padding                         │
│  • 12px border-radius                   │
│  • 1px border gray-200                  │
│  • White background                     │
│  • Subtle shadow on hover               │
└─────────────────────────────────────────┘
```

### Buttons
```
Primary:   [████████████] Blue-600, white text, 12px radius
Secondary: [────────────] White, gray border, gray text
Danger:    [████████████] Red-500, white text
Ghost:     [            ] Transparent, blue text

Sizes:
Large:  48px height, 16px padding, 16px text
Medium: 40px height, 12px padding, 14px text
Small:  32px height, 8px padding, 12px text
```

### Status Badges
```
Complete:    [✓ Complete   ] Green bg, green text
In Progress: [⏳ In Progress] Yellow bg, yellow text  
Delayed:     [⚠️ Delayed    ] Red bg, red text
Pending:     [○ Pending    ] Gray bg, gray text
Blocked:     [🔒 Blocked   ] Orange bg, orange text
```

## 6.5 Screen Layouts

### Dashboard (Mobile)
```
┌─────────────────────────────────────────┐
│ ▓▓▓▓▓▓▓▓ HEADER ▓▓▓▓▓▓▓▓               │ 56px
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────────────────────────────┐   │
│  │     WEATHER WIDGET              │   │ 120px
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐      │
│  │STAT │ │STAT │ │STAT │ │STAT │      │ 80px
│  └─────┘ └─────┘ └─────┘ └─────┘      │
│                                         │
│  ┌───────────┐ ┌───────────┐           │
│  │  ACTION   │ │  ACTION   │           │ 80px
│  └───────────┘ └───────────┘           │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │     ON-SITE TODAY               │   │
│  │     • Sub 1                     │   │ Variable
│  │     • Sub 2                     │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │     ACTIVE LOTS                 │   │
│  │     • Lot 1  ████████░░ 80%    │   │ Variable
│  │     • Lot 2  ██████░░░░ 60%    │   │
│  └─────────────────────────────────┘   │
│                                         │
├─────────────────────────────────────────┤
│ ░░░░░ BOTTOM NAVIGATION ░░░░░          │ 56px
└─────────────────────────────────────────┘
```

---

# 7. API SPECIFICATIONS

## 7.1 API Overview

**Base URL:** `https://api.buildflow.io/v1`

**Authentication:** JWT Bearer Token
```
Authorization: Bearer <token>
```

**Response Format:**
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "page": 1,
    "per_page": 20,
    "total": 150
  }
}
```

**Error Format:**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Start date is required",
    "details": { ... }
  }
}
```

## 7.2 Authentication Endpoints

```
POST   /auth/login              Login with email/password
POST   /auth/logout             Logout (invalidate token)
POST   /auth/refresh            Refresh access token
POST   /auth/forgot-password    Request password reset
POST   /auth/reset-password     Reset password with token
GET    /auth/me                 Get current user profile
PUT    /auth/me                 Update current user profile
```

## 7.3 Core Resource Endpoints

### Communities
```
GET    /communities                    List communities
POST   /communities                    Create community
GET    /communities/:id                Get community details
PUT    /communities/:id                Update community
DELETE /communities/:id                Delete community
GET    /communities/:id/lots           List lots in community
GET    /communities/:id/specs          List community specs
POST   /communities/:id/specs          Add community spec
GET    /communities/:id/documents      List community documents
POST   /communities/:id/documents      Upload document (plat map)
```

### Lots
```
GET    /lots                           List all lots (paginated, filtered)
POST   /lots                           Create lot
GET    /lots/:id                       Get lot details with schedule
PUT    /lots/:id                       Update lot
DELETE /lots/:id                       Delete lot
POST   /lots/:id/start                 Start lot (generate schedule)
GET    /lots/:id/tasks                 Get task schedule
PUT    /lots/:id/tasks/reorder         Reorder tasks
GET    /lots/:id/documents             List lot documents
POST   /lots/:id/documents             Upload document (site plan)
GET    /lots/:id/photos                List lot photos
GET    /lots/:id/inspections           List inspections
GET    /lots/:id/punch-list            Get punch list
GET    /lots/:id/daily-logs            List daily logs
GET    /lots/:id/change-orders         List change orders
GET    /lots/:id/materials             List material orders
```

### Tasks
```
GET    /tasks/:id                      Get task details
PUT    /tasks/:id                      Update task
PUT    /tasks/:id/status               Update task status
POST   /tasks/:id/delay                Log delay
POST   /tasks/:id/photos               Add photo to task
GET    /tasks/:id/history              Get task change history
```

### Inspections
```
POST   /lots/:lot_id/inspections       Schedule inspection
GET    /inspections/:id                Get inspection details
PUT    /inspections/:id                Update inspection
PUT    /inspections/:id/result         Record inspection result
POST   /inspections/:id/failure-items  Add failure item
PUT    /inspections/:id/failure-items/:item_id   Update failure item
```

### Punch List
```
POST   /lots/:lot_id/punch-list        Add punch item
GET    /punch-list/:id                 Get punch item details
PUT    /punch-list/:id                 Update punch item
PUT    /punch-list/:id/status          Update punch item status
POST   /punch-list/:id/photos          Add photo to punch item
```

### Daily Logs
```
POST   /lots/:lot_id/daily-logs        Create daily log
GET    /daily-logs/:id                 Get daily log details
PUT    /daily-logs/:id                 Update daily log
POST   /daily-logs/:id/photos          Add photo to daily log
```

### Subcontractors
```
GET    /subcontractors                 List all subs
POST   /subcontractors                 Create sub
GET    /subcontractors/:id             Get sub details
PUT    /subcontractors/:id             Update sub
DELETE /subcontractors/:id             Delete sub
GET    /subcontractors/:id/schedule    Get sub's schedule
GET    /subcontractors/:id/performance Get sub's performance metrics
POST   /subcontractors/:id/contacts    Add contact to sub
```

### Communications
```
POST   /messages                       Send message to sub
GET    /messages                       List sent messages
GET    /messages/:id                   Get message details
POST   /messages/bulk                  Send bulk message
GET    /message-templates              List message templates
```

### Reports
```
GET    /reports/progress               Generate progress report
GET    /reports/delays                 Generate delay analysis
GET    /reports/sub-performance        Generate sub performance report
GET    /reports/community-summary      Generate community summary
POST   /reports/schedule               Schedule recurring report
GET    /reports/exports/:id            Download generated report
```

### Change Orders
```
POST   /lots/:lot_id/change-orders     Create change order
GET    /change-orders/:id              Get change order details
PUT    /change-orders/:id              Update change order
PUT    /change-orders/:id/status       Update CO status (approve/decline)
POST   /change-orders/:id/documents    Add document to CO
```

### Materials
```
POST   /lots/:lot_id/materials         Create material order
GET    /materials/:id                  Get material order details
PUT    /materials/:id                  Update material order
PUT    /materials/:id/status           Update material status
GET    /materials/alerts               Get material alerts
```

### Weather
```
GET    /weather                        Get weather forecast
GET    /weather/alerts                 Get weather alerts for scheduled tasks
```

### Notifications
```
GET    /notifications                  List notifications
PUT    /notifications/:id/read         Mark as read
PUT    /notifications/read-all         Mark all as read
GET    /notifications/preferences      Get notification preferences
PUT    /notifications/preferences      Update notification preferences
```

## 7.4 Webhook Events

```typescript
// Events sent to configured webhook URLs
type WebhookEvent = 
  | 'lot.started'
  | 'lot.milestone_reached'
  | 'lot.completed'
  | 'task.status_changed'
  | 'task.delayed'
  | 'inspection.scheduled'
  | 'inspection.completed'
  | 'inspection.failed'
  | 'change_order.created'
  | 'change_order.approved'
  | 'material.at_risk'
  | 'material.delivered';

interface WebhookPayload {
  event: WebhookEvent;
  timestamp: DateTime;
  data: {
    entity_type: string;
    entity_id: UUID;
    organization_id: UUID;
    changes: Record<string, any>;
  };
}
```

---

# 8. SECURITY & PERMISSIONS

## 8.1 Authentication

- **Method:** JWT (JSON Web Tokens)
- **Access Token Expiry:** 1 hour
- **Refresh Token Expiry:** 30 days
- **Password Requirements:** Min 8 chars, 1 upper, 1 lower, 1 number
- **MFA:** Optional TOTP (Google Authenticator)

## 8.2 Authorization (RBAC)

```typescript
enum Permission {
  // Lots
  LOTS_VIEW = 'lots:view',
  LOTS_CREATE = 'lots:create',
  LOTS_EDIT = 'lots:edit',
  LOTS_DELETE = 'lots:delete',
  
  // Tasks
  TASKS_VIEW = 'tasks:view',
  TASKS_EDIT = 'tasks:edit',
  TASKS_STATUS = 'tasks:status',
  TASKS_DELAY = 'tasks:delay',
  
  // Inspections
  INSPECTIONS_VIEW = 'inspections:view',
  INSPECTIONS_SCHEDULE = 'inspections:schedule',
  INSPECTIONS_RESULT = 'inspections:result',
  
  // Subs
  SUBS_VIEW = 'subs:view',
  SUBS_MANAGE = 'subs:manage',
  SUBS_MESSAGE = 'subs:message',
  
  // Reports
  REPORTS_VIEW = 'reports:view',
  REPORTS_EXPORT = 'reports:export',
  
  // Admin
  ADMIN_USERS = 'admin:users',
  ADMIN_SETTINGS = 'admin:settings',
}

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  superintendent: [
    'lots:view', 'lots:create', 'lots:edit',
    'tasks:view', 'tasks:edit', 'tasks:status', 'tasks:delay',
    'inspections:view', 'inspections:schedule', 'inspections:result',
    'subs:view', 'subs:message',
    'reports:view', 'reports:export',
  ],
  assistant_super: [
    'lots:view',
    'tasks:view', 'tasks:status',
    'inspections:view',
    'subs:view',
    'reports:view',
  ],
  manager: [
    'lots:view',
    'tasks:view',
    'inspections:view',
    'subs:view', 'subs:manage',
    'reports:view', 'reports:export',
  ],
  admin: [
    // All permissions
  ],
};
```

## 8.3 Data Security

- **Encryption at Rest:** AES-256
- **Encryption in Transit:** TLS 1.3
- **Database:** Encrypted RDS with automated backups
- **Files:** S3 with server-side encryption
- **PII Handling:** Buyer info encrypted, access logged
- **Audit Trail:** All data changes logged with user, timestamp

---

# 9. INTEGRATION REQUIREMENTS

## 9.1 Required Integrations

| Integration | Purpose | Priority |
|-------------|---------|----------|
| Weather API | Forecast data | MVP |
| Twilio | SMS notifications | MVP |
| SendGrid | Email notifications | MVP |
| AWS S3 | File storage | MVP |
| Firebase | Push notifications | MVP |
| Google Maps | Address validation | MVP |

## 9.2 Future Integrations

| Integration | Purpose | Phase |
|-------------|---------|-------|
| QuickBooks | Accounting sync | v2 |
| BuilderTrend | Data import | v2 |
| CoConstruct | Data import | v2 |
| Procore | Enterprise integration | v3 |
| DocuSign | Digital signatures | v2 |
| Zapier | Custom integrations | v2 |

---

# 10. MVP VS FUTURE ROADMAP

## 10.1 MVP (v1.0) - 12 weeks

**Core Features:**
- [x] Community & lot structure
- [x] Task scheduling with dependencies
- [x] Parallel tracks (interior/exterior)
- [x] Delay tracking with cascade
- [x] Calendar views (day/week)
- [x] Sub contact management
- [x] Basic milestone tracking
- [x] Weather widget
- [x] Photo documentation
- [x] Export to CSV
- [x] Document upload (plat, site plan)
- [x] SMS notifications (basic)
- [x] Offline mode (basic)

## 10.2 Version 1.5 - 6 weeks

**Enhanced Features:**
- [ ] Inspection management
- [ ] Punch list system
- [ ] Daily log / site diary
- [ ] Full offline mode
- [ ] Email notifications
- [ ] Message templates
- [ ] Enhanced reporting

## 10.3 Version 2.0 - 8 weeks

**Advanced Features:**
- [ ] Change order management
- [ ] Material tracking
- [ ] Sub portal
- [ ] Buyer portal
- [ ] Advanced analytics
- [ ] Scheduled reports
- [ ] QuickBooks integration
- [ ] API for third-party

## 10.4 Version 3.0 - Future

**Enterprise Features:**
- [ ] Multi-builder support
- [ ] White-label option
- [ ] Advanced permissions
- [ ] Custom workflows
- [ ] AI schedule optimization
- [ ] Predictive delay analysis
- [ ] Resource leveling

---

# APPENDIX A: GLOSSARY

| Term | Definition |
|------|------------|
| **Block** | Subdivision of a community (A, B, C, etc.) |
| **Cascade** | Automatic schedule shift when task delayed |
| **Critical Path** | Sequence of tasks with zero slack |
| **Dried-In** | House is weatherproof (roof complete) |
| **Lead Time** | Days to order materials before needed |
| **Lot** | Individual home site |
| **Milestone** | Major completion point (Foundation, Dried-In, etc.) |
| **Parallel Track** | Work that can proceed independently |
| **Plat** | Official map of community lots |
| **Punch List** | Final items to complete before closing |
| **Rough-In** | MEP work before walls closed |
| **Site Plan** | Individual lot layout drawing |
| **Track** | Sequence of related tasks (interior vs exterior) |

---

# APPENDIX B: DOCUMENT HISTORY

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | Dec 2024 | - | Initial specification |
| 2.0 | Dec 2024 | - | Added all 20 features, API spec |

---

*End of Specification Document*
