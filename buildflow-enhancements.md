BuildFlow Enhancement Plan - Final
Overview
Comprehensive enhancements to community creation, lot management, job starting, inspections, punch lists, and new features for sales/realtor views.
User Clarifications (Confirmed)
Product types: Customizable by admin (not fixed)
Plans: Customizable at admin level with presets for demo
Builder = Superintendent: Same role
Sales view: Filtered view within main app (not separate portal)
Agencies: Managed at both org level and community level
Inspections: Create sample data for demo
Gantt view: Standard - task name, duration, assigned sub, status color
Custom fields: Basic (2-3 text fields)
Implementation Phases
Phase 1: Data Model & Admin Settings (Foundation)
Files to modify:
src/data/seed.js - Add default product types, plans, agencies, templates
src/data/constants.js - Add builder colors, inspection types, sold statuses
src/data/template.js - Create 3 templates (Cottage 115d, Rancher 130d, Townhome 145d)
src/lib/storage.js - Add migration for existing data
New data structures:

// Product Types (admin customizable)
product_types: [
  { id: 'pt-cottage', name: 'Cottage', build_days: 115, template_id: '...', is_active: true },
  { id: 'pt-rancher', name: 'Rancher', build_days: 130, template_id: '...', is_active: true },
  { id: 'pt-townhome', name: 'Townhome', build_days: 145, template_id: '...', is_active: true }
]

// Plans (tied to product types)
plans: [
  { id: 'plan-oak', name: 'The Oak', product_type_id: 'pt-cottage', sq_ft: 1800 },
  { id: 'plan-spruce', name: 'The Spruce', product_type_id: 'pt-rancher', sq_ft: 2200 },
  // ... more plans
]

// Agencies (org + community level)
agencies: [
  { id: 'agency-1', name: 'City of Huntsville', inspection_types: [...], is_org_level: true }
]

// Multiple templates by product type
templates: [
  { id: 'template-cottage', product_type_id: 'pt-cottage', build_days: 115, tasks: [...] },
  { id: 'template-rancher', product_type_id: 'pt-rancher', build_days: 130, tasks: [...] },
  { id: 'template-townhome', product_type_id: 'pt-townhome', build_days: 145, tasks: [...] }
]
Admin Settings Panel (new tab in app):
Product Type Manager (CRUD)
Plan Manager (CRUD, filtered by product type)
Agency Manager (with inspection type assignments)
Custom Fields Manager (2-3 org-level text fields)
Phase 2: Community Creation Overhaul
Files to modify:
src/BuildFlow.jsx - Community creation wizard steps 1, 2, 4
Step 1 Changes:
Remove "default build days" field
Add multi-select for product types available in community
Step 2 Changes (Major):
Remove block/lot structure entirely
Simple lot count input (e.g., 50 lots = Lot 1-50)
Range selector UI for assigning product types to lots
Example: "Lots 1-10 = Cottage, Lots 11-20 = Rancher"
New utility function:

// src/lib/utils.js (new file)
export const parseRange = (rangeStr) => {
  // Parses "1-10, 15, 20-25" into [1,2,3,...10,15,20,21,...25]
}
Step 4 Changes:
Replace HOA contact with Realtors (multiple)
Multiple City Inspectors with Agency dropdown
Add Builders/Superintendents section:
Name, phone, email, color picker
Lot assignment via range input
Validation: all lots must be assigned to exactly one builder
Phase 3: Job Starting Updates
Files to modify:
src/BuildFlow.jsx - StartLotModal component
src/lib/scheduleEngine.js - Template selection logic
Changes:
Product type displayed (read-only, from community setup)
Plan dropdown filtered by lot's product type
Build Days Target NOT editable (auto from template)
Add Job Number field
Add Permit Number field (already exists, ensure visible)
Add 2-3 custom text fields (from org settings)
Phase 4: Community View Enhancements
Files to modify:
src/BuildFlow.jsx - Community detail view, lot grid
Builder Color-Coded Lots:
Legend showing builder → color mapping at top
Each lot card/tile colored by assigned builder
Visual distinction for quick identification
Community Contacts Quick Access:
Card showing all builders, realtors, inspectors
Quick edit functionality
Phone numbers as clickable links
Community Specs Improvements:
Bulk save multiple specs
Assign specs to product types or specific plans
Filter specs by applicability
Phase 5: Photo Gallery & Punch List Updates
Files to modify:
src/BuildFlow.jsx - Lot detail tabs, PunchListModal, AddPunchItemModal
Photo Gallery:
New "Photos" tab in lot detail view
Grid gallery layout
Add photo button with camera/upload options
Punch List:
Photo marked as optional (not required)
Camera button uses capture="environment" to auto-open device camera
Simple checkbox sign-off for completed items
Phase 6: Inspections Overhaul
Files to modify:
src/data/seed.js - Add sample inspection checklists
src/BuildFlow.jsx - Inspection components
Sample Inspection Data:

INSPECTION_CHECKLISTS: {
  PRE: [
    { id: 'pre-1', label: 'Footing depth per plan', required: true },
    { id: 'pre-2', label: 'Rebar placement correct', required: true }
  ],
  FND: [...],
  FRM: [...],
  // ... all inspection types
}
Inspection Checklist Modal:
Full checklist view for each inspection type
Click checkboxes to mark items complete
"Mark as Passed" button when all required items checked
Phase 7: Sales/Filtered View
Files to modify:
src/BuildFlow.jsx - New SalesView component, lot sold status
New lot fields:
sold_status: 'available' | 'pending' | 'sold'
sold_date: Date or null
Sales View Features:
Filter by community
Filter by product type
Filter by plan
Filter by sold status
Filter by completion date range (e.g., "finished by April")
Show count of available lots
Phase 8: Hybrid Schedule View (Calendar + Gantt)
Files to modify:
src/BuildFlow.jsx - Add HybridScheduleView component, toggle button
Hybrid View Component:
Calendar-style header: Day/week columns across the top (scrollable left-to-right)
Gantt task bars: Horizontal bars spanning across timeline
Overlapping tasks visible: Tasks that run concurrently shown stacked/overlapping
Task bar content: Name, duration, status color, assigned sub
Date markers: Weekly/daily column dividers
Scrollable: Horizontal scroll for full project timeline
Toggle: Switch between list view and hybrid view
Visual Layout:

         | Mon 1/6 | Tue 1/7 | Wed 1/8 | Thu 1/9 | Fri 1/10 | Mon 1/13 | ...
─────────┼─────────┼─────────┼─────────┼─────────┼──────────┼──────────┼────
Framing  |████████████████████████████████████████|          |          |
Roofing  |         |         |███████████████████████████████|          |
Electric |         |         |         |██████████████████████████████████
Plumbing |         |         |         |██████████████████████████████████
Phase 9: Summary Dashboard
Files to modify:
src/BuildFlow.jsx - Dashboard section
New Dashboard Cards:
Upcoming Inspections - Next 5 scheduled inspections
Critical Deadlines - Lots approaching hard deadline
At-a-Glance Stats:
Tasks scheduled today
Pending inspections
Delayed lots
Open punch items
Critical Files Summary
File	Changes
src/BuildFlow.jsx	All UI components (10,575 lines) - Admin panel, community wizard, lot view, Gantt view, sales view, dashboard
src/data/seed.js	Product types, plans, agencies, templates, inspection checklists
src/data/template.js	3 templates: Cottage (115d), Rancher (130d), Townhome (145d)
src/data/constants.js	Builder colors, inspection types, sold statuses
src/lib/scheduleEngine.js	Template selection by product type
src/lib/utils.js	NEW: Range parsing, validation helpers
src/lib/storage.js	Data migration for existing state
Implementation Order
Priority	Phase	Description
1	Phase 1	Data models & admin settings (foundation)
2	Phase 2	Community creation overhaul
3	Phase 3	Job starting updates
4	Phase 4	Community view (builder colors, contacts)
5	Phase 5	Photo gallery & punch list
6	Phase 6	Inspections with checklists
7	Phase 7	Sales/filtered view
8	Phase 8	Gantt schedule view
9	Phase 9	Summary dashboard
Key UI Patterns
Range Input for Lot Assignment:

Product Type: [Cottage    ] Lots: [1-10, 15, 20-25  ] (16 lots)
Product Type: [Rancher    ] Lots: [11-14, 16-19     ] (8 lots)
Builder Assignment with Color:

Builder: [John Smith  ] Color: [■] Lots: [1-25] Phone: [555-0001]
Builder: [Jane Doe    ] Color: [■] Lots: [26-50] Phone: [555-0002]
✓ All 50 lots assigned
Lot Grid with Builder Colors:

Legend: [■ John Smith] [■ Jane Doe]

[1] [2] [3] ... [10]   ← Blue-tinted (John)
[11][12][13]... [25]   ← Blue-tinted (John)
[26][27][28]... [50]   ← Green-tinted (Jane)
Ready for Implementation
This plan covers all 10 enhancement areas requested:
✅ Community Step 1 - Product types instead of build days
✅ Community Step 2 - Simple lot numbers with bulk product type assignment
✅ Community Step 4 - Realtors, inspectors, builders with lot assignments
✅ Job Starting - Plan dropdown, job number, read-only build days
✅ Photo Gallery - Per job gallery view
✅ Community View - Builder color coding, contacts access
✅ Community Specs - Bulk save, product type/plan assignment
✅ Inspections - Municipality-based checklists
✅ Sales View - Filter by completion date, sold status
✅ Punch List - Optional photo, camera integration, checkbox sign-off
✅ Gantt View - Horizontal timeline toggle
✅ Summary Dashboard - Upcoming inspections, critical deadlines
Stayed in plan mode
give full plan woth all context i have provided and your assessment and create a .md plan file
Write robust-coalescing-tulip.md
1600 lines
# BuildFlow Enhancement Plan - Complete Specification

## Project Overview

**BuildFlow** is a mobile-first construction scheduling and management platform for residential home builder superintendents. The current implementation is a React/Vite single-page application with a monolithic architecture (10,575 lines in BuildFlow.jsx).

**Current Tech Stack:**
- Frontend: React + Vite
- Styling: Tailwind CSS
- Icons: Lucide React
- Storage: LocalStorage + IndexedDB (local-first, offline-capable)
- Weather: Open-Meteo API

---

## Current Codebase Structure

```
src/
├── App.jsx                 # Entry point
├── BuildFlow.jsx          # Main application (10,575 lines)
├── lib/
│   ├── scheduleEngine.js  # Core scheduling algorithm
│   ├── storage.js         # LocalStorage persistence
│   ├── date.js            # Workday calculations
│   ├── idb.js             # IndexedDB for photos
│   ├── uuid.js            # UUID generation
│   └── templating.js      # Message templates
└── data/
    ├── constants.js       # Enums and configurations
    ├── seed.js            # Default org data and contractors
    └── template.js        # 135-day build template
```

---

## User Requirements Summary

### 1. Community Creation - Step 1 Changes
- **REMOVE**: Default build days field
- **ADD**: Multi-select for product types (Cottage, Rancher, Townhome)
- Product types must be **customizable by admin** (CRUD)

### 2. Community Creation - Step 2 Changes
- **REMOVE**: Block/lot structure (no more "Block A, Lot 1")
- **ADD**: Simple sequential lot numbers (Lot 1, 2, 3... 50)
- **ADD**: Bulk assignment of lots to product types using range selector
- Example: "Lots 1-10 = Cottage, Lots 11-20 = Rancher, Lots 21-50 = Townhome"
- UI must be intuitive and user-friendly

### 3. Community Creation - Step 4 Changes
- **REMOVE**: HOA contact
- **ADD**: Realtors (multiple allowed) with name, phone, email, company
- **ADD**: City Inspectors (multiple allowed) with Agency dropdown
- **ADD**: Agency dropdown (City of Huntsville, City of Madison, etc.)
  - Customizable at **both org level AND community level**
- **ADD**: Builders/Superintendents assigned to community
  - Name, phone, email, color (for visualization)
  - Assign specific lots to each builder via range input
  - **VALIDATION**: All lots must be assigned to exactly one builder

### 4. Job Starting Updates
- **Model Type**: Dropdown filtered by lot's pre-assigned product type
- **Plan Names**: Tied to product types (e.g., The Oak, Spruce, Cedar, Pine)
  - **Customizable by admin** with presets for demo
- **Build Days Target**: NOT editable - auto-set from product type template
- **ADD**: Job Number field
- **ADD**: Permit Number field
- **ADD**: 2-3 custom text fields (basic, admin-definable)
- **Product Type Templates**:
  - Cottage: 115 days
  - Rancher: 130 days
  - Townhome: 145 days
  - Each with similar but nuanced tasks

### 5. Photo Gallery
- Upload photos assigned to each job
- Gallery view accessible to office staff, builder, realtor
- Grid layout with thumbnails

### 6. Community View Enhancements
- **Color-code lots by builder** with legend at top
- **Quick access to all community contacts** (editable)
- Visual distinction for quick identification

### 7. Community Specs Improvements
- Bulk save multiple specs at once (not one at a time)
- Assign specs to **specific product types** or **specific plans**
- Intuitive UI for spec management

### 8. Inspections Overhaul
- Preload inspections based on **municipality/agency**
- Community-specific inspection checklists
- Full checklist from start to finish
- Simple click to mark as passed
- Sample data for demo purposes

### 9. Sales/Realtor Filtered View
- Mark lots as **sold/unsold/pending**
- Filter by expected completion date (e.g., "available by April")
- Filter by product type (Cottage, Rancher, Townhome)
- Filter by specific plan name
- Filtered view within main app (not separate portal for now)

### 10. Punch List Updates
- Photo is **optional** (not required)
- **In-app camera integration**: Auto-open camera, save directly
- Simple **checkbox sign-off** for completed items

