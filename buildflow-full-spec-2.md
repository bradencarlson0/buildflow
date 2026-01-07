# BuildFlow Specification v2.0
## Part 2: Feature Specifications (Continued)

---

## 5.7 Inspection Management

### 5.7.1 Inspection Types

| Code | Type | Trigger Task | Blocks Next Task |
|------|------|--------------|------------------|
| PRE | Pre-Pour | Footings | Foundation Pour |
| FND | Foundation | Foundation Cure | Backfill |
| FRM | Framing | Roofing | Windows |
| REL | Rough Electrical | Rough Electrical | Insulation |
| RPL | Rough Plumbing | Rough Plumbing | Insulation |
| RHV | Rough HVAC | Rough HVAC | Insulation |
| RME | Rough MEP (Combined) | All Rough | Insulation |
| INS | Insulation | Insulation | Drywall |
| DRY | Drywall | Drywall Hang | Drywall Finish |
| FEL | Final Electrical | Final Electrical | Final Clean |
| FPL | Final Plumbing | Final Plumbing | Final Clean |
| FHV | Final HVAC | Final HVAC | Final Clean |
| FIN | Final Building | Final Clean | Punch |
| COO | Certificate of Occupancy | Punch Complete | Handover |

### 5.7.2 Inspection Workflow

```
Task Complete
     │
     ▼
┌─────────────────────┐
│ SCHEDULE INSPECTION │
│                     │
│ • Select date/time  │
│ • Add inspector info│
│ • Notify inspector  │
└─────────────────────┘
     │
     ▼
┌─────────────────────┐
│ INSPECTION PENDING  │
│                     │
│ Status: Scheduled   │
│ Date: Dec 5, 2024   │
│ Inspector: J. Smith │
└─────────────────────┘
     │
     ▼
┌─────────────────────┐
│ INSPECTOR ARRIVES   │
│                     │
│ □ Mark as "Started" │
│ □ Take photos       │
└─────────────────────┘
     │
     ├──────────────────┬──────────────────┐
     ▼                  ▼                  ▼
┌─────────┐      ┌───────────┐      ┌──────────┐
│  PASS   │      │  PARTIAL  │      │   FAIL   │
│         │      │           │      │          │
│ ✅ Next │      │ ⚠️ Items  │      │ ❌ Items │
│ task    │      │ to fix    │      │ to fix   │
│ unlocks │      │           │      │          │
└─────────┘      └───────────┘      └──────────┘
                       │                  │
                       ▼                  ▼
               ┌─────────────────────────────┐
               │ CREATE FAILURE ITEMS        │
               │                             │
               │ • Description               │
               │ • Location                  │
               │ • Trade responsible         │
               │ • Photo                     │
               │ • Assign to sub             │
               └─────────────────────────────┘
                       │
                       ▼
               ┌─────────────────────────────┐
               │ FIX ITEMS                   │
               │                             │
               │ Sub fixes issue             │
               │ Super marks "Fixed"         │
               │ Photo of fix                │
               └─────────────────────────────┘
                       │
                       ▼
               ┌─────────────────────────────┐
               │ SCHEDULE RE-INSPECTION      │
               │                             │
               │ Links to original           │
               │ inspection record           │
               └─────────────────────────────┘
```

### 5.7.3 Inspection UI

**Schedule Inspection Modal:**
```
┌─────────────────────────────────────────┐
│  Schedule Inspection                 ✕  │
├─────────────────────────────────────────┤
│                                         │
│  Type: [Rough MEP Inspection      ▼]    │
│                                         │
│  Date: [December 5, 2024       📅]      │
│                                         │
│  Time: [○ AM  ● PM  ○ Specific]         │
│         [10:00 AM              ▼]       │
│                                         │
│  Inspector:                             │
│  Name:  [John Smith              ]      │
│  Phone: [555-555-1234            ]      │
│  Agency:[City of Dallas          ]      │
│                                         │
│  Notes:                                 │
│  [Enter any special notes...      ]     │
│                                         │
│  [     Schedule Inspection     ]        │
│                                         │
└─────────────────────────────────────────┘
```

