export const TRACKS = [
  { id: 'foundation', label: 'Foundation' },
  { id: 'structure', label: 'Structure' },
  { id: 'interior', label: 'Interior Track' },
  { id: 'exterior', label: 'Exterior Track' },
  { id: 'final', label: 'Final' },
]

export const PHASES = [
  { id: 'pre_construction', label: 'Pre-Construction' },
  { id: 'foundation', label: 'Foundation' },
  { id: 'framing', label: 'Framing' },
  { id: 'mechanical', label: 'Mechanical' },
  { id: 'insulation_drywall', label: 'Insulation & Drywall' },
  { id: 'finishes', label: 'Finishes' },
  { id: 'exterior', label: 'Exterior' },
  { id: 'final', label: 'Final' },
]

export const TRADES = [
  { id: 'excavation', label: 'Excavation' },
  { id: 'concrete', label: 'Concrete' },
  { id: 'framing', label: 'Framing' },
  { id: 'roofing', label: 'Roofing' },
  { id: 'windows', label: 'Windows' },
  { id: 'electrical', label: 'Electrical' },
  { id: 'plumbing', label: 'Plumbing' },
  { id: 'hvac', label: 'HVAC' },
  { id: 'insulation', label: 'Insulation' },
  { id: 'drywall', label: 'Drywall' },
  { id: 'paint', label: 'Paint' },
  { id: 'cabinets', label: 'Cabinets' },
  { id: 'countertops', label: 'Countertops' },
  { id: 'flooring', label: 'Flooring' },
  { id: 'trim', label: 'Trim' },
  { id: 'siding', label: 'Siding' },
  { id: 'gutters', label: 'Gutters' },
  { id: 'landscaping', label: 'Landscaping' },
  { id: 'cleaning', label: 'Cleaning' },
  { id: 'appliances', label: 'Appliances' },
  { id: 'garage_door', label: 'Garage Door' },
  { id: 'other', label: 'Other' },
]

export const DELAY_REASONS = [
  { id: 'weather', icon: '🌧️', label: 'Weather', description: 'Rain, snow, extreme temps' },
  { id: 'material_delay', icon: '📦', label: 'Material Delay', description: 'Backordered, late shipment' },
  { id: 'material_wrong', icon: '📦❌', label: 'Material Wrong', description: 'Wrong item delivered' },
  { id: 'labor_no_show', icon: '👷❌', label: 'Labor No-Show', description: "Sub didn't show up" },
  { id: 'labor_shortage', icon: '👷', label: 'Labor Shortage', description: 'Not enough crew' },
  { id: 'inspection_failed', icon: '🔍❌', label: 'Inspection Failed', description: 'Failed, needs rework' },
  { id: 'inspection_delayed', icon: '🔍', label: 'Inspection Delayed', description: "Inspector didn't come" },
  { id: 'permit_issue', icon: '📋', label: 'Permit Issue', description: 'Permit problem' },
  { id: 'prior_trade', icon: '🏗️', label: 'Prior Trade', description: 'Previous trade not done' },
  { id: 'change_order', icon: '✏️', label: 'Change Order', description: 'Scope changed' },
  { id: 'owner_request', icon: '🏠', label: 'Owner Request', description: 'Buyer requested delay' },
  { id: 'other', icon: '❓', label: 'Other', description: 'Other reason' },
]

export const COMMUNITY_SPEC_CATEGORIES = [
  { id: 'plumbing', label: '🚿 Plumbing', trade: 'plumbing' },
  { id: 'electrical', label: '⚡ Electrical', trade: 'electrical' },
  { id: 'hvac', label: '❄️ HVAC', trade: 'hvac' },
  { id: 'exterior', label: '🏠 Exterior', trade: null },
  { id: 'interior', label: '🛋️ Interior', trade: null },
  { id: 'appliances', label: '🍳 Appliances', trade: 'appliances' },
  { id: 'hoa_rules', label: '📜 HOA Rules', trade: null },
  { id: 'structural', label: '🏗️ Structural', trade: null },
  { id: 'other', label: '📝 Other', trade: null },
]