### 11. Hybrid Schedule View (Calendar + Gantt)
- Horizontal timeline (scrollable left-to-right)
- Calendar-style header with day/week columns
- Gantt task bars spanning across timeline
- Overlapping/concurrent tasks visible
- Task bars show: name, duration, status color, assigned sub
- **Toggle** between list view and hybrid view

### 12. Summary Dashboard
- Upcoming inspections
- Critical deadlines (punch, milestones)
- At-a-glance important items

---

## User Clarifications (Confirmed)

| Question | Answer |
|----------|--------|
| Product types fixed or customizable? | **Customizable** by admin |
| Plan names structure? | **Customizable** at admin level with presets for demo |
| Builder vs Superintendent? | **Same role** (Builder = Superintendent) |
| Realtor/Sales portal? | **Filtered view** within main app (not separate login) |
| Agency management level? | **Both** org level and community level |
| Inspection data? | **Create sample data** for demo |
| Gantt view details? | **Standard** - task name, duration, sub, status color |
| Custom fields complexity? | **Basic** - 2-3 text fields |
| Schedule view style? | **Hybrid** - calendar header + Gantt bars |

---

## Data Model Changes

### New: Product Types (Admin Customizable)
```javascript
product_types: [
  {
    id: 'pt-cottage',
    name: 'Cottage',
    build_days: 115,
    template_id: 'template-cottage-115',
    sort_order: 1,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z'
  },
  {
    id: 'pt-rancher',
    name: 'Rancher',
    build_days: 130,
    template_id: 'template-rancher-130',
    sort_order: 2,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z'
  },
  {
    id: 'pt-townhome',
    name: 'Townhome',
    build_days: 145,
    template_id: 'template-townhome-145',
    sort_order: 3,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z'
  }
]
```

### New: Plans (Tied to Product Types)
```javascript
plans: [
  { id: 'plan-oak', name: 'The Oak', product_type_id: 'pt-cottage', sq_ft: 1400, bedrooms: 2, bathrooms: 2 },
  { id: 'plan-maple', name: 'The Maple', product_type_id: 'pt-cottage', sq_ft: 1600, bedrooms: 3, bathrooms: 2 },
  { id: 'plan-cedar', name: 'The Cedar', product_type_id: 'pt-rancher', sq_ft: 1800, bedrooms: 3, bathrooms: 2 },
  { id: 'plan-pine', name: 'The Pine', product_type_id: 'pt-rancher', sq_ft: 2200, bedrooms: 4, bathrooms: 3 },
  { id: 'plan-spruce', name: 'The Spruce', product_type_id: 'pt-townhome', sq_ft: 1600, bedrooms: 3, bathrooms: 2.5 },
  { id: 'plan-birch', name: 'The Birch', product_type_id: 'pt-townhome', sq_ft: 2000, bedrooms: 4, bathrooms: 3 }
]
```

### New: Agencies (Org + Community Level)
```javascript
agencies: [
  {
    id: 'agency-huntsville',
    name: 'City of Huntsville',
    type: 'municipality',
    inspection_types: ['PRE', 'FND', 'FRM', 'RME', 'INS', 'FIN', 'COO'],
    is_org_level: true,
    created_at: '2024-01-01T00:00:00Z'
  },
  {
    id: 'agency-madison',
    name: 'City of Madison',
    type: 'municipality',
    inspection_types: ['PRE', 'FND', 'FRM', 'REL', 'RPL', 'RHV', 'INS', 'FIN', 'COO'],
    is_org_level: true,
    created_at: '2024-01-01T00:00:00Z'
  }
]
```

### New: Multiple Templates by Product Type
```javascript
templates: [
  {
    id: 'template-cottage-115',
    name: 'Cottage Standard',
    product_type_id: 'pt-cottage',
    build_days: 115,
    tasks: [/* 115-day task sequence */]
  },
  {
    id: 'template-rancher-130',
    name: 'Rancher Standard',
    product_type_id: 'pt-rancher',
    build_days: 130,
    tasks: [/* 130-day task sequence */]
  },
  {
    id: 'template-townhome-145',
    name: 'Townhome Standard',
    product_type_id: 'pt-townhome',
    build_days: 145,
    tasks: [/* 145-day task sequence */]
  }
]
```

### New: Inspection Checklists
```javascript
inspection_checklists: {
  PRE: [
    { id: 'pre-1', label: 'Footing depth per plan', required: true },
    { id: 'pre-2', label: 'Rebar placement correct', required: true },
    { id: 'pre-3', label: 'Form boards in place', required: true },
    { id: 'pre-4', label: 'Soil compaction verified', required: false }
  ],
  FND: [
    { id: 'fnd-1', label: 'Foundation walls plumb', required: true },
    { id: 'fnd-2', label: 'Anchor bolts installed', required: true },
    { id: 'fnd-3', label: 'No visible cracks', required: true }
  ],
  FRM: [
    { id: 'frm-1', label: 'Wall framing per plan', required: true },
    { id: 'frm-2', label: 'Roof trusses secured', required: true },
    { id: 'frm-3', label: 'Sheathing complete', required: true },
    { id: 'frm-4', label: 'Window/door openings correct', required: true }
  ],
  // ... more inspection types
}
```

### Updated: Community Structure
```javascript
community: {
  id: 'comm-1',
  name: 'The Grove',
  address: '123 Main St, Huntsville, AL',

  // NEW: Product types enabled for this community
  product_types: ['pt-cottage', 'pt-rancher', 'pt-townhome'],

  // NEW: Simple lot count (replaces blocks)
  lot_count: 50,

  // NEW: Lot to product type mapping
  lots_by_product_type: {
    'pt-cottage': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    'pt-rancher': [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    'pt-townhome': [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]
  },

  // NEW: Builders/Superintendents with lot assignments
  builders: [
    {
      id: 'builder-1',
      name: 'John Smith',
      phone: '555-0001',
      email: 'john@builder.com',
      color: '#3B82F6',  // Blue
      assigned_lots: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]
    },
    {
      id: 'builder-2',
      name: 'Jane Doe',
      phone: '555-0002',
      email: 'jane@builder.com',
      color: '#22C55E',  // Green
      assigned_lots: [26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]
    }
  ],

  // NEW: Realtors (replaces HOA)
  realtors: [
    {
      id: 'realtor-1',
      name: 'Sarah Johnson',
      phone: '555-0010',
      email: 'sarah@realty.com',
      company: 'ABC Realty'
    }
  ],

  // NEW: City Inspectors with agency
  inspectors: [
    {
      id: 'inspector-1',
      name: 'Bob Wilson',
      phone: '555-0020',
      email: 'bob@city.gov',
      agency_id: 'agency-huntsville'
    }
  ],

  // NEW: Community-level agencies
  agencies: ['agency-huntsville'],

  // Existing
  specifications: [...],
  status: 'active',
  created_at: '2024-01-01T00:00:00Z'
}
```

### Updated: Lot Structure
```javascript
lot: {
  id: 'lot-1',
  community_id: 'comm-1',

  // CHANGED: Simple lot number (no block)
  lot_number: 5,

  // NEW: Pre-assigned from community setup
  product_type_id: 'pt-cottage',
  builder_id: 'builder-1',

  // NEW: Selected when job starts
  plan_id: 'plan-oak',

  // NEW: Additional fields
  job_number: 'JOB-2024-0005',
  permit_number: 'BP-2024-12345',

  // NEW: Custom fields
  custom_fields: {
    'custom_1': 'Value 1',
    'custom_2': 'Value 2',
    'custom_3': 'Value 3'
  },

  // NEW: Sold status
  sold_status: 'available',  // 'available' | 'pending' | 'sold'
  sold_date: null,

  // Existing
  address: '123 Oak Street',
  model_type: 'The Oak',
  status: 'in_progress',
  start_date: '2024-01-15',
  target_completion_date: '2024-05-10',
  build_days: 115,  // From template (not editable)
  tasks: [...],
  photos: [...],
  inspections: [...],
  punch_list: {...}
}
```

### Updated: Org Settings
```javascript
org: {
  // Existing
  builder_name: 'ABC Homes',
  phone: '555-1234',
  work_days: [1, 2, 3, 4, 5],
  holidays: [...],

  // NEW: Custom fields for job starting
  custom_fields: [
    { id: 'custom_1', label: 'Special Instructions', type: 'text' },
    { id: 'custom_2', label: 'Lot Notes', type: 'text' },
    { id: 'custom_3', label: 'Additional Info', type: 'text' }
  ]
}
```

---

## Implementation Phases

### Phase 1: Data Model & Admin Settings (Foundation)

**Files to modify:**
- `src/data/seed.js` - Add product_types, plans, agencies, templates, inspection_checklists
- `src/data/constants.js` - Add BUILDER_COLORS, SOLD_STATUSES, new inspection types
- `src/data/template.js` - Create 3 templates (Cottage 115d, Rancher 130d, Townhome 145d)
- `src/lib/storage.js` - Add data migration for existing state
- `src/lib/utils.js` - NEW: Range parsing, validation helpers
- `src/BuildFlow.jsx` - Add Admin Settings tab and panels

**Admin Settings Panel Components:**
1. **Product Type Manager** - Create, edit, delete, reorder product types
2. **Plan Manager** - Create, edit plans (filtered by product type)
3. **Agency Manager** - Manage agencies with inspection type assignments
4. **Custom Fields Manager** - Define 2-3 org-level text field labels

**New Utility Functions (src/lib/utils.js):**
```javascript
// Parse range string like "1-10, 15, 20-25" into array [1,2,3,...10,15,20,21,...25]
export const parseRange = (rangeStr) => {
  if (!rangeStr) return []
  const result = []
  const parts = rangeStr.split(',').map(s => s.trim())
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number)
      for (let i = start; i <= end; i++) result.push(i)
    } else if (part) {
      result.push(Number(part))
    }
  }
  return [...new Set(result)].filter(n => !isNaN(n)).sort((a, b) => a - b)
}

// Convert array back to range string
export const toRangeString = (numbers) => {
  if (!numbers.length) return ''
  const sorted = [...numbers].sort((a, b) => a - b)
  const ranges = []
  let start = sorted[0], end = sorted[0]

  for (let i = 1; i <= sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i]
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`)
      start = end = sorted[i]
    }
  }
  return ranges.join(', ')
}

// Validate all lots assigned to exactly one builder
export const validateBuilderAssignments = (builders, lotCount) => {
  const assigned = new Map()
  for (const builder of builders) {
    const lots = parseRange(builder.lotRange || '')
    for (const lot of lots) {
      if (lot < 1 || lot > lotCount) {
        return { valid: false, error: `Lot ${lot} is outside range 1-${lotCount}` }
      }
      if (assigned.has(lot)) {
        return { valid: false, error: `Lot ${lot} assigned to multiple builders` }
      }
      assigned.set(lot, builder.id)
    }
  }
  for (let i = 1; i <= lotCount; i++) {
    if (!assigned.has(i)) {
      return { valid: false, error: `Lot ${i} not assigned to any builder` }
    }
  }
  return { valid: true }
}
```

---

### Phase 2: Community Creation Overhaul

**Files to modify:**
- `src/BuildFlow.jsx` - Community creation wizard (Steps 1, 2, 4)

**Step 1 Changes:**
- Remove `build_days_default` input field
- Add product type multi-select checkboxes
```jsx
<div className="space-y-2">
  <p className="text-sm font-semibold">Product Types Available *</p>
  {app.product_types.filter(pt => pt.is_active).map(pt => (
    <label key={pt.id} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
      <input
        type="checkbox"
        checked={draft.product_types?.includes(pt.id)}
        onChange={(e) => toggleProductType(pt.id, e.target.checked)}
      />
      <span className="font-medium">{pt.name}</span>
      <span className="text-sm text-gray-500">({pt.build_days} days)</span>
    </label>
  ))}