**Inspection Result Entry:**
```
┌─────────────────────────────────────────┐
│  Rough MEP Inspection               ✕   │
│  The Grove A-4                          │
├─────────────────────────────────────────┤
│                                         │
│  Result:                                │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │  ✅     │ │  ⚠️     │ │  ❌     │   │
│  │  PASS   │ │ PARTIAL │ │  FAIL   │   │
│  └─────────┘ └─────────┘ └─────────┘   │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  Failure Items:                         │
│  ┌─────────────────────────────────┐   │
│  │ + Add Failure Item              │   │
│  └─────────────────────────────────┘   │
│                                         │
│  1. Missing GFCI in master bath        │
│     📍 Master Bathroom                  │
│     👷 Electrical - Sparky Electric     │
│     📷 [Photo attached]                 │
│     Status: ○ Open ○ Fixed ○ Verified  │
│                                         │
│  2. Plumbing vent not visible          │
│     📍 Attic above bathroom            │
│     👷 Plumbing - Pro Plumbing         │
│     📷 [Photo attached]                 │
│     Status: ○ Open ○ Fixed ○ Verified  │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  Upload Inspection Report: [Choose File]│
│                                         │
│  [     Save & Notify Subs     ]         │
│                                         │
└─────────────────────────────────────────┘
```

### 5.7.4 Inspection Blocking Logic

When inspection is **required** for a task:
1. Task cannot be marked "Complete" until inspection passes
2. Dependent tasks remain "Blocked" status
3. UI shows lock icon: 🔒
4. Tooltip: "Waiting on Rough MEP inspection"

```typescript
function canCompleteTask(task: Task, inspections: Inspection[]): boolean {
  if (!task.requires_inspection) {
    return true;
  }
  
  const relatedInspection = inspections.find(
    i => i.task_id === task.id && 
         i.result === 'pass'
  );
  
  return relatedInspection !== null;
}

function canStartTask(task: Task, schedule: Task[], inspections: Inspection[]): boolean {
  // Check all dependencies
  for (const dep of task.dependencies) {
    const predecessor = schedule.find(t => t.id === dep.depends_on_task_id);
    
    if (predecessor.status !== 'complete') {
      return false;
    }
    
    // Check if predecessor required inspection
    if (predecessor.requires_inspection) {
      const inspection = inspections.find(
        i => i.task_id === predecessor.id && i.result === 'pass'
      );
      if (!inspection) {
        return false;
      }
    }
  }
  
  return true;
}
```

---

## 5.8 Punch List System

### 5.8.1 Punch List Categories

**Exterior:**
- Paint/Stain
- Siding/Trim
- Concrete/Flatwork
- Roofing/Gutters
- Landscaping
- Grading/Drainage
- Garage Door
- Mailbox/Address

**Interior:**
- Drywall
- Paint
- Flooring
- Trim/Baseboards
- Doors (interior)
- Cabinets
- Countertops
- Hardware/Fixtures

**Mechanical:**
- Electrical (outlets, switches, fixtures)
- Plumbing (faucets, toilets, drains)
- HVAC (registers, thermostat)
- Appliances

**Doors & Windows:**
- Entry doors
- Interior doors
- Windows
- Screens
- Locks/Hardware

**Final:**
- Cleaning
- Touch-up
- Labels/Stickers
- Manuals/Warranty docs

### 5.8.2 Punch List Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                     PUNCH LIST WORKFLOW                     │
└─────────────────────────────────────────────────────────────┘

   IDENTIFY              ASSIGN              FIX               VERIFY
      │                    │                  │                   │
      ▼                    ▼                  ▼                   ▼
┌──────────┐        ┌──────────┐        ┌──────────┐        ┌──────────┐
│   SUPER  │        │  SYSTEM  │        │   SUB    │        │  SUPER   │
│  or BUYER│        │          │        │          │        │ or BUYER │
│          │        │          │        │          │        │          │
│ • Walk   │───────▶│ • Route  │───────▶│ • Fix    │───────▶│ • Verify │
│   house  │        │   to sub │        │   item   │        │   fix    │
│ • Add    │        │ • Send   │        │ • Upload │        │ • Mark   │
│   items  │        │   notif  │        │   photo  │        │   done   │
│ • Photo  │        │          │        │ • Mark   │        │          │
│   each   │        │          │        │   fixed  │        │          │
└──────────┘        └──────────┘        └──────────┘        └──────────┘
      │                                                            │
      │              Item Status Flow                              │
      │                                                            │
      └──────────────────────────────────────────────────────────┘
      
      OPEN ──▶ IN PROGRESS ──▶ FIXED ──▶ VERIFIED ──▶ CLOSED
        │           │            │           │
        │           │            │           └── Final sign-off
        │           │            └── Sub completed work
        │           └── Sub acknowledged, scheduled
        └── Item logged with photo