export const INSPECTION_TYPES = [
  { code: 'PRE', label: 'Pre-Pour', trigger: 'Footings', blocksNext: 'Foundation Pour' },
  { code: 'FND', label: 'Foundation', trigger: 'Foundation Cure', blocksNext: 'Backfill' },
  { code: 'FRM', label: 'Framing', trigger: 'Roofing', blocksNext: 'Windows/Doors' },
  { code: 'REL', label: 'Rough Electrical', trigger: 'Rough Electrical', blocksNext: 'Insulation' },
  { code: 'RPL', label: 'Rough Plumbing', trigger: 'Rough Plumbing', blocksNext: 'Insulation' },
  { code: 'RHV', label: 'Rough HVAC', trigger: 'Rough HVAC', blocksNext: 'Insulation' },
  { code: 'RME', label: 'Rough MEP (Combined)', trigger: 'All Rough', blocksNext: 'Insulation' },
  { code: 'INS', label: 'Insulation', trigger: 'Insulation', blocksNext: 'Drywall Hang' },
  { code: 'DRY', label: 'Drywall', trigger: 'Drywall Hang', blocksNext: 'Drywall Finish' },
  { code: 'FEL', label: 'Final Electrical', trigger: 'Final Electrical', blocksNext: 'Final Clean' },
  { code: 'FPL', label: 'Final Plumbing', trigger: 'Final Plumbing', blocksNext: 'Final Clean' },
  { code: 'FHV', label: 'Final HVAC', trigger: 'Final HVAC', blocksNext: 'Final Clean' },
  { code: 'FIN', label: 'Final Building', trigger: 'Final Clean', blocksNext: 'Punch Complete' },
  { code: 'COO', label: 'Certificate of Occupancy', trigger: 'Punch Complete', blocksNext: 'Handover' },
]

export const INSPECTION_CHECKLISTS = {
  PRE: [
    { id: 'pre-1', label: 'Footing depth per plan', required: true },
    { id: 'pre-2', label: 'Rebar placement correct', required: true },
    { id: 'pre-3', label: 'Form boards in place', required: true },
    { id: 'pre-4', label: 'Soil compaction verified', required: false },
  ],
  FND: [
    { id: 'fnd-1', label: 'Foundation walls plumb', required: true },
    { id: 'fnd-2', label: 'Anchor bolts installed', required: true },
    { id: 'fnd-3', label: 'No visible cracks', required: true },
  ],
  FRM: [
    { id: 'frm-1', label: 'Wall framing per plan', required: true },
    { id: 'frm-2', label: 'Roof trusses secured', required: true },
    { id: 'frm-3', label: 'Sheathing complete', required: true },
    { id: 'frm-4', label: 'Window/door openings correct', required: true },
  ],
  REL: [
    { id: 'rel-1', label: 'Panel installed and labeled', required: true },
    { id: 'rel-2', label: 'Rough wiring secured', required: true },
  ],
  RPL: [
    { id: 'rpl-1', label: 'Water lines pressure tested', required: true },
    { id: 'rpl-2', label: 'Drain lines sloped correctly', required: true },
  ],
  RHV: [
    { id: 'rhv-1', label: 'Ductwork sealed', required: true },
    { id: 'rhv-2', label: 'Equipment set and strapped', required: true },
  ],
  RME: [
    { id: 'rme-1', label: 'Electrical, plumbing, HVAC rough complete', required: true },
  ],
  INS: [
    { id: 'ins-1', label: 'Insulation depth meets spec', required: true },
    { id: 'ins-2', label: 'Baffles installed at soffits', required: false },
  ],
  DRY: [
    { id: 'dry-1', label: 'Drywall hung per plan', required: true },
    { id: 'dry-2', label: 'Nail/screw pattern correct', required: true },
  ],
  FIN: [
    { id: 'fin-1', label: 'Final clean complete', required: true },
    { id: 'fin-2', label: 'Safety items addressed', required: true },
  ],
  COO: [
    { id: 'coo-1', label: 'CO documents completed', required: true },
    { id: 'coo-2', label: 'All finals passed', required: true },
  ],
}

export const BUILDER_COLORS = ['#3B82F6', '#22C55E', '#F59E0B', '#EF4444', '#0EA5E9', '#8B5CF6', '#10B981']

export const SOLD_STATUSES = [
  { id: 'available', label: 'Available' },
  { id: 'pending', label: 'Pending' },
  { id: 'sold', label: 'Sold' },
]

export const PUNCH_CATEGORIES = [
  { id: 'exterior', label: 'Exterior', items: ['Paint/Stain', 'Siding/Trim', 'Concrete/Flatwork', 'Roofing/Gutters', 'Landscaping'] },
  { id: 'interior', label: 'Interior', items: ['Drywall', 'Paint', 'Flooring', 'Trim/Baseboards', 'Doors', 'Cabinets', 'Countertops'] },
  { id: 'mechanical', label: 'Mechanical', items: ['Electrical', 'Plumbing', 'HVAC', 'Appliances'] },
  { id: 'doors_windows', label: 'Doors & Windows', items: ['Entry doors', 'Interior doors', 'Windows', 'Screens', 'Locks/Hardware'] },
  { id: 'final', label: 'Final', items: ['Cleaning', 'Touch-up', 'Labels/Stickers', 'Manuals/Warranty docs'] },
]