</div>
```

**Step 2 Changes (Major Restructure):**
- Remove block start/end letter inputs
- Add simple lot count input
- Add product type range assignment UI
```jsx
<div className="space-y-4">
  <label className="block">
    <span className="text-sm font-semibold">Total Number of Lots *</span>
    <input
      type="number"
      min="1"
      value={draft.lot_count}
      onChange={(e) => setDraft(d => ({ ...d, lot_count: Number(e.target.value) }))}
      className="mt-1 w-full px-4 py-3 border rounded-xl"
      placeholder="50"
    />
  </label>

  <div className="bg-gray-50 p-4 rounded-xl">
    <p className="font-semibold mb-3">Assign Product Types to Lots</p>
    <p className="text-xs text-gray-600 mb-4">
      Enter lot ranges (e.g., "1-10" or "1-5, 8, 12-15")
    </p>

    {draft.product_types?.map(ptId => {
      const pt = app.product_types.find(p => p.id === ptId)
      const range = draft.productTypeRanges?.[ptId] || ''
      const count = parseRange(range).length

      return (
        <div key={ptId} className="flex items-center gap-3 mb-3">
          <span className="w-28 text-sm font-medium">{pt?.name}:</span>
          <input
            value={range}
            onChange={(e) => updateProductTypeRange(ptId, e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg text-sm"
            placeholder="e.g., 1-10, 15, 20-25"
          />
          <span className="text-xs text-gray-500 w-16">({count} lots)</span>
        </div>
      )
    })}

    <div className="mt-3 pt-3 border-t flex justify-between text-sm">
      <span>Total Assigned:</span>
      <span className={totalAssigned === draft.lot_count ? 'text-green-600' : 'text-red-600'}>
        {totalAssigned} / {draft.lot_count} lots
      </span>
    </div>
  </div>
</div>
```

**Step 4 Changes:**
- Remove HOA contact section
- Add Realtors section (multiple)
- Add City Inspectors with Agency dropdown (multiple)
- Add Builders/Superintendents with lot assignments
```jsx
{/* Realtors Section */}
<div className="space-y-3">
  <div className="flex items-center justify-between">
    <p className="font-semibold">Realtors</p>
    <button onClick={addRealtor} className="text-sm text-blue-600">+ Add Realtor</button>
  </div>
  {draft.realtors?.map((r, idx) => (
    <div key={idx} className="p-3 bg-gray-50 rounded-xl space-y-2">
      <div className="flex gap-2">
        <input placeholder="Name" value={r.name} onChange={...} className="flex-1" />
        <button onClick={() => removeRealtor(idx)} className="text-red-500">×</button>
      </div>
      <input placeholder="Phone" value={r.phone} onChange={...} />
      <input placeholder="Email" value={r.email} onChange={...} />
      <input placeholder="Company" value={r.company} onChange={...} />
    </div>
  ))}
</div>

{/* City Inspectors Section */}
<div className="space-y-3">
  <div className="flex items-center justify-between">
    <p className="font-semibold">City Inspectors</p>
    <button onClick={addInspector} className="text-sm text-blue-600">+ Add Inspector</button>
  </div>
  {draft.inspectors?.map((i, idx) => (
    <div key={idx} className="p-3 bg-gray-50 rounded-xl space-y-2">
      <div className="flex gap-2">
        <input placeholder="Name" value={i.name} onChange={...} className="flex-1" />
        <button onClick={() => removeInspector(idx)} className="text-red-500">×</button>
      </div>
      <input placeholder="Phone" value={i.phone} onChange={...} />
      <select value={i.agency_id} onChange={...}>
        <option value="">Select Agency...</option>
        {availableAgencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </div>
  ))}
</div>

{/* Builders/Superintendents Section */}
<div className="space-y-3">
  <div className="flex items-center justify-between">
    <p className="font-semibold">Builders/Superintendents</p>
    <button onClick={addBuilder} className="text-sm text-blue-600">+ Add Builder</button>
  </div>
  {draft.builders?.map((b, idx) => (
    <div key={idx} className="p-3 bg-gray-50 rounded-xl space-y-2">
      <div className="flex gap-2 items-center">
        <input placeholder="Name" value={b.name} onChange={...} className="flex-1" />
        <input type="color" value={b.color} onChange={...} className="w-10 h-10 rounded" />
        <button onClick={() => removeBuilder(idx)} className="text-red-500">×</button>
      </div>
      <input placeholder="Phone" value={b.phone} onChange={...} />
      <input placeholder="Email" value={b.email} onChange={...} />
      <label className="block">
        <span className="text-xs text-gray-600">Assigned Lots (e.g., "1-25")</span>
        <input
          placeholder="1-25"
          value={b.lotRange}
          onChange={...}
          className="w-full px-3 py-2 border rounded-lg"
        />
      </label>
    </div>
  ))}

  {/* Validation Message */}
  {builderValidation.valid ? (
    <p className="text-green-600 text-sm">✓ All {draft.lot_count} lots assigned</p>
  ) : (
    <p className="text-red-600 text-sm">⚠ {builderValidation.error}</p>
  )}
</div>
```

---

### Phase 3: Job Starting Updates

**Files to modify:**
- `src/BuildFlow.jsx` - StartLotModal component (~line 4528)
- `src/lib/scheduleEngine.js` - Template selection by product type

**StartLotModal Changes:**
```jsx
function StartLotModal({ app, org, prefill, onClose, onStart }) {
  // Get lot's pre-assigned product type from community setup
  const lot = app.lots.find(l => l.id === prefill?.lot_id)
  const community = app.communities.find(c => c.id === lot?.community_id)
  const productTypeId = lot?.product_type_id
  const productType = app.product_types.find(pt => pt.id === productTypeId)

  // Get template from product type (build_days is read-only)
  const template = app.templates.find(t => t.product_type_id === productTypeId)
  const buildDays = template?.build_days ?? productType?.build_days ?? 135

  // Filter plans by product type
  const availablePlans = app.plans.filter(p => p.product_type_id === productTypeId && p.is_active)

  const [form, setForm] = useState({
    start_date: '',
    plan_id: '',
    job_number: '',
    permit_number: '',
    address: '',
    hard_deadline: '',
    custom_1: '',
    custom_2: '',
    custom_3: ''
  })

  return (
    <Modal title={`Start Lot ${lot?.lot_number}`} onClose={onClose}>
      {/* Product Type (Read-Only) */}
      <div className="bg-blue-50 p-3 rounded-xl mb-4">
        <p className="text-xs text-blue-600">Product Type</p>
        <p className="font-semibold">{productType?.name ?? 'Not assigned'}</p>
        <p className="text-sm text-gray-600">{buildDays}-day build template</p>
      </div>

      {/* Plan Selection */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Plan *</span>
        <select
          value={form.plan_id}
          onChange={(e) => setForm(f => ({ ...f, plan_id: e.target.value }))}
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        >
          <option value="">Select plan...</option>
          {availablePlans.map(p => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.sq_ft} sq ft, {p.bedrooms}BR/{p.bathrooms}BA)
            </option>
          ))}
        </select>
      </label>

      {/* Start Date */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Start Date *</span>
        <input
          type="date"
          value={form.start_date}
          onChange={(e) => setForm(f => ({ ...f, start_date: e.target.value }))}
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        />
      </label>

      {/* Build Days (Read-Only) */}
      <div className="bg-gray-50 p-3 rounded-xl mb-3">
        <p className="text-xs text-gray-500">Build Days Target</p>
        <p className="font-semibold">{buildDays} days</p>
        <p className="text-xs text-gray-500">(From {productType?.name} template - not editable)</p>
      </div>

      {/* Job Number */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Job Number</span>
        <input
          value={form.job_number}
          onChange={(e) => setForm(f => ({ ...f, job_number: e.target.value }))}
          placeholder="JOB-2024-001"
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        />
      </label>

      {/* Permit Number */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Permit Number</span>
        <input
          value={form.permit_number}
          onChange={(e) => setForm(f => ({ ...f, permit_number: e.target.value }))}
          placeholder="BP-2024-12345"
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        />
      </label>

      {/* Address */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Address</span>
        <input
          value={form.address}
          onChange={(e) => setForm(f => ({ ...f, address: e.target.value }))}
          placeholder="123 Oak Street"
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        />
      </label>

      {/* Hard Deadline */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Hard Deadline (Optional)</span>
        <input
          type="date"
          value={form.hard_deadline}
          onChange={(e) => setForm(f => ({ ...f, hard_deadline: e.target.value }))}
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        />
      </label>

      {/* Custom Fields */}
      {org.custom_fields?.map(cf => (
        <label key={cf.id} className="block mb-3">
          <span className="text-sm font-semibold">{cf.label}</span>
          <input
            value={form[cf.id] || ''}
            onChange={(e) => setForm(f => ({ ...f, [cf.id]: e.target.value }))}
            className="mt-1 w-full px-4 py-3 border rounded-xl"
          />
        </label>
      ))}

      <button onClick={handleStart} className="w-full py-3 bg-blue-600 text-white rounded-xl font-semibold">
        Start Lot
      </button>
    </Modal>
  )
}
```

**scheduleEngine.js Changes:**
```javascript
// Update startLotFromTemplate to use product-type-specific template
export function startLotFromTemplate(lot, app, org) {
  // Find template by product type
  const template = app.templates.find(t => t.product_type_id === lot.product_type_id)
    || app.templates[0] // fallback

  const buildDays = template.build_days
  const tasks = buildLotTasksFromTemplate(template.tasks, lot.start_date, org, app.subcontractors)

  return {
    ...lot,
    build_days: buildDays,
    tasks,
    target_completion_date: calculateTargetCompletionDate(lot.start_date, buildDays, org)
  }
}
```

---

### Phase 4: Community View Enhancements

**Files to modify:**
- `src/BuildFlow.jsx` - Community detail view, lot grid

**Builder Color-Coded Lot Grid:**
```jsx
{/* Builder Legend */}
<div className="flex flex-wrap gap-3 mb-4 p-3 bg-gray-50 rounded-xl">
  <span className="text-sm font-semibold">Builders:</span>
  {selectedCommunity.builders?.map(b => (
    <div key={b.id} className="flex items-center gap-2">
      <div className="w-4 h-4 rounded" style={{ backgroundColor: b.color }} />
      <span className="text-sm">{b.name}</span>
    </div>
  ))}
</div>

{/* Lot Grid (No Blocks) */}
<div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 gap-2">
  {Array.from({ length: selectedCommunity.lot_count }, (_, i) => i + 1).map(lotNum => {
    const lot = lotsInCommunity.find(l => l.lot_number === lotNum)
    const builder = selectedCommunity.builders?.find(b =>
      parseRange(b.lotRange || b.assigned_lots?.join(',')).includes(lotNum)
    )
    const productType = app.product_types.find(pt => pt.id === lot?.product_type_id)

    const statusIcon = !lot ? '○'
      : lot.status === 'complete' ? '✓'
      : lot.status === 'in_progress' ? (lot.hasDelay ? '!' : '●')
      : '○'

    const statusColor = !lot ? 'text-gray-400'
      : lot.status === 'complete' ? 'text-green-600'
      : lot.status === 'in_progress' ? (lot.hasDelay ? 'text-yellow-600' : 'text-blue-600')
      : 'text-gray-400'

    return (
      <button
        key={lotNum}
        onClick={() => lot && openLot(lot.id)}
        className="p-2 rounded-xl border-2 text-center transition-all hover:shadow-md"
        style={{
          backgroundColor: builder ? `${builder.color}15` : '#f9fafb',
          borderColor: builder?.color || '#e5e7eb'
        }}
      >
        <p className="font-bold text-sm">{lotNum}</p>
        <p className={`text-lg ${statusColor}`}>{statusIcon}</p>
        {productType && <p className="text-[10px] text-gray-500 truncate">{productType.name}</p>}
      </button>
    )
  })}
</div>
```

**Community Contacts Quick Access Card:**
```jsx
<Card className="mb-4">
  <div className="flex items-center justify-between mb-3">
    <h3 className="font-semibold">Community Contacts</h3>
    <button onClick={() => setEditingContacts(true)} className="text-sm text-blue-600">Edit</button>
  </div>

  {/* Builders */}
  <div className="mb-3">
    <p className="text-xs font-semibold text-gray-500 mb-1">BUILDERS</p>
    {selectedCommunity.builders?.map(b => (
      <div key={b.id} className="flex items-center justify-between py-1">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded" style={{ backgroundColor: b.color }} />
          <span className="text-sm">{b.name}</span>
        </div>
        <a href={`tel:${b.phone}`} className="text-blue-600 text-sm">{b.phone}</a>
      </div>
    ))}
  </div>

  {/* Realtors */}
  <div className="mb-3">
    <p className="text-xs font-semibold text-gray-500 mb-1">REALTORS</p>
    {selectedCommunity.realtors?.map(r => (
      <div key={r.id} className="flex items-center justify-between py-1">
        <span className="text-sm">{r.name} <span className="text-gray-500">({r.company})</span></span>
        <a href={`tel:${r.phone}`} className="text-blue-600 text-sm">{r.phone}</a>
      </div>
    ))}
  </div>

  {/* Inspectors */}
  <div>
    <p className="text-xs font-semibold text-gray-500 mb-1">INSPECTORS</p>
    {selectedCommunity.inspectors?.map(i => {
      const agency = [...app.agencies, ...(selectedCommunity.agencies || [])].find(a => a.id === i.agency_id)
      return (
        <div key={i.id} className="flex items-center justify-between py-1">
          <span className="text-sm">{i.name} <span className="text-gray-500">({agency?.name})</span></span>
          <a href={`tel:${i.phone}`} className="text-blue-600 text-sm">{i.phone}</a>
        </div>
      )
    })}
  </div>
</Card>
```

**Community Specs with Product Type/Plan Assignment:**
```jsx
{/* When editing a spec, add targeting options */}
<label className="block mb-3">
  <span className="text-sm font-semibold">Applies To</span>
  <select value={specDraft.applies_to} onChange={...}>
    <option value="all">All Lots in Community</option>
    <option value="product_type">Specific Product Type</option>
    <option value="plan">Specific Plan</option>
  </select>
</label>

{specDraft.applies_to === 'product_type' && (
  <select value={specDraft.product_type_id} onChange={...}>
    <option value="">Select product type...</option>
    {selectedCommunity.product_types.map(ptId => {
      const pt = app.product_types.find(p => p.id === ptId)
      return <option key={ptId} value={ptId}>{pt?.name}</option>
    })}
  </select>
)}

{specDraft.applies_to === 'plan' && (
  <select value={specDraft.plan_id} onChange={...}>
    <option value="">Select plan...</option>
    {app.plans.filter(p => selectedCommunity.product_types.includes(p.product_type_id)).map(p => (
      <option key={p.id} value={p.id}>{p.name}</option>
    ))}
  </select>
)}
```

---

### Phase 5: Photo Gallery & Punch List Updates

**Files to modify:**
- `src/BuildFlow.jsx` - Lot detail tabs, photo gallery, punch list modals

**Photo Gallery Tab:**
```jsx
{/* Add Photos tab to lot detail */}
<button
  onClick={() => setLotDetailTab('photos')}
  className={`px-4 py-2 rounded-lg text-sm font-medium ${
    lotDetailTab === 'photos' ? 'bg-blue-100 text-blue-700' : 'text-gray-600'
  }`}
>
  Photos ({(selectedLot.photos || []).length})
</button>

{lotDetailTab === 'photos' && (
  <div className="space-y-4">
    <div className="flex justify-between items-center">
      <h3 className="font-semibold">Photo Gallery</h3>
      <button
        onClick={() => setAddPhotoModal({ lot_id: selectedLot.id })}
        className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium"
      >
        + Add Photo
      </button>
    </div>

    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
      {(selectedLot.photos || []).map(photo => (
        <div
          key={photo.id}
          onClick={() => setViewingPhoto(photo)}
          className="relative aspect-square rounded-xl overflow-hidden cursor-pointer hover:opacity-90"
        >
          <PhotoThumb blobId={photo.blob_id} className="w-full h-full object-cover" />
          <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs p-1">
            {formatShortDate(photo.taken_at)}
          </div>
        </div>
      ))}
    </div>

    {(selectedLot.photos || []).length === 0 && (
      <p className="text-center text-gray-500 py-8">No photos yet</p>
    )}
  </div>
)}
```

**Punch List with Optional Photo & Camera Integration:**
```jsx
function AddPunchItemModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ description: '', location: '', category: '', sub_id: '' })
  const [photoFile, setPhotoFile] = useState(null)
  const [photoPreview, setPhotoPreview] = useState(null)
  const cameraInputRef = useRef(null)
  const fileInputRef = useRef(null)

  const handleCameraCapture = () => {
    cameraInputRef.current?.click()
  }

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      setPhotoFile(file)
      setPhotoPreview(URL.createObjectURL(file))
    }
  }

  return (
    <Modal title="Add Punch Item" onClose={onClose}>
      {/* Description */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Description *</span>
        <input
          value={form.description}
          onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
          className="mt-1 w-full px-4 py-3 border rounded-xl"
          placeholder="Describe the issue..."
        />
      </label>

      {/* Location */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Location</span>
        <input
          value={form.location}
          onChange={(e) => setForm(f => ({ ...f, location: e.target.value }))}
          className="mt-1 w-full px-4 py-3 border rounded-xl"
          placeholder="e.g., Master Bedroom, North Wall"
        />
      </label>

      {/* Category & Sub dropdowns... */}

      {/* Photo (Optional) */}
      <div className="mb-3">
        <p className="text-sm font-semibold mb-2">Photo <span className="text-gray-400">(Optional)</span></p>

        {photoPreview ? (
          <div className="relative">
            <img src={photoPreview} alt="Preview" className="w-full h-40 object-cover rounded-xl" />
            <button
              onClick={() => { setPhotoFile(null); setPhotoPreview(null) }}
              className="absolute top-2 right-2 w-8 h-8 bg-red-500 text-white rounded-full"
            >
              ×
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={handleCameraCapture}
              className="flex-1 py-3 bg-blue-50 text-blue-700 rounded-xl font-medium border border-blue-200"
            >
              📷 Take Photo
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex-1 py-3 bg-gray-50 text-gray-700 rounded-xl font-medium border border-gray-200"
            >
              📁 Choose File
            </button>
          </div>
        )}

        {/* Hidden inputs */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileSelect}
          className="hidden"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      <button
        onClick={() => onCreate({ ...form, photo: photoFile })}
        disabled={!form.description}
        className="w-full py-3 bg-blue-600 text-white rounded-xl font-semibold disabled:opacity-50"
      >
        Add Item
      </button>
    </Modal>
  )
}
```

**Punch List Simple Checkbox Sign-Off:**
```jsx
{/* In punch list view */}
{punchItems.map(item => (
  <div key={item.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
    <input
      type="checkbox"
      checked={item.status === 'closed' || item.status === 'verified'}
      onChange={(e) => {
        const newStatus = e.target.checked ? 'closed' : 'open'
        updatePunchItem(item.id, { status: newStatus })
      }}
      className="w-6 h-6 mt-1 rounded"
    />
    <div className="flex-1">
      <p className={`font-medium ${item.status === 'closed' ? 'line-through text-gray-400' : ''}`}>
        {item.description}
      </p>
      {item.location && <p className="text-sm text-gray-500">{item.location}</p>}
    </div>
  </div>
))}
```

---

### Phase 6: Inspections Overhaul

**Files to modify:**
- `src/data/seed.js` - Add inspection checklists
- `src/BuildFlow.jsx` - Inspection checklist modal

**Inspection Checklist Modal:**
```jsx
function InspectionChecklistModal({ inspection, lot, onClose, onPass }) {
  const agency = app.agencies.find(a => a.id === lot.agency_id)
  const checklist = INSPECTION_CHECKLISTS[inspection.type] || []
  const [checked, setChecked] = useState({})

  const requiredItems = checklist.filter(c => c.required)
  const allRequiredChecked = requiredItems.every(c => checked[c.id])

  const handleToggle = (itemId) => {
    setChecked(prev => ({ ...prev, [itemId]: !prev[itemId] }))
  }

  const handleMarkPassed = () => {
    onPass(inspection.id, {
      result: 'pass',
      checklist_completed: checked,
      passed_at: new Date().toISOString()
    })
    onClose()
  }

  return (
    <Modal title={`${inspection.type} Inspection Checklist`} onClose={onClose}>
      <p className="text-sm text-gray-600 mb-4">
        Lot {lot.lot_number} • {agency?.name || 'Unknown Agency'}
      </p>

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {checklist.map(item => (
          <label
            key={item.id}
            className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer ${
              checked[item.id] ? 'bg-green-50' : 'bg-gray-50'
            }`}
          >
            <input
              type="checkbox"
              checked={checked[item.id] || false}
              onChange={() => handleToggle(item.id)}
              className="w-5 h-5 rounded"
            />
            <span className={checked[item.id] ? 'text-green-700' : ''}>
              {item.label}
            </span>
            {item.required && (
              <span className="text-xs text-red-500 ml-auto">Required</span>
            )}
          </label>
        ))}
      </div>

      <div className="mt-4 pt-4 border-t">
        <p className="text-sm text-gray-600 mb-3">
          {Object.values(checked).filter(Boolean).length} / {checklist.length} items checked
          {!allRequiredChecked && (
            <span className="text-red-500 ml-2">(all required items must be checked)</span>
          )}
        </p>

        <button
          onClick={handleMarkPassed}
          disabled={!allRequiredChecked}
          className="w-full py-3 bg-green-600 text-white rounded-xl font-semibold disabled:opacity-50 disabled:bg-gray-400"
        >
          ✓ Mark Inspection as Passed
        </button>
      </div>
    </Modal>
  )
}
```

---

### Phase 7: Sales/Filtered View

**Files to modify:**
- `src/BuildFlow.jsx` - Add SalesView component, sold status management

**Sales View Component:**
```jsx
function SalesView({ app }) {
  const [filters, setFilters] = useState({
    community_id: 'all',
    product_type_id: 'all',
    plan_id: 'all',
    sold_status: 'all',
    completion_by: ''
  })

  const filteredLots = useMemo(() => {
    return app.lots.filter(lot => {
      if (filters.community_id !== 'all' && lot.community_id !== filters.community_id) return false
      if (filters.product_type_id !== 'all' && lot.product_type_id !== filters.product_type_id) return false
      if (filters.plan_id !== 'all' && lot.plan_id !== filters.plan_id) return false
      if (filters.sold_status !== 'all' && lot.sold_status !== filters.sold_status) return false
      if (filters.completion_by && lot.target_completion_date > filters.completion_by) return false
      return true
    })
  }, [app.lots, filters])

  const availableCount = filteredLots.filter(l => l.sold_status === 'available').length

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Sales View</h2>

      {/* Filters */}
      <Card>
        <p className="font-semibold mb-3">Filters</p>
        <div className="grid grid-cols-2 gap-3">
          <select
            value={filters.community_id}
            onChange={(e) => setFilters(f => ({ ...f, community_id: e.target.value }))}
            className="px-3 py-2 border rounded-lg"
          >
            <option value="all">All Communities</option>
            {app.communities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <select
            value={filters.product_type_id}
            onChange={(e) => setFilters(f => ({ ...f, product_type_id: e.target.value }))}
            className="px-3 py-2 border rounded-lg"
          >
            <option value="all">All Product Types</option>
            {app.product_types.map(pt => <option key={pt.id} value={pt.id}>{pt.name}</option>)}
          </select>

          <select
            value={filters.plan_id}
            onChange={(e) => setFilters(f => ({ ...f, plan_id: e.target.value }))}
            className="px-3 py-2 border rounded-lg"
          >
            <option value="all">All Plans</option>
            {app.plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <select
            value={filters.sold_status}
            onChange={(e) => setFilters(f => ({ ...f, sold_status: e.target.value }))}
            className="px-3 py-2 border rounded-lg"
          >
            <option value="all">All Statuses</option>
            <option value="available">Available</option>
            <option value="pending">Pending</option>
            <option value="sold">Sold</option>
          </select>

          <div className="col-span-2">
            <label className="text-sm text-gray-600">Available by date:</label>
            <input
              type="date"
              value={filters.completion_by}
              onChange={(e) => setFilters(f => ({ ...f, completion_by: e.target.value }))}
              className="w-full px-3 py-2 border rounded-lg mt-1"
            />
          </div>
        </div>
      </Card>

      {/* Results Summary */}
      <div className="bg-green-50 p-4 rounded-xl">
        <p className="text-2xl font-bold text-green-700">{availableCount}</p>
        <p className="text-sm text-green-600">Available lots matching filters</p>
      </div>

      {/* Lot Cards */}
      <div className="space-y-3">
        {filteredLots.map(lot => {
          const community = app.communities.find(c => c.id === lot.community_id)
          const productType = app.product_types.find(pt => pt.id === lot.product_type_id)
          const plan = app.plans.find(p => p.id === lot.plan_id)

          return (
            <Card key={lot.id}>
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-bold">{community?.name} - Lot {lot.lot_number}</p>
                  <p className="text-sm text-gray-600">{productType?.name} • {plan?.name || 'No plan'}</p>
                  <p className="text-sm text-gray-500">{lot.address || 'No address'}</p>
                  {lot.target_completion_date && (
                    <p className="text-sm text-blue-600">
                      Est. completion: {formatShortDate(lot.target_completion_date)}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                    lot.sold_status === 'available' ? 'bg-green-100 text-green-700' :
                    lot.sold_status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {lot.sold_status || 'Available'}
                  </span>
                  <div className="mt-2">
                    <select
                      value={lot.sold_status || 'available'}
                      onChange={(e) => updateLotSoldStatus(lot.id, e.target.value)}
                      className="text-sm px-2 py-1 border rounded"
                    >
                      <option value="available">Available</option>
                      <option value="pending">Pending</option>
                      <option value="sold">Sold</option>
                    </select>
                  </div>
                </div>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
```

---

### Phase 8: Hybrid Schedule View (Calendar + Gantt)

**Files to modify:**
- `src/BuildFlow.jsx` - Add HybridScheduleView component

**Hybrid Schedule View Component:**
```jsx
function HybridScheduleView({ lot, subcontractors }) {
  const tasks = (lot.tasks || []).slice().sort((a, b) =>
    (a.scheduled_start || '').localeCompare(b.scheduled_start || '')
  )

  // Calculate date range
  const allDates = tasks.flatMap(t => [t.scheduled_start, t.scheduled_end]).filter(Boolean)
  const minDate = allDates.length ? parseISODate(allDates.sort()[0]) : new Date()
  const maxDate = allDates.length ? parseISODate(allDates.sort().reverse()[0]) : addCalendarDays(new Date(), 60)
  const totalDays = daysBetweenCalendar(maxDate, minDate) + 1

  // Generate week columns
  const weeks = []
  let currentDate = new Date(minDate)
  while (currentDate <= maxDate) {
    weeks.push(new Date(currentDate))
    currentDate = addCalendarDays(currentDate, 7)
  }

  const STATUS_COLORS = {
    complete: '#22C55E',
    in_progress: '#3B82F6',
    delayed: '#EF4444',
    blocked: '#F97316',
    ready: '#8B5CF6',
    pending: '#D1D5DB'
  }

  return (
    <div className="overflow-x-auto border rounded-xl">
      <div style={{ minWidth: `${Math.max(800, weeks.length * 100)}px` }}>
        {/* Calendar Header */}
        <div className="flex border-b bg-gray-50 sticky top-0">
          <div className="w-48 shrink-0 p-3 font-semibold border-r">Task</div>
          <div className="flex-1 flex">
            {weeks.map((week, i) => (
              <div
                key={i}
                className="flex-1 p-2 text-center text-sm font-medium border-r last:border-r-0"
                style={{ minWidth: '100px' }}
              >
                {formatShortDate(week)}
              </div>
            ))}
          </div>
        </div>

        {/* Task Rows */}
        {tasks.map(task => {
          const sub = subcontractors.find(s => s.id === task.sub_id)
          const status = deriveTaskStatus(task, lot.tasks, lot.inspections)

          const startDate = parseISODate(task.scheduled_start)
          const endDate = parseISODate(task.scheduled_end)
          const startOffset = daysBetweenCalendar(startDate, minDate)
          const duration = daysBetweenCalendar(endDate, startDate) + 1

          const leftPercent = (startOffset / totalDays) * 100
          const widthPercent = (duration / totalDays) * 100

          return (
            <div key={task.id} className="flex border-b hover:bg-gray-50">
              {/* Task Name Column */}
              <div className="w-48 shrink-0 p-2 border-r">
                <p className="text-sm font-medium truncate">{task.name}</p>
                <p className="text-xs text-gray-500 truncate">{sub?.company_name || '—'}</p>
              </div>

              {/* Gantt Bar Area */}
              <div className="flex-1 relative h-14">
                {/* Week grid lines */}
                {weeks.map((_, i) => (
                  <div
                    key={i}
                    className="absolute top-0 bottom-0 border-r border-gray-100"
                    style={{ left: `${((i + 1) / weeks.length) * 100}%` }}
                  />
                ))}

                {/* Task Bar */}
                <div
                  className="absolute top-2 h-10 rounded-lg flex items-center px-2 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
                  style={{
                    left: `${leftPercent}%`,
                    width: `${Math.max(widthPercent, 3)}%`,
                    backgroundColor: STATUS_COLORS[status] || STATUS_COLORS.pending
                  }}
                  title={`${task.name}\n${formatShortDate(startDate)} - ${formatShortDate(endDate)}\n${duration} days`}
                >
                  <span className="text-xs text-white font-medium truncate">
                    {task.name} ({duration}d)
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

{/* Toggle in lot detail view */}
<div className="flex gap-2 mb-4">
  <button
    onClick={() => setScheduleView('list')}
    className={`px-4 py-2 rounded-lg text-sm font-medium ${
      scheduleView === 'list' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100'
    }`}
  >
    List View
  </button>
  <button
    onClick={() => setScheduleView('gantt')}
    className={`px-4 py-2 rounded-lg text-sm font-medium ${
      scheduleView === 'gantt' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100'
    }`}
  >
    Timeline View
  </button>
</div>
```

---

### Phase 9: Summary Dashboard

**Files to modify:**
- `src/BuildFlow.jsx` - Dashboard section enhancements

**Dashboard Summary Cards:**
```jsx
{/* Upcoming Inspections */}
<Card>
  <h3 className="font-semibold mb-3">Upcoming Inspections</h3>
  {upcomingInspections.slice(0, 5).map(({ lot, inspection, community }) => (
    <button
      key={inspection.id}
      onClick={() => openLot(lot.id)}
      className="w-full p-3 bg-gray-50 rounded-xl mb-2 text-left hover:bg-gray-100"
    >
      <div className="flex justify-between items-center">
        <span className="font-medium">{inspection.type}</span>
        <span className="text-sm text-gray-600">{formatShortDate(inspection.scheduled_date)}</span>
      </div>
      <p className="text-sm text-gray-500">{community?.name} - Lot {lot.lot_number}</p>
    </button>
  ))}
  {upcomingInspections.length === 0 && (
    <p className="text-gray-500 text-center py-4">No upcoming inspections</p>
  )}
</Card>

{/* Critical Deadlines */}
<Card>
  <h3 className="font-semibold mb-3">Critical Deadlines</h3>
  {criticalDeadlines.slice(0, 5).map(({ lot, daysRemaining, community }) => (
    <button
      key={lot.id}
      onClick={() => openLot(lot.id)}
      className={`w-full p-3 rounded-xl mb-2 text-left ${
        daysRemaining <= 7 ? 'bg-red-50' : daysRemaining <= 14 ? 'bg-yellow-50' : 'bg-gray-50'
      }`}
    >
      <div className="flex justify-between items-center">
        <span className="font-medium">{community?.name} - Lot {lot.lot_number}</span>
        <span className={`text-sm font-bold ${
          daysRemaining <= 7 ? 'text-red-600' : daysRemaining <= 14 ? 'text-yellow-600' : 'text-gray-600'
        }`}>
          {daysRemaining} days
        </span>
      </div>
      <p className="text-sm text-gray-500">
        {lot.model_type} • Target: {formatShortDate(lot.hard_deadline || lot.target_completion_date)}
      </p>
    </button>
  ))}
</Card>

{/* At-a-Glance Stats */}
<Card>
  <h3 className="font-semibold mb-3">At a Glance</h3>
  <div className="grid grid-cols-2 gap-3">
    <div className="p-4 bg-blue-50 rounded-xl text-center">
      <p className="text-3xl font-bold text-blue-600">{todaysTasks.length}</p>
      <p className="text-sm text-gray-600">Tasks Today</p>
    </div>
    <div className="p-4 bg-orange-50 rounded-xl text-center">
      <p className="text-3xl font-bold text-orange-600">{pendingInspections.length}</p>
      <p className="text-sm text-gray-600">Pending Inspections</p>
    </div>
    <div className="p-4 bg-red-50 rounded-xl text-center">
      <p className="text-3xl font-bold text-red-600">{delayedLots.length}</p>
      <p className="text-sm text-gray-600">Delayed Lots</p>
    </div>
    <div className="p-4 bg-purple-50 rounded-xl text-center">
      <p className="text-3xl font-bold text-purple-600">{openPunchItems}</p>
      <p className="text-sm text-gray-600">Open Punch Items</p>
    </div>
  </div>
</Card>
```

---

## Files to Modify Summary

| File | Changes |
|------|---------|
| `src/BuildFlow.jsx` | Admin panel, community wizard, lot grid, job starting, photo gallery, punch list, inspections, sales view, Gantt view, dashboard |
| `src/data/seed.js` | product_types, plans, agencies, templates, inspection_checklists, updated community/lot structures |
| `src/data/template.js` | 3 templates: Cottage (115d), Rancher (130d), Townhome (145d) with nuanced tasks |
| `src/data/constants.js` | BUILDER_COLORS, SOLD_STATUSES, INSPECTION_TYPES |
| `src/lib/scheduleEngine.js` | Template selection by product type |
| `src/lib/utils.js` | NEW: parseRange, toRangeString, validateBuilderAssignments |
| `src/lib/storage.js` | Data migration for existing state |

---

## Implementation Priority Order

| Phase | Priority | Description |
|-------|----------|-------------|
| 1 | Critical | Data models, admin settings, product types, templates |
| 2 | Critical | Community creation overhaul (no blocks, builders, realtors) |
| 3 | High | Job starting updates (plan dropdown, read-only build days) |
| 4 | High | Community view (builder colors, contacts) |
| 5 | Medium | Photo gallery, punch list camera integration |
| 6 | Medium | Inspections with municipality checklists |
| 7 | Medium | Sales/filtered view |
| 8 | Medium | Hybrid schedule view (Gantt) |
| 9 | Low | Summary dashboard enhancements |

---

## Ready for Implementation

All requirements captured and detailed. Proceed with Phase 1 (Data Models & Admin Settings) first as it establishes the foundation for all other features.
I've created the comprehensive plan file at /Users/bradencarlson/.claude/plans/robust-coalescing-tulip.md with: Complete documentation including:
Project overview and current codebase structure
All 12 user requirements with detailed specifications
User clarifications confirmed
Complete data model changes with code examples
9 implementation phases with JSX/JavaScript code snippets
File modification summary
Implementation priority order
The plan covers:
Community creation overhaul (product types, simple lots, builders, realtors)
Job starting with plan dropdown and read-only build days
Photo gallery per job
Builder color-coded lot grid with legend
Community specs with product type/plan targeting
Municipality-based inspection checklists
Sales/realtor filtered view
Hybrid Gantt schedule view
Summary dashboard with critical deadlines
Ready to proceed with implementation when you approve!
Claude’s Plan
BuildFlow Enhancement Plan - Complete Specification
Project Overview
BuildFlow is a mobile-first construction scheduling and management platform for residential home builder superintendents. The current implementation is a React/Vite single-page application with a monolithic architecture (10,575 lines in BuildFlow.jsx). Current Tech Stack:
Frontend: React + Vite
Styling: Tailwind CSS
Icons: Lucide React
Storage: LocalStorage + IndexedDB (local-first, offline-capable)
Weather: Open-Meteo API
Current Codebase Structure

src/
├── App.jsx                 # Entry point
├── BuildFlow.jsx          # Main application (10,575 lines)
├── lib/
│   ├── scheduleEngine.js  # Core scheduling algorithm
│   ├── storage.js         # LocalStorage persistence
│   ├── date.js            # Workday calculations
│   ├── idb.js             # IndexedDB for photos
│   ├── uuid.js            # UUID generation
│   └── templating.js      # Message templates
└── data/
    ├── constants.js       # Enums and configurations
    ├── seed.js            # Default org data and contractors
    └── template.js        # 135-day build template
User Requirements Summary
1. Community Creation - Step 1 Changes
REMOVE: Default build days field
ADD: Multi-select for product types (Cottage, Rancher, Townhome)
Product types must be customizable by admin (CRUD)
2. Community Creation - Step 2 Changes
REMOVE: Block/lot structure (no more "Block A, Lot 1")
ADD: Simple sequential lot numbers (Lot 1, 2, 3... 50)
ADD: Bulk assignment of lots to product types using range selector
Example: "Lots 1-10 = Cottage, Lots 11-20 = Rancher, Lots 21-50 = Townhome"
UI must be intuitive and user-friendly
3. Community Creation - Step 4 Changes
REMOVE: HOA contact
ADD: Realtors (multiple allowed) with name, phone, email, company
ADD: City Inspectors (multiple allowed) with Agency dropdown
ADD: Agency dropdown (City of Huntsville, City of Madison, etc.)
Customizable at both org level AND community level
ADD: Builders/Superintendents assigned to community
Name, phone, email, color (for visualization)
Assign specific lots to each builder via range input
VALIDATION: All lots must be assigned to exactly one builder
4. Job Starting Updates
Model Type: Dropdown filtered by lot's pre-assigned product type
Plan Names: Tied to product types (e.g., The Oak, Spruce, Cedar, Pine)
Customizable by admin with presets for demo
Build Days Target: NOT editable - auto-set from product type template
ADD: Job Number field
ADD: Permit Number field
ADD: 2-3 custom text fields (basic, admin-definable)
Product Type Templates:
Cottage: 115 days
Rancher: 130 days
Townhome: 145 days
Each with similar but nuanced tasks
5. Photo Gallery
Upload photos assigned to each job
Gallery view accessible to office staff, builder, realtor
Grid layout with thumbnails
6. Community View Enhancements
Color-code lots by builder with legend at top
Quick access to all community contacts (editable)
Visual distinction for quick identification
7. Community Specs Improvements
Bulk save multiple specs at once (not one at a time)
Assign specs to specific product types or specific plans
Intuitive UI for spec management
8. Inspections Overhaul
Preload inspections based on municipality/agency
Community-specific inspection checklists
Full checklist from start to finish
Simple click to mark as passed
Sample data for demo purposes
9. Sales/Realtor Filtered View
Mark lots as sold/unsold/pending
Filter by expected completion date (e.g., "available by April")
Filter by product type (Cottage, Rancher, Townhome)
Filter by specific plan name
Filtered view within main app (not separate portal for now)
10. Punch List Updates
Photo is optional (not required)
In-app camera integration: Auto-open camera, save directly
Simple checkbox sign-off for completed items
11. Hybrid Schedule View (Calendar + Gantt)
Horizontal timeline (scrollable left-to-right)
Calendar-style header with day/week columns
Gantt task bars spanning across timeline
Overlapping/concurrent tasks visible
Task bars show: name, duration, status color, assigned sub
Toggle between list view and hybrid view
12. Summary Dashboard
Upcoming inspections
Critical deadlines (punch, milestones)
At-a-glance important items
User Clarifications (Confirmed)
Question	Answer
Product types fixed or customizable?	Customizable by admin
Plan names structure?	Customizable at admin level with presets for demo
Builder vs Superintendent?	Same role (Builder = Superintendent)
Realtor/Sales portal?	Filtered view within main app (not separate login)
Agency management level?	Both org level and community level
Inspection data?	Create sample data for demo
Gantt view details?	Standard - task name, duration, sub, status color
Custom fields complexity?	Basic - 2-3 text fields
Schedule view style?	Hybrid - calendar header + Gantt bars
Data Model Changes
New: Product Types (Admin Customizable)

product_types: [
  {
    id: 'pt-cottage',
    name: 'Cottage',
    build_days: 115,
    template_id: 'template-cottage-115',
    sort_order: 1,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z'
  },
  {
    id: 'pt-rancher',
    name: 'Rancher',
    build_days: 130,
    template_id: 'template-rancher-130',
    sort_order: 2,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z'
  },
  {
    id: 'pt-townhome',
    name: 'Townhome',
    build_days: 145,
    template_id: 'template-townhome-145',
    sort_order: 3,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z'
  }
]
New: Plans (Tied to Product Types)

plans: [
  { id: 'plan-oak', name: 'The Oak', product_type_id: 'pt-cottage', sq_ft: 1400, bedrooms: 2, bathrooms: 2 },
  { id: 'plan-maple', name: 'The Maple', product_type_id: 'pt-cottage', sq_ft: 1600, bedrooms: 3, bathrooms: 2 },
  { id: 'plan-cedar', name: 'The Cedar', product_type_id: 'pt-rancher', sq_ft: 1800, bedrooms: 3, bathrooms: 2 },
  { id: 'plan-pine', name: 'The Pine', product_type_id: 'pt-rancher', sq_ft: 2200, bedrooms: 4, bathrooms: 3 },
  { id: 'plan-spruce', name: 'The Spruce', product_type_id: 'pt-townhome', sq_ft: 1600, bedrooms: 3, bathrooms: 2.5 },
  { id: 'plan-birch', name: 'The Birch', product_type_id: 'pt-townhome', sq_ft: 2000, bedrooms: 4, bathrooms: 3 }
]
New: Agencies (Org + Community Level)

agencies: [
  {
    id: 'agency-huntsville',
    name: 'City of Huntsville',
    type: 'municipality',
    inspection_types: ['PRE', 'FND', 'FRM', 'RME', 'INS', 'FIN', 'COO'],
    is_org_level: true,
    created_at: '2024-01-01T00:00:00Z'
  },
  {
    id: 'agency-madison',
    name: 'City of Madison',
    type: 'municipality',
    inspection_types: ['PRE', 'FND', 'FRM', 'REL', 'RPL', 'RHV', 'INS', 'FIN', 'COO'],
    is_org_level: true,
    created_at: '2024-01-01T00:00:00Z'
  }
]
New: Multiple Templates by Product Type

templates: [
  {
    id: 'template-cottage-115',
    name: 'Cottage Standard',
    product_type_id: 'pt-cottage',
    build_days: 115,
    tasks: [/* 115-day task sequence */]
  },
  {
    id: 'template-rancher-130',
    name: 'Rancher Standard',
    product_type_id: 'pt-rancher',
    build_days: 130,
    tasks: [/* 130-day task sequence */]
  },
  {
    id: 'template-townhome-145',
    name: 'Townhome Standard',
    product_type_id: 'pt-townhome',
    build_days: 145,
    tasks: [/* 145-day task sequence */]
  }
]
New: Inspection Checklists

inspection_checklists: {
  PRE: [
    { id: 'pre-1', label: 'Footing depth per plan', required: true },
    { id: 'pre-2', label: 'Rebar placement correct', required: true },
    { id: 'pre-3', label: 'Form boards in place', required: true },
    { id: 'pre-4', label: 'Soil compaction verified', required: false }
  ],
  FND: [
    { id: 'fnd-1', label: 'Foundation walls plumb', required: true },
    { id: 'fnd-2', label: 'Anchor bolts installed', required: true },
    { id: 'fnd-3', label: 'No visible cracks', required: true }
  ],
  FRM: [
    { id: 'frm-1', label: 'Wall framing per plan', required: true },
    { id: 'frm-2', label: 'Roof trusses secured', required: true },
    { id: 'frm-3', label: 'Sheathing complete', required: true },
    { id: 'frm-4', label: 'Window/door openings correct', required: true }
  ],
  // ... more inspection types
}
Updated: Community Structure

community: {
  id: 'comm-1',
  name: 'The Grove',
  address: '123 Main St, Huntsville, AL',

  // NEW: Product types enabled for this community
  product_types: ['pt-cottage', 'pt-rancher', 'pt-townhome'],

  // NEW: Simple lot count (replaces blocks)
  lot_count: 50,

  // NEW: Lot to product type mapping
  lots_by_product_type: {
    'pt-cottage': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    'pt-rancher': [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    'pt-townhome': [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]
  },

  // NEW: Builders/Superintendents with lot assignments
  builders: [
    {
      id: 'builder-1',
      name: 'John Smith',
      phone: '555-0001',
      email: 'john@builder.com',
      color: '#3B82F6',  // Blue
      assigned_lots: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]
    },
    {
      id: 'builder-2',
      name: 'Jane Doe',
      phone: '555-0002',
      email: 'jane@builder.com',
      color: '#22C55E',  // Green
      assigned_lots: [26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]
    }
  ],

  // NEW: Realtors (replaces HOA)
  realtors: [
    {
      id: 'realtor-1',
      name: 'Sarah Johnson',
      phone: '555-0010',
      email: 'sarah@realty.com',
      company: 'ABC Realty'
    }
  ],

  // NEW: City Inspectors with agency
  inspectors: [
    {
      id: 'inspector-1',
      name: 'Bob Wilson',
      phone: '555-0020',
      email: 'bob@city.gov',
      agency_id: 'agency-huntsville'
    }
  ],

  // NEW: Community-level agencies
  agencies: ['agency-huntsville'],

  // Existing
  specifications: [...],
  status: 'active',
  created_at: '2024-01-01T00:00:00Z'
}
Updated: Lot Structure

lot: {
  id: 'lot-1',
  community_id: 'comm-1',

  // CHANGED: Simple lot number (no block)
  lot_number: 5,

  // NEW: Pre-assigned from community setup
  product_type_id: 'pt-cottage',
  builder_id: 'builder-1',

  // NEW: Selected when job starts
  plan_id: 'plan-oak',

  // NEW: Additional fields
  job_number: 'JOB-2024-0005',
  permit_number: 'BP-2024-12345',

  // NEW: Custom fields
  custom_fields: {
    'custom_1': 'Value 1',
    'custom_2': 'Value 2',
    'custom_3': 'Value 3'
  },

  // NEW: Sold status
  sold_status: 'available',  // 'available' | 'pending' | 'sold'
  sold_date: null,

  // Existing
  address: '123 Oak Street',
  model_type: 'The Oak',
  status: 'in_progress',
  start_date: '2024-01-15',
  target_completion_date: '2024-05-10',
  build_days: 115,  // From template (not editable)
  tasks: [...],
  photos: [...],
  inspections: [...],
  punch_list: {...}
}
Updated: Org Settings

org: {
  // Existing
  builder_name: 'ABC Homes',
  phone: '555-1234',
  work_days: [1, 2, 3, 4, 5],
  holidays: [...],

  // NEW: Custom fields for job starting
  custom_fields: [
    { id: 'custom_1', label: 'Special Instructions', type: 'text' },
    { id: 'custom_2', label: 'Lot Notes', type: 'text' },
    { id: 'custom_3', label: 'Additional Info', type: 'text' }
  ]
}
Implementation Phases
Phase 1: Data Model & Admin Settings (Foundation)
Files to modify:
src/data/seed.js - Add product_types, plans, agencies, templates, inspection_checklists
src/data/constants.js - Add BUILDER_COLORS, SOLD_STATUSES, new inspection types
src/data/template.js - Create 3 templates (Cottage 115d, Rancher 130d, Townhome 145d)
src/lib/storage.js - Add data migration for existing state
src/lib/utils.js - NEW: Range parsing, validation helpers
src/BuildFlow.jsx - Add Admin Settings tab and panels
Admin Settings Panel Components:
Product Type Manager - Create, edit, delete, reorder product types
Plan Manager - Create, edit plans (filtered by product type)
Agency Manager - Manage agencies with inspection type assignments
Custom Fields Manager - Define 2-3 org-level text field labels
New Utility Functions (src/lib/utils.js):

// Parse range string like "1-10, 15, 20-25" into array [1,2,3,...10,15,20,21,...25]
export const parseRange = (rangeStr) => {
  if (!rangeStr) return []
  const result = []
  const parts = rangeStr.split(',').map(s => s.trim())
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number)
      for (let i = start; i <= end; i++) result.push(i)
    } else if (part) {
      result.push(Number(part))
    }
  }
  return [...new Set(result)].filter(n => !isNaN(n)).sort((a, b) => a - b)
}

// Convert array back to range string
export const toRangeString = (numbers) => {
  if (!numbers.length) return ''
  const sorted = [...numbers].sort((a, b) => a - b)
  const ranges = []
  let start = sorted[0], end = sorted[0]

  for (let i = 1; i <= sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i]
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`)
      start = end = sorted[i]
    }
  }
  return ranges.join(', ')
}

// Validate all lots assigned to exactly one builder
export const validateBuilderAssignments = (builders, lotCount) => {
  const assigned = new Map()
  for (const builder of builders) {
    const lots = parseRange(builder.lotRange || '')
    for (const lot of lots) {
      if (lot < 1 || lot > lotCount) {
        return { valid: false, error: `Lot ${lot} is outside range 1-${lotCount}` }
      }
      if (assigned.has(lot)) {
        return { valid: false, error: `Lot ${lot} assigned to multiple builders` }
      }
      assigned.set(lot, builder.id)
    }
  }
  for (let i = 1; i <= lotCount; i++) {
    if (!assigned.has(i)) {
      return { valid: false, error: `Lot ${i} not assigned to any builder` }
    }
  }
  return { valid: true }
}
Phase 2: Community Creation Overhaul
Files to modify:
src/BuildFlow.jsx - Community creation wizard (Steps 1, 2, 4)
Step 1 Changes:
Remove build_days_default input field
Add product type multi-select checkboxes

<div className="space-y-2">
  <p className="text-sm font-semibold">Product Types Available *</p>
  {app.product_types.filter(pt => pt.is_active).map(pt => (
    <label key={pt.id} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
      <input
        type="checkbox"
        checked={draft.product_types?.includes(pt.id)}
        onChange={(e) => toggleProductType(pt.id, e.target.checked)}
      />
      <span className="font-medium">{pt.name}</span>
      <span className="text-sm text-gray-500">({pt.build_days} days)</span>
    </label>
  ))}
</div>
Step 2 Changes (Major Restructure):
Remove block start/end letter inputs
Add simple lot count input
Add product type range assignment UI

<div className="space-y-4">
  <label className="block">
    <span className="text-sm font-semibold">Total Number of Lots *</span>
    <input
      type="number"
      min="1"
      value={draft.lot_count}
      onChange={(e) => setDraft(d => ({ ...d, lot_count: Number(e.target.value) }))}
      className="mt-1 w-full px-4 py-3 border rounded-xl"
      placeholder="50"
    />
  </label>

  <div className="bg-gray-50 p-4 rounded-xl">
    <p className="font-semibold mb-3">Assign Product Types to Lots</p>
    <p className="text-xs text-gray-600 mb-4">
      Enter lot ranges (e.g., "1-10" or "1-5, 8, 12-15")
    </p>

    {draft.product_types?.map(ptId => {
      const pt = app.product_types.find(p => p.id === ptId)
      const range = draft.productTypeRanges?.[ptId] || ''
      const count = parseRange(range).length

      return (
        <div key={ptId} className="flex items-center gap-3 mb-3">
          <span className="w-28 text-sm font-medium">{pt?.name}:</span>
          <input
            value={range}
            onChange={(e) => updateProductTypeRange(ptId, e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg text-sm"
            placeholder="e.g., 1-10, 15, 20-25"
          />
          <span className="text-xs text-gray-500 w-16">({count} lots)</span>
        </div>
      )
    })}

    <div className="mt-3 pt-3 border-t flex justify-between text-sm">
      <span>Total Assigned:</span>
      <span className={totalAssigned === draft.lot_count ? 'text-green-600' : 'text-red-600'}>
        {totalAssigned} / {draft.lot_count} lots
      </span>
    </div>
  </div>
</div>
Step 4 Changes:
Remove HOA contact section
Add Realtors section (multiple)
Add City Inspectors with Agency dropdown (multiple)
Add Builders/Superintendents with lot assignments

{/* Realtors Section */}
<div className="space-y-3">
  <div className="flex items-center justify-between">
    <p className="font-semibold">Realtors</p>
    <button onClick={addRealtor} className="text-sm text-blue-600">+ Add Realtor</button>
  </div>
  {draft.realtors?.map((r, idx) => (
    <div key={idx} className="p-3 bg-gray-50 rounded-xl space-y-2">
      <div className="flex gap-2">
        <input placeholder="Name" value={r.name} onChange={...} className="flex-1" />
        <button onClick={() => removeRealtor(idx)} className="text-red-500">×</button>
      </div>
      <input placeholder="Phone" value={r.phone} onChange={...} />
      <input placeholder="Email" value={r.email} onChange={...} />
      <input placeholder="Company" value={r.company} onChange={...} />
    </div>
  ))}
</div>

{/* City Inspectors Section */}
<div className="space-y-3">
  <div className="flex items-center justify-between">
    <p className="font-semibold">City Inspectors</p>
    <button onClick={addInspector} className="text-sm text-blue-600">+ Add Inspector</button>
  </div>
  {draft.inspectors?.map((i, idx) => (
    <div key={idx} className="p-3 bg-gray-50 rounded-xl space-y-2">
      <div className="flex gap-2">
        <input placeholder="Name" value={i.name} onChange={...} className="flex-1" />
        <button onClick={() => removeInspector(idx)} className="text-red-500">×</button>
      </div>
      <input placeholder="Phone" value={i.phone} onChange={...} />
      <select value={i.agency_id} onChange={...}>
        <option value="">Select Agency...</option>
        {availableAgencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </div>
  ))}
</div>

{/* Builders/Superintendents Section */}
<div className="space-y-3">
  <div className="flex items-center justify-between">
    <p className="font-semibold">Builders/Superintendents</p>
    <button onClick={addBuilder} className="text-sm text-blue-600">+ Add Builder</button>
  </div>
  {draft.builders?.map((b, idx) => (
    <div key={idx} className="p-3 bg-gray-50 rounded-xl space-y-2">
      <div className="flex gap-2 items-center">
        <input placeholder="Name" value={b.name} onChange={...} className="flex-1" />
        <input type="color" value={b.color} onChange={...} className="w-10 h-10 rounded" />
        <button onClick={() => removeBuilder(idx)} className="text-red-500">×</button>
      </div>
      <input placeholder="Phone" value={b.phone} onChange={...} />
      <input placeholder="Email" value={b.email} onChange={...} />
      <label className="block">
        <span className="text-xs text-gray-600">Assigned Lots (e.g., "1-25")</span>
        <input
          placeholder="1-25"
          value={b.lotRange}
          onChange={...}
          className="w-full px-3 py-2 border rounded-lg"
        />
      </label>
    </div>
  ))}

  {/* Validation Message */}
  {builderValidation.valid ? (
    <p className="text-green-600 text-sm">✓ All {draft.lot_count} lots assigned</p>
  ) : (
    <p className="text-red-600 text-sm">⚠ {builderValidation.error}</p>
  )}
</div>
Phase 3: Job Starting Updates
Files to modify:
src/BuildFlow.jsx - StartLotModal component (~line 4528)
src/lib/scheduleEngine.js - Template selection by product type
StartLotModal Changes:

function StartLotModal({ app, org, prefill, onClose, onStart }) {
  // Get lot's pre-assigned product type from community setup
  const lot = app.lots.find(l => l.id === prefill?.lot_id)
  const community = app.communities.find(c => c.id === lot?.community_id)
  const productTypeId = lot?.product_type_id
  const productType = app.product_types.find(pt => pt.id === productTypeId)

  // Get template from product type (build_days is read-only)
  const template = app.templates.find(t => t.product_type_id === productTypeId)
  const buildDays = template?.build_days ?? productType?.build_days ?? 135

  // Filter plans by product type
  const availablePlans = app.plans.filter(p => p.product_type_id === productTypeId && p.is_active)

  const [form, setForm] = useState({
    start_date: '',
    plan_id: '',
    job_number: '',
    permit_number: '',
    address: '',
    hard_deadline: '',
    custom_1: '',
    custom_2: '',
    custom_3: ''
  })

  return (
    <Modal title={`Start Lot ${lot?.lot_number}`} onClose={onClose}>
      {/* Product Type (Read-Only) */}
      <div className="bg-blue-50 p-3 rounded-xl mb-4">
        <p className="text-xs text-blue-600">Product Type</p>
        <p className="font-semibold">{productType?.name ?? 'Not assigned'}</p>
        <p className="text-sm text-gray-600">{buildDays}-day build template</p>
      </div>

      {/* Plan Selection */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Plan *</span>
        <select
          value={form.plan_id}
          onChange={(e) => setForm(f => ({ ...f, plan_id: e.target.value }))}
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        >
          <option value="">Select plan...</option>
          {availablePlans.map(p => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.sq_ft} sq ft, {p.bedrooms}BR/{p.bathrooms}BA)
            </option>
          ))}
        </select>
      </label>

      {/* Start Date */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Start Date *</span>
        <input
          type="date"
          value={form.start_date}
          onChange={(e) => setForm(f => ({ ...f, start_date: e.target.value }))}
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        />
      </label>

      {/* Build Days (Read-Only) */}
      <div className="bg-gray-50 p-3 rounded-xl mb-3">
        <p className="text-xs text-gray-500">Build Days Target</p>
        <p className="font-semibold">{buildDays} days</p>
        <p className="text-xs text-gray-500">(From {productType?.name} template - not editable)</p>
      </div>

      {/* Job Number */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Job Number</span>
        <input
          value={form.job_number}
          onChange={(e) => setForm(f => ({ ...f, job_number: e.target.value }))}
          placeholder="JOB-2024-001"
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        />
      </label>

      {/* Permit Number */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Permit Number</span>
        <input
          value={form.permit_number}
          onChange={(e) => setForm(f => ({ ...f, permit_number: e.target.value }))}
          placeholder="BP-2024-12345"
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        />
      </label>

      {/* Address */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Address</span>
        <input
          value={form.address}
          onChange={(e) => setForm(f => ({ ...f, address: e.target.value }))}
          placeholder="123 Oak Street"
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        />
      </label>

      {/* Hard Deadline */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Hard Deadline (Optional)</span>
        <input
          type="date"
          value={form.hard_deadline}
          onChange={(e) => setForm(f => ({ ...f, hard_deadline: e.target.value }))}
          className="mt-1 w-full px-4 py-3 border rounded-xl"
        />
      </label>

      {/* Custom Fields */}
      {org.custom_fields?.map(cf => (
        <label key={cf.id} className="block mb-3">
          <span className="text-sm font-semibold">{cf.label}</span>
          <input
            value={form[cf.id] || ''}
            onChange={(e) => setForm(f => ({ ...f, [cf.id]: e.target.value }))}
            className="mt-1 w-full px-4 py-3 border rounded-xl"
          />
        </label>
      ))}

      <button onClick={handleStart} className="w-full py-3 bg-blue-600 text-white rounded-xl font-semibold">
        Start Lot
      </button>
    </Modal>
  )
}
scheduleEngine.js Changes:

// Update startLotFromTemplate to use product-type-specific template
export function startLotFromTemplate(lot, app, org) {
  // Find template by product type
  const template = app.templates.find(t => t.product_type_id === lot.product_type_id)
    || app.templates[0] // fallback

  const buildDays = template.build_days
  const tasks = buildLotTasksFromTemplate(template.tasks, lot.start_date, org, app.subcontractors)

  return {
    ...lot,
    build_days: buildDays,
    tasks,
    target_completion_date: calculateTargetCompletionDate(lot.start_date, buildDays, org)
  }
}
Phase 4: Community View Enhancements
Files to modify:
src/BuildFlow.jsx - Community detail view, lot grid
Builder Color-Coded Lot Grid:

{/* Builder Legend */}
<div className="flex flex-wrap gap-3 mb-4 p-3 bg-gray-50 rounded-xl">
  <span className="text-sm font-semibold">Builders:</span>
  {selectedCommunity.builders?.map(b => (
    <div key={b.id} className="flex items-center gap-2">
      <div className="w-4 h-4 rounded" style={{ backgroundColor: b.color }} />
      <span className="text-sm">{b.name}</span>
    </div>
  ))}
</div>

{/* Lot Grid (No Blocks) */}
<div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 gap-2">
  {Array.from({ length: selectedCommunity.lot_count }, (_, i) => i + 1).map(lotNum => {
    const lot = lotsInCommunity.find(l => l.lot_number === lotNum)
    const builder = selectedCommunity.builders?.find(b =>
      parseRange(b.lotRange || b.assigned_lots?.join(',')).includes(lotNum)
    )
    const productType = app.product_types.find(pt => pt.id === lot?.product_type_id)

    const statusIcon = !lot ? '○'
      : lot.status === 'complete' ? '✓'
      : lot.status === 'in_progress' ? (lot.hasDelay ? '!' : '●')
      : '○'

    const statusColor = !lot ? 'text-gray-400'
      : lot.status === 'complete' ? 'text-green-600'
      : lot.status === 'in_progress' ? (lot.hasDelay ? 'text-yellow-600' : 'text-blue-600')
      : 'text-gray-400'

    return (
      <button
        key={lotNum}
        onClick={() => lot && openLot(lot.id)}
        className="p-2 rounded-xl border-2 text-center transition-all hover:shadow-md"
        style={{
          backgroundColor: builder ? `${builder.color}15` : '#f9fafb',
          borderColor: builder?.color || '#e5e7eb'
        }}
      >
        <p className="font-bold text-sm">{lotNum}</p>
        <p className={`text-lg ${statusColor}`}>{statusIcon}</p>
        {productType && <p className="text-[10px] text-gray-500 truncate">{productType.name}</p>}
      </button>
    )
  })}
</div>
Community Contacts Quick Access Card:

<Card className="mb-4">
  <div className="flex items-center justify-between mb-3">
    <h3 className="font-semibold">Community Contacts</h3>
    <button onClick={() => setEditingContacts(true)} className="text-sm text-blue-600">Edit</button>
  </div>

  {/* Builders */}
  <div className="mb-3">
    <p className="text-xs font-semibold text-gray-500 mb-1">BUILDERS</p>
    {selectedCommunity.builders?.map(b => (
      <div key={b.id} className="flex items-center justify-between py-1">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded" style={{ backgroundColor: b.color }} />
          <span className="text-sm">{b.name}</span>
        </div>
        <a href={`tel:${b.phone}`} className="text-blue-600 text-sm">{b.phone}</a>
      </div>
    ))}
  </div>

  {/* Realtors */}
  <div className="mb-3">
    <p className="text-xs font-semibold text-gray-500 mb-1">REALTORS</p>
    {selectedCommunity.realtors?.map(r => (
      <div key={r.id} className="flex items-center justify-between py-1">
        <span className="text-sm">{r.name} <span className="text-gray-500">({r.company})</span></span>
        <a href={`tel:${r.phone}`} className="text-blue-600 text-sm">{r.phone}</a>
      </div>
    ))}
  </div>

  {/* Inspectors */}
  <div>
    <p className="text-xs font-semibold text-gray-500 mb-1">INSPECTORS</p>
    {selectedCommunity.inspectors?.map(i => {
      const agency = [...app.agencies, ...(selectedCommunity.agencies || [])].find(a => a.id === i.agency_id)
      return (
        <div key={i.id} className="flex items-center justify-between py-1">
          <span className="text-sm">{i.name} <span className="text-gray-500">({agency?.name})</span></span>
          <a href={`tel:${i.phone}`} className="text-blue-600 text-sm">{i.phone}</a>
        </div>
      )
    })}
  </div>
</Card>
Community Specs with Product Type/Plan Assignment:

{/* When editing a spec, add targeting options */}
<label className="block mb-3">
  <span className="text-sm font-semibold">Applies To</span>
  <select value={specDraft.applies_to} onChange={...}>
    <option value="all">All Lots in Community</option>
    <option value="product_type">Specific Product Type</option>
    <option value="plan">Specific Plan</option>
  </select>
</label>

{specDraft.applies_to === 'product_type' && (
  <select value={specDraft.product_type_id} onChange={...}>
    <option value="">Select product type...</option>
    {selectedCommunity.product_types.map(ptId => {
      const pt = app.product_types.find(p => p.id === ptId)
      return <option key={ptId} value={ptId}>{pt?.name}</option>
    })}
  </select>
)}

{specDraft.applies_to === 'plan' && (
  <select value={specDraft.plan_id} onChange={...}>
    <option value="">Select plan...</option>
    {app.plans.filter(p => selectedCommunity.product_types.includes(p.product_type_id)).map(p => (
      <option key={p.id} value={p.id}>{p.name}</option>
    ))}
  </select>
)}
Phase 5: Photo Gallery & Punch List Updates
Files to modify:
src/BuildFlow.jsx - Lot detail tabs, photo gallery, punch list modals
Photo Gallery Tab:

{/* Add Photos tab to lot detail */}
<button
  onClick={() => setLotDetailTab('photos')}
  className={`px-4 py-2 rounded-lg text-sm font-medium ${
    lotDetailTab === 'photos' ? 'bg-blue-100 text-blue-700' : 'text-gray-600'
  }`}
>
  Photos ({(selectedLot.photos || []).length})
</button>

{lotDetailTab === 'photos' && (
  <div className="space-y-4">
    <div className="flex justify-between items-center">
      <h3 className="font-semibold">Photo Gallery</h3>
      <button
        onClick={() => setAddPhotoModal({ lot_id: selectedLot.id })}
        className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium"
      >
        + Add Photo
      </button>
    </div>

    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
      {(selectedLot.photos || []).map(photo => (
        <div
          key={photo.id}
          onClick={() => setViewingPhoto(photo)}
          className="relative aspect-square rounded-xl overflow-hidden cursor-pointer hover:opacity-90"
        >
          <PhotoThumb blobId={photo.blob_id} className="w-full h-full object-cover" />
          <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs p-1">
            {formatShortDate(photo.taken_at)}
          </div>
        </div>
      ))}
    </div>

    {(selectedLot.photos || []).length === 0 && (
      <p className="text-center text-gray-500 py-8">No photos yet</p>
    )}
  </div>
)}
Punch List with Optional Photo & Camera Integration:

function AddPunchItemModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ description: '', location: '', category: '', sub_id: '' })
  const [photoFile, setPhotoFile] = useState(null)
  const [photoPreview, setPhotoPreview] = useState(null)
  const cameraInputRef = useRef(null)
  const fileInputRef = useRef(null)

  const handleCameraCapture = () => {
    cameraInputRef.current?.click()
  }

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      setPhotoFile(file)
      setPhotoPreview(URL.createObjectURL(file))
    }
  }

  return (
    <Modal title="Add Punch Item" onClose={onClose}>
      {/* Description */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Description *</span>
        <input
          value={form.description}
          onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
          className="mt-1 w-full px-4 py-3 border rounded-xl"
          placeholder="Describe the issue..."
        />
      </label>

      {/* Location */}
      <label className="block mb-3">
        <span className="text-sm font-semibold">Location</span>
        <input
          value={form.location}
          onChange={(e) => setForm(f => ({ ...f, location: e.target.value }))}
          className="mt-1 w-full px-4 py-3 border rounded-xl"
          placeholder="e.g., Master Bedroom, North Wall"
        />
      </label>

      {/* Category & Sub dropdowns... */}

      {/* Photo (Optional) */}
      <div className="mb-3">
        <p className="text-sm font-semibold mb-2">Photo <span className="text-gray-400">(Optional)</span></p>

        {photoPreview ? (
          <div className="relative">
            <img src={photoPreview} alt="Preview" className="w-full h-40 object-cover rounded-xl" />
            <button
              onClick={() => { setPhotoFile(null); setPhotoPreview(null) }}
              className="absolute top-2 right-2 w-8 h-8 bg-red-500 text-white rounded-full"
            >
              ×
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={handleCameraCapture}
              className="flex-1 py-3 bg-blue-50 text-blue-700 rounded-xl font-medium border border-blue-200"
            >
              📷 Take Photo
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex-1 py-3 bg-gray-50 text-gray-700 rounded-xl font-medium border border-gray-200"
            >
              📁 Choose File
            </button>
          </div>
        )}

        {/* Hidden inputs */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileSelect}
          className="hidden"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      <button
        onClick={() => onCreate({ ...form, photo: photoFile })}
        disabled={!form.description}
        className="w-full py-3 bg-blue-600 text-white rounded-xl font-semibold disabled:opacity-50"
      >
        Add Item
      </button>
    </Modal>
  )
}
Punch List Simple Checkbox Sign-Off:

{/* In punch list view */}
{punchItems.map(item => (
  <div key={item.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
    <input
      type="checkbox"
      checked={item.status === 'closed' || item.status === 'verified'}
      onChange={(e) => {
        const newStatus = e.target.checked ? 'closed' : 'open'
        updatePunchItem(item.id, { status: newStatus })
      }}
      className="w-6 h-6 mt-1 rounded"
    />
    <div className="flex-1">
      <p className={`font-medium ${item.status === 'closed' ? 'line-through text-gray-400' : ''}`}>
        {item.description}
      </p>
      {item.location && <p className="text-sm text-gray-500">{item.location}</p>}
    </div>
  </div>
))}
Phase 6: Inspections Overhaul
Files to modify:
src/data/seed.js - Add inspection checklists
src/BuildFlow.jsx - Inspection checklist modal
Inspection Checklist Modal:

function InspectionChecklistModal({ inspection, lot, onClose, onPass }) {
  const agency = app.agencies.find(a => a.id === lot.agency_id)
  const checklist = INSPECTION_CHECKLISTS[inspection.type] || []
  const [checked, setChecked] = useState({})

  const requiredItems = checklist.filter(c => c.required)
  const allRequiredChecked = requiredItems.every(c => checked[c.id])

  const handleToggle = (itemId) => {
    setChecked(prev => ({ ...prev, [itemId]: !prev[itemId] }))
  }

  const handleMarkPassed = () => {
    onPass(inspection.id, {
      result: 'pass',
      checklist_completed: checked,
      passed_at: new Date().toISOString()
    })
    onClose()
  }

  return (
    <Modal title={`${inspection.type} Inspection Checklist`} onClose={onClose}>
      <p className="text-sm text-gray-600 mb-4">
        Lot {lot.lot_number} • {agency?.name || 'Unknown Agency'}
      </p>

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {checklist.map(item => (
          <label
            key={item.id}
            className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer ${
              checked[item.id] ? 'bg-green-50' : 'bg-gray-50'
            }`}
          >
            <input
              type="checkbox"
              checked={checked[item.id] || false}
              onChange={() => handleToggle(item.id)}
              className="w-5 h-5 rounded"
            />
            <span className={checked[item.id] ? 'text-green-700' : ''}>
              {item.label}
            </span>
            {item.required && (
              <span className="text-xs text-red-500 ml-auto">Required</span>
            )}
          </label>
        ))}
      </div>

      <div className="mt-4 pt-4 border-t">
        <p className="text-sm text-gray-600 mb-3">
          {Object.values(checked).filter(Boolean).length} / {checklist.length} items checked
          {!allRequiredChecked && (
            <span className="text-red-500 ml-2">(all required items must be checked)</span>
          )}
        </p>

        <button
          onClick={handleMarkPassed}
          disabled={!allRequiredChecked}
          className="w-full py-3 bg-green-600 text-white rounded-xl font-semibold disabled:opacity-50 disabled:bg-gray-400"
        >
          ✓ Mark Inspection as Passed
        </button>
      </div>
    </Modal>
  )
}
Phase 7: Sales/Filtered View
Files to modify:
src/BuildFlow.jsx - Add SalesView component, sold status management
Sales View Component:

function SalesView({ app }) {
  const [filters, setFilters] = useState({
    community_id: 'all',
    product_type_id: 'all',
    plan_id: 'all',
    sold_status: 'all',
    completion_by: ''
  })

  const filteredLots = useMemo(() => {
    return app.lots.filter(lot => {
      if (filters.community_id !== 'all' && lot.community_id !== filters.community_id) return false
      if (filters.product_type_id !== 'all' && lot.product_type_id !== filters.product_type_id) return false
      if (filters.plan_id !== 'all' && lot.plan_id !== filters.plan_id) return false
      if (filters.sold_status !== 'all' && lot.sold_status !== filters.sold_status) return false
      if (filters.completion_by && lot.target_completion_date > filters.completion_by) return false
      return true
    })
  }, [app.lots, filters])

  const availableCount = filteredLots.filter(l => l.sold_status === 'available').length

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Sales View</h2>

      {/* Filters */}
      <Card>
        <p className="font-semibold mb-3">Filters</p>
        <div className="grid grid-cols-2 gap-3">
          <select
            value={filters.community_id}
            onChange={(e) => setFilters(f => ({ ...f, community_id: e.target.value }))}
            className="px-3 py-2 border rounded-lg"
          >
            <option value="all">All Communities</option>
            {app.communities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <select
            value={filters.product_type_id}
            onChange={(e) => setFilters(f => ({ ...f, product_type_id: e.target.value }))}
            className="px-3 py-2 border rounded-lg"
          >
            <option value="all">All Product Types</option>
            {app.product_types.map(pt => <option key={pt.id} value={pt.id}>{pt.name}</option>)}
          </select>

          <select
            value={filters.plan_id}
            onChange={(e) => setFilters(f => ({ ...f, plan_id: e.target.value }))}
            className="px-3 py-2 border rounded-lg"
          >
            <option value="all">All Plans</option>
            {app.plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <select
            value={filters.sold_status}
            onChange={(e) => setFilters(f => ({ ...f, sold_status: e.target.value }))}
            className="px-3 py-2 border rounded-lg"
          >
            <option value="all">All Statuses</option>
            <option value="available">Available</option>
            <option value="pending">Pending</option>
            <option value="sold">Sold</option>
          </select>

          <div className="col-span-2">
            <label className="text-sm text-gray-600">Available by date:</label>
            <input
              type="date"
              value={filters.completion_by}
              onChange={(e) => setFilters(f => ({ ...f, completion_by: e.target.value }))}
              className="w-full px-3 py-2 border rounded-lg mt-1"
            />
          </div>
        </div>
      </Card>

      {/* Results Summary */}
      <div className="bg-green-50 p-4 rounded-xl">
        <p className="text-2xl font-bold text-green-700">{availableCount}</p>
        <p className="text-sm text-green-600">Available lots matching filters</p>
      </div>

      {/* Lot Cards */}
      <div className="space-y-3">
        {filteredLots.map(lot => {
          const community = app.communities.find(c => c.id === lot.community_id)
          const productType = app.product_types.find(pt => pt.id === lot.product_type_id)
          const plan = app.plans.find(p => p.id === lot.plan_id)

          return (
            <Card key={lot.id}>
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-bold">{community?.name} - Lot {lot.lot_number}</p>
                  <p className="text-sm text-gray-600">{productType?.name} • {plan?.name || 'No plan'}</p>
                  <p className="text-sm text-gray-500">{lot.address || 'No address'}</p>
                  {lot.target_completion_date && (
                    <p className="text-sm text-blue-600">
                      Est. completion: {formatShortDate(lot.target_completion_date)}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                    lot.sold_status === 'available' ? 'bg-green-100 text-green-700' :
                    lot.sold_status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {lot.sold_status || 'Available'}
                  </span>
                  <div className="mt-2">
                    <select
                      value={lot.sold_status || 'available'}
                      onChange={(e) => updateLotSoldStatus(lot.id, e.target.value)}
                      className="text-sm px-2 py-1 border rounded"
                    >
                      <option value="available">Available</option>
                      <option value="pending">Pending</option>
                      <option value="sold">Sold</option>
                    </select>
                  </div>
                </div>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
Phase 8: Hybrid Schedule View (Calendar + Gantt)
Files to modify:
src/BuildFlow.jsx - Add HybridScheduleView component
Hybrid Schedule View Component:

function HybridScheduleView({ lot, subcontractors }) {
  const tasks = (lot.tasks || []).slice().sort((a, b) =>
    (a.scheduled_start || '').localeCompare(b.scheduled_start || '')
  )

  // Calculate date range
  const allDates = tasks.flatMap(t => [t.scheduled_start, t.scheduled_end]).filter(Boolean)
  const minDate = allDates.length ? parseISODate(allDates.sort()[0]) : new Date()
  const maxDate = allDates.length ? parseISODate(allDates.sort().reverse()[0]) : addCalendarDays(new Date(), 60)
  const totalDays = daysBetweenCalendar(maxDate, minDate) + 1

  // Generate week columns
  const weeks = []
  let currentDate = new Date(minDate)
  while (currentDate <= maxDate) {
    weeks.push(new Date(currentDate))
    currentDate = addCalendarDays(currentDate, 7)
  }

  const STATUS_COLORS = {
    complete: '#22C55E',
    in_progress: '#3B82F6',
    delayed: '#EF4444',
    blocked: '#F97316',
    ready: '#8B5CF6',
    pending: '#D1D5DB'
  }

  return (
    <div className="overflow-x-auto border rounded-xl">
      <div style={{ minWidth: `${Math.max(800, weeks.length * 100)}px` }}>
        {/* Calendar Header */}
        <div className="flex border-b bg-gray-50 sticky top-0">
          <div className="w-48 shrink-0 p-3 font-semibold border-r">Task</div>
          <div className="flex-1 flex">
            {weeks.map((week, i) => (
              <div
                key={i}
                className="flex-1 p-2 text-center text-sm font-medium border-r last:border-r-0"
                style={{ minWidth: '100px' }}
              >
                {formatShortDate(week)}
              </div>
            ))}
          </div>
        </div>

        {/* Task Rows */}
        {tasks.map(task => {
          const sub = subcontractors.find(s => s.id === task.sub_id)
          const status = deriveTaskStatus(task, lot.tasks, lot.inspections)

          const startDate = parseISODate(task.scheduled_start)
          const endDate = parseISODate(task.scheduled_end)
          const startOffset = daysBetweenCalendar(startDate, minDate)
          const duration = daysBetweenCalendar(endDate, startDate) + 1

          const leftPercent = (startOffset / totalDays) * 100
          const widthPercent = (duration / totalDays) * 100

          return (
            <div key={task.id} className="flex border-b hover:bg-gray-50">
              {/* Task Name Column */}
              <div className="w-48 shrink-0 p-2 border-r">
                <p className="text-sm font-medium truncate">{task.name}</p>
                <p className="text-xs text-gray-500 truncate">{sub?.company_name || '—'}</p>
              </div>

              {/* Gantt Bar Area */}
              <div className="flex-1 relative h-14">
                {/* Week grid lines */}
                {weeks.map((_, i) => (
                  <div
                    key={i}
                    className="absolute top-0 bottom-0 border-r border-gray-100"
                    style={{ left: `${((i + 1) / weeks.length) * 100}%` }}
                  />
                ))}

                {/* Task Bar */}
                <div
                  className="absolute top-2 h-10 rounded-lg flex items-center px-2 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
                  style={{
                    left: `${leftPercent}%`,
                    width: `${Math.max(widthPercent, 3)}%`,
                    backgroundColor: STATUS_COLORS[status] || STATUS_COLORS.pending
                  }}
                  title={`${task.name}\n${formatShortDate(startDate)} - ${formatShortDate(endDate)}\n${duration} days`}
                >
                  <span className="text-xs text-white font-medium truncate">
                    {task.name} ({duration}d)
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

{/* Toggle in lot detail view */}
<div className="flex gap-2 mb-4">
  <button
    onClick={() => setScheduleView('list')}
    className={`px-4 py-2 rounded-lg text-sm font-medium ${
      scheduleView === 'list' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100'
    }`}
  >
    List View
  </button>
  <button
    onClick={() => setScheduleView('gantt')}
    className={`px-4 py-2 rounded-lg text-sm font-medium ${
      scheduleView === 'gantt' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100'
    }`}
  >
    Timeline View
  </button>
</div>
Phase 9: Summary Dashboard
Files to modify:
src/BuildFlow.jsx - Dashboard section enhancements
Dashboard Summary Cards:

{/* Upcoming Inspections */}
<Card>
  <h3 className="font-semibold mb-3">Upcoming Inspections</h3>
  {upcomingInspections.slice(0, 5).map(({ lot, inspection, community }) => (
    <button
      key={inspection.id}
      onClick={() => openLot(lot.id)}
      className="w-full p-3 bg-gray-50 rounded-xl mb-2 text-left hover:bg-gray-100"
    >
      <div className="flex justify-between items-center">
        <span className="font-medium">{inspection.type}</span>
        <span className="text-sm text-gray-600">{formatShortDate(inspection.scheduled_date)}</span>
      </div>
      <p className="text-sm text-gray-500">{community?.name} - Lot {lot.lot_number}</p>
    </button>
  ))}
  {upcomingInspections.length === 0 && (
    <p className="text-gray-500 text-center py-4">No upcoming inspections</p>
  )}
</Card>

{/* Critical Deadlines */}
<Card>
  <h3 className="font-semibold mb-3">Critical Deadlines</h3>
  {criticalDeadlines.slice(0, 5).map(({ lot, daysRemaining, community }) => (
    <button
      key={lot.id}
      onClick={() => openLot(lot.id)}
      className={`w-full p-3 rounded-xl mb-2 text-left ${
        daysRemaining <= 7 ? 'bg-red-50' : daysRemaining <= 14 ? 'bg-yellow-50' : 'bg-gray-50'
      }`}
    >
      <div className="flex justify-between items-center">
        <span className="font-medium">{community?.name} - Lot {lot.lot_number}</span>
        <span className={`text-sm font-bold ${
          daysRemaining <= 7 ? 'text-red-600' : daysRemaining <= 14 ? 'text-yellow-600' : 'text-gray-600'
        }`}>
          {daysRemaining} days
        </span>
      </div>
      <p className="text-sm text-gray-500">
        {lot.model_type} • Target: {formatShortDate(lot.hard_deadline || lot.target_completion_date)}
      </p>
    </button>
  ))}
</Card>

{/* At-a-Glance Stats */}
<Card>
  <h3 className="font-semibold mb-3">At a Glance</h3>
  <div className="grid grid-cols-2 gap-3">
    <div className="p-4 bg-blue-50 rounded-xl text-center">
      <p className="text-3xl font-bold text-blue-600">{todaysTasks.length}</p>
      <p className="text-sm text-gray-600">Tasks Today</p>
    </div>
    <div className="p-4 bg-orange-50 rounded-xl text-center">
      <p className="text-3xl font-bold text-orange-600">{pendingInspections.length}</p>
      <p className="text-sm text-gray-600">Pending Inspections</p>
    </div>
    <div className="p-4 bg-red-50 rounded-xl text-center">
      <p className="text-3xl font-bold text-red-600">{delayedLots.length}</p>
      <p className="text-sm text-gray-600">Delayed Lots</p>
    </div>
    <div className="p-4 bg-purple-50 rounded-xl text-center">
      <p className="text-3xl font-bold text-purple-600">{openPunchItems}</p>
      <p className="text-sm text-gray-600">Open Punch Items</p>
    </div>
  </div>
</Card>
Files to Modify Summary
File	Changes
src/BuildFlow.jsx	Admin panel, community wizard, lot grid, job starting, photo gallery, punch list, inspections, sales view, Gantt view, dashboard
src/data/seed.js	product_types, plans, agencies, templates, inspection_checklists, updated community/lot structures
src/data/template.js	3 templates: Cottage (115d), Rancher (130d), Townhome (145d) with nuanced tasks
src/data/constants.js	BUILDER_COLORS, SOLD_STATUSES, INSPECTION_TYPES
src/lib/scheduleEngine.js	Template selection by product type
src/lib/utils.js	NEW: parseRange, toRangeString, validateBuilderAssignments
src/lib/storage.js	Data migration for existing state
Implementation Priority Order
Phase	Priority	Description
1	Critical	Data models, admin settings, product types, templates
2	Critical	Community creation overhaul (no blocks, builders, realtors)
3	High	Job starting updates (plan dropdown, read-only build days)
4	High	Community view (builder colors, contacts)
5	Medium	Photo gallery, punch list camera integration
6	Medium	Inspections with municipality checklists
7	Medium	Sales/filtered view
8	Medium	Hybrid schedule view (Gantt)
9	Low	Summary dashboard enhancements
Ready for Implementation
All requirements captured and detailed. Proceed with Phase 1 (Data Models & Admin Settings) first as it establishes the foundation for all other features.