```

### 5.8.3 Punch List UI

**Master List View:**
```
┌─────────────────────────────────────────┐
│  Punch List - The Grove A-4         ✕   │
│  Progress: ████████░░ 24/32 (75%)       │
├─────────────────────────────────────────┤
│                                         │
│  Filter: [All ▼] [All Trades ▼]         │
│                                         │
│  ─────────────────────────────────────  │
│  EXTERIOR (3 remaining)            ▼    │
│  ─────────────────────────────────────  │
│                                         │
│  □ Fascia paint touch-up                │
│    📍 Front elevation, left corner      │
│    👷 Painting - Pro Painters           │
│    🔴 Open                              │
│                                         │
│  □ Caulk gap at window                  │
│    📍 Bedroom 2, window                 │
│    👷 Windows - Clear View              │
│    🟡 In Progress                       │
│                                         │
│  ─────────────────────────────────────  │
│  INTERIOR (5 remaining)            ▼    │
│  ─────────────────────────────────────  │
│                                         │
│  □ Drywall ding above door              │
│    📍 Master bedroom entry              │
│    👷 Drywall - Perfect Drywall         │
│    🟢 Fixed - Needs verification        │
│                                         │
│  [+ Add Punch Item]                     │
│                                         │
└─────────────────────────────────────────┘
```

**Add Punch Item Modal:**
```
┌─────────────────────────────────────────┐
│  Add Punch Item                     ✕   │
├─────────────────────────────────────────┤
│                                         │
│  Category:                              │
│  [Interior - Drywall              ▼]    │
│                                         │
│  Location:                              │
│  [Master bedroom entry             ]    │
│                                         │
│  Description:                           │
│  [Small ding in drywall above      ]    │
│  [door frame, needs mud and paint  ]    │
│                                         │
│  Photo: (Required)                      │
│  ┌─────────────────────────────────┐   │
│  │                                 │   │
│  │        📷 Take Photo            │   │
│  │        or Choose from Gallery   │   │
│  │                                 │   │
│  └─────────────────────────────────┘   │
│                                         │
│  Priority:                              │
│  [○ Critical] [● Standard] [○ Cosmetic] │
│                                         │
│  Trade: [Drywall                   ▼]   │
│  Sub:   [Perfect Drywall           ▼]   │
│                                         │
│  Source:                                │
│  [● Super] [○ Manager] [○ Buyer]        │
│                                         │
│  [        Add Item        ]             │
│                                         │
└─────────────────────────────────────────┘
```

### 5.8.4 Punch List Pre-Population

When lot reaches "Final Clean" task, auto-generate punch list template:

```typescript
const PUNCH_TEMPLATE = [
  // Exterior
  { category: 'exterior_paint', desc: 'Check all fascia, soffit, trim for touch-up' },
  { category: 'exterior_siding', desc: 'Check siding for damage, gaps' },
  { category: 'exterior_concrete', desc: 'Check driveway, walkways for cracks' },
  { category: 'exterior_landscaping', desc: 'Check sod, plants, mulch' },
  
  // Interior - Room by Room
  { category: 'interior_drywall', desc: 'Walk all rooms for dings, nail pops' },
  { category: 'interior_paint', desc: 'Check all walls, ceilings, trim' },
  { category: 'interior_flooring', desc: 'Check all flooring for damage, gaps' },
  { category: 'interior_trim', desc: 'Check all baseboards, casing, crown' },
  { category: 'interior_cabinets', desc: 'Check all doors, drawers, alignment' },
  
  // Mechanicals
  { category: 'electrical', desc: 'Test all outlets, switches, fixtures' },
  { category: 'plumbing', desc: 'Test all faucets, toilets, drains' },
  { category: 'hvac', desc: 'Test all registers, thermostat, airflow' },
  { category: 'appliances', desc: 'Test all appliances, verify manuals' },
  
  // Final
  { category: 'cleaning', desc: 'Final clean complete, no construction debris' },
  { category: 'doors_windows', desc: 'Check all doors, windows, locks, screens' },
];
```

---

## 5.9 Daily Log / Site Diary

### 5.9.1 Purpose & Legal Importance

The daily log serves as:
1. **Legal protection** - Documentation of site conditions, work performed
2. **Management visibility** - What happened today
3. **Historical reference** - Track patterns, issues
4. **Delay justification** - Weather, sub no-shows documented

### 5.9.2 Daily Log Structure

```typescript
interface DailyLog {
  // Header
  lot_id: UUID;
  log_date: Date;
  superintendent_id: UUID;
  
  // Time
  time_arrived: string;      // "7:00 AM"
  time_departed: string;     // "4:30 PM"
  
  // Weather (Critical for delay justification)
  weather: {
    conditions: WeatherCondition[];  // ['sunny', 'windy']
    temp_high: number;               // 75
    temp_low: number;                // 52
    precipitation: boolean;
    precipitation_amount: string;    // "0.5 inches"
    weather_impact: string | null;   // "Rain delayed concrete pour 2 hrs"
  };
  
  // Personnel
  subs_on_site: {
    sub_id: UUID;
    sub_name: string;
    crew_count: number;
    time_in: string;
    time_out: string;
    work_performed: string;
    check_in_confirmed: boolean;
  }[];
  