export const PHOTO_CATEGORIES = [
  { id: 'progress', label: 'Progress' },
  { id: 'issue', label: 'Issue' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'inspection', label: 'Inspection' },
  { id: 'punch', label: 'Punch' },
  { id: 'daily', label: 'Daily' },
  { id: 'milestone', label: 'Milestone' },
  { id: 'safety', label: 'Safety' },
]

export const PHOTO_REQUIREMENTS = {
  Foundation: { min: 2, angles: ['overview', 'detail'], milestone: true },
  Framing: { min: 4, angles: ['front', 'back', 'interior', 'roof'], milestone: true },
  Roofing: { min: 2, angles: ['front_elevation', 'detail'], milestone: true },
  'Rough Inspection': { min: 3, angles: ['electrical', 'plumbing', 'hvac'], milestone: false },
  Drywall: { min: 2, angles: ['before_texture', 'after_texture'], milestone: true },
  'Final Inspection': { min: 6, angles: ['front', 'back', 'kitchen', 'master', 'living', 'garage'], milestone: true },
}

export const WEATHER_THRESHOLDS = {
  rain_probability: 50,
  wind_speed: 25,
  temp_low: 35,
  temp_high: 100,
}

export const OUTDOOR_TASK_NAMES = [
  'Stake Lot',
  'Excavation',
  'Footings',
  'Form / Gravel Deliver',
  'Form Checks / Elevation Certificate',
  'Plumbing Slab',
  'Plumbing Slab Inspection',
  'Prep Slab / Sling Gravel',
  'Slab Inspection',
  'Foundation Pour',
  'Backfill',
  'Slab Grade',
  'Frame Delivery',
  'Framing',
  'Roof Sheathing',
  'Roofing',
  'Windows/Doors',
  'Window & Door Install',
  'Siding',
  'Exterior Brick/Stone',
  'Exterior Paint',
  'Gutters',
  'Concrete Flatwork',
  'Landscaping',
  'Garage Door',
]

export const MILESTONES = [
  { id: 'permit_issued', label: 'Permit Issued', trigger: null, pct: 0, short: 'PER', manual: true },
  { id: 'foundation_complete', label: 'Foundation Complete', trigger: 'Slab Grade', pct: 8, short: 'FND' },
  { id: 'framing_complete', label: 'Framing Complete', trigger: 'Framing', pct: 20, short: 'FRM' },
  { id: 'dried_in', label: 'Dried-In', trigger: 'Roofing', pct: 27, short: 'DRY' },
  { id: 'rough_complete', label: 'Rough Complete', trigger: 'Rough Inspection (Final)', pct: 45, short: 'RGH' },
  { id: 'drywall_complete', label: 'Drywall Complete', trigger: 'Drywall Hang', pct: 55, short: 'DRW' },
  { id: 'trim_complete', label: 'Trim Complete', trigger: 'Final Trim Install / Countertop Install', pct: 75, short: 'TRM' },
  { id: 'final_inspection', label: 'Final Inspection', trigger: 'Final Inspection', pct: 95, short: 'FIN' },
  { id: 'co', label: 'Certificate of Occupancy', trigger: null, pct: 98, short: 'CO', manual: true },
  { id: 'complete', label: 'Complete', trigger: 'Punch Complete', pct: 100, short: 'CMP' },
]

export const MESSAGE_TEMPLATES = {
  schedule_notification: `📅 NEW SCHEDULE - {community} {block}-{lot}\n\n{sub_name}, you are scheduled for:\n\nTask: {task_name}\nDate: {start_date} - {end_date}\nAddress: {lot_address}\n\nPlease confirm availability.\nReply Y to confirm, N if conflict.\n\n- {builder_name}`,
  schedule_change: `📅 SCHEDULE UPDATE - {community} {block}-{lot}\n\n{sub_name}, your schedule has changed:\n\nTask: {task_name}\nOLD: {old_start_date}\nNEW: {new_start_date}\n\nReason: {change_reason}\n\nReply Y to confirm, Q with questions.\n\n- {builder_name}`,
  day_before_reminder: `⏰ REMINDER - Tomorrow\n\n{sub_name}, reminder for tomorrow:\n\nTask: {task_name}\nLocation: {lot_address}\nCommunity: {community} {block}-{lot}\n\nContact super: {super_phone}\n\n- {builder_name}`,
  inspection_failed: `⚠️ INSPECTION FAILED - {community} {block}-{lot}\n\n{sub_name}, the {inspection_type} inspection failed.\n\nIssues requiring your attention:\n{failure_items_list}\n\nPlease schedule time to correct.\nRe-inspection needed by: {target_date}\n\nContact: {super_phone}\n\n- {builder_name}`,
  punch_item_assigned: `🧾 PUNCH ITEM - {community} {block}-{lot}\n\n{sub_name}, a new punch item was assigned:\n\n{description}\nLocation: {location}\nPriority: {priority}\n\nPlease reply when you can address this item.\n\n- {builder_name}`,
}

export const PUNCH_TEMPLATE = [
  // Exterior
  { category: 'Exterior', subcategory: 'Paint/Stain', description: 'Check all fascia, soffit, trim for touch-up' },
  { category: 'Exterior', subcategory: 'Siding/Trim', description: 'Check siding for damage, gaps' },
  { category: 'Exterior', subcategory: 'Concrete/Flatwork', description: 'Check driveway, walkways for cracks' },
  { category: 'Exterior', subcategory: 'Landscaping', description: 'Check sod, plants, mulch' },

  // Interior
  { category: 'Interior', subcategory: 'Drywall', description: 'Walk all rooms for dings, nail pops' },
  { category: 'Interior', subcategory: 'Paint', description: 'Check all walls, ceilings, trim' },
  { category: 'Interior', subcategory: 'Flooring', description: 'Check all flooring for damage, gaps' },
  { category: 'Interior', subcategory: 'Trim/Baseboards', description: 'Check all baseboards, casing, crown' },
  { category: 'Interior', subcategory: 'Cabinets', description: 'Check all doors, drawers, alignment' },

  // Mechanicals
  { category: 'Mechanical', subcategory: 'Electrical', description: 'Test all outlets, switches, fixtures' },
  { category: 'Mechanical', subcategory: 'Plumbing', description: 'Test all faucets, toilets, drains' },
  { category: 'Mechanical', subcategory: 'HVAC', description: 'Test all registers, thermostat, airflow' },
  { category: 'Mechanical', subcategory: 'Appliances', description: 'Test all appliances, verify manuals' },

  // Final + Doors/Windows
  { category: 'Final', subcategory: 'Cleaning', description: 'Final clean complete, no construction debris' },
  { category: 'Doors & Windows', subcategory: 'Locks/Hardware', description: 'Check all doors, windows, locks, screens' },
]

export const CHANGE_ORDER_CATEGORIES = [
  { id: 'structural', label: 'Structural' },
  { id: 'electrical', label: 'Electrical' },
  { id: 'plumbing', label: 'Plumbing' },
  { id: 'hvac', label: 'HVAC' },
  { id: 'exterior', label: 'Exterior' },
  { id: 'interior_finish', label: 'Interior Finish' },
  { id: 'appliances', label: 'Appliances' },
  { id: 'landscaping', label: 'Landscaping' },
  { id: 'other', label: 'Other' },
]

export const CHANGE_ORDER_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'pending_buyer_approval',
  'approved',
  'declined',
  'in_progress',
  'complete',
  'cancelled',
]

export const MATERIAL_CATEGORIES = [
  { id: 'windows', label: 'Windows', typical_lead_days: 35 },
  { id: 'doors_exterior', label: 'Exterior Doors', typical_lead_days: 21 },
  { id: 'doors_interior', label: 'Interior Doors', typical_lead_days: 14 },
  { id: 'cabinets', label: 'Cabinets', typical_lead_days: 42 },
  { id: 'countertops', label: 'Countertops', typical_lead_days: 17 },
  { id: 'appliances', label: 'Appliances', typical_lead_days: 14 },
  { id: 'hvac_equipment', label: 'HVAC Equipment', typical_lead_days: 10 },
  { id: 'flooring', label: 'Flooring', typical_lead_days: 21 },
  { id: 'trusses', label: 'Trusses', typical_lead_days: 21 },
  { id: 'roofing', label: 'Roofing', typical_lead_days: 14 },
  { id: 'siding', label: 'Siding', typical_lead_days: 14 },
  { id: 'garage_door', label: 'Garage Door', typical_lead_days: 10 },
  { id: 'fireplace', label: 'Fireplace', typical_lead_days: 21 },
  { id: 'fixtures', label: 'Fixtures', typical_lead_days: 10 },
  { id: 'lighting', label: 'Lighting', typical_lead_days: 10 },
  { id: 'hardware', label: 'Hardware', typical_lead_days: 7 },
  { id: 'other', label: 'Other', typical_lead_days: 14 },
]

export const MATERIAL_STATUSES = [
  'not_ordered',
  'quote_requested',
  'ordered',
  'order_confirmed',
  'in_production',
  'ready_to_ship',
  'shipped',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'installed',
  'backordered',
  'cancelled',
]