  // Visitors
  visitors: {
    name: string;
    company: string;
    purpose: string;
    time_in: string;
    time_out: string;
  }[];
  
  // Work Summary
  work_summary: string;        // Free text: "Framing crew completed..."
  
  // Tasks Worked
  tasks: {
    task_id: UUID;
    task_name: string;
    percent_before: number;
    percent_after: number;
    notes: string;
  }[];
  
  // Deliveries
  deliveries: {
    vendor: string;
    items: string;
    received_by: string;
    condition: 'good' | 'damaged' | 'partial';
    notes: string;
    photo: Photo | null;
  }[];
  
  // Issues
  issues: {
    description: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    action_taken: string;
    resolved: boolean;
    notify_manager: boolean;
    photo: Photo | null;
  }[];
  
  // Safety
  safety_observations: string;
  safety_incidents: {
    description: string;
    persons_involved: string;
    action_taken: string;
    reported_to: string;
    photo: Photo | null;
  }[];
  
  // Photos
  photos: {
    photo: Photo;
    caption: string;
    category: 'progress' | 'issue' | 'delivery' | 'safety' | 'general';
  }[];
  
  // Sign-off
  notes: string;
  signature: string;           // Base64 signature image
  signed_at: DateTime;
}
```

### 5.9.3 Daily Log UI

**Quick Entry Mode:**
```
┌─────────────────────────────────────────┐
│  Daily Log - The Grove A-4          ✕   │
│  Monday, December 2, 2024               │
├─────────────────────────────────────────┤
│                                         │
│  ⏱️ Time On Site                        │
│  Arrived: [7:00 AM ▼]  Left: [4:30 PM ▼]│
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  🌤️ Weather                             │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐   │
│  │ ☀️ │ │ ⛅ │ │ ☁️ │ │ 🌧️ │ │ ❄️ │   │
│  └────┘ └────┘ └────┘ └────┘ └────┘   │
│  High: [75°]  Low: [52°]               │
│  Weather Impact: [None            ▼]    │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  👷 Subs On Site                        │
│  (Auto-populated from schedule)         │
│                                         │
│  ☑️ Mike's Framing                      │
│     Crew: [4]  In: [7:15] Out: [4:00]  │
│     Work: [Completed 2nd floor walls ]  │
│                                         │
│  ☐ TopNotch Roofing                    │
│     ⚠️ NO SHOW - Tap to log            │
│                                         │
│  [+ Add Sub Not on Schedule]            │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  📝 Work Summary                        │
│  [Framing crew made good progress    ]  │
│  [on 2nd floor. Waiting on trusses   ]  │
│  [delivery tomorrow.                 ]  │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  📷 Photos (Tap to add)                 │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐      │
│  │     │ │     │ │     │ │  +  │      │
│  │ 📷  │ │ 📷  │ │ 📷  │ │     │      │
│  └─────┘ └─────┘ └─────┘ └─────┘      │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  ⚠️ Issues (Optional)                   │
│  [+ Add Issue]                          │
│                                         │
│  ─────────────────────────────────────  │
│                                         │
│  ✍️ Signature                           │
│  ┌─────────────────────────────────┐   │
│  │                                 │   │
│  │   Sign here                     │   │
│  │                                 │   │
│  └─────────────────────────────────┘   │
│                                         │
│  [         Save Daily Log         ]     │
│                                         │
└─────────────────────────────────────────┘
```

---

## 5.10 Communication System

### 5.10.1 Communication Types

| Type | Trigger | Recipients | Method |
|------|---------|------------|--------|
| Schedule Notification | Lot started | Sub | SMS + Email |
| Day-Before Reminder | T-1 day | Sub | SMS |
| Schedule Change | Task moved | Affected subs | SMS + Email |
| Delay Notification | Delay logged | Downstream subs | SMS + Email |
| Spec Reminder | Task started | Sub | In-notification |
| Inspection Scheduled | Inspection created | Inspector | Email |
| Inspection Failed | Fail logged | Responsible sub | SMS + Email |
| Punch Item Assigned | Item created | Sub | SMS |
| Weekly Schedule | Monday AM | All subs | Email |

### 5.10.2 Message Templates

**Schedule Notification:**
```
📅 NEW SCHEDULE - {community} {block}-{lot}

{sub_name}, you are scheduled for:

Task: {task_name}
Date: {start_date} - {end_date}
Address: {lot_address}

Please confirm availability.
Reply Y to confirm, N if conflict.

- {builder_name}
```

**Schedule Change:**
```
📅 SCHEDULE UPDATE - {community} {block}-{lot}

{sub_name}, your schedule has changed:

Task: {task_name}
OLD: {old_start_date}
NEW: {new_start_date}

Reason: {change_reason}

Reply Y to confirm, Q with questions.

- {builder_name}
```

**Day-Before Reminder:**
```
⏰ REMINDER - Tomorrow

{sub_name}, reminder for tomorrow:

Task: {task_name}
Location: {lot_address}
Community: {community} {block}-{lot}

Contact super: {super_phone}

- {builder_name}
```

**Inspection Failed:**
```
⚠️ INSPECTION FAILED - {community} {block}-{lot}

{sub_name}, the {inspection_type} inspection failed.

Issues requiring your attention:
{failure_items_list}

Please schedule time to correct.
Re-inspection needed by: {target_date}

Contact: {super_phone}

- {builder_name}
```

### 5.10.3 Bulk Communication

**Weekly Schedule Email:**
```
Subject: Weekly Schedule - {week_of_date}

{sub_name},

Here is your schedule for the week of {week_of_date}:

MONDAY, {date}
• {community} {lot} - {task_name}
  Address: {address}

TUESDAY, {date}
• {community} {lot} - {task_name}
  Address: {address}

WEDNESDAY, {date}
• No work scheduled

...

Total jobs this week: {count}

Questions? Contact {super_name} at {super_phone}

- {builder_name}
```

### 5.10.4 Communication Center UI

```
┌─────────────────────────────────────────┐
│  Message Sub                        ✕   │
│  The Grove A-4                          │
├─────────────────────────────────────────┤
│                                         │
│  To:                                    │
│  [Mike's Framing - Framing       ▼]     │
│                                         │
│  Template:                              │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │Schedule │ │Schedule │ │  Spec   │   │
│  │Reminder │ │ Change  │ │Reminder │   │
│  └─────────┘ └─────────┘ └─────────┘   │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │  Delay  │ │  Punch  │ │ Custom  │   │
│  │  Alert  │ │  Item   │ │ Message │   │
│  └─────────┘ └─────────┘ └─────────┘   │
│                                         │
│  Message Preview:                       │
│  ┌─────────────────────────────────┐   │
│  │ 📅 SCHEDULE REMINDER            │   │
│  │                                 │   │
│  │ Mike's Framing, you are         │   │
│  │ scheduled for:                  │   │
│  │                                 │   │
│  │ Task: Framing                   │   │
│  │ Date: Dec 5 - Dec 18            │   │
│  │ Address: 123 Oak St             │   │
│  │                                 │   │
│  │ Reply Y to confirm.             │   │
│  │                                 │   │
│  │ - ABC Homes                     │   │
│  └─────────────────────────────────┘   │
│                                         │
│  Attachments:                           │
│  [+ Community Specs] [+ Site Plan]      │
│                                         │
│  Send via:                              │
│  [☑️ SMS] [☑️ Email] [☐ App]            │
│                                         │
│  [         Send Message         ]       │
│                                         │
└─────────────────────────────────────────┘
```

---

## 5.11 Subcontractor Management

### 5.11.1 Sub Profile

**Complete Sub Record:**
```
┌─────────────────────────────────────────┐
│  Mike's Framing LLC                     │
│  ★★★★★ 4.9 (47 jobs)                   │
├─────────────────────────────────────────┤
│                                         │
│  CONTACT                                │
│  ─────────────────────────────────────  │
│  Mike Johnson (Owner)                   │
│  📱 555-555-0103                        │
│  ✉️ mike@mikesframing.com               │
│                                         │
│  Additional Contacts:                   │
│  • Sarah (Office) - 555-555-0104       │
│  • Tom (Crew Lead) - 555-555-0105      │
│                                         │
│  TRADES                                 │
│  ─────────────────────────────────────  │
│  🏗️ Framing (Primary)                   │
│  🏗️ Decks                               │
│  🏗️ Pergolas                            │
│                                         │
│  COMPLIANCE                             │
│  ─────────────────────────────────────  │
│  License: #123456 (TX)                  │
│  Expires: Dec 31, 2025 ✅               │
│                                         │
│  Insurance: ABC Insurance               │
│  Policy: POL-789012                     │
│  Expires: Jun 30, 2025 ✅               │
│                                         │
│  W-9: ✅ On file                        │
│                                         │
│  CAPACITY                               │
│  ─────────────────────────────────────  │
│  Crew Size: 4-6                         │
│  Max Concurrent: 2 jobs                 │
│  Service Area: Dallas, Fort Worth       │
│                                         │
│  PERFORMANCE                            │
│  ─────────────────────────────────────  │
│  Total Jobs: 47                         │
│  On-Time: 94%                           │
│  Delays Caused: 3                       │
│  Avg Rating: 4.9 ★                      │
│                                         │
│  STATUS                                 │
│  ─────────────────────────────────────  │
│  ● Active                               │
│  ☑️ Preferred for Framing               │
│                                         │
│  NOTES                                  │
│  ─────────────────────────────────────  │
│  Great quality work. Sometimes runs     │
│  1-2 days over on large homes. Very     │
│  responsive to punch items.             │
│                                         │
│  [📱 Call] [✉️ Message] [✏️ Edit]       │
│                                         │
└─────────────────────────────────────────┘
```

### 5.11.2 Sub Assignment Logic

When generating schedule, auto-assign subs:

```typescript
function assignSubToTask(task: Task, subs: Subcontractor[]): Subcontractor | null {
  // 1. Filter subs by trade
  const tradeSubs = subs.filter(s => 
    s.trades.includes(task.trade) && 
    s.status === 'active'
  );
  
  if (tradeSubs.length === 0) return null;
  
  // 2. Prefer "preferred" sub for this trade
  const preferred = tradeSubs.find(s => s.is_preferred);
  if (preferred) {
    // Check availability
    if (isAvailable(preferred, task.scheduled_start)) {
      return preferred;
    }
  }
  
  // 3. Fall back to backup
  const backup = tradeSubs.find(s => s.is_backup);
  if (backup && isAvailable(backup, task.scheduled_start)) {
    return backup;
  }
  
  // 4. Find any available sub, sorted by rating
  const available = tradeSubs
    .filter(s => isAvailable(s, task.scheduled_start))
    .sort((a, b) => b.rating - a.rating);
  
  return available[0] || null;
}

function isAvailable(sub: Subcontractor, date: Date): boolean {
  // Check blackout dates
  const isBlackout = sub.blackout_dates.some(range =>
    date >= range.start && date <= range.end
  );
  if (isBlackout) return false;
  
  // Check capacity (how many jobs already scheduled that day)
  const jobsOnDate = getJobsForSubOnDate(sub.id, date);
  if (jobsOnDate >= sub.max_concurrent_jobs) return false;
  
  return true;
}
```

### 5.11.3 Sub Conflict Detection

Dashboard widget shows conflicts:

```
┌─────────────────────────────────────────┐
│  ⚠️ Sub Conflicts Detected              │
├─────────────────────────────────────────┤
│                                         │
│  Mike's Framing                         │
│  Dec 5, 2024 - Double booked           │
│  • The Grove A-4 (Framing)             │
│  • The Grove A-7 (Framing)             │
│  Max capacity: 2 | Booked: 3           │
│                                         │
│  [Resolve]                              │
│                                         │
│  Sparky Electric                        │
│  Dec 8, 2024 - Double booked           │
│  • Ovation A-1 (Rough Electrical)      │
│  • The Grove B-2 (Rough Electrical)    │
│  Max capacity: 1 | Booked: 2           │
│                                         │
│  [Resolve]                              │
│                                         │
└─────────────────────────────────────────┘
```

---

## 5.12 Document Management

### 5.12.1 Document Hierarchy

```
Organization
├── Company documents
│   ├── Insurance certificates
│   ├── License
│   └── Standard contracts
│
├── Community: The Grove
│   ├── Plat Map ⭐
│   ├── HOA Documents
│   ├── Development Agreement
│   ├── Utility Maps
│   └── Community Specs
│
│   └── Lot: A-4
│       ├── Site Plan ⭐
│       ├── Floor Plan
│       ├── Elevation Drawings
│       ├── Engineering (if custom)
│       ├── Permit
│       ├── Survey
│       ├── Inspection Reports
│       ├── Change Orders
│       └── Photos (by date)
│
└── Subcontractor: Mike's Framing
    ├── Insurance Certificate
    ├── License
    └── W-9
```

### 5.12.2 Document Viewer Features

**For PDFs (Plat Maps, Site Plans):**
- Pinch-to-zoom (mobile)
- Pan/scroll
- Rotate
- Download original
- Share via email
- Offline caching
- Thumbnail preview
- Multi-page navigation

**For Images:**
- Full-screen view
- Pinch-to-zoom
- Swipe between images
- Download
- Share

### 5.12.3 Upload Specifications

| Document Type | Max Size | Formats | Thumbnail |
|---------------|----------|---------|-----------|
| Plat Map | 50 MB | PDF, PNG, JPG, TIFF | Yes |
| Site Plan | 50 MB | PDF, PNG, JPG, TIFF | Yes |
| Floor Plan | 25 MB | PDF, PNG, JPG | Yes |
| Permit | 10 MB | PDF, PNG, JPG | Yes |
| Inspection Report | 10 MB | PDF, PNG, JPG | Yes |
| Photo | 10 MB | PNG, JPG, HEIC | Yes |
| Insurance Cert | 5 MB | PDF, PNG, JPG | No |
| General | 25 MB | PDF, PNG, JPG, DOC, XLS | No |

---

## 5.13 Weather Integration

### 5.13.1 Weather Data

**API:** OpenWeather or Tomorrow.io

**Data Points:**
- Current conditions
- 7-day forecast
- Hourly forecast (next 48 hrs)
- Precipitation probability
- Temperature (high/low)
- Wind speed
- Humidity

### 5.13.2 Weather Impact Logic

```typescript
const OUTDOOR_TASKS = [
  'Excavation',
  'Footings',
  'Foundation Pour',
  'Backfill',
  'Slab Pour',
  'Framing',
  'Roof Sheathing',
  'Roofing',
  'Exterior Sheathing',
  'Siding',
  'Exterior Paint',
  'Concrete Flatwork',
  'Landscaping',
];

const WEATHER_THRESHOLDS = {
  rain_probability: 50,      // >50% = warning
  wind_speed: 25,            // >25 mph = warning for framing
  temp_low: 35,              // <35°F = concrete warning
  temp_high: 100,            // >100°F = safety warning
};

function getWeatherWarnings(
  forecast: DayForecast[],
  schedule: Task[]
): WeatherWarning[] {
  const warnings: WeatherWarning[] = [];
  
  for (const day of forecast) {
    // Find outdoor tasks scheduled this day
    const outdoorTasks = schedule.filter(task =>
      OUTDOOR_TASKS.includes(task.name) &&
      isDateInRange(day.date, task.scheduled_start, task.scheduled_end)
    );
    
    if (outdoorTasks.length === 0) continue;
    
    // Check rain
    if (day.precipitation_chance > WEATHER_THRESHOLDS.rain_probability) {
      warnings.push({
        date: day.date,
        type: 'rain',
        severity: day.precipitation_chance > 80 ? 'high' : 'medium',
        message: `${day.precipitation_chance}% chance of rain`,
        affected_tasks: outdoorTasks,
        recommendation: 'Consider rescheduling outdoor work',
      });
    }
    
    // Check temperature for concrete
    const concreteTasks = outdoorTasks.filter(t => 
      t.name.includes('Pour') || t.name.includes('Concrete')
    );
    if (concreteTasks.length > 0 && day.temp_low < WEATHER_THRESHOLDS.temp_low) {
      warnings.push({
        date: day.date,
        type: 'cold',
        severity: 'high',
        message: `Low of ${day.temp_low}°F - too cold for concrete`,
        affected_tasks: concreteTasks,
        recommendation: 'Reschedule concrete work or use cold-weather mix',
      });
    }
    
    // Check wind for framing
    const framingTasks = outdoorTasks.filter(t =>
      t.name.includes('Framing') || t.name.includes('Roof')
    );
    if (framingTasks.length > 0 && day.wind_speed > WEATHER_THRESHOLDS.wind_speed) {
      warnings.push({
        date: day.date,
        type: 'wind',
        severity: 'high',
        message: `Wind ${day.wind_speed} mph - unsafe for elevated work`,
        affected_tasks: framingTasks,
        recommendation: 'Reschedule elevated work',
      });
    }
  }
  
  return warnings;
}
```

### 5.13.3 Weather UI Widget

```
┌─────────────────────────────────────────┐
│  🌤️ 7-Day Forecast - Dallas, TX         │
├─────────────────────────────────────────┤
│                                         │
│  Today  Tue   Wed   Thu   Fri  Sat  Sun │
│   ☀️    ⛅    🌧️    🌧️    ☀️   ☀️   ☀️  │
│   72°   68°   61°   58°   65°  68°  71° │
│         20%   80%   70%   10%           │
│                                         │
│  ⚠️ Weather Alerts                      │
│  ─────────────────────────────────────  │
│  🌧️ Wed-Thu: Rain expected (70-80%)     │
│     3 outdoor tasks affected:           │
│     • A-4: Roofing                      │
│     • B-2: Concrete Flatwork            │
│     • B-5: Siding                       │
│     [View Details] [Reschedule]         │
│                                         │
└─────────────────────────────────────────┘
```

---

## 5.14 Milestone & Progress Tracking

### 5.14.1 Standard Milestones

| Milestone | Trigger Task | % Complete | Draw Schedule |
|-----------|--------------|------------|---------------|
| Permit Issued | Manual | 0% | - |
| Foundation Complete | Foundation task | 8% | Draw 1 |
| Framing Complete | Framing task | 20% | Draw 2 |
| Dried-In | Roofing task | 27% | Draw 3 |
| Rough Complete | Rough Inspection | 45% | Draw 4 |
| Drywall Complete | Drywall task | 55% | Draw 5 |
| Trim Complete | Trim task | 75% | Draw 6 |
| Final Inspection | Final Inspection | 95% | Draw 7 |
| Certificate of Occupancy | CO received | 98% | - |
| Complete | Punch complete | 100% | Final Draw |

### 5.14.2 Progress Calculation

```typescript
function calculateProgress(lot: Lot): number {
  const completedTasks = lot.tasks.filter(t => t.status === 'complete');
  
  // Find highest milestone achieved
  const milestones = MILESTONES.sort((a, b) => b.pct - a.pct);
  
  for (const milestone of milestones) {
    const triggerTask = lot.tasks.find(t => t.name === milestone.task);
    if (triggerTask?.status === 'complete') {
      return milestone.pct;
    }
  }
  
  // If no milestone reached, calculate based on task count
  // (rough estimate)
  if (completedTasks.length > 0) {
    return Math.round((completedTasks.length / lot.tasks.length) * 
      MILESTONES[0].pct); // Up to first milestone
  }
  
  return 0;
}
```

### 5.14.3 Progress Visualization

**Lot Card:**
```
┌─────────────────────────────────────────┐
│  The Grove A-4                          │
│  ████████████████████░░░░░ 75%          │
│  ──●────●────●────●────●────○────○──    │
│   8%   20%  27%  45%  55%  75%  95%     │
│   FND  FRM  DRY  RGH  DRY  TRM  FIN     │
│                          ▲              │
│                     Current             │
│                                         │
│  Milestone: Trim Complete               │
│  Days Elapsed: 98 of 135                │
│  Status: ✅ On Track                    │
└─────────────────────────────────────────┘
```

---

## 5.15 Reporting & Analytics

### 5.15.1 Report Types

**1. Progress Report (Weekly)**
- All active lots
- Current milestone & % complete
- Days ahead/behind schedule
- Delays this week
- Photos from each lot

**2. Community Summary**
- Lots by status
- Average completion %
- Average build time
- On-time percentage
- Total delays

**3. Delay Analysis**
- Delays by reason (chart)
- Delays by sub (chart)
- Delays by community
- Trend over time

**4. Sub Performance**
- All subs ranked by rating
- On-time percentage
- Delay count
- Jobs completed

**5. Schedule Forecast**
- Projected completions
- Subs booked by week
- Capacity utilization

### 5.15.2 Export Formats

- **Excel (.xlsx)** - Full data, multiple sheets
- **PDF** - Formatted report with charts
- **CSV** - Raw data for custom analysis

### 5.15.3 Report Generation UI

```
┌─────────────────────────────────────────┐
│  Generate Report                    ✕   │
├─────────────────────────────────────────┤
│                                         │
│  Report Type:                           │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │Progress │ │Community│ │ Delay   │   │
│  │ Report  │ │ Summary │ │Analysis │   │
│  └─────────┘ └─────────┘ └─────────┘   │
│  ┌─────────┐ ┌─────────┐               │
│  │   Sub   │ │Schedule │               │
│  │  Perf.  │ │Forecast │               │
│  └─────────┘ └─────────┘               │
│                                         │
│  Date Range:                            │
│  [This Week ▼]                          │
│  From: [12/1/2024]  To: [12/7/2024]    │
│                                         │
│  Communities:                           │
│  [☑️ All] [☑️ The Grove] [☑️ Ovation]   │
│                                         │
│  Format:                                │
│  [● Excel] [○ PDF] [○ CSV]             │
│                                         │
│  Include:                               │
│  [☑️ Charts] [☑️ Photos] [☐ Comments]   │
│                                         │
│  [      Generate Report      ]          │
│                                         │
└─────────────────────────────────────────┘
```

### 5.15.4 Scheduled Reports

```typescript
interface ScheduledReport {
  id: UUID;
  report_type: ReportType;
  frequency: 'daily' | 'weekly' | 'monthly';
  day_of_week: number;        // 1 = Monday (for weekly)
  time: string;               // "7:00 AM"
  recipients: string[];       // Email addresses
  communities: UUID[] | 'all';
  format: 'excel' | 'pdf';
  include_photos: boolean;
  is_active: boolean;
}

// Example: Weekly progress report every Monday at 7 AM
{
  report_type: 'progress',
  frequency: 'weekly',
  day_of_week: 1,
  time: '7:00 AM',
  recipients: ['manager@abchomes.com', 'super@abchomes.com'],
  communities: 'all',
  format: 'excel',
  include_photos: true,
  is_active: true,
}
```

---

*[Continued in Part 3: Features 5.16-5.20, UI Specs, API Specs]*
