import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Building2,
  Calendar,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudRain,
  DollarSign,
  Download,
  GripVertical,
  Image,
  LayoutGrid,
  Lock,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  Play,
  Plus,
  Sun,
  Upload,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'

import { createSeedState } from './data/seed.js'
import {
  COMMUNITY_SPEC_CATEGORIES,
  CHANGE_ORDER_CATEGORIES,
  CHANGE_ORDER_STATUSES,
  BUILDER_COLORS,
  DELAY_REASONS,
  INSPECTION_CHECKLISTS,
  INSPECTION_TYPES,
  MATERIAL_CATEGORIES,
  MATERIAL_STATUSES,
  MILESTONES,
  MESSAGE_TEMPLATES,
  OUTDOOR_TASK_NAMES,
  PHOTO_CATEGORIES,
  PHOTO_REQUIREMENTS,
  PUNCH_CATEGORIES,
  PUNCH_TEMPLATE,
  TRADES,
  WEATHER_THRESHOLDS,
} from './data/constants.js'
import {
  addCalendarDays,
  daysBetweenCalendar,
  formatISODate,
  formatISODateInTimeZone,
  formatLongDate,
  formatShortDate,
  formatShortDateWithWeekday,
  makeWorkdayHelpers,
  parseISODate,
} from './lib/date.js'
import { fillTemplate } from './lib/templating.js'
import { clearAppState, loadAppState, loadAppStateFromIdb, loadStoredAppStateRaw, saveAppState } from './lib/storage.js'
import { normalizeRange, toRangeString, validateAssignments } from './lib/utils.js'
import {
  applyDelayCascade,
  applyDurationChange,
  applyListReorder,
  applyManualStartDate,
  buildReschedulePreview,
  calculateLotProgress,
  calculateTargetCompletionDate,
  deriveTaskStatus,
  getCurrentMilestone,
  getPredictedCompletionDate,
  previewDelayImpact,
  normalizeTrackSortOrderBySchedule,
  rebuildTrackSchedule,
  insertBufferTaskAfter,
  removeBufferTask,
  refreshReadyStatuses,
  startLotFromTemplate,
} from './lib/scheduleEngine.js'
import { deleteBlob, getBlob, putBlob } from './lib/idb.js'
import { ensureImportedFromSnapshotV1, outboxAck, outboxEnqueue, outboxList, outboxListV2Due, outboxUpdate, getSyncV2Cursor, setSyncV2Cursor } from './lib/localDb.js'
import { isSyncV2Enabled, writeFlag } from './lib/flags.js'
import { syncV2Pull, syncV2Push } from './lib/syncV2.js'
import { uuid } from './lib/uuid.js'
import { supabase } from './lib/supabaseClient.js'

const WEATHER_FALLBACK = {
  name: 'Madison, AL',
  latitude: 34.6993,
  longitude: -86.7483,
  timezone: 'America/Chicago',
  source: 'fallback',
}

const WEATHER_HUNTSVILLE = {
  name: 'Huntsville, AL',
  latitude: 34.7304,
  longitude: -86.5861,
  timezone: 'America/Chicago',
  source: 'manual',
}

const COMMUNITY_WEATHER_ANCHORS = [
  {
    id: 'ovation',
    community_name: 'ovation',
    street_keywords: ['350 lime quarry rd', '350 lime quarry road'],
    city: 'madison',
    state: 'al',
    zip: '35758',
    name: 'Ovation at Town Madison',
    latitude: 34.6770694,
    longitude: -86.7406771,
    timezone: 'America/Chicago',
  },
  {
    id: 'grove',
    community_name: 'the grove',
    street_keywords: ['390 saint louis street', '390 st louis street'],
    city: 'madison',
    state: 'al',
    zip: '35758',
    name: 'The Grove',
    latitude: 34.6774023,
    longitude: -86.7304281,
    timezone: 'America/Chicago',
  },
]

const normalizeWeatherText = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('.', '')
    .replaceAll(',', '')
    .replaceAll(/\s+/g, ' ')

const resolveCommunityWeatherAnchor = (community) => {
  if (!community) return null
  const name = normalizeWeatherText(community.name)
  const street = normalizeWeatherText(community.address?.street)
  const city = normalizeWeatherText(community.address?.city)
  const state = normalizeWeatherText(community.address?.state)
  const zip = normalizeWeatherText(community.address?.zip)

  for (const anchor of COMMUNITY_WEATHER_ANCHORS) {
    const nameHit = name.includes(anchor.community_name)
    const streetHit = (anchor.street_keywords ?? []).some((token) => street.includes(normalizeWeatherText(token)))
    const cityHit = !anchor.city || city === anchor.city
    const stateHit = !anchor.state || state === anchor.state
    const zipHit = !anchor.zip || zip === anchor.zip
    if (nameHit || (streetHit && cityHit && stateHit && zipHit)) return anchor
  }

  return null
}

const buildCommunityWeatherLocation = (communities = [], lots = []) => {
  const activeCommunityIds = new Set((lots ?? []).filter((lot) => lot?.status === 'in_progress').map((lot) => lot.community_id))
  const orderedCommunities =
    activeCommunityIds.size > 0
      ? [...(communities ?? [])].filter((community) => activeCommunityIds.has(community.id))
      : [...(communities ?? [])]

  const matches = orderedCommunities
    .map((community) => ({ community, anchor: resolveCommunityWeatherAnchor(community) }))
    .filter((entry) => entry.anchor)

  if (matches.length === 0) return null

  if (matches.length === 1) {
    const { anchor, community } = matches[0]
    return {
      name: `${anchor.name} (${community.name})`,
      latitude: anchor.latitude,
      longitude: anchor.longitude,
      timezone: anchor.timezone,
      source: 'community',
    }
  }

  const avgLat = matches.reduce((acc, entry) => acc + Number(entry.anchor.latitude), 0) / matches.length
  const avgLon = matches.reduce((acc, entry) => acc + Number(entry.anchor.longitude), 0) / matches.length
  return {
    id: 'community',
    name: 'Breland Communities - Madison, AL',
    latitude: avgLat,
    longitude: avgLon,
    timezone: 'America/Chicago',
    source: 'community',
  }
}

const TASK_CATEGORIES = [
  { id: 'foundation', label: 'Foundation', track: 'foundation', phase: 'foundation', is_outdoor: true },
  { id: 'structure', label: 'Structure', track: 'structure', phase: 'framing', is_outdoor: false },
  { id: 'interior', label: 'Interior Track', track: 'interior', phase: 'finishes', is_outdoor: false },
  { id: 'exterior', label: 'Exterior Track', track: 'exterior', phase: 'exterior', is_outdoor: true },
  { id: 'final', label: 'Final', track: 'final', phase: 'final', is_outdoor: false },
  { id: 'misc', label: 'Miscellaneous', track: 'misc', phase: 'misc', is_outdoor: false },
]

const TASK_PRESETS = [
  { id: 'siding', name: 'Siding', trade: 'siding', duration: 5, category: 'exterior' },
  { id: 'siding_soffit', name: 'Siding/Soffit', trade: 'siding', duration: 5, category: 'exterior' },
  { id: 'brick', name: 'Exterior Brick/Stone', trade: 'siding', duration: 4, category: 'exterior' },
  { id: 'paint', name: 'Exterior Paint', trade: 'paint', duration: 3, category: 'exterior' },
  { id: 'gutters', name: 'Gutters', trade: 'gutters', duration: 1, category: 'exterior' },
  { id: 'flatwork', name: 'Concrete Flatwork', trade: 'concrete', duration: 3, category: 'exterior' },
  { id: 'landscaping', name: 'Landscaping', trade: 'landscaping', duration: 3, category: 'exterior' },
  { id: 'pest_control', name: 'Pest Control', trade: 'other', duration: 1, category: 'exterior' },
  { id: 'garage_door', name: 'Garage Door', trade: 'garage_door', duration: 1, category: 'interior' },
]

const CUSTOM_TASK_PRESET = { id: 'custom', name: 'Custom', trade: 'other', duration: 1, category: 'misc' }
const DURATION_OPTIONS = Array.from({ length: 10 }, (_, i) => i + 1)
const FILE_ACCEPT = '.pdf,.csv,.xls,.xlsx,.doc,.docx,.ppt,.pptx,.txt,.rtf,.jpg,.jpeg,.png,.heic,.heif'
const SUPABASE_ORG_ID_FALLBACK = String(import.meta.env.VITE_SUPABASE_ORG_ID ?? '').trim()

const getWeatherFromCode = (code) => {
  const n = Number(code)
  if (n === 0) return { condition: 'Clear', icon: Sun }
  if (n === 1 || n === 2) return { condition: 'Partly cloudy', icon: Cloud }
  if (n === 3) return { condition: 'Cloudy', icon: Cloud }
  if (n === 45 || n === 48) return { condition: 'Fog', icon: Cloud }
  if ((n >= 51 && n <= 67) || (n >= 80 && n <= 82)) return { condition: 'Rain', icon: CloudRain }
  if (n >= 95 && n <= 99) return { condition: 'Storms', icon: CloudRain }
  return { condition: 'Weather', icon: Cloud }
}

const build7DayForecast = (daily) => {
  const times = daily?.time ?? []
  const tMax = daily?.temperature_2m_max ?? []
  const tMin = daily?.temperature_2m_min ?? []
  const precipMax = daily?.precipitation_probability_max ?? []
  const codes = daily?.weathercode ?? []
  const windMax = daily?.wind_speed_10m_max ?? []

  return times.slice(0, 7).map((iso, i) => {
    const when = parseISODate(iso)
    const md = when ? `${when.getMonth() + 1}/${when.getDate()}` : ''
    const label =
      i === 0
        ? 'Today'
        : i === 1
          ? 'Tomorrow'
          : when
            ? when.toLocaleDateString('en-US', { weekday: 'short' })
            : `Day ${i + 1}`

    const { condition, icon } = getWeatherFromCode(codes[i])

    return {
      date: iso,
      md,
      label,
      icon,
      condition,
      max: Number.isFinite(Number(tMax[i])) ? Math.round(Number(tMax[i])) : null,
      min: Number.isFinite(Number(tMin[i])) ? Math.round(Number(tMin[i])) : null,
      rainChance: Number.isFinite(Number(precipMax[i])) ? Math.round(Number(precipMax[i])) : null,
      windMax: Number.isFinite(Number(windMax[i])) ? Math.round(Number(windMax[i])) : null,
    }
  })
}

const Card = ({ children, className = '' }) => (
  <div className={`bg-white rounded-xl border border-gray-200 p-4 ${className}`}>{children}</div>
)

const PrimaryButton = ({ children, className = '', type = 'button', ...props }) => (
  <button
    type={type}
    {...props}
    className={`h-12 px-4 rounded-xl bg-blue-600 text-white font-semibold disabled:opacity-50 ${className}`}
  >
    {children}
  </button>
)

const SecondaryButton = ({ children, className = '', type = 'button', ...props }) => (
  <button
    type={type}
    {...props}
    className={`h-12 px-4 rounded-xl bg-white border border-gray-200 text-gray-900 font-semibold disabled:opacity-50 ${className}`}
  >
    {children}
  </button>
)

const IconButton = ({ children, className = '', type = 'button', ...props }) => (
  <button type={type} {...props} className={`p-2 rounded-xl bg-white/15 hover:bg-white/20 ${className}`}>
    {children}
  </button>
)

function SubcontractorCard({ sub, onEdit, onMessage, tradeLabel }) {
  const primary = sub?.primary_contact ?? {}
  const additional = Array.isArray(sub?.additional_contacts) ? sub.additional_contacts : []

  const contacts = useMemo(() => {
    return [
      {
        id: primary.id ?? 'primary',
        name: primary.name ?? '',
        phone: primary.phone ?? '',
        email: primary.email ?? '',
        role: 'Primary Contact',
      },
      ...additional.map((c, idx) => ({
        id: c.id ?? `${sub?.id ?? 'sub'}-extra-${idx}`,
        name: c.name ?? '',
        phone: c.phone ?? '',
        email: c.email ?? '',
        role: 'Additional Contact',
      })),
    ].filter((c) => (c.name || c.phone || c.email))
  }, [additional, primary.email, primary.id, primary.name, primary.phone, sub?.id])

  const [contactIndex, setContactIndex] = useState(0)

  useEffect(() => {
    const max = Math.max(0, contacts.length - 1)
    setContactIndex((prev) => Math.max(0, Math.min(prev, max)))
  }, [contacts.length])

  const contactCount = contacts.length
  const activeContact = contactCount > 0 ? contacts[Math.min(contactIndex, contactCount - 1)] : null
  const contactPhone = (activeContact?.phone ?? '').trim()
  const contactEmail = (activeContact?.email ?? '').trim()

  const step = (delta) => {
    if (!contactCount) return
    setContactIndex((prev) => (prev + delta + contactCount) % contactCount)
  }

  return (
    <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-semibold">{sub?.company_name ?? 'Subcontractor'}</p>
          <p className="text-xs text-gray-600 mt-1">Trade: {tradeLabel ?? sub?.trade ?? 'other'}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <div className="bg-white border border-gray-200 rounded-xl p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">{activeContact?.role ?? 'Contact'}</p>
              <p className="text-xs text-gray-500">
                {contactCount > 0 ? `${Math.min(contactIndex, contactCount - 1) + 1}/${contactCount}` : '0/0'}
              </p>
            </div>
            {activeContact ? (
              <>
                <p className="text-sm font-semibold mt-1">{activeContact.name || 'Unnamed Contact'}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs mt-2">
                  {contactPhone ? (
                    <a
                      href={`tel:${contactPhone}`}
                      className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition hover:border-blue-200 hover:text-blue-700"
                    >
                      <Phone className="w-3.5 h-3.5 text-blue-600" />
                      <span className="tracking-tight">{contactPhone}</span>
                    </a>
                  ) : null}
                  {contactEmail ? (
                    <a
                      href={`mailto:${contactEmail}`}
                      title={contactEmail}
                      className="inline-flex min-w-0 items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition hover:border-blue-200 hover:text-blue-700"
                    >
                      <Mail className="w-3.5 h-3.5 text-blue-600" />
                      <span className="max-w-[220px] truncate sm:max-w-none">{contactEmail}</span>
                    </a>
                  ) : null}
                </div>
                {contactCount > 1 ? (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => step(-1)}
                      className="h-8 w-8 rounded-full border border-gray-200 bg-white flex items-center justify-center text-gray-500"
                      aria-label="Previous contact"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => step(1)}
                      className="h-8 w-8 rounded-full border border-gray-200 bg-white flex items-center justify-center text-gray-500"
                      aria-label="Next contact"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                    <p className="text-xs text-gray-500">Swipe to flip</p>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-gray-500 mt-1">No contacts yet.</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onEdit} className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white">
            Edit
          </button>
          <button onClick={onMessage} className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white">
            Message
          </button>
        </div>
      </div>
    </div>
  )
}

let modalScrollLockCount = 0
let modalScrollTop = 0
let modalScrollStyles = null

const lockBodyScroll = () => {
  if (typeof document === 'undefined') return () => {}

  modalScrollLockCount += 1
  if (modalScrollLockCount > 1) return () => unlockBodyScroll()

  const body = document.body
  const docEl = document.documentElement
  modalScrollTop = window.scrollY || window.pageYOffset || 0
  modalScrollStyles = {
    bodyOverflow: body.style.overflow,
    bodyPosition: body.style.position,
    bodyTop: body.style.top,
    bodyWidth: body.style.width,
    docOverflow: docEl.style.overflow,
  }

  body.style.overflow = 'hidden'
  body.style.position = 'fixed'
  body.style.top = `-${modalScrollTop}px`
  body.style.width = '100%'
  docEl.style.overflow = 'hidden'

  return () => unlockBodyScroll()
}

const unlockBodyScroll = () => {
  if (typeof document === 'undefined') return
  if (modalScrollLockCount === 0) return

  modalScrollLockCount -= 1
  if (modalScrollLockCount > 0) return

  const body = document.body
  const docEl = document.documentElement
  if (modalScrollStyles) {
    body.style.overflow = modalScrollStyles.bodyOverflow
    body.style.position = modalScrollStyles.bodyPosition
    body.style.top = modalScrollStyles.bodyTop
    body.style.width = modalScrollStyles.bodyWidth
    docEl.style.overflow = modalScrollStyles.docOverflow
  } else {
    body.style.overflow = ''
    body.style.position = ''
    body.style.top = ''
    body.style.width = ''
    docEl.style.overflow = ''
  }

  window.scrollTo(0, modalScrollTop)
  modalScrollStyles = null
}

function Modal({ title, onClose, children, footer, zIndex = 'z-[70]' }) {
  useEffect(() => lockBodyScroll(), [])

  return (
    <div className={`fixed inset-0 bg-black/40 ${zIndex} flex items-end sm:items-center justify-center`}>
      <div className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl p-4 border border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-lg">{title}</h2>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-auto pb-2">{children}</div>
        {footer ? <div className="pt-3 border-t mt-3">{footer}</div> : null}
      </div>
    </div>
  )
}

const STATUS_BADGE = {
  complete: { label: '✓ Complete', cls: 'bg-green-50 text-green-700 border-green-200' },
  in_progress: { label: '⏳ In Progress', cls: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
  delayed: { label: '⚠️ Delayed', cls: 'bg-red-50 text-red-700 border-red-200' },
  blocked: { label: '🔒 Blocked', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  pending: { label: '○ Not Started', cls: 'bg-gray-50 text-gray-600 border-gray-200' },
}

const TASK_STATUS_COLORS = {
  complete: '#22C55E',
  in_progress: '#3B82F6',
  delayed: '#EF4444',
  blocked: '#F97316',
  ready: '#8B5CF6',
  pending: '#D1D5DB',
}

const DASHBOARD_STATUS_META = {
  active: {
    title: 'Active Lots',
    empty: 'No active lots yet.',
    hint: 'All in-progress lots.',
  },
  on_track: {
    title: 'On Track Lots',
    empty: 'No on-track lots right now.',
    hint: 'In-progress lots with no delayed tasks.',
  },
  delayed: {
    title: 'Delayed Lots',
    empty: 'No delayed lots right now.',
    hint: 'In-progress lots with at least one delayed task.',
  },
}

const TaskStatusBadge = ({ status }) => {
  const entry = STATUS_BADGE[status === 'ready' ? 'pending' : status] ?? STATUS_BADGE.pending
  return <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-lg border ${entry.cls}`}>{entry.label}</span>
}

const isMilestoneAchieved = (lot, milestone) => {
  if (!lot || !milestone) return false
  const manual = lot.manual_milestones ?? {}

  if (milestone.id === 'permit_issued') return Boolean(manual.permit_issued)
  if (milestone.id === 'co') return Boolean(manual.co)
  if (milestone.id === 'rough_complete') {
    const rough = (lot.tasks ?? []).filter((t) => ['Rough Electrical', 'Rough Plumbing', 'Rough HVAC'].includes(t.name))
    return rough.length > 0 && rough.every((t) => t.status === 'complete')
  }

  const trigger = milestone.trigger
  if (!trigger) return false
  const t = (lot.tasks ?? []).find((x) => x.name === trigger)
  return t?.status === 'complete'
}

const MilestoneDots = ({ lot, className = '' }) => {
  const current = getCurrentMilestone(lot)
  return (
    <div className={`mt-2 ${className}`}>
      <div className="flex items-start justify-between gap-1">
        {(MILESTONES ?? []).map((m) => {
          const achieved = isMilestoneAchieved(lot, m)
          const isCurrent = current?.id === m.id
          return (
            <div key={m.id} className="flex flex-col items-center flex-1 min-w-0">
              <div
                className={`w-3 h-3 rounded-full ${achieved ? 'bg-blue-600' : 'bg-gray-300'} ${isCurrent ? 'ring-2 ring-blue-300' : ''}`}
                title={m.label}
              />
              <span className={`mt-1 text-[10px] ${achieved ? 'text-gray-700' : 'text-gray-400'}`}>{m.short}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const lotCode = (lot) => {
  if (!lot) return '--'
  const block = String(lot.block ?? '').trim()
  const lotNumber = lot.lot_number ?? ''
  return block ? `${block}-${lotNumber}` : `Lot ${lotNumber}`
}

const parseLotNumberKey = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return { hasNum: false, num: null, suffix: '', raw: '' }
  const m = raw.match(/(\d+)/)
  if (!m) return { hasNum: false, num: null, suffix: '', raw: raw.toLowerCase() }
  const num = Number.parseInt(m[1], 10)
  const suffix = raw.replace(m[1], '').trim().toLowerCase()
  return { hasNum: Number.isFinite(num), num: Number.isFinite(num) ? num : null, suffix, raw: raw.toLowerCase() }
}

const compareLotNumbers = (a, b) => {
  const ka = parseLotNumberKey(a)
  const kb = parseLotNumberKey(b)
  if (ka.hasNum && kb.hasNum) {
    if (ka.num !== kb.num) return ka.num - kb.num
    const suffixCmp = ka.suffix.localeCompare(kb.suffix)
    if (suffixCmp) return suffixCmp
    return ka.raw.localeCompare(kb.raw)
  }
  if (ka.hasNum !== kb.hasNum) return ka.hasNum ? -1 : 1
  return ka.raw.localeCompare(kb.raw)
}

const compareCommunityLots = (a, b) => {
  const blockCmp = String(a?.block ?? '').localeCompare(String(b?.block ?? ''), undefined, { numeric: true, sensitivity: 'base' })
  if (blockCmp) return blockCmp
  const numCmp = compareLotNumbers(a?.lot_number, b?.lot_number)
  if (numCmp) return numCmp
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
}

const sanitizeStorageFileName = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return 'file'
  // Storage object names are path-based; never allow user-provided path segments.
  const cleaned = raw.replaceAll('\\', '/').split('/').pop() || raw
  return cleaned.replaceAll(/[^\w.\- ()]/g, '_').slice(0, 160) || 'file'
}

const encodeRemoteBlobId = (bucket, path) => {
  const b = String(bucket ?? '').trim()
  const p = String(path ?? '').trim()
  if (!b || !p) return ''
  return `sb:${b}:${p}`
}

const decodeRemoteBlobId = (blobId) => {
  const raw = String(blobId ?? '')
  if (!raw.startsWith('sb:')) return null
  const rest = raw.slice(3)
  const idx = rest.indexOf(':')
  if (idx < 0) return null
  const bucket = rest.slice(0, idx)
  const path = rest.slice(idx + 1)
  if (!bucket || !path) return null
  return { bucket, path }
}

const tintHex = (hex, alpha = '22') => (/^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alpha}` : hex)

const csvEscape = (value) => {
  const s = value == null ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

const rowsToCsv = (rows) => rows.map((r) => r.map(csvEscape).join(',')).join('\n')

const downloadTextFile = (filename, text, mime = 'text/plain;charset=utf-8') => {
  try {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (err) {
    console.error(err)
    alert('Download failed in this browser.')
  }
}

const IMAGE_MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

const inferImageMimeFromName = (name) => {
  const lower = String(name ?? '').toLowerCase()
  const ext = Object.keys(IMAGE_MIME_BY_EXT).find((key) => lower.endsWith(key))
  return ext ? IMAGE_MIME_BY_EXT[ext] : ''
}

const sniffImageMime = async (file) => {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif'
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
      return 'image/webp'
    }
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
      const brand = String.fromCharCode(head[8], head[9], head[10], head[11]).toLowerCase()
      if (['heic', 'heif', 'hevc', 'hevx', 'mif1'].includes(brand)) return 'image/heic'
    }
  } catch (err) {
    console.error(err)
  }
  return ''
}

const normalizeImageBlob = async (file) => {
  if (!file || typeof file !== 'object') throw new Error('Invalid image')
  if (!file.size) throw new Error('Invalid image')
  const declaredType = String(file.type ?? '')
  const nameType = inferImageMimeFromName(file.name)
  const headerType = declaredType.startsWith('image/') ? declaredType : await sniffImageMime(file)
  const mime = declaredType.startsWith('image/') ? declaredType : (nameType || headerType)
  if (!mime || !mime.startsWith('image/')) throw new Error('Invalid image')
  const blob = file.slice(0, file.size, mime)
  const fallbackName = file.name || `photo.${mime.split('/')[1] || 'jpg'}`
  return { blob, mime, fileName: fallbackName, size: blob.size }
}

const normalizePhone = (phone) => String(phone ?? '').replace(/[^\d+]/g, '')

const formatPhoneInput = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '').slice(0, 10)
  if (digits.length <= 3) return digits
  if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
}

const buildSmsLink = (phone) => {
  const normalized = normalizePhone(phone)
  return normalized ? `sms:${normalized}` : ''
}

const buildMailtoLink = (email) => {
  const address = String(email ?? '').trim()
  return address ? `mailto:${address}` : ''
}

const getSubPhone = (sub) => sub?.phone || sub?.primary_contact?.phone || sub?.office_phone || ''
const getSubEmail = (sub) => sub?.email || sub?.primary_contact?.email || ''

const coerceArray = (value) => (Array.isArray(value) ? value : [])

const normalizeHolidayObjects = (nextLike, prevLike) => {
  const prev = Array.isArray(prevLike) ? prevLike : []
  const prevNameByDate = new Map(
    prev
      .map((h) => (h && typeof h === 'object' ? { date: String(h.date ?? '').trim(), name: String(h.name ?? '').trim() } : null))
      .filter((h) => h?.date),
  )

  const next = Array.isArray(nextLike) ? nextLike : []
  const out = []
  for (const raw of next) {
    const date = typeof raw === 'string' ? raw.trim() : raw && typeof raw === 'object' ? String(raw.date ?? '').trim() : ''
    if (!date || !parseISODate(date)) continue
    const existingName = prevNameByDate.get(date)?.name ?? ''
    const name =
      raw && typeof raw === 'object' && 'name' in raw && String(raw.name ?? '').trim()
        ? String(raw.name ?? '').trim()
        : existingName
    out.push({ date, name })
  }
  return out
}

const toSupabaseHolidayDates = (holidaysLike) => {
  const list = Array.isArray(holidaysLike) ? holidaysLike : []
  const out = []
  for (const raw of list) {
    const date = typeof raw === 'string' ? raw.trim() : raw && typeof raw === 'object' ? String(raw.date ?? '').trim() : ''
    if (!date || !parseISODate(date)) continue
    out.push(date)
  }
  return out
}

const isBufferTask = (task) => {
  if (!task) return false
  if (task.is_buffer) return true
  if (String(task.kind ?? '').toLowerCase() === 'buffer') return true
  if (String(task.trade ?? '').toLowerCase() === 'buffer') return true
  if (String(task.name ?? '').trim().toLowerCase() === 'buffer') return true
  return false
}

const isMissingSupabaseTableError = (error) => {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '').toLowerCase()
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    message.includes('relation') && message.includes('does not exist') ||
    message.includes('could not find the table') && message.includes('schema cache')
  )
}

const mapTaskFromSupabase = (taskRow) => {
  const { dependencies: _dependencies, ...rest } = taskRow ?? {}
  return {
    ...rest,
    duration: Math.max(1, Number(taskRow?.duration ?? 1) || 1),
    sort_order: Number.isFinite(Number(taskRow?.sort_order)) ? Math.trunc(Number(taskRow.sort_order)) : 0,
  }
}

const mapLotFromSupabase = (lotRow, lotTasks = []) => ({
  ...lotRow,
  custom_fields: lotRow?.custom_fields ?? {},
  tasks: coerceArray(lotTasks),
  inspections: coerceArray(lotRow?.inspections),
  punch_list: lotRow?.punch_list ?? null,
  daily_logs: coerceArray(lotRow?.daily_logs),
  change_orders: coerceArray(lotRow?.change_orders),
  material_orders: coerceArray(lotRow?.material_orders),
  documents: coerceArray(lotRow?.documents),
  photos: coerceArray(lotRow?.photos),
})

const mapCommunityFromSupabase = (communityRow) => ({
  ...communityRow,
  builders: coerceArray(communityRow?.builders),
  realtors: coerceArray(communityRow?.realtors),
  inspectors: coerceArray(communityRow?.inspectors),
  documents: coerceArray(communityRow?.documents),
})

const mapSubcontractorFromSupabase = (subRow) => ({
  ...subRow,
  company_name: subRow?.company_name ?? subRow?.name ?? 'Subcontractor',
  trade: subRow?.trade ?? 'other',
  secondary_trades: coerceArray(subRow?.secondary_trades),
  primary_contact: {
    name: subRow?.primary_contact?.name ?? '',
    phone: subRow?.primary_contact?.phone ?? subRow?.phone ?? '',
    email: subRow?.primary_contact?.email ?? subRow?.email ?? '',
  },
  additional_contacts: coerceArray(subRow?.additional_contacts),
  office_phone: subRow?.office_phone ?? subRow?.phone ?? subRow?.primary_contact?.phone ?? '',
})

const toIsoDateOrNull = (value) => {
  if (!value) return null
  if (typeof value === 'string') return value
  if (value instanceof Date) return formatISODate(value)
  return String(value)
}

const mapProductTypeToSupabase = (row, orgId) => ({
  id: row?.id,
  org_id: orgId,
  name: row?.name ?? 'Product Type',
  build_days: Math.max(1, Number(row?.build_days ?? 1) || 1),
  template_id: row?.template_id ?? null,
  sort_order: Number.isFinite(Number(row?.sort_order)) ? Number(row.sort_order) : 0,
  is_active: row?.is_active !== false,
})

const mapPlanToSupabase = (row, orgId) => ({
  id: row?.id,
  org_id: orgId,
  name: row?.name ?? 'Plan',
  product_type_id: row?.product_type_id ?? null,
  sq_ft: Number.isFinite(Number(row?.sq_ft)) ? Number(row.sq_ft) : null,
  bedrooms: Number.isFinite(Number(row?.bedrooms)) ? Number(row.bedrooms) : null,
  bathrooms: Number.isFinite(Number(row?.bathrooms)) ? Number(row.bathrooms) : null,
  is_active: row?.is_active !== false,
})

const mapAgencyToSupabase = (row, orgId) => ({
  id: row?.id,
  org_id: orgId,
  name: row?.name ?? 'Agency',
  type: row?.type ?? 'municipality',
  inspection_types: coerceArray(row?.inspection_types),
  is_org_level: row?.is_org_level !== false,
  is_active: row?.is_active !== false,
})

const mapCommunityToSupabase = (row, orgId) => ({
  id: row?.id,
  org_id: orgId,
  name: row?.name ?? 'Community',
  address: row?.address ?? {},
  product_type_ids: coerceArray(row?.product_type_ids),
  lot_count: Math.max(0, Number(row?.lot_count ?? 0) || 0),
  lots_by_product_type: row?.lots_by_product_type ?? {},
  builders: coerceArray(row?.builders),
  realtors: coerceArray(row?.realtors),
  inspectors: coerceArray(row?.inspectors),
  agency_ids: coerceArray(row?.agency_ids),
  agencies: coerceArray(row?.agencies),
  documents: coerceArray(row?.documents),
  specs: coerceArray(row?.specs),
  is_active: row?.is_active !== false,
})

const mapSubcontractorToSupabase = (row, orgId) => ({
  id: row?.id,
  org_id: orgId,
  name: row?.name ?? row?.company_name ?? 'Subcontractor',
  company_name: row?.company_name ?? row?.name ?? 'Subcontractor',
  trade: row?.trade ?? 'other',
  secondary_trades: coerceArray(row?.secondary_trades),
  phone: row?.phone ?? row?.primary_contact?.phone ?? null,
  email: row?.email ?? row?.primary_contact?.email ?? null,
  office_phone: row?.office_phone ?? row?.phone ?? row?.primary_contact?.phone ?? null,
  primary_contact: row?.primary_contact ?? {},
  additional_contacts: coerceArray(row?.additional_contacts),
  insurance_expiration: toIsoDateOrNull(row?.insurance_expiration),
  license_number: row?.license_number ?? null,
  w9_on_file: Boolean(row?.w9_on_file),
  crew_size: Number.isFinite(Number(row?.crew_size)) ? Number(row.crew_size) : null,
  is_preferred: row?.is_preferred !== false,
  is_backup: Boolean(row?.is_backup),
  rating: Number.isFinite(Number(row?.rating)) ? Number(row.rating) : null,
  total_jobs: Number.isFinite(Number(row?.total_jobs)) ? Number(row.total_jobs) : 0,
  on_time_pct: Number.isFinite(Number(row?.on_time_pct)) ? Number(row.on_time_pct) : null,
  delay_count: Number.isFinite(Number(row?.delay_count)) ? Number(row.delay_count) : 0,
  blackout_dates: coerceArray(row?.blackout_dates),
  notes: row?.notes ?? null,
  status: row?.status ?? 'active',
  documents: coerceArray(row?.documents),
  custom_fields: row?.custom_fields ?? {},
})

const mapLotToSupabase = (row, orgId) => ({
  id: row?.id,
  org_id: orgId,
  community_id: row?.community_id,
  block: row?.block ?? '',
  lot_number: String(row?.lot_number ?? ''),
  product_type_id: row?.product_type_id ?? null,
  plan_id: row?.plan_id ?? null,
  builder_id: row?.builder_id ?? null,
  address: row?.address ?? '',
  job_number: row?.job_number ?? '',
  permit_number: row?.permit_number ?? null,
  model_type: row?.model_type ?? '',
  status: row?.status ?? 'not_started',
  start_date: toIsoDateOrNull(row?.start_date),
  hard_deadline: toIsoDateOrNull(row?.hard_deadline),
  build_days: Math.max(1, Number(row?.build_days ?? 1) || 1),
  target_completion_date: toIsoDateOrNull(row?.target_completion_date),
  actual_completion_date: toIsoDateOrNull(row?.actual_completion_date),
  sold_status: row?.sold_status ?? 'available',
  sold_date: toIsoDateOrNull(row?.sold_date),
  custom_fields: row?.custom_fields ?? {},
  inspections: coerceArray(row?.inspections),
  punch_list: row?.punch_list ?? null,
  daily_logs: coerceArray(row?.daily_logs),
  change_orders: coerceArray(row?.change_orders),
  material_orders: coerceArray(row?.material_orders),
  documents: coerceArray(row?.documents),
  photos: coerceArray(row?.photos),
})

const mapTaskToSupabase = (row, lotId, orgId) => ({
  id: row?.id,
  org_id: orgId,
  lot_id: lotId,
  name: row?.name ?? 'Task',
  trade: row?.trade ?? 'other',
  track: row?.track ?? 'foundation',
  phase: row?.phase ?? 'foundation',
  duration: Math.max(1, Number(row?.duration ?? 1) || 1),
  sort_order: Number.isFinite(Number(row?.sort_order)) ? Math.trunc(Number(row.sort_order)) : 0,
  status: row?.status ?? 'not_started',
  scheduled_start: row?.scheduled_start ?? null,
  scheduled_end: row?.scheduled_end ?? null,
  actual_start: row?.actual_start ?? null,
  actual_end: row?.actual_end ?? null,
  sub_id: row?.sub_id ?? null,
  notes: row?.notes ?? null,
  delay_reason: row?.delay_reason ?? null,
  delay_days: Number.isFinite(Number(row?.delay_days)) ? Number(row.delay_days) : 0,
  custom_fields: row?.custom_fields ?? {},
})

const chunkArray = (rows, chunkSize = 200) => {
  const chunks = []
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize))
  }
  return chunks
}

const formatSyncTimestamp = (iso) => {
  if (!iso) return ''
  const dt = parseISODate(iso)
  if (!dt) return ''
  return dt.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

const mergeTradeOptions = (customTrades = []) => {
  const map = new Map()
  TRADES.forEach((t) => map.set(t.id, t))
  ;(customTrades ?? []).forEach((t) => {
    if (!t?.id || !t?.label) return
    if (!map.has(t.id)) map.set(t.id, { id: t.id, label: t.label })
  })
  return Array.from(map.values())
}

const buildOutlookWebLink = (email) => {
  const address = String(email ?? '').trim()
  if (!address) return ''
  return `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(address)}`
}

const openExternalLink = (href, onClose) => {
  if (!href || typeof window === 'undefined') return
  if (onClose) onClose()
  window.location.href = href
}

const openBlobInNewTab = async (blobId) => {
  if (!blobId) return
  try {
    const win = window.open('', '_blank')
    let blob = await getBlob(blobId)
    if (!blob) {
      const remote = decodeRemoteBlobId(blobId)
      if (remote) {
        const { data, error } = await supabase.storage.from(remote.bucket).download(remote.path)
        if (error) throw error
        blob = data ?? null
        if (blob) {
          try {
            await putBlob(blobId, blob)
          } catch {
            // ignore cache failures
          }
        }
      }
    }
    if (!blob) return
    const url = URL.createObjectURL(blob)
    if (win && !win.closed) {
      win.location.href = url
    } else {
      const opened = window.open(url, '_blank', 'noopener,noreferrer')
      if (!opened) {
        const a = document.createElement('a')
        a.href = url
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (err) {
    console.error(err)
    alert('Failed to open file.')
  }
}

const BottomNav = ({ value, onChange }) => {
  const items = [
    { id: 'dashboard', label: 'Home', icon: LayoutGrid },
    { id: 'calendar', label: 'Calendar', icon: Calendar },
    { id: 'communities', label: 'Communities', icon: MapPin },
    { id: 'subs', label: 'Subs', icon: Users },
    { id: 'sales', label: 'Sales', icon: DollarSign },
    { id: 'reports', label: 'Reports', icon: BarChart3 },
    { id: 'admin', label: 'Admin', icon: Lock },
  ]

  const [showMore, setShowMore] = useState(false)
  const [isMobile, setIsMobile] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 640 : false))

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => setIsMobile(window.innerWidth < 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const primaryItems = isMobile ? items.slice(0, 4) : items
  const overflowItems = isMobile ? items.slice(4) : []
  const activeIsOverflow = overflowItems.some((item) => item.id === value)

  return (
    <>
      <div className="bottom-nav border-t px-2 py-2 safe-area-pb sm:flex sm:flex-nowrap sm:justify-around sm:gap-1">
        <div className={isMobile ? 'grid grid-cols-5 gap-1' : 'flex w-full justify-around gap-1'}>
          {primaryItems.map((item) => {
            const Icon = item.icon
            const active = value === item.id
            return (
              <button
                key={item.id}
                onClick={() => onChange(item.id)}
                className={`flex flex-col items-center justify-center px-2 py-1 rounded-xl w-full ${active ? 'text-blue-600' : 'text-gray-500'}`}
              >
                <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
                <span className="text-[10px] sm:text-[11px] mt-1">{item.label}</span>
              </button>
            )
          })}
          {isMobile ? (
            <button
              type="button"
              onClick={() => setShowMore(true)}
              className={`flex flex-col items-center justify-center px-2 py-1 rounded-xl w-full ${activeIsOverflow ? 'text-blue-600' : 'text-gray-500'}`}
            >
              <span className="text-lg leading-none">⋯</span>
              <span className="text-[10px] mt-1">More</span>
            </button>
          ) : null}
        </div>
      </div>

      {isMobile && showMore ? (
        <div className="fixed inset-0 z-[70]">
          <button type="button" className="absolute inset-0 bg-black/40" onClick={() => setShowMore(false)} />
          <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl p-4 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <p className="font-semibold">More</p>
              <button type="button" onClick={() => setShowMore(false)} className="text-sm text-gray-500">
                Close
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {overflowItems.map((item) => {
                const Icon = item.icon
                const active = value === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onChange(item.id)
                      setShowMore(false)
                    }}
                    className={`flex flex-col items-center justify-center p-3 rounded-xl border ${active ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700'}`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-xs mt-1">{item.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

function AuthLandingPage({
  authInitialized,
  supabaseStatus,
  supabaseUser,
  authDraft,
  authBusy,
  authError,
  uiLastCheckAt,
  onSetAuthField,
  onSignIn,
  onCreateLogin,
  onContinueAsGuest,
  onContinueToApp,
  onSignOut,
}) {
  const statusMessage = authInitialized ? supabaseStatus.message : 'Checking existing session...'
  const statusClass = supabaseStatus.phase === 'error' ? 'text-red-600' : 'text-gray-700'

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-700 via-blue-600 to-sky-500 p-4 sm:p-8">
      <div className="mx-auto max-w-5xl min-h-[calc(100vh-2rem)] sm:min-h-[calc(100vh-4rem)] flex items-center">
        <div className="grid w-full gap-5 lg:grid-cols-[1.05fr_1fr]">
          <div className="rounded-2xl border border-white/25 bg-white/10 p-6 text-white backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <Building2 className="h-7 w-7" />
              <p className="text-2xl font-bold">BuildFlow</p>
            </div>
            <p className="mt-4 text-sm text-blue-50 max-w-md">
              Start with sign-in, then jump directly into active lots, schedule risk, and team execution.
            </p>
            <div className="mt-5 space-y-1.5 text-sm text-blue-100">
              <p>- Focus on active communities and lots</p>
              <p>- Spot on-track vs delayed work immediately</p>
              <p>- Continue as guest for demo/testing data</p>
            </div>
          </div>

          <Card className="sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Supabase Access</p>
            <p className={`mt-2 text-sm ${statusClass}`}>{statusMessage}</p>
            <p className="mt-1 text-xs text-gray-500">
              Last check: {uiLastCheckAt && formatSyncTimestamp(uiLastCheckAt) ? formatSyncTimestamp(uiLastCheckAt) : 'Not yet'}
            </p>
            {supabaseStatus.warning ? <p className="mt-2 text-xs text-amber-700">{supabaseStatus.warning}</p> : null}

            {supabaseUser?.id ? (
              <div className="mt-4 space-y-2">
                <Card className="bg-blue-50 border-blue-200">
                  <p className="text-xs text-blue-700 font-semibold">Session Found</p>
                  <p className="text-sm text-blue-900 mt-1 break-words">
                    {supabaseUser?.email ?? 'Guest session'}
                  </p>
                </Card>
                <PrimaryButton onClick={onContinueToApp} disabled={!authInitialized}>
                  Continue to App
                </PrimaryButton>
                <SecondaryButton onClick={onSignOut} disabled={authBusy} className="w-full border-blue-200">
                  Sign Out / Switch Account
                </SecondaryButton>
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                <input
                  type="email"
                  value={authDraft.email}
                  onChange={(e) => onSetAuthField('email', e.target.value)}
                  placeholder="Email"
                  className="w-full h-11 rounded-xl border border-blue-200 px-3 text-sm"
                  autoComplete="email"
                  disabled={!authInitialized || authBusy}
                />
                <input
                  type="password"
                  value={authDraft.password}
                  onChange={(e) => onSetAuthField('password', e.target.value)}
                  placeholder="Password"
                  className="w-full h-11 rounded-xl border border-blue-200 px-3 text-sm"
                  autoComplete="current-password"
                  disabled={!authInitialized || authBusy}
                />
                {authError ? <p className="text-xs text-red-600">{authError}</p> : null}
                <div className="grid grid-cols-2 gap-2">
                  <PrimaryButton onClick={onSignIn} disabled={!authInitialized || authBusy}>
                    {authBusy ? 'Signing in...' : 'Sign In'}
                  </PrimaryButton>
                  <SecondaryButton onClick={onCreateLogin} disabled={!authInitialized || authBusy} className="border-blue-200">
                    Create Login
                  </SecondaryButton>
                </div>
                <SecondaryButton
                  onClick={onContinueAsGuest}
                  disabled={!authInitialized || authBusy}
                  className="w-full border-blue-200"
                >
                  Continue as Guest
                </SecondaryButton>
                <p className="text-xs text-gray-600">
                  Guest sign-in uses an anonymous Supabase account so test edits persist to shared data.
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

function DashboardStatusLotsModal({ kind, lots, communitiesById, onOpenLot, onClose }) {
  const meta = DASHBOARD_STATUS_META[kind] ?? DASHBOARD_STATUS_META.active

  const sortedLots = useMemo(() => {
    return [...(lots ?? [])].sort((a, b) => {
      const communityA = communitiesById.get(a.community_id)?.name ?? ''
      const communityB = communitiesById.get(b.community_id)?.name ?? ''
      const communityCompare = communityA.localeCompare(communityB)
      if (communityCompare !== 0) return communityCompare
      const lotA = Number(a.lot_number ?? 0) || 0
      const lotB = Number(b.lot_number ?? 0) || 0
      return lotA - lotB
    })
  }, [communitiesById, lots])

  return (
    <Modal title={`${meta.title} (${sortedLots.length})`} onClose={onClose}>
      <p className="text-xs text-gray-600 mb-3">{meta.hint}</p>
      {sortedLots.length === 0 ? (
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">{meta.empty}</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {sortedLots.map((lot) => {
            const community = communitiesById.get(lot.community_id) ?? null
            const progress = calculateLotProgress(lot)
            const milestone = getCurrentMilestone(lot)
            const delayed = (lot.tasks ?? []).some((task) => task.status === 'delayed')
            return (
              <button
                key={lot.id}
                onClick={() => onOpenLot(lot.id)}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 p-3 text-left hover:border-blue-300 hover:bg-blue-50/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-gray-900">
                      {community?.name ?? 'Community'} {lotCode(lot)}
                    </p>
                    <p className="text-xs text-gray-600 mt-1">Milestone: {milestone.label}</p>
                    <p className={`text-xs mt-1 ${delayed ? 'text-red-600' : 'text-green-700'}`}>
                      {delayed ? 'Delayed tasks present' : 'No delayed tasks'}
                    </p>
                  </div>
                  <p className="text-sm font-bold text-blue-600">{progress}%</p>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

export default function BuildFlow() {
  const seedState = useMemo(() => createSeedState(), [])
  const [app, setApp] = useState(() => loadAppState(seedState))
  const [tab, setTab] = useState('dashboard')
  const [selectedCommunityId, setSelectedCommunityId] = useState(null)
  const [selectedLotId, setSelectedLotId] = useState(null)
  const [lotViewMode, setLotViewMode] = useState('grid')
  const [communitySpecFilters, setCommunitySpecFilters] = useState({ productTypeId: 'all', planId: 'all' })
  const [salesFilters, setSalesFilters] = useState({
    communityId: 'all',
    productTypeId: 'all',
    planId: 'all',
    soldStatus: 'all',
    completionBy: '',
  })
  const [lotDetailTab, setLotDetailTab] = useState('overview')
  const [scheduleView, setScheduleView] = useState('list')
  const [scheduleTimelineScale, setScheduleTimelineScale] = useState('week')
  const [selectedScheduleTaskIds, setSelectedScheduleTaskIds] = useState([])
  const [parallelOverrideDeps, setParallelOverrideDeps] = useState(false)
  const [listDraggingTaskId, setListDraggingTaskId] = useState(null)
  const [listDropTaskId, setListDropTaskId] = useState(null)
  const [listDragOffset, setListDragOffset] = useState(0)
  const [listDropPulseId, setListDropPulseId] = useState(null)
  const [photoSourceModal, setPhotoSourceModal] = useState(null)
  const [photoViewer, setPhotoViewer] = useState(null)
  const [adminSection, setAdminSection] = useState('product_types')
  const [productTypeRangeDrafts, setProductTypeRangeDrafts] = useState({})
  const [builderRangeDrafts, setBuilderRangeDrafts] = useState({})
  const [showNotifications, setShowNotifications] = useState(false)
  const [showNotificationPrefs, setShowNotificationPrefs] = useState(false)
  const [showOfflineStatus, setShowOfflineStatus] = useState(false)
  const [showCreateCommunity, setShowCreateCommunity] = useState(false)
  const [showStartLot, setShowStartLot] = useState(false)
  const [startLotPrefill, setStartLotPrefill] = useState(null)
  const [taskModal, setTaskModal] = useState(null)
  const [onSiteLotModal, setOnSiteLotModal] = useState(null)
  const [dashboardStatusModal, setDashboardStatusModal] = useState(null)
  const [atGlanceModal, setAtGlanceModal] = useState(null)
  const [delayModal, setDelayModal] = useState(null)
  const [rescheduleModal, setRescheduleModal] = useState(null)
  const [bufferModal, setBufferModal] = useState(null)
  const [createBufferModal, setCreateBufferModal] = useState(null)
  const [addTaskModal, setAddTaskModal] = useState(null)
  const [scheduleInspectionModal, setScheduleInspectionModal] = useState(null)
  const [inspectionResultModal, setInspectionResultModal] = useState(null)
  const [inspectionNoteModal, setInspectionNoteModal] = useState(null)
  const [photoCaptureModal, setPhotoCaptureModal] = useState(null)
  const [messageModal, setMessageModal] = useState(null)
  const [specEditorModal, setSpecEditorModal] = useState(null)
  const [specBulkModal, setSpecBulkModal] = useState(null)
  const [photoTimelineLotId, setPhotoTimelineLotId] = useState(null)
  const [inspectionsLotId, setInspectionsLotId] = useState(null)
  const [punchListLotId, setPunchListLotId] = useState(null)
  const [dailyLogLotId, setDailyLogLotId] = useState(null)
  const [materialsLotId, setMaterialsLotId] = useState(null)
  const [changeOrdersLotId, setChangeOrdersLotId] = useState(null)
  const [sitePlanLotId, setSitePlanLotId] = useState(null)
  const [lotFilesLotId, setLotFilesLotId] = useState(null)
  const [communityDocsCommunityId, setCommunityDocsCommunityId] = useState(null)
  const [communityContactsModalId, setCommunityContactsModalId] = useState(null)
  const [reportModal, setReportModal] = useState(false)
  const [scheduledReportModal, setScheduledReportModal] = useState(false)
  const [subContactModalId, setSubContactModalId] = useState(null)
  const [editingSubId, setEditingSubId] = useState(null)
  const [subFilterCategory, setSubFilterCategory] = useState('all')
  const [subFilterTrade, setSubFilterTrade] = useState('all')
  const [authDraft, setAuthDraft] = useState({ email: '', password: '' })
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authInitialized, setAuthInitialized] = useState(false)
  const [showAuthLanding, setShowAuthLanding] = useState(true)
  const [claimLotBusyId, setClaimLotBusyId] = useState(null)
  const [supabaseSession, setSupabaseSession] = useState(null)
  const [supabaseUser, setSupabaseUser] = useState(null)
  const [supabaseBootstrapVersion, setSupabaseBootstrapVersion] = useState(0)
  const [supabaseStatus, setSupabaseStatus] = useState({
    phase: 'idle',
    message: 'Not signed in. Using local data.',
    orgId: null,
    role: null,
    loadedAt: null,
    counts: null,
    warning: '',
  })
  const [writeSyncState, setWriteSyncState] = useState({
    phase: 'idle',
    lastSyncedAt: null,
    error: '',
  })
  const [syncV2Enabled, setSyncV2Enabled] = useState(() => isSyncV2Enabled())
  const [syncV2Status, setSyncV2Status] = useState({
    phase: 'idle',
    last_pulled_at: null,
    last_pushed_at: null,
    warning: '',
    error: '',
  })
  const [cloudRetryTick, setCloudRetryTick] = useState(0)
  const [resetSeedBusy, setResetSeedBusy] = useState(false)

  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true))
  const [weather, setWeather] = useState({
    loading: true,
    forecast: [],
    locationName: WEATHER_FALLBACK.name,
    source: WEATHER_FALLBACK.source,
  })
  const [userWeatherLocation, setUserWeatherLocation] = useState(null)
  const [weatherGeoRequested, setWeatherGeoRequested] = useState(false)
  const [weatherLocationMode, setWeatherLocationMode] = useState('auto')
  const [calendarView, setCalendarView] = useState('day')
  const [calendarDate, setCalendarDate] = useState(() => formatISODate(new Date()))
  const [draggingCalendarTask, setDraggingCalendarTask] = useState(null)
  const [calendarDropTarget, setCalendarDropTarget] = useState(null)
  const [calendarFilters, setCalendarFilters] = useState(() => ({
    communityId: 'all',
    trade: 'all',
    subId: 'all',
    showDelayed: true,
    showMilestones: true,
  }))

  const listDragRef = useRef({
    active: false,
    timer: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    taskId: null,
    track: null,
    pointerType: '',
    scrollEl: null,
    startScrollTop: 0,
    scrollRaf: null,
  })
  const listDropPulseTimerRef = useRef(null)
  const listSuppressClickRef = useRef(false)
  const supabaseWriteInFlightRef = useRef(false)
  const persistenceBootstrappedRef = useRef(false)
  const latestAppRef = useRef(app)
  const localDbImportedOrgIdRef = useRef(null)

  useEffect(() => {
    latestAppRef.current = app
    if (!persistenceBootstrappedRef.current) return
    saveAppState(app)
  }, [app])

  useEffect(() => {
    let cancelled = false

    // Boot sequence (best-effort):
    // 1) If localStorage is empty/corrupt, try to restore from IndexedDB snapshot mirror.
    // 2) Only then start persisting changes (avoid clobbering a recoverable state with seed data).
    const boot = async () => {
      try {
        const raw = loadStoredAppStateRaw()
        if (!raw) {
          const restored = await loadAppStateFromIdb(seedState)
          if (!cancelled && restored) {
            setApp(restored)
            latestAppRef.current = restored
          }
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          persistenceBootstrappedRef.current = true
          try {
            // Ensure we have at least one persisted snapshot for future restores.
            saveAppState(latestAppRef.current)
          } catch {
            // ignore
          }
        }
      }
    }

    boot()

    return () => {
      cancelled = true
    }
  }, [seedState])

  useEffect(() => {
    const orgId = supabaseStatus?.orgId ?? app?.org?.id ?? null
    if (!orgId) return
    if (localDbImportedOrgIdRef.current === orgId) return
    localDbImportedOrgIdRef.current = orgId

    // Async + best-effort: create an IndexedDB-backed normalized copy of the local snapshot.
    // This is the foundation for the durable outbox + sync v2, but does not change UI behavior yet.
    const snapshot = latestAppRef.current
    void Promise.resolve()
      .then(() => ensureImportedFromSnapshotV1(snapshot, { org_id: orgId }))
      .catch(() => {
        // Non-fatal: continue using localStorage snapshot only.
      })
  }, [app?.org?.id, supabaseStatus?.orgId])

  useEffect(() => {
    setApp((prev) => {
      const sync = prev.sync ?? {}
      if (sync.dependencies_cleanup_done) return prev
      let changed = false

      const stripTask = (task) => {
        if (!task || !Object.prototype.hasOwnProperty.call(task, 'dependencies')) return task
        const { dependencies: _dependencies, ...rest } = task
        changed = true
        return rest
      }

      const nextLots = (prev.lots ?? []).map((lot) => {
        if (!Array.isArray(lot?.tasks)) return lot
        const nextTasks = lot.tasks.map(stripTask)
        return nextTasks === lot.tasks ? lot : { ...lot, tasks: nextTasks }
      })

      const nextTemplates = (prev.templates ?? []).map((template) => {
        if (!Array.isArray(template?.tasks)) return template
        const nextTasks = template.tasks.map(stripTask)
        return nextTasks === template.tasks ? template : { ...template, tasks: nextTasks }
      })

      if (!changed) {
        return { ...prev, sync: { ...sync, dependencies_cleanup_done: true } }
      }

      return {
        ...prev,
        lots: nextLots,
        templates: nextTemplates,
        sync: { ...sync, dependencies_cleanup_done: true },
      }
    })
  }, [])

  useEffect(() => {
    let active = true

    const readSession = async () => {
      try {
        const { data, error } = await supabase.auth.getSession()
        if (!active) return

        if (error) {
          setSupabaseStatus((prev) => ({
            ...prev,
            phase: 'error',
            message: `Auth session check failed: ${error.message}`,
            loadedAt: new Date().toISOString(),
          }))
          return
        }

        const session = data?.session ?? null
        setSupabaseSession(session)
        setSupabaseUser(session?.user ?? null)
        if (session?.user?.email) {
          setAuthDraft((prev) => ({ ...prev, email: prev.email || session.user.email, password: '' }))
        }
      } finally {
        if (active) setAuthInitialized(true)
      }
    }

    readSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return
      setSupabaseSession(session ?? null)
      setSupabaseUser(session?.user ?? null)
      if (!session?.user?.id) setShowAuthLanding(true)
      if (session?.user?.email) {
        setAuthDraft((prev) => ({ ...prev, email: prev.email || session.user.email, password: '' }))
      } else {
        setAuthDraft((prev) => ({ ...prev, password: '' }))
      }
      setAuthError('')
    })

    return () => {
      active = false
      subscription?.unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const readOrgScopedRows = async (tableName, orgId, filterFallbackTables, allowUnfilteredFallback = false) => {
      const withFilter = await supabase.from(tableName).select('*').eq('org_id', orgId)
      if (!withFilter.error) {
        return { rows: withFilter.data ?? [], missing: false, error: null }
      }
      if (isMissingSupabaseTableError(withFilter.error)) {
        return { rows: [], missing: true, error: null }
      }

      const code = String(withFilter.error?.code ?? '')
      const message = String(withFilter.error?.message ?? '').toLowerCase()
      const orgColumnMissing = code === '42703' || (message.includes('org_id') && message.includes('column'))
      if (!orgColumnMissing) {
        return { rows: [], missing: false, error: withFilter.error }
      }

      if (!allowUnfilteredFallback) {
        return {
          rows: [],
          missing: false,
          error: new Error(`Refusing unfiltered read: ${tableName} is missing org_id column`),
        }
      }

      const withoutFilter = await supabase.from(tableName).select('*')
      if (withoutFilter.error) {
        if (isMissingSupabaseTableError(withoutFilter.error)) {
          return { rows: [], missing: true, error: null }
        }
        return { rows: [], missing: false, error: withoutFilter.error }
      }

      filterFallbackTables.push(tableName)
      return { rows: withoutFilter.data ?? [], missing: false, error: null }
    }

    const hydrateFromSupabase = async () => {
      if (!supabaseUser?.id) {
        setSupabaseStatus({
          phase: 'signed_out',
          message: 'Not signed in. Using local data.',
          orgId: null,
          role: null,
          loadedAt: new Date().toISOString(),
          counts: null,
          warning: '',
        })
        return
      }

      let guestProvision = null
      if (supabaseUser?.is_anonymous) {
        guestProvision = await ensureGuestOrg()
        if (!guestProvision?.org_id && !guestProvision?.orgId) return
      }

      setSupabaseStatus((prev) => ({
        ...prev,
        phase: 'loading',
        message: 'Loading organization data from Supabase...',
        loadedAt: new Date().toISOString(),
        warning: '',
      }))

      const profileResult = await supabase
        .from('profiles')
        .select('id, org_id, role')
        .eq('id', supabaseUser.id)
        .limit(1)

      if (cancelled) return
      if (profileResult.error) {
        setSupabaseStatus((prev) => ({
          ...prev,
          phase: 'error',
          message: `Profile lookup failed: ${profileResult.error.message}`,
          loadedAt: new Date().toISOString(),
        }))
        return
      }

      const profile = (profileResult.data ?? [])[0] ?? null
      const guestOrgId = guestProvision?.org_id ?? guestProvision?.orgId ?? null
      const guestRole = guestProvision?.role ?? null
      const orgId = profile?.org_id ?? guestOrgId ?? (SUPABASE_ORG_ID_FALLBACK || null)
      const usedEnvOrgFallback = !profile?.org_id && Boolean(SUPABASE_ORG_ID_FALLBACK)

      if (!orgId) {
        setSupabaseStatus((prev) => ({
          ...prev,
          phase: 'error',
          message: 'No profile.org_id found for this user. Add a profile row or set VITE_SUPABASE_ORG_ID.',
          loadedAt: new Date().toISOString(),
        }))
        return
      }

      const orgResult = await supabase.from('organizations').select('*').eq('id', orgId).limit(1)
      if (cancelled) return
      if (orgResult.error) {
        setSupabaseStatus((prev) => ({
          ...prev,
          phase: 'error',
          message: `Organization lookup failed: ${orgResult.error.message}`,
          orgId,
          role: profile?.role ?? guestRole ?? null,
          loadedAt: new Date().toISOString(),
        }))
        return
      }

      const orgRow = (orgResult.data ?? [])[0] ?? null
      const filterFallbackTables = []
      const missingTables = []
      const allowUnfilteredFallback = Boolean(supabaseUser?.is_anonymous) || Boolean(orgRow?.is_demo)

      const communitiesRead = await readOrgScopedRows('communities', orgId, filterFallbackTables, allowUnfilteredFallback)
      const lotsRead = await readOrgScopedRows('lots', orgId, filterFallbackTables, allowUnfilteredFallback)
      const tasksRead = await readOrgScopedRows('tasks', orgId, filterFallbackTables, allowUnfilteredFallback)
      const subsRead = await readOrgScopedRows('subcontractors', orgId, filterFallbackTables, allowUnfilteredFallback)
      const productTypesRead = await readOrgScopedRows('product_types', orgId, filterFallbackTables, allowUnfilteredFallback)
      const plansRead = await readOrgScopedRows('plans', orgId, filterFallbackTables, allowUnfilteredFallback)
      const agenciesRead = await readOrgScopedRows('agencies', orgId, filterFallbackTables, allowUnfilteredFallback)
      const assignmentsRead = await readOrgScopedRows('lot_assignments', orgId, filterFallbackTables, allowUnfilteredFallback)

      const reads = [communitiesRead, lotsRead, tasksRead, subsRead, productTypesRead, plansRead, agenciesRead, assignmentsRead]
      const fatalReadError = reads.find((r) => r.error)?.error ?? null
      if (fatalReadError) {
        setSupabaseStatus((prev) => ({
          ...prev,
          phase: 'error',
          message: `Supabase read failed: ${fatalReadError.message}`,
          orgId,
          role: profile?.role ?? null,
          loadedAt: new Date().toISOString(),
        }))
        return
      }

      if (communitiesRead.missing) missingTables.push('communities')
      if (lotsRead.missing) missingTables.push('lots')
      if (tasksRead.missing) missingTables.push('tasks')
      if (subsRead.missing) missingTables.push('subcontractors')
      if (productTypesRead.missing) missingTables.push('product_types')
      if (plansRead.missing) missingTables.push('plans')
      if (agenciesRead.missing) missingTables.push('agencies')
      if (assignmentsRead.missing) missingTables.push('lot_assignments')

      const tasksByLotId = new Map()
      for (const taskRow of tasksRead.rows ?? []) {
        const lotId = taskRow?.lot_id
        if (!lotId) continue
        const mappedTask = mapTaskFromSupabase(taskRow)
        const list = tasksByLotId.get(lotId) ?? []
        list.push(mappedTask)
        tasksByLotId.set(lotId, list)
      }

      const mappedCommunities = (communitiesRead.rows ?? []).map(mapCommunityFromSupabase)
      const mappedLots = (lotsRead.rows ?? []).map((lotRow) =>
        mapLotFromSupabase(lotRow, tasksByLotId.get(lotRow.id) ?? []),
      )
      const mappedSubs = (subsRead.rows ?? []).map(mapSubcontractorFromSupabase)
      const mappedProductTypes = coerceArray(productTypesRead.rows)
      const mappedPlans = coerceArray(plansRead.rows)
      const mappedAgencies = coerceArray(agenciesRead.rows)
      const mappedAssignments = coerceArray(assignmentsRead.rows)
      const shouldSetAssignments = !assignmentsRead.missing

      const hasRemoteCoreData = mappedCommunities.length > 0 || mappedLots.length > 0 || mappedSubs.length > 0

      setApp((prev) => {
        const nextTimezoneRaw = String(orgRow?.timezone ?? prev.org?.timezone ?? '').trim()
        const nextTimezone = nextTimezoneRaw || 'America/Chicago'
        const nextHolidays = Array.isArray(orgRow?.holidays)
          ? normalizeHolidayObjects(orgRow.holidays, prev.org?.holidays)
          : Array.isArray(prev.org?.holidays)
            ? prev.org.holidays
            : []

        const nextOrg = {
          ...prev.org,
          name: orgRow?.name ?? orgRow?.builder_name ?? prev.org.name,
          builder_name: orgRow?.builder_name ?? orgRow?.name ?? prev.org.builder_name,
          timezone: nextTimezone,
          is_demo: Boolean(orgRow?.is_demo ?? prev.org?.is_demo ?? false),
          default_build_days: Number.isFinite(Number(orgRow?.default_build_days))
            ? Number(orgRow.default_build_days)
            : prev.org.default_build_days,
          work_days: Array.isArray(orgRow?.work_days) ? orgRow.work_days : prev.org.work_days,
          holidays: nextHolidays,
        }

        // Persist last-known auth scope into the snapshot so we can enforce "super assignment"
        // rules even if the device restarts offline.
        const prevSync = prev.sync ?? {}
        const nextSync = {
          ...prevSync,
          supabase_user_id: supabaseUser?.id ?? prevSync.supabase_user_id ?? null,
          supabase_org_id: orgId ?? prevSync.supabase_org_id ?? null,
          supabase_role: profile?.role ?? guestRole ?? prevSync.supabase_role ?? null,
        }

        if (!hasRemoteCoreData) {
          return {
            ...prev,
            org: nextOrg,
            sync: nextSync,
            lot_assignments: shouldSetAssignments ? mappedAssignments : prev.lot_assignments,
          }
        }

        return {
          ...prev,
          org: nextOrg,
          sync: nextSync,
          communities: mappedCommunities.length > 0 ? mappedCommunities : prev.communities,
          lots: mappedLots.length > 0 ? mappedLots : prev.lots,
          subcontractors: mappedSubs.length > 0 ? mappedSubs : prev.subcontractors,
          product_types: mappedProductTypes.length > 0 ? mappedProductTypes : prev.product_types,
          plans: mappedPlans.length > 0 ? mappedPlans : prev.plans,
          agencies: mappedAgencies.length > 0 ? mappedAgencies : prev.agencies,
          lot_assignments: shouldSetAssignments ? mappedAssignments : prev.lot_assignments,
        }
      })

      const warningParts = []
      if (filterFallbackTables.length > 0) {
        warningParts.push(`No org_id filter on: ${filterFallbackTables.join(', ')}`)
      }
      if (usedEnvOrgFallback) {
        warningParts.push('Using VITE_SUPABASE_ORG_ID fallback because profile mapping was not found')
      }
      if (missingTables.length > 0) {
        warningParts.push(`Missing tables: ${Array.from(new Set(missingTables)).join(', ')}`)
      }

      if (cancelled) return
      setSupabaseStatus({
        phase: 'ready',
        message: hasRemoteCoreData
          ? 'Supabase connected. Remote data is loaded.'
          : 'Supabase connected. No remote core rows yet; local seed data remains active.',
        orgId,
        role: profile?.role ?? null,
        loadedAt: new Date().toISOString(),
        counts: {
          communities: mappedCommunities.length,
          lots: mappedLots.length,
          tasks: (tasksRead.rows ?? []).length,
          subcontractors: mappedSubs.length,
          product_types: mappedProductTypes.length,
          lot_assignments: mappedAssignments.length,
        },
        warning: warningParts.join(' | '),
      })
    }

    hydrateFromSupabase()

    return () => {
      cancelled = true
    }
  }, [supabaseUser?.id, supabaseBootstrapVersion])

  const syncPayloadToSupabase = async (pendingPayload) => {
    const {
      orgId,
      userId,
      role,
      orgRow,
      productTypes,
      plansRows,
      agenciesRows,
      communitiesRows,
      subcontractorRows,
      lotRows,
      taskRows,
      deletedTaskIds,
    } = pendingPayload ?? {}

    if (!orgId || !userId) {
      throw new Error('Missing org or user for sync')
    }

    const profileUpsert = await supabase.from('profiles').upsert(
      {
        id: userId,
        org_id: orgId,
        role: role || 'admin',
      },
      { onConflict: 'id' },
    )
    if (profileUpsert.error) {
      throw new Error(`Profile upsert failed: ${profileUpsert.error.message}`)
    }

    if (orgRow) {
      const orgUpdatePayload = {
        name: orgRow.name,
        builder_name: orgRow.builder_name,
        timezone: orgRow.timezone,
        default_build_days: orgRow.default_build_days,
        work_days: orgRow.work_days,
        holidays: orgRow.holidays,
      }

      let orgUpdate = await supabase.from('organizations').update(orgUpdatePayload).eq('id', orgId)
      if (orgUpdate.error) {
        const code = String(orgUpdate.error?.code ?? '')
        const message = String(orgUpdate.error?.message ?? '').toLowerCase()
        const timezoneColumnMissing =
          code === '42703' || (message.includes('timezone') && message.includes('column') && message.includes('does not exist'))

        if (timezoneColumnMissing) {
          // Backward-compat with older bootstrap schemas that don't yet have organizations.timezone.
          // (The server-side default still keeps date math stable.)
          const { timezone: _timezone, ...withoutTimezone } = orgUpdatePayload
          orgUpdate = await supabase.from('organizations').update(withoutTimezone).eq('id', orgId)
        }
      }

      if (orgUpdate.error) {
        throw new Error(`Organization update failed: ${orgUpdate.error.message}`)
      }
    }

    const upsertRows = async (tableName, rows, onConflict) => {
      if (!Array.isArray(rows) || rows.length === 0) return
      for (const chunk of chunkArray(rows, 200)) {
        const result = await supabase.from(tableName).upsert(chunk, { onConflict })
        if (result.error) {
          throw new Error(`${tableName} sync failed: ${result.error.message}`)
        }
      }
    }

    await upsertRows('product_types', productTypes ?? [], 'id')
    await upsertRows('plans', plansRows ?? [], 'id')
    await upsertRows('agencies', agenciesRows ?? [], 'id')
    await upsertRows('communities', communitiesRows ?? [], 'id')
    await upsertRows('subcontractors', subcontractorRows ?? [], 'id')
    await upsertRows('lots', lotRows ?? [], 'id')

    const deletedIds = Array.from(new Set(coerceArray(deletedTaskIds).filter(Boolean)))
    if (deletedIds.length > 0) {
      for (const chunk of chunkArray(deletedIds, 200)) {
        const taskDelete = await supabase.from('tasks').delete().in('id', chunk)
        if (taskDelete.error && !isMissingSupabaseTableError(taskDelete.error)) {
          throw new Error(`Task delete failed: ${taskDelete.error.message}`)
        }
      }
    }

    await upsertRows('tasks', taskRows ?? [], 'id')

    const syncedAt = new Date().toISOString()
    setSupabaseStatus((prev) => ({
      ...prev,
      phase: 'ready',
      message: 'Supabase connected. Remote data is loaded.',
      loadedAt: syncedAt,
      counts: {
        communities: coerceArray(communitiesRows).length,
        lots: coerceArray(lotRows).length,
        tasks: coerceArray(taskRows).length,
        subcontractors: coerceArray(subcontractorRows).length,
        product_types: coerceArray(productTypes).length,
      },
    }))

    if (deletedIds.length > 0) {
      const deletedSet = new Set(deletedIds)
      setApp((prev) => {
        const sync = prev.sync ?? {}
        const remaining = coerceArray(sync.deleted_task_ids).filter((id) => !deletedSet.has(id))
        if (remaining.length === coerceArray(sync.deleted_task_ids).length) return prev
        return { ...prev, sync: { ...sync, deleted_task_ids: remaining } }
      })
    }

    return { syncedAt }
  }

  const buildCloudPayload = () => {
    if (!supabaseUser?.id || !supabaseStatus.orgId) return null

    const orgId = supabaseStatus.orgId
    const orgConfig = app.org ?? {}
    const effectiveRole = supabaseStatus.role ?? app?.sync?.supabase_role ?? null
    if (!effectiveRole) return null
    const isRestrictedSuper = effectiveRole === 'super' && !orgConfig?.is_demo
    const timezoneRaw = String(orgConfig?.timezone ?? '').trim()

    // Non-demo supers are only allowed to write lots/tasks for lots they are assigned to.
    // Snapshot sync is transitional; v2 sync will replace it.
    const orgRow = isRestrictedSuper
      ? null
      : {
          id: orgId,
          name: orgConfig?.name ?? orgConfig?.builder_name ?? 'BuildFlow',
          builder_name: orgConfig?.builder_name ?? orgConfig?.name ?? 'BuildFlow',
          timezone: timezoneRaw || 'America/Chicago',
          default_build_days: Math.max(1, Number(orgConfig?.default_build_days ?? 1) || 1),
          work_days: coerceArray(orgConfig?.work_days)
            .map((day) => Number(day))
            .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
          holidays: toSupabaseHolidayDates(orgConfig?.holidays),
        }

    const productTypes = isRestrictedSuper
      ? []
      : (app.product_types ?? [])
          .map((row) => mapProductTypeToSupabase(row, orgId))
          .filter((row) => row?.id)

    const plansRows = isRestrictedSuper ? [] : (app.plans ?? []).map((row) => mapPlanToSupabase(row, orgId)).filter((row) => row?.id)

    const agenciesRows = isRestrictedSuper
      ? []
      : (app.agencies ?? [])
          .map((row) => mapAgencyToSupabase(row, orgId))
          .filter((row) => row?.id)

    const communitiesRows = isRestrictedSuper
      ? []
      : (app.communities ?? [])
          .map((row) => mapCommunityToSupabase(row, orgId))
          .filter((row) => row?.id)

    const subcontractorRows = isRestrictedSuper
      ? []
      : (app.subcontractors ?? [])
          .map((row) => mapSubcontractorToSupabase(row, orgId))
          .filter((row) => row?.id)

    const lotsToSync = isRestrictedSuper ? (app.lots ?? []).filter((l) => myAssignedLotIds.has(l.id)) : app.lots ?? []
    const lotRows = lotsToSync.map((row) => mapLotToSupabase(row, orgId)).filter((row) => row?.id)

    const taskRows = []
    for (const lot of lotsToSync) {
      for (const task of lot?.tasks ?? []) {
        const mappedTask = mapTaskToSupabase(task, lot.id, orgId)
        if (!mappedTask?.id) continue
        taskRows.push(mappedTask)
      }
    }

    const deletedTaskIds = isRestrictedSuper ? [] : coerceArray(app.sync?.deleted_task_ids).filter(Boolean)

    const nextPayload = {
      orgId,
      userId: supabaseUser.id,
      role: effectiveRole,
      orgRow,
      productTypes,
      plansRows,
      agenciesRows,
      communitiesRows,
      subcontractorRows,
      lotRows,
      taskRows,
      deletedTaskIds,
    }
    const nextHash = JSON.stringify(nextPayload)
    return {
      payload: nextPayload,
      hash: nextHash,
    }
  }

  useEffect(() => {
    if (syncV2Enabled) return
    if (!supabaseUser?.id || !supabaseStatus.orgId || supabaseStatus.phase === 'loading') return

    const built = buildCloudPayload()
    if (!built) return
    const { hash } = built

    let didEnqueue = false
    setApp((prev) => {
      const sync = prev.sync ?? {}
      const lastSynced = sync.cloud_last_synced_hash ?? ''
      const lastQueued = sync.cloud_last_queued_hash ?? ''
      if (hash === lastSynced || hash === lastQueued) return prev
      const now = new Date().toISOString()
      const nextQueue = [{ id: uuid(), hash, created_at: now, attempts: 0, last_error: '', next_retry_at: null }]
      didEnqueue = true
      return {
        ...prev,
        sync: {
          ...sync,
          cloud_queue: nextQueue,
          cloud_last_queued_hash: hash,
          cloud_last_error: '',
          cloud_last_error_at: null,
        },
      }
    })

    if (didEnqueue) {
      setWriteSyncState((prev) => ({ ...prev, phase: prev.phase === 'syncing' ? 'syncing' : 'pending', error: '' }))
      setCloudRetryTick((prev) => prev + 1)
    }
  }, [app, supabaseUser?.id, supabaseStatus.orgId, supabaseStatus.phase, syncV2Enabled])

  useEffect(() => {
    if (!syncV2Enabled) return
    if (!supabaseUser?.id || supabaseStatus.phase !== 'ready') return

    let cancelled = false
    let timer = null
    let inFlight = false

    const looksLikeNetworkError = (err) => {
      const msg = String(err?.message ?? err ?? '').toLowerCase()
      return msg.includes('failed to fetch') || msg.includes('network') || msg.includes('fetch failed')
    }

    const scheduleNext = (ms) => {
      if (cancelled) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => tick(), Math.max(350, Number(ms) || 0))
    }

    const tick = async () => {
      if (cancelled) return
      if (inFlight) return
      inFlight = true

      const startedAt = new Date().toISOString()
      setSyncV2Status((prev) => ({ ...prev, phase: 'syncing', error: '', warning: prev.warning }))

      try {
        // Push due ops (durable outbox)
        const due = await outboxListV2Due({ limit: 5 })
        if (cancelled) return

        if (due.length > 0) {
          // Mark attempt + exponential backoff on errors.
          for (const op of due) {
            const attempts = (Number(op?.attempts ?? 0) || 0) + 1
            await outboxUpdate(op.id, { attempts, last_error: '', last_error_at: null })
          }

          const isStorageAlreadyExistsError = (err) => {
            const code = String(err?.statusCode ?? err?.status ?? err?.code ?? '')
            const msg = String(err?.message ?? '').toLowerCase()
            return code === '409' || msg.includes('already exists') || msg.includes('duplicate')
          }

          const ready = []
          const uploadedAttachmentRefs = []

          for (const op of due) {
            if (op?.kind !== 'attachments_batch') {
              ready.push(op)
              continue
            }

            const items = Array.isArray(op?.payload?.attachments) ? op.payload.attachments : []
            if (items.length === 0) continue

            let uploadOk = true
            const uploadedForOp = []
            for (const item of items) {
              if (item?.action === 'delete') continue
              const row = item?.row ?? {}
              const bucket = row?.storage_bucket ?? 'photos'
              const path = row?.storage_path ?? ''
              const clientBlobId = row?.client_blob_id ?? row?.blob_id ?? null
              if (!bucket || !path || !clientBlobId) {
                uploadOk = false
                await outboxUpdate(op.id, {
                  last_error: 'Attachment upload op missing storage_bucket/storage_path/client_blob_id',
                  last_error_at: new Date().toISOString(),
                  next_retry_at: new Date(Date.now() + 15000).toISOString(),
                })
                break
              }

              const blob = await getBlob(clientBlobId)
              if (!blob) {
                uploadOk = false
                await outboxUpdate(op.id, {
                  last_error: 'Attachment blob missing locally (please re-add the photo)',
                  last_error_at: new Date().toISOString(),
                  next_retry_at: new Date(Date.now() + 60000).toISOString(),
                })
                break
              }

              const contentType = row?.mime || blob.type || undefined
              const { error } = await supabase.storage.from(bucket).upload(path, blob, {
                contentType,
                upsert: false,
              })

              if (error && !isStorageAlreadyExistsError(error)) {
                uploadOk = false
                if (looksLikeNetworkError(error)) setIsOnline(false)
                const attempts = Number(op?.attempts ?? 1) || 1
                const backoff = Math.min(300000, 8000 * Math.pow(2, Math.max(0, attempts - 1)))
                await outboxUpdate(op.id, {
                  last_error: String(error?.message ?? 'Storage upload failed'),
                  last_error_at: new Date().toISOString(),
                  next_retry_at: new Date(Date.now() + backoff).toISOString(),
                })
                break
              }

              uploadedForOp.push({
                id: item?.id,
                lot_id: row?.lot_id ?? null,
                storage_bucket: bucket,
                storage_path: path,
                thumb_storage_path: row?.thumb_storage_path ?? null,
              })
            }

            if (uploadOk) {
              ready.push(op)
              uploadedAttachmentRefs.push(...uploadedForOp)
            }
          }

          if (ready.length === 0) {
            scheduleNext(6500)
            return
          }

          const pushRes = await syncV2Push({ supabase, ops: ready })
          if (cancelled) return

          if (!pushRes.ok) {
            const msg = String(pushRes.error?.message ?? 'sync_push failed')
            const missing = Boolean(pushRes.missing)
            setSyncV2Status((prev) => ({
              ...prev,
              phase: 'error',
              warning: missing ? 'Sync v2 RPCs are not deployed on this Supabase project yet (sync_push/sync_pull).' : prev.warning,
              error: msg,
            }))

            if (!missing && looksLikeNetworkError(pushRes.error)) setIsOnline(false)

            // Retry later (unless missing RPCs; then back off longer).
            const delayMs = missing ? 60000 : 8000
            for (const op of ready) {
              const attempts = Number(op?.attempts ?? 0) || 0
              const backoff = Math.min(300000, delayMs * Math.pow(2, Math.max(0, attempts - 1)))
              const nextRetryAt = new Date(Date.now() + backoff).toISOString()
              await outboxUpdate(op.id, { last_error: msg, last_error_at: new Date().toISOString(), next_retry_at: nextRetryAt })
            }

            scheduleNext(missing ? 60000 : 10000)
            return
          }

          // Mark local photos as synced when their attachment metadata is pushed.
          if (uploadedAttachmentRefs.length > 0) {
            const byId = new Map(uploadedAttachmentRefs.map((r) => [r.id, r]))
            setApp((prev) => ({
              ...prev,
              lots: (prev.lots ?? []).map((lot) => {
                const photos = Array.isArray(lot.photos) ? lot.photos : []
                let changed = false
                const nextPhotos = photos.map((p) => {
                  const ref = p?.id ? byId.get(p.id) : null
                  if (!ref) return p
                  changed = true
                  return {
                    ...p,
                    synced: true,
                    sync_error: null,
                    storage_bucket: ref.storage_bucket ?? p.storage_bucket ?? 'photos',
                    storage_path: ref.storage_path ?? p.storage_path ?? null,
                    thumb_storage_path: ref.thumb_storage_path ?? p.thumb_storage_path ?? null,
                    uploaded_at: p.uploaded_at ?? new Date().toISOString(),
                  }
                })
                return changed ? { ...lot, photos: nextPhotos } : lot
              }),
            }))
          }

          await outboxAck(ready.map((op) => op.id))
          setIsOnline(true)
          setSyncV2Status((prev) => ({ ...prev, last_pushed_at: pushRes.server_time ?? new Date().toISOString() }))
        }

        // Pull incremental changes
        const cursor = await getSyncV2Cursor()
        const pullRes = await syncV2Pull({ supabase, since: cursor })
        if (cancelled) return

        if (!pullRes.ok) {
          const msg = String(pullRes.error?.message ?? 'sync_pull failed')
          setSyncV2Status((prev) => ({
            ...prev,
            phase: 'error',
            warning: pullRes.missing ? 'Sync v2 RPCs are not deployed on this Supabase project yet (sync_push/sync_pull).' : prev.warning,
            error: msg,
          }))
          if (!pullRes.missing && looksLikeNetworkError(pullRes.error)) setIsOnline(false)
          scheduleNext(pullRes.missing ? 60000 : 12000)
          return
        }

        setIsOnline(true)
        const serverTime = pullRes.server_time ?? startedAt

        // Avoid clobbering local, un-acked edits. Until we have a real conflict UX,
        // we skip applying server rows for entities that are referenced by pending v2 ops.
        const blockedTaskIds = new Set()
        const blockedLotIds = new Set()
        try {
          const allOps = await outboxList()
          for (const op of allOps) {
            if (!op || op.v2 !== true) continue
            if (op?.lot_id) blockedLotIds.add(op.lot_id)
            for (const id of Array.isArray(op.entity_ids) ? op.entity_ids : []) {
              if (id) blockedTaskIds.add(id)
            }
            const payloadTasks = Array.isArray(op?.payload?.tasks) ? op.payload.tasks : []
            for (const t of payloadTasks) {
              const id = t?.id
              if (id) blockedTaskIds.add(id)
            }
          }
        } catch {
          // ignore; best-effort only
        }

        // Merge rows into app state (best-effort; v2 conflict UX is future work).
        setApp((prev) => {
          const lots = Array.isArray(prev.lots) ? prev.lots : []
          const tasksByLotId = new Map()
          for (const taskRow of pullRes.tasks ?? []) {
            const lotId = taskRow?.lot_id
            if (!lotId) continue
            const mappedTask = mapTaskFromSupabase(taskRow)
            if (mappedTask?.id && blockedTaskIds.has(mappedTask.id)) continue
            const list = tasksByLotId.get(lotId) ?? []
            list.push(mappedTask)
            tasksByLotId.set(lotId, list)
          }

          const attachmentsByLotId = new Map()
          for (const attachmentRow of pullRes.attachments ?? []) {
            const lotId = attachmentRow?.lot_id
            if (!lotId) continue
            const list = attachmentsByLotId.get(lotId) ?? []
            list.push(attachmentRow)
            attachmentsByLotId.set(lotId, list)
          }

          const nextLots = lots.map((lot) => {
            const lotRow = blockedLotIds.has(lot.id) ? null : (pullRes.lots ?? []).find((r) => r?.id === lot.id) ?? null
            const incomingTasks = tasksByLotId.get(lot.id) ?? null
            const incomingAttachments = attachmentsByLotId.get(lot.id) ?? null
            if (!lotRow && !incomingTasks && !incomingAttachments) return lot

            const nextLotBase = lotRow ? mapLotFromSupabase(lotRow, lot.tasks ?? []) : lot
            const baseTasks = Array.isArray(nextLotBase.tasks) ? nextLotBase.tasks : lot.tasks ?? []

            let mergedTasks = baseTasks
            if (incomingTasks) {
              const currentById = new Map(baseTasks.map((t) => [t.id, t]))
              for (const t of incomingTasks) {
                if (!t?.id) continue
                if (t.deleted_at) {
                  currentById.delete(t.id)
                } else {
                  currentById.set(t.id, t)
                }
              }
              mergedTasks = Array.from(currentById.values()).slice().sort((a, b) => (Number(a.sort_order ?? 0) || 0) - (Number(b.sort_order ?? 0) || 0))
            }

            // Attachments -> photos (transitional mapping: keep lot.photos UX, but source-of-truth is server attachments table).
            let mergedPhotos = Array.isArray(nextLotBase.photos) ? nextLotBase.photos : []
            if (incomingAttachments && incomingAttachments.length > 0) {
              const photoById = new Map(mergedPhotos.map((p) => [p?.id, p]).filter(([id]) => id))
              for (const a of incomingAttachments) {
                if (!a?.id) continue
                if (String(a.kind ?? 'photo') !== 'photo') continue
                if (a.deleted_at) {
                  photoById.delete(a.id)
                  continue
                }

                const existing = photoById.get(a.id) ?? null
                const remoteBlobId = encodeRemoteBlobId(a.storage_bucket ?? 'photos', a.thumb_storage_path ?? a.storage_path ?? '')
                const next = {
                  id: a.id,
                  lot_id: a.lot_id,
                  task_id: a.task_id ?? null,
                  inspection_id: null,
                  punch_item_id: null,
                  daily_log_id: null,
                  category: a.category ?? 'progress',
                  blob_id: (existing?.blob_id ?? remoteBlobId) || null,
                  file_name: a.file_name ?? '',
                  mime: a.mime ?? '',
                  file_size: Number.isFinite(Number(a.file_size)) ? Number(a.file_size) : 0,
                  caption: a.caption ?? '',
                  location: existing?.location ?? '',
                  tags: existing?.tags ?? [],
                  taken_at: a.created_at ?? a.updated_at ?? null,
                  device_type: existing?.device_type ?? '',
                  gps_lat: existing?.gps_lat ?? null,
                  gps_lng: existing?.gps_lng ?? null,
                  uploaded_at: a.updated_at ?? a.created_at ?? null,
                  uploaded_by: existing?.uploaded_by ?? '',
                  upload_source: existing?.upload_source ?? 'cloud',
                  synced: true,
                  sync_error: null,
                  storage_bucket: a.storage_bucket ?? 'photos',
                  storage_path: a.storage_path ?? null,
                  thumb_storage_path: a.thumb_storage_path ?? null,
                }

                // If this photo already exists locally, preserve the local blob_id and metadata while adding storage pointers.
                if (existing && existing.blob_id && !String(existing.blob_id).startsWith('sb:')) {
                  next.blob_id = existing.blob_id
                }

                photoById.set(a.id, { ...(existing ?? {}), ...next })
              }
              mergedPhotos = Array.from(photoById.values()).filter(Boolean).slice().sort((x, y) => String(y.taken_at ?? '').localeCompare(String(x.taken_at ?? '')))
            }

            // Ensure each task has a list of associated photo ids based on task_id pointers.
            const photoIdsByTaskId = new Map()
            for (const p of mergedPhotos) {
              const tid = p?.task_id
              if (!tid || !p?.id) continue
              const list = photoIdsByTaskId.get(tid) ?? []
              list.push(p.id)
              photoIdsByTaskId.set(tid, list)
            }
            const tasksWithPhotos = mergedTasks.map((t) => {
              const ids = photoIdsByTaskId.get(t.id) ?? []
              if (ids.length === 0) return t
              const existing = Array.isArray(t.photos) ? t.photos : []
              const merged = Array.from(new Set([...existing, ...ids]))
              return { ...t, photos: merged }
            })

            return { ...nextLotBase, tasks: tasksWithPhotos, photos: mergedPhotos }
          })

          const knownLotIds = new Set(nextLots.map((l) => l.id))
          for (const lotRow of pullRes.lots ?? []) {
            if (!lotRow?.id || knownLotIds.has(lotRow.id)) continue
            if (blockedLotIds.has(lotRow.id)) continue
            const incomingTasks = tasksByLotId.get(lotRow.id) ?? []
            const incomingAttachments = attachmentsByLotId.get(lotRow.id) ?? []
            const base = mapLotFromSupabase(lotRow, incomingTasks)
            const mergedTasks = (base.tasks ?? []).filter((t) => !t?.deleted_at).slice().sort((a, b) => (Number(a.sort_order ?? 0) || 0) - (Number(b.sort_order ?? 0) || 0))
            let mergedPhotos = Array.isArray(base.photos) ? base.photos : []
            if (incomingAttachments.length > 0) {
              const photoById = new Map(mergedPhotos.map((p) => [p?.id, p]).filter(([id]) => id))
              for (const a of incomingAttachments) {
                if (!a?.id) continue
                if (String(a.kind ?? 'photo') !== 'photo') continue
                if (a.deleted_at) {
                  photoById.delete(a.id)
                  continue
                }
                const existing = photoById.get(a.id) ?? null
                const remoteBlobId = encodeRemoteBlobId(a.storage_bucket ?? 'photos', a.thumb_storage_path ?? a.storage_path ?? '')
                const next = {
                  id: a.id,
                  lot_id: a.lot_id,
                  task_id: a.task_id ?? null,
                  category: a.category ?? 'progress',
                  blob_id: (existing?.blob_id ?? remoteBlobId) || null,
                  file_name: a.file_name ?? '',
                  mime: a.mime ?? '',
                  file_size: Number.isFinite(Number(a.file_size)) ? Number(a.file_size) : 0,
                  caption: a.caption ?? '',
                  location: existing?.location ?? '',
                  tags: existing?.tags ?? [],
                  taken_at: a.created_at ?? a.updated_at ?? null,
                  uploaded_at: a.updated_at ?? a.created_at ?? null,
                  upload_source: existing?.upload_source ?? 'cloud',
                  synced: true,
                  sync_error: null,
                  storage_bucket: a.storage_bucket ?? 'photos',
                  storage_path: a.storage_path ?? null,
                  thumb_storage_path: a.thumb_storage_path ?? null,
                }
                photoById.set(a.id, { ...(existing ?? {}), ...next })
              }
              mergedPhotos = Array.from(photoById.values()).filter(Boolean).slice().sort((x, y) => String(y.taken_at ?? '').localeCompare(String(x.taken_at ?? '')))
            }

            const photoIdsByTaskId = new Map()
            for (const p of mergedPhotos) {
              const tid = p?.task_id
              if (!tid || !p?.id) continue
              const list = photoIdsByTaskId.get(tid) ?? []
              list.push(p.id)
              photoIdsByTaskId.set(tid, list)
            }
            const tasksWithPhotos = mergedTasks.map((t) => {
              const ids = photoIdsByTaskId.get(t.id) ?? []
              if (ids.length === 0) return t
              const existing = Array.isArray(t.photos) ? t.photos : []
              const merged = Array.from(new Set([...existing, ...ids]))
              return { ...t, photos: merged }
            })

            nextLots.push({ ...base, tasks: tasksWithPhotos, photos: mergedPhotos })
          }

          const nextAssignments = pullRes.lot_assignments ?? null
          const nextSync = {
            ...(prev.sync ?? {}),
            v2_last_pulled_at: serverTime,
          }

          return {
            ...prev,
            lots: nextLots,
            lot_assignments: Array.isArray(nextAssignments) ? nextAssignments : prev.lot_assignments,
            sync: nextSync,
          }
        })

        await setSyncV2Cursor(serverTime)
        setSyncV2Status((prev) => ({ ...prev, phase: 'ready', last_pulled_at: serverTime, error: '', warning: prev.warning }))

        scheduleNext(4500)
      } catch (err) {
        const msg = String(err?.message ?? 'Sync v2 failed')
        setSyncV2Status((prev) => ({ ...prev, phase: 'error', error: msg }))
        if (looksLikeNetworkError(err)) setIsOnline(false)
        scheduleNext(12000)
      } finally {
        inFlight = false
      }
    }

    tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [syncV2Enabled, supabaseUser?.id, supabaseStatus.phase])

  const pendingSyncOps = app.sync?.pending ?? []
  const pendingSyncCount = pendingSyncOps.length
  const lastSyncedAt = app.sync?.last_synced_at ?? null
  const isGuestSession = Boolean(supabaseUser?.is_anonymous)
  const cloudQueue = Array.isArray(app.sync?.cloud_queue) ? app.sync.cloud_queue : []
  const cloudQueueCount = cloudQueue.length
  const cloudHasPending =
    cloudQueueCount > 0 ||
    writeSyncState.phase === 'pending' ||
    writeSyncState.phase === 'syncing' ||
    writeSyncState.phase === 'error'
  const cloudLastSyncedAt = app.sync?.cloud_last_synced_at ?? writeSyncState.lastSyncedAt ?? null
  const uiLastSyncedAt = cloudLastSyncedAt ?? writeSyncState.lastSyncedAt ?? null
  const uiLastCheckAt = supabaseStatus.loadedAt ?? uiLastSyncedAt ?? null
  const cloudLastError = app.sync?.cloud_last_error ?? writeSyncState.error ?? ''
  const cloudLastErrorAt = app.sync?.cloud_last_error_at ?? null
  const cloudNextRetryAt = useMemo(() => {
    if (cloudQueue.length === 0) return null
    const times = cloudQueue
      .map((item) => (item?.next_retry_at ? new Date(item.next_retry_at).getTime() : null))
      .filter((value) => Number.isFinite(value))
    if (times.length === 0) return null
    return new Date(Math.min(...times)).toISOString()
  }, [cloudQueue])
  const showSyncPill = !isOnline || pendingSyncCount > 0 || Boolean(supabaseUser?.id)
  const syncPillLabel = (() => {
    if (!isOnline) return 'Offline'
    if (!supabaseUser?.id) return pendingSyncCount > 0 ? 'Sync' : 'Local'
    if (supabaseStatus.phase !== 'ready') return 'Connecting'
    if (writeSyncState.phase === 'error') return 'Sync error'
    if (writeSyncState.phase === 'syncing') return 'Syncing'
    if (cloudQueueCount > 0 || writeSyncState.phase === 'pending') return 'Pending'
    return 'Synced'
  })()

  useEffect(() => {
    if (!supabaseUser?.id) {
      setWriteSyncState({ phase: 'idle', lastSyncedAt: null, error: '' })
      return
    }
    if (cloudQueue.length === 0 && writeSyncState.phase !== 'syncing') {
      setWriteSyncState((prev) => (prev.phase === 'synced' ? prev : { ...prev, phase: 'synced', error: '' }))
    }
  }, [cloudQueue.length, supabaseUser?.id])

  useEffect(() => {
    if (cloudQueue.length === 0) return
    const times = cloudQueue
      .map((item) => (item?.next_retry_at ? new Date(item.next_retry_at).getTime() : null))
      .filter((value) => Number.isFinite(value))
    if (times.length === 0) return
    const nextTime = Math.min(...times)
    const delay = Math.max(250, nextTime - Date.now())
    const timer = setTimeout(() => setCloudRetryTick((prev) => prev + 1), delay)
    return () => clearTimeout(timer)
  }, [cloudQueue, cloudRetryTick])

  useEffect(() => {
    if (syncV2Enabled) return
    if (!supabaseUser?.id || supabaseStatus.phase !== 'ready' || !isOnline) return
    if (cloudQueue.length === 0) return
    if (supabaseWriteInFlightRef.current) return

    const latest = cloudQueue[cloudQueue.length - 1]
    if (!latest) return
    const retryAt = latest.next_retry_at ? new Date(latest.next_retry_at).getTime() : 0
    if (retryAt && retryAt > Date.now()) return

    const built = buildCloudPayload()
    if (!built) return
    const { payload, hash } = built

    supabaseWriteInFlightRef.current = true
    setWriteSyncState((prev) => ({ ...prev, phase: 'syncing', error: '' }))

    let cancelled = false
    const runSync = async () => {
      try {
        const { syncedAt } = await syncPayloadToSupabase(payload)
        if (cancelled) return

        setApp((prev) => {
          const sync = prev.sync ?? {}
          const queue = Array.isArray(sync.cloud_queue) ? sync.cloud_queue : []
          const queueLatest = queue[queue.length - 1]
          const hasNewer = queueLatest && queueLatest.hash !== hash
          return {
            ...prev,
            sync: {
              ...sync,
              cloud_queue: hasNewer ? queue : [],
              cloud_last_synced_at: syncedAt,
              cloud_last_synced_hash: hash,
              cloud_last_error: '',
              cloud_last_error_at: null,
            },
          }
        })

        const hasNewer = cloudQueue[cloudQueue.length - 1]?.hash && cloudQueue[cloudQueue.length - 1]?.hash !== hash
        setWriteSyncState({ phase: hasNewer ? 'pending' : 'synced', lastSyncedAt: syncedAt, error: '' })
      } catch (err) {
        if (cancelled) return
        console.error('Supabase sync failed', err)
        const message = String(err?.message ?? 'Supabase sync failed')
        const attempts = (latest.attempts ?? 0) + 1
        const delayMs = Math.min(300000, 5000 * Math.pow(2, Math.max(0, attempts - 1)))
        const nextRetryAt = new Date(Date.now() + delayMs).toISOString()
        const errorAt = new Date().toISOString()

        setApp((prev) => {
          const sync = prev.sync ?? {}
          const queue = Array.isArray(sync.cloud_queue) ? sync.cloud_queue : []
          const queueLatest = queue[queue.length - 1]
          if (!queueLatest || queueLatest.hash !== hash) {
            return { ...prev, sync: { ...sync, cloud_last_error: message, cloud_last_error_at: errorAt } }
          }
          const nextQueue = [
            {
              ...queueLatest,
              attempts,
              last_error: message,
              next_retry_at: nextRetryAt,
            },
          ]
          return {
            ...prev,
            sync: {
              ...sync,
              cloud_queue: nextQueue,
              cloud_last_error: message,
              cloud_last_error_at: errorAt,
            },
          }
        })

        setWriteSyncState((prev) => ({ ...prev, phase: 'error', error: message }))
      } finally {
        supabaseWriteInFlightRef.current = false
      }
    }

    runSync()
    return () => {
      cancelled = true
    }
  }, [cloudQueue, supabaseUser?.id, supabaseStatus.phase, isOnline, cloudRetryTick, syncV2Enabled])

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true)
      // Simulated "sync": mark queued items as synced when connectivity returns.
      setApp((prev) => {
        const now = new Date().toISOString()
        return {
          ...prev,
          lots: (prev.lots ?? []).map((lot) => ({
            ...lot,
            photos: (lot.photos ?? []).map((p) => (p && !p.synced ? { ...p, synced: true, sync_error: null } : p)),
          })),
          messages: (prev.messages ?? []).map((m) => (m && m.status === 'queued' ? { ...m, status: 'sent', sent_at: now } : m)),
          sync: {
            ...(prev.sync ?? {}),
            pending: [],
            last_synced_at: now,
          },
        }
      })
    }
    const onOffline = () => setIsOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  const communityWeatherLocation = useMemo(
    () => buildCommunityWeatherLocation(app.communities ?? [], app.lots ?? []),
    [app.communities, app.lots],
  )

  const effectiveWeatherLocation = useMemo(() => {
    if (weatherLocationMode === 'madison') {
      return WEATHER_FALLBACK
    }
    if (weatherLocationMode === 'huntsville') {
      return WEATHER_HUNTSVILLE
    }
    return userWeatherLocation ?? communityWeatherLocation ?? WEATHER_FALLBACK
  }, [weatherLocationMode, userWeatherLocation, communityWeatherLocation])

  const requestWeatherGeo = useCallback(
    (force = false) => {
      if (!force && weatherGeoRequested) return
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        setWeatherGeoRequested(true)
        setUserWeatherLocation(null)
        return
      }

      setWeatherGeoRequested(true)
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setUserWeatherLocation({
            id: 'device',
            name: 'Your Location',
            latitude: Number(pos.coords.latitude),
            longitude: Number(pos.coords.longitude),
            timezone: app?.org?.timezone || WEATHER_FALLBACK.timezone,
            source: 'device',
          })
        },
        () => {
          // Permission denied/unavailable: fall back to community location.
          setUserWeatherLocation(null)
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 },
      )
    },
    [weatherGeoRequested, app?.org?.timezone],
  )

  useEffect(() => {
    if (weatherLocationMode !== 'auto') return
    requestWeatherGeo(false)
  }, [weatherLocationMode, requestWeatherGeo])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const effectiveLocation = effectiveWeatherLocation

    const loadWeather = async () => {
      setWeather((prev) => ({
        ...prev,
        loading: true,
        locationName: effectiveLocation.name,
        source: effectiveLocation.source,
      }))
      try {
        const url = new URL('https://api.open-meteo.com/v1/forecast')
        url.searchParams.set('latitude', String(effectiveLocation.latitude))
        url.searchParams.set('longitude', String(effectiveLocation.longitude))
        url.searchParams.set('timezone', effectiveLocation.timezone || WEATHER_FALLBACK.timezone)
        url.searchParams.set('temperature_unit', 'fahrenheit')
        url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode,wind_speed_10m_max')

        const res = await fetch(url.toString(), { signal: controller.signal })
        if (!res.ok) throw new Error(`Weather request failed: ${res.status}`)
        const json = await res.json()
        const forecast = build7DayForecast(json?.daily)
        if (!cancelled) {
          setWeather({
            loading: false,
            forecast,
            locationName: effectiveLocation.name,
            source: effectiveLocation.source,
          })
        }
      } catch (err) {
        if (!cancelled && err?.name !== 'AbortError') {
          console.error(err)
          setWeather((prev) => ({ ...prev, loading: false, locationName: effectiveLocation.name, source: effectiveLocation.source }))
        }
      }
    }

    if (isOnline) loadWeather()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [isOnline, effectiveWeatherLocation])

  useEffect(() => {
    setSelectedScheduleTaskIds([])
    setParallelOverrideDeps(false)
    setListDraggingTaskId(null)
    setListDropTaskId(null)
    setListDragOffset(0)
  }, [selectedLotId, scheduleView])

  const org = app.org
  const communities = app.communities ?? []
  const productTypes = app.product_types ?? []
  const plans = app.plans ?? []
  const agencies = app.agencies ?? []
  const lotAssignments = app.lot_assignments ?? []
  const contactLibrary = app.contact_library ?? { builders: [], realtors: [] }
  const contactLibraryBuilders = contactLibrary.builders ?? []
  const contactLibraryRealtors = contactLibrary.realtors ?? []
  const { businessDaysBetweenInclusive, getNextWorkDay } = makeWorkdayHelpers(org)
  const todayIso = formatISODateInTimeZone(new Date(), org?.timezone) || formatISODate(new Date())

  const communitiesById = useMemo(() => new Map(app.communities.map((c) => [c.id, c])), [app.communities])
  const lotsById = useMemo(() => new Map(app.lots.map((l) => [l.id, l])), [app.lots])

  const activeSuperAssignments = useMemo(() => {
    if (!Array.isArray(lotAssignments) || lotAssignments.length === 0) return []
    return lotAssignments.filter((a) => {
      if (!a) return false
      if (a.role && a.role !== 'super') return false
      if (a.deleted_at) return false
      if (a.ended_at) return false
      return Boolean(a.lot_id) && Boolean(a.profile_id)
    })
  }, [lotAssignments])

  const activeSuperAssignmentByLotId = useMemo(() => {
    const map = new Map()
    for (const a of activeSuperAssignments) {
      if (!a?.lot_id) continue
      if (!map.has(a.lot_id)) map.set(a.lot_id, a)
    }
    return map
  }, [activeSuperAssignments])

  const myAssignedLotIds = useMemo(() => {
    const set = new Set()
    const me = supabaseUser?.id ?? ''
    if (!me) return set
    for (const a of activeSuperAssignments) {
      if (a?.profile_id === me && a?.lot_id) set.add(a.lot_id)
    }
    return set
  }, [activeSuperAssignments, supabaseUser?.id])

  const effectiveRoleForAccess = supabaseStatus?.role ?? app?.sync?.supabase_role ?? null

  const shouldEnforceLotAssignments =
    Boolean(supabaseUser?.id) && effectiveRoleForAccess === 'super' && !app?.org?.is_demo

  const canEditLot = (lotId) => {
    if (!shouldEnforceLotAssignments) return true
    return myAssignedLotIds.has(lotId)
  }
  const productTypesById = useMemo(() => new Map(productTypes.map((pt) => [pt.id, pt])), [productTypes])
  const allSubsSorted = useMemo(
    () => (app.subcontractors ?? []).slice().sort((a, b) => String(a.company_name).localeCompare(String(b.company_name))),
    [app.subcontractors],
  )

  const getSubsForTrade = (tradeId) => {
    const matching = allSubsSorted.filter((s) => s.trade === tradeId || (s.secondary_trades ?? []).includes(tradeId))
    return matching.length > 0 ? matching : allSubsSorted
  }

  const selectedCommunity = selectedCommunityId ? communitiesById.get(selectedCommunityId) : null
  const selectedLot = selectedLotId ? lotsById.get(selectedLotId) : null
  const selectedCommunityBuilders = selectedCommunity?.builders ?? []
  const selectedCommunityRealtors = selectedCommunity?.realtors ?? []
  const selectedCommunityInspectors = selectedCommunity?.inspectors ?? []
  const selectedCommunityBuilderById = useMemo(
    () => new Map(selectedCommunityBuilders.map((b) => [b.id, b])),
    [selectedCommunityBuilders],
  )

  const toggleManualMilestone = (lotId, milestoneId, nextValue) => {
    const lot = lotsById.get(lotId) ?? null
    const community = lot ? communitiesById.get(lot.community_id) ?? null : null

    updateLot(lotId, (l) => ({
      ...l,
      manual_milestones: { ...(l.manual_milestones ?? {}), [milestoneId]: Boolean(nextValue) },
    }))

    if (nextValue) {
      const m = (MILESTONES ?? []).find((x) => x.id === milestoneId)
      if (m) {
        pushNotificationDeduped({
          dedupeKey: `milestone_reached:${lotId}:${milestoneId}`,
          type: 'milestone_reached',
          title: `Milestone Reached - ${community?.name ?? ''} ${lot ? lotCode(lot) : ''}`.trim(),
          body: `${m.label} (${m.pct}%)`,
          entity_type: 'lot',
          entity_id: lotId,
          lot_id: lotId,
          priority: 'normal',
        })
      }
    }
  }

  const activeLots = useMemo(() => app.lots.filter((l) => l.status === 'in_progress'), [app.lots])

  const unreadNotifications = useMemo(
    () => (app.notifications ?? []).filter((n) => !n.read).length,
    [app.notifications],
  )

  const enqueueSyncOp = ({ type, lot_id, entity_type, entity_id, summary }) => {
    const now = new Date().toISOString()
    const op = {
      id: uuid(),
      type,
      lot_id: lot_id ?? null,
      entity_type: entity_type ?? null,
      entity_id: entity_id ?? null,
      summary: summary ?? '',
      created_at: now,
    }

    // Best-effort: mirror into IndexedDB outbox so v2 sync can pick it up later.
    // (Do not await; UI must stay responsive and localStorage snapshot remains the primary durability today.)
    try {
      Promise.resolve().then(() => outboxEnqueue({ ...op, next_retry_at: null }))
    } catch {
      // ignore
    }

    setApp((prev) => ({
      ...prev,
      sync: {
        ...(prev.sync ?? {}),
        pending: [...((prev.sync ?? {}).pending ?? []), op],
      },
    }))

    return op.id
  }

  const buildV2TaskPatch = (prevTask, nextTask, { mode = 'schedule' } = {}) => {
    if (!prevTask || !nextTask) return null
    const patch = {}

    const includeSchedule = mode === 'schedule' || mode === 'any'
    const includeTaskMeta = mode === 'task' || mode === 'any'

    if (includeSchedule) {
      if ((Number(prevTask.duration ?? 0) || 0) !== (Number(nextTask.duration ?? 0) || 0)) patch.duration = Math.max(1, Number(nextTask.duration ?? 1) || 1)
      if ((Number(prevTask.sort_order ?? 0) || 0) !== (Number(nextTask.sort_order ?? 0) || 0)) patch.sort_order = Number.isFinite(Number(nextTask.sort_order)) ? Math.trunc(Number(nextTask.sort_order)) : 0
      if (String(prevTask.scheduled_start ?? '') !== String(nextTask.scheduled_start ?? '')) patch.scheduled_start = nextTask.scheduled_start ?? null
      if (String(prevTask.scheduled_end ?? '') !== String(nextTask.scheduled_end ?? '')) patch.scheduled_end = nextTask.scheduled_end ?? null
      if (String(prevTask.delay_reason ?? '') !== String(nextTask.delay_reason ?? '')) patch.delay_reason = nextTask.delay_reason ?? null
      if ((Number(prevTask.delay_days ?? 0) || 0) !== (Number(nextTask.delay_days ?? 0) || 0)) patch.delay_days = Number.isFinite(Number(nextTask.delay_days)) ? Number(nextTask.delay_days) : 0
    }

    if (includeTaskMeta) {
      if (String(prevTask.status ?? '') !== String(nextTask.status ?? '')) patch.status = nextTask.status ?? 'not_started'
      if (String(prevTask.actual_start ?? '') !== String(nextTask.actual_start ?? '')) patch.actual_start = nextTask.actual_start ?? null
      if (String(prevTask.actual_end ?? '') !== String(nextTask.actual_end ?? '')) patch.actual_end = nextTask.actual_end ?? null
      if (String(prevTask.sub_id ?? '') !== String(nextTask.sub_id ?? '')) patch.sub_id = nextTask.sub_id ?? null
      if (String(prevTask.notes ?? '') !== String(nextTask.notes ?? '')) patch.notes = nextTask.notes ?? null
    }

    return Object.keys(patch).length > 0 ? patch : null
  }

  // Sync v2 lot updates are intentionally scoped to "start lot" and other schedule-impacting
  // fields. We avoid sending full lot rows (which contain large arrays like photos/docs) to
  // prevent accidental clobbering while v2 is still being rolled out.
  const buildV2LotPatch = (prevLot, nextLot) => {
    if (!prevLot || !nextLot) return null
    const patch = {}

    const same = (a, b) => String(a ?? '') === String(b ?? '')
    const sameNum = (a, b) => (Number(a ?? 0) || 0) === (Number(b ?? 0) || 0)

    if (!same(prevLot.status, nextLot.status)) patch.status = nextLot.status ?? 'not_started'
    if (!same(prevLot.start_date, nextLot.start_date)) patch.start_date = nextLot.start_date ?? null
    if (!same(prevLot.plan_id, nextLot.plan_id)) patch.plan_id = nextLot.plan_id ?? null
    if (!same(prevLot.job_number, nextLot.job_number)) patch.job_number = nextLot.job_number ?? ''
    if (!same(prevLot.address, nextLot.address)) patch.address = nextLot.address ?? ''
    if (!same(prevLot.permit_number, nextLot.permit_number)) patch.permit_number = nextLot.permit_number ?? null
    if (!same(prevLot.hard_deadline, nextLot.hard_deadline)) patch.hard_deadline = nextLot.hard_deadline ?? null
    if (!same(prevLot.model_type, nextLot.model_type)) patch.model_type = nextLot.model_type ?? ''
    if (!sameNum(prevLot.build_days, nextLot.build_days)) patch.build_days = Math.max(1, Number(nextLot.build_days ?? 1) || 1)
    if (!same(prevLot.target_completion_date, nextLot.target_completion_date)) patch.target_completion_date = nextLot.target_completion_date ?? null
    if (!same(prevLot.actual_completion_date, nextLot.actual_completion_date)) patch.actual_completion_date = nextLot.actual_completion_date ?? null

    // Treat custom_fields as an atomic JSON blob for now (patch only if reference/shape changed).
    const prevCustom = prevLot.custom_fields ?? {}
    const nextCustom = nextLot.custom_fields ?? {}
    if (JSON.stringify(prevCustom) !== JSON.stringify(nextCustom)) patch.custom_fields = nextCustom

    return Object.keys(patch).length > 0 ? patch : null
  }

  const buildV2TasksBatchOp = ({ lotId, prevLot, nextLot, includeLotRow = false, mode = 'schedule' }) => {
    if (!syncV2Enabled) return null
    const userId = supabaseUser?.id ?? app?.sync?.supabase_user_id ?? null
    const orgId = supabaseStatus?.orgId ?? app?.sync?.supabase_org_id ?? null
    if (!userId || !orgId) return null
    if (!prevLot || !nextLot) return null

    const prevTasks = Array.isArray(prevLot.tasks) ? prevLot.tasks : []
    const nextTasks = Array.isArray(nextLot.tasks) ? nextLot.tasks : []
    const prevById = new Map(prevTasks.map((t) => [t.id, t]))
    const nextById = new Map(nextTasks.map((t) => [t.id, t]))

    const tasksPayload = []

    for (const nextTask of nextTasks) {
      if (!nextTask?.id) continue
      const prevTask = prevById.get(nextTask.id) ?? null
      if (!prevTask) {
        // Insert: send full row for required fields.
        tasksPayload.push({
          action: 'upsert',
          id: nextTask.id,
          base_version: null,
          row: mapTaskToSupabase(nextTask, lotId, orgId),
        })
        continue
      }

      const patch = buildV2TaskPatch(prevTask, nextTask, { mode })
      if (!patch) continue
      tasksPayload.push({
        action: 'upsert',
        id: nextTask.id,
        base_version: Number.isFinite(Number(prevTask.version)) ? Number(prevTask.version) : null,
        row: patch,
      })
    }

    // Deletes: task existed before, missing now.
    for (const prevTask of prevTasks) {
      if (!prevTask?.id) continue
      if (nextById.has(prevTask.id)) continue
      tasksPayload.push({
        action: 'delete',
        id: prevTask.id,
        base_version: Number.isFinite(Number(prevTask.version)) ? Number(prevTask.version) : null,
        row: null,
      })
    }

    const lotBaseVersion = Number.isFinite(Number(prevLot.version)) ? Number(prevLot.version) : null
    const canIncludeLotPatch = Boolean(includeLotRow) && Number.isFinite(Number(lotBaseVersion))
    const lotRow = canIncludeLotPatch ? buildV2LotPatch(prevLot, nextLot) : null

    if (tasksPayload.length === 0 && !lotRow) return null

    const opId = uuid()
    const now = new Date().toISOString()

    const payload = {
      id: opId,
      kind: 'tasks_batch',
      lot_id: lotId,
      lot_base_version: canIncludeLotPatch ? lotBaseVersion : null,
      lot: lotRow,
      tasks: tasksPayload,
    }

    return {
      id: opId,
      v2: true,
      kind: 'tasks_batch',
      lot_id: lotId,
      entity_ids: tasksPayload.map((t) => t.id).filter(Boolean),
      created_at: now,
      attempts: 0,
      next_retry_at: null,
      last_error: '',
      last_error_at: null,
      payload,
    }
  }

  const buildV2AttachmentUpsertOp = ({ attachmentId, lotId, taskId, kind, category, caption, mime, fileName, fileSize, storageBucket, storagePath, thumbStoragePath, clientBlobId }) => {
    if (!syncV2Enabled) return null
    const userId = supabaseUser?.id ?? app?.sync?.supabase_user_id ?? null
    const orgId = supabaseStatus?.orgId ?? app?.sync?.supabase_org_id ?? null
    if (!userId || !orgId) return null
    if (!attachmentId || !lotId || !storageBucket || !storagePath || !clientBlobId) return null

    const opId = uuid()
    const now = new Date().toISOString()

    const payload = {
      id: opId,
      kind: 'attachments_batch',
      attachments: [
        {
          action: 'upsert',
          id: attachmentId,
          base_version: null,
          row: {
            lot_id: lotId,
            task_id: taskId ?? null,
            kind: kind ?? 'photo',
            category: category ?? null,
            caption: caption ?? null,
            mime: mime ?? '',
            file_name: fileName ?? '',
            file_size: Number.isFinite(Number(fileSize)) ? Number(fileSize) : 0,
            storage_bucket: storageBucket,
            storage_path: storagePath,
            thumb_storage_path: thumbStoragePath ?? null,
            client_blob_id: clientBlobId,
          },
        },
      ],
    }

    return {
      id: opId,
      v2: true,
      kind: 'attachments_batch',
      lot_id: lotId,
      entity_ids: [attachmentId].filter(Boolean),
      created_at: now,
      attempts: 0,
      next_retry_at: null,
      last_error: '',
      last_error_at: null,
      payload,
    }
  }

  const _buildV2AttachmentDeleteOp = ({ attachmentId, lotId, baseVersion }) => {
    if (!syncV2Enabled) return null
    const userId = supabaseUser?.id ?? app?.sync?.supabase_user_id ?? null
    const orgId = supabaseStatus?.orgId ?? app?.sync?.supabase_org_id ?? null
    if (!userId || !orgId) return null
    if (!attachmentId || !lotId) return null
    if (!Number.isFinite(Number(baseVersion))) return null

    const opId = uuid()
    const now = new Date().toISOString()

    const payload = {
      id: opId,
      kind: 'attachments_batch',
      attachments: [
        {
          action: 'delete',
          id: attachmentId,
          base_version: Number(baseVersion),
          row: null,
        },
      ],
    }

    return {
      id: opId,
      v2: true,
      kind: 'attachments_batch',
      lot_id: lotId,
      entity_ids: [attachmentId].filter(Boolean),
      created_at: now,
      attempts: 0,
      next_retry_at: null,
      last_error: '',
      last_error_at: null,
      payload,
    }
  }

  const syncNow = () => {
    if (!isOnline) return
    setApp((prev) => {
      const now = new Date().toISOString()
      const sync = prev.sync ?? {}
      const queue = Array.isArray(sync.cloud_queue) ? sync.cloud_queue : []
      const refreshedQueue = queue.map((item) => ({ ...item, next_retry_at: null }))
      return {
        ...prev,
        lots: (prev.lots ?? []).map((lot) => ({
          ...lot,
          photos: (lot.photos ?? []).map((p) => (p && !p.synced ? { ...p, synced: true, sync_error: null } : p)),
        })),
        messages: (prev.messages ?? []).map((m) =>
          m && m.status === 'queued' ? { ...m, status: 'sent', sent_at: now } : m,
        ),
        sync: {
          ...sync,
          pending: [],
          last_synced_at: now,
          cloud_queue: refreshedQueue,
          cloud_last_error: '',
          cloud_last_error_at: null,
        },
      }
    })
    if (supabaseUser?.id) {
      setWriteSyncState((prev) => ({ ...prev, phase: prev.phase === 'syncing' ? 'syncing' : 'pending', error: '' }))
      setCloudRetryTick((prev) => prev + 1)
    }
  }

  const resetDemo = () => {
    clearAppState()
    setApp(createSeedState())
    setTab('dashboard')
    setSelectedCommunityId(null)
    setSelectedLotId(null)
    setLotDetailTab('overview')
  }

  const setAuthField = (field, value) => {
    setAuthDraft((prev) => ({ ...prev, [field]: value }))
  }

  const ensureGuestOrg = async () => {
    if (!supabaseUser?.is_anonymous) return null
    const { data, error } = await supabase.rpc('ensure_guest_org')
    if (error) {
      setSupabaseStatus((prev) => ({
        ...prev,
        phase: 'error',
        message: `Guest org provisioning failed: ${error.message}`,
        loadedAt: new Date().toISOString(),
      }))
      return null
    }
    const row = Array.isArray(data) ? data[0] ?? null : data
    return row
  }

  const refreshLotAssignments = async (overrideOrgId = null) => {
    if (!supabaseUser?.id) return null
    const orgId = overrideOrgId ?? supabaseStatus?.orgId ?? null
    if (!orgId) return null

    const { data, error } = await supabase.from('lot_assignments').select('*').eq('org_id', orgId)
    if (error) return null

    const rows = Array.isArray(data) ? data : []
    setApp((prev) => ({ ...prev, lot_assignments: rows }))
    return rows
  }

  const claimLot = async (lotId) => {
    if (!lotId) return false
    if (!supabaseUser?.id) {
      alert('Sign in to claim lots.')
      return false
    }
    if (!isOnline) {
      alert('Claiming a lot requires a connection.')
      return false
    }
    if (claimLotBusyId) return false

    setClaimLotBusyId(lotId)
    try {
      const { error } = await supabase.rpc('claim_lot', { p_lot_id: lotId })
      if (error) {
        alert(error.message || 'Unable to claim lot.')
        return false
      }

      await refreshLotAssignments()
      return true
    } catch (err) {
      alert(err?.message || 'Unable to claim lot.')
      return false
    } finally {
      setClaimLotBusyId(null)
    }
  }

  const signInAsGuest = async () => {
    setAuthBusy(true)
    setAuthError('')
    const { error } = await supabase.auth.signInAnonymously()
    setAuthBusy(false)

    if (error) {
      setAuthError(error.message)
      setSupabaseStatus((prev) => ({
        ...prev,
        phase: 'error',
        message: `Guest sign-in failed: ${error.message}`,
        loadedAt: new Date().toISOString(),
      }))
      return
    }

    const { error: provisionError } = await supabase.rpc('ensure_guest_org')
    if (provisionError) {
      setSupabaseStatus((prev) => ({
        ...prev,
        phase: 'error',
        message: `Guest org provisioning failed: ${provisionError.message}`,
        loadedAt: new Date().toISOString(),
      }))
      return
    }

    setSupabaseStatus((prev) => ({
      ...prev,
      phase: 'loading',
      message: 'Guest session ready. Syncing with Supabase...',
      loadedAt: new Date().toISOString(),
      warning: '',
    }))
    setShowAuthLanding(false)
  }

  const signInWithSupabase = async () => {
    const email = String(authDraft.email ?? '').trim()
    const password = String(authDraft.password ?? '')
    if (!email || !password) {
      setAuthError('Enter both email and password.')
      return
    }

    setAuthBusy(true)
    setAuthError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setAuthBusy(false)

    if (error) {
      setAuthError(error.message)
      setSupabaseStatus((prev) => ({
        ...prev,
        phase: 'error',
        message: `Sign in failed: ${error.message}`,
        loadedAt: new Date().toISOString(),
      }))
      return
    }

    setAuthDraft((prev) => ({ ...prev, password: '' }))
    setShowAuthLanding(false)
  }

  const createSupabaseLogin = async () => {
    const email = String(authDraft.email ?? '').trim()
    const password = String(authDraft.password ?? '')
    if (!email || !password) {
      setAuthError('Enter an email and password to create a login.')
      return
    }

    setAuthBusy(true)
    setAuthError('')
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined },
    })
    setAuthBusy(false)

    if (error) {
      setAuthError(error.message)
      return
    }

    setAuthDraft((prev) => ({ ...prev, password: '' }))
    setSupabaseStatus((prev) => ({
      ...prev,
      phase: 'auth_pending',
      message: 'Account created. Check your email if confirmation is enabled, then sign in.',
      loadedAt: new Date().toISOString(),
    }))
  }

  const signOutFromSupabase = async () => {
    setAuthBusy(true)
    setAuthError('')
    const { error } = await supabase.auth.signOut()
    setAuthBusy(false)
    if (error) {
      setAuthError(error.message)
      return
    }
    setShowAuthLanding(true)
    setSupabaseBootstrapVersion((prev) => prev + 1)
  }

  const refreshSupabaseBootstrap = () => {
    if (!supabaseUser?.id) return
    setSupabaseBootstrapVersion((prev) => prev + 1)
  }

  const resetRemoteSeed = async () => {
    if (!supabaseUser?.id) return

    const confirmed = typeof window === 'undefined' ? false : window.confirm('Reset all remote data back to the seed baseline? This will overwrite current Supabase data for this org.')
    if (!confirmed) return

    setResetSeedBusy(true)
    const { error } = await supabase.rpc('reset_buildflow_seed', { target_org_id: supabaseStatus.orgId ?? null })
    setResetSeedBusy(false)

    if (error) {
      setSupabaseStatus((prev) => ({
        ...prev,
        phase: 'error',
        message: `Seed reset failed: ${error.message}`,
        loadedAt: new Date().toISOString(),
      }))
      return
    }

    setSupabaseStatus((prev) => ({
      ...prev,
      phase: 'loading',
      message: 'Seed reset complete. Reloading Supabase data...',
      loadedAt: new Date().toISOString(),
    }))
    setSupabaseBootstrapVersion((prev) => prev + 1)
  }

  const navigateRoot = (nextTab) => {
    setTab(nextTab)
    setSelectedCommunityId(null)
    setSelectedLotId(null)
    setLotDetailTab('overview')
  }

  const [scheduleEditLock, setScheduleEditLock] = useState({
    lotId: null,
    token: null,
    expiresAt: null,
    lockedBy: null,
    warning: '',
    warningUntil: null,
    error: '',
  })
  const scheduleEditLockRef = useRef(scheduleEditLock)
  const scheduleEditLockAcquireRef = useRef(null)
  const scheduleEditLockLastDenyAtRef = useRef(0)

  useEffect(() => {
    scheduleEditLockRef.current = scheduleEditLock
  }, [scheduleEditLock])

  const releaseScheduleEditLock = async (token) => {
    const toRelease = token ?? scheduleEditLockRef.current?.token ?? null
    if (!toRelease) return
    if (!isOnline) return
    if (!supabaseUser?.id) return
    try {
      await supabase.rpc('release_lot_lock', { p_token: toRelease })
    } catch (_err) {
      void _err
      // Best-effort only.
    }
  }

  useEffect(() => {
    // Be polite: when leaving a lot, release the lock early instead of waiting for TTL expiry.
    const current = scheduleEditLockRef.current
    if (!current?.token || !current?.lotId) return
    if (!selectedLotId || current.lotId !== selectedLotId) {
      void releaseScheduleEditLock(current.token)
      setScheduleEditLock((prev) =>
        prev.token
          ? {
              ...prev,
              lotId: null,
              token: null,
              expiresAt: null,
              lockedBy: null,
              warning: '',
              warningUntil: null,
              error: '',
            }
          : prev,
      )
    }
  }, [selectedLotId])

  useEffect(() => {
    return () => {
      const current = scheduleEditLockRef.current
      if (current?.token) void releaseScheduleEditLock(current.token)
    }
  }, [])

  const isScheduleLockValidFor = (lock, lotId) => {
    if (!lock?.token || !lock?.expiresAt) return false
    if (lock.lotId !== lotId) return false
    const ms = new Date(lock.expiresAt).getTime()
    if (!Number.isFinite(ms)) return false
    // If we're actively editing, renew proactively rather than racing the expiry window.
    return ms - Date.now() > 60000
  }

  const ensureScheduleEditLock = async (lotId, { ttlSeconds = 300, quiet = false } = {}) => {
    const resolvedLotId = String(lotId ?? '').trim()
    if (!resolvedLotId) return { ok: true, mode: 'noop' }

    // Offline-first: locks are advisory and can't be required offline.
    if (!isOnline || !supabaseUser?.id || supabaseStatus.phase !== 'ready') {
      return { ok: true, mode: 'offline' }
    }

    const current = scheduleEditLockRef.current
    if (isScheduleLockValidFor(current, resolvedLotId)) return { ok: true, mode: 'cached', lock: current }

    if (current?.lotId === resolvedLotId && current.warning && current.warningUntil) {
      const untilMs = new Date(current.warningUntil).getTime()
      if (Number.isFinite(untilMs) && untilMs > Date.now()) {
        return { ok: true, mode: 'warning_cached', warning: current.warning }
      }
    }

    if (scheduleEditLockAcquireRef.current?.lotId === resolvedLotId) {
      return scheduleEditLockAcquireRef.current.promise
    }

    const orgIsDemo = Boolean(app.org?.is_demo)
    const isDemoLike = orgIsDemo || Boolean(isGuestSession)

    const promise = (async () => {
      setScheduleEditLock((prev) => ({ ...prev, warning: '', warningUntil: null, error: '' }))

      // If we're switching lots, release the previous lock to avoid blocking others unnecessarily.
      if (current?.token && current.lotId && current.lotId !== resolvedLotId) {
        void releaseScheduleEditLock(current.token)
      }

      const { data, error } = await supabase.rpc('acquire_lot_lock', {
        p_lot_id: resolvedLotId,
        p_ttl_seconds: ttlSeconds,
      })

      if (error) {
        const message = String(error?.message ?? 'Unable to acquire lock')
        const code = String(error?.code ?? '')
        const msgLower = message.toLowerCase()
        const looksLikeLockConflict = msgLower.includes('locked by another user') || msgLower.includes('locked')
        const looksLikeMissingRpc =
          code === '42883' || (msgLower.includes('acquire_lot_lock') && msgLower.includes('does not exist'))

        if (looksLikeLockConflict && !isDemoLike) {
          setScheduleEditLock((prev) => ({
            ...prev,
            lotId: resolvedLotId,
            token: null,
            expiresAt: null,
            lockedBy: null,
            error: message,
          }))

          const now = Date.now()
          if (!quiet && now - scheduleEditLockLastDenyAtRef.current > 1200) {
            scheduleEditLockLastDenyAtRef.current = now
            alert('This lot schedule is currently being edited by another user. Try again in a few minutes.')
          }

          return { ok: false, mode: 'blocked', error: message }
        }

        // Demo orgs keep moving; and in prod we still allow edits if locks aren't configured yet.
        const warning = looksLikeMissingRpc
          ? 'Schedule locking is not configured on this server yet. Edits may conflict across devices.'
          : message

        setScheduleEditLock((prev) => ({
          ...prev,
          lotId: resolvedLotId,
          token: null,
          expiresAt: null,
          lockedBy: null,
          warning,
          warningUntil: new Date(Date.now() + (looksLikeMissingRpc ? 10 * 60 * 1000 : 60 * 1000)).toISOString(),
          error: '',
        }))

        return { ok: true, mode: 'warning', warning }
      }

      const row = Array.isArray(data) ? data[0] : data
      const next = {
        lotId: resolvedLotId,
        token: row?.token ?? null,
        expiresAt: row?.expires_at ?? null,
        lockedBy: row?.locked_by ?? null,
        warning: '',
        warningUntil: null,
        error: '',
      }
      setScheduleEditLock(next)
      return { ok: true, mode: 'acquired', lock: next }
    })()

    scheduleEditLockAcquireRef.current = { lotId: resolvedLotId, promise }

    try {
      return await promise
    } finally {
      if (scheduleEditLockAcquireRef.current?.promise === promise) {
        scheduleEditLockAcquireRef.current = null
      }
    }
  }

  const runScheduleEditWithLock = async (lotId, action) => {
    if (!canEditLot(lotId)) {
      alert('Read-only: you are not assigned to this lot. Claim it in Overview to edit the schedule.')
      return false
    }
    const lockResult = await ensureScheduleEditLock(lotId)
    if (!lockResult.ok) return false
    await action()
    return true
  }

  const updateLot = (lotId, updater) => {
    setApp((prev) => {
      const nextLots = prev.lots.map((l) => (l.id === lotId ? updater(l, prev) : l))
      return { ...prev, lots: nextLots }
    })
  }

  const toggleScheduleTaskSelection = (taskId) => {
    setSelectedScheduleTaskIds((prev) => {
      const set = new Set(prev)
      if (set.has(taskId)) set.delete(taskId)
      else set.add(taskId)
      return Array.from(set)
    })
  }

  const clearScheduleSelection = () => {
    setSelectedScheduleTaskIds([])
    setParallelOverrideDeps(false)
  }

  const updateTaskDuration = (lotId, taskId, nextDuration) => {
    void runScheduleEditWithLock(lotId, async () => {
      let op = null
      setApp((prev) => {
        const nextLots = (prev.lots ?? []).map((lot) => {
          if (lot.id !== lotId) return lot
          const nextLot = applyDurationChange(lot, taskId, nextDuration, prev.org)
          op = buildV2TasksBatchOp({ lotId, prevLot: lot, nextLot })
          return nextLot
        })
        return { ...prev, lots: nextLots }
      })

      if (op) {
        try {
          await outboxEnqueue(op)
        } catch {
          // ignore
        }
      }
    })
  }

  const updateTaskStartDate = (lotId, taskId, nextStartIso) => {
    if (!nextStartIso) return
    void runScheduleEditWithLock(lotId, async () => {
      let op = null
      setApp((prev) => {
        const nextLots = (prev.lots ?? []).map((lot) => {
          if (lot.id !== lotId) return lot
          const nextLot = applyManualStartDate(lot, taskId, nextStartIso, prev.org)
          op = buildV2TasksBatchOp({ lotId, prevLot: lot, nextLot })
          return nextLot
        })
        return { ...prev, lots: nextLots }
      })

      if (op) {
        try {
          await outboxEnqueue(op)
        } catch {
          // ignore
        }
      }
    })
  }

  const updateTaskSub = (lotId, taskId, subId) => {
    if (!canEditLot(lotId)) {
      alert('Read-only: you are not assigned to this lot. Claim it in Overview to edit.')
      return
    }

    let op = null
    setApp((prev) => {
      const now = new Date().toISOString()
      const nextLots = (prev.lots ?? []).map((lot) => {
        if (lot.id !== lotId) return lot
        const nextTasks = (lot.tasks ?? []).map((t) => (t.id !== taskId ? t : { ...t, sub_id: subId || null, updated_at: now }))
        const nextLot = { ...lot, tasks: nextTasks }
        op = buildV2TasksBatchOp({ lotId, prevLot: lot, nextLot, mode: 'task' })
        return nextLot
      })
      return { ...prev, lots: nextLots }
    })

    if (op) {
      void Promise.resolve()
        .then(() => outboxEnqueue(op))
        .catch(() => {})
    }
  }

  const markTaskIncomplete = (lotId, taskId) => {
    if (!canEditLot(lotId)) {
      alert('Read-only: you are not assigned to this lot. Claim it in Overview to edit.')
      return
    }

    let op = null
    setApp((prev) => {
      const now = new Date().toISOString()
      const nextLots = (prev.lots ?? []).map((lot) => {
        if (lot.id !== lotId) return lot
        const tasks = (lot.tasks ?? []).map((t) => {
          if (t.id !== taskId) return t
          return {
            ...t,
            status: 'pending',
            actual_start: null,
            actual_end: null,
            updated_at: now,
          }
        })

        const nextStatus = lot.status === 'complete' ? 'in_progress' : lot.status
        const nextLot = {
          ...lot,
          status: nextStatus,
          actual_completion_date: nextStatus === 'complete' ? lot.actual_completion_date ?? null : null,
          tasks: refreshReadyStatuses(tasks),
        }

        op = buildV2TasksBatchOp({ lotId, prevLot: lot, nextLot, includeLotRow: true, mode: 'task' })
        return nextLot
      })

      const prevSync = prev.sync ?? {}
      return { ...prev, lots: nextLots, sync: prevSync }
    })

    if (op) {
      void Promise.resolve()
        .then(() => outboxEnqueue(op))
        .catch(() => {})
    }

    if (!syncV2Enabled && !isOnline) {
      enqueueSyncOp({
        type: 'task_status',
        lot_id: lotId,
        entity_type: 'task',
        entity_id: taskId,
        summary: 'Task marked incomplete',
      })
    }
  }

  const deleteLotTask = (lotId, taskId, taskName = '') => {
    void runScheduleEditWithLock(lotId, async () => {
      let op = null

      setApp((prev) => {
        const now = new Date().toISOString()
        const nextLots = (prev.lots ?? []).map((lot) => {
          if (lot.id !== lotId) return lot
          const target = (lot.tasks ?? []).find((t) => t.id === taskId) ?? null
          const baseLot = { ...lot, tasks: (lot.tasks ?? []).map((t) => ({ ...t })) }
          const intermediate = target && isBufferTask(target) ? removeBufferTask(baseLot, taskId, prev.org) : baseLot
          const nextTasks = refreshReadyStatuses((intermediate.tasks ?? []).filter((t) => t.id !== taskId))
          const nextLot = { ...intermediate, tasks: nextTasks, updated_at: now }
          op = buildV2TasksBatchOp({ lotId, prevLot: lot, nextLot })
          return nextLot
        })

        const prevSync = prev.sync ?? {}
        const deleted = new Set(coerceArray(prevSync.deleted_task_ids))
        deleted.add(taskId)

        return {
          ...prev,
          lots: nextLots,
          sync: {
            ...prevSync,
            deleted_task_ids: Array.from(deleted),
          },
        }
      })

      setSelectedScheduleTaskIds((prev) => prev.filter((id) => id !== taskId))

      if (op) {
        try {
          await outboxEnqueue(op)
        } catch {
          // ignore
        }
      }

      if (!syncV2Enabled && !isOnline) {
        enqueueSyncOp({
          type: 'task_delete',
          lot_id: lotId,
          entity_type: 'task',
          entity_id: taskId,
          summary: `Task deleted${taskName ? ` (${taskName})` : ''}`,
        })
      }
    })
  }

  const buildParallelCascadePlan = (lot, taskIds) => {
    if (!lot || !Array.isArray(taskIds) || taskIds.length === 0) return { tasks: lot?.tasks ?? [], impacted: [] }
    const tasks = (lot.tasks ?? []).map((t) => ({ ...t }))
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const selectedTasks = taskIds.map((id) => byId.get(id)).filter(Boolean)
    if (selectedTasks.length === 0) return { tasks, impacted: [] }

    const { getNextWorkDay, addWorkDays } = makeWorkdayHelpers(org)
    const normalizeStart = (iso) => {
      const next = getNextWorkDay(iso) ?? parseISODate(iso)
      return next ? formatISODate(next) : iso
    }
    const getEndFor = (startIso, duration) => {
      if (!startIso) return ''
      const end = addWorkDays(startIso, Math.max(1, Number(duration ?? 1) || 1) - 1)
      return end ? formatISODate(end) : ''
    }

    const selectedByTrack = new Map()
    for (const task of selectedTasks) {
      const track = task.track ?? 'misc'
      const group = selectedByTrack.get(track) ?? []
      group.push(task)
      selectedByTrack.set(track, group)
    }

    for (const [track, group] of selectedByTrack.entries()) {
      const earliestStart = group.map((t) => t.scheduled_start).filter(Boolean).sort()[0]
      if (!earliestStart) continue
      const baseStart = normalizeStart(earliestStart)

      for (const task of group) {
        const duration = Math.max(1, Number(task.duration ?? 1) || 1)
        task.scheduled_start = baseStart
        task.scheduled_end = getEndFor(baseStart, duration)
        task.updated_at = new Date().toISOString()
      }

      const trackTasks = tasks
        .filter((t) => (t.track ?? 'misc') === track)
        .sort((a, b) => (Number(a.sort_order ?? 0) || 0) - (Number(b.sort_order ?? 0) || 0))

      const maxSelectedOrder = Math.max(
        ...group.map((t) => Number(t.sort_order ?? 0) || 0).filter((v) => Number.isFinite(v)),
      )

      let latestEnd = ''
      for (const task of trackTasks) {
        const order = Number(task.sort_order ?? 0) || 0
        if (order > maxSelectedOrder) break
        const start = task.scheduled_start ? normalizeStart(task.scheduled_start) : ''
        if (start && start !== task.scheduled_start) task.scheduled_start = start
        const end = task.scheduled_end || getEndFor(start, task.duration)
        if (end) {
          task.scheduled_end = end
          if (!latestEnd || end > latestEnd) latestEnd = end
        }
      }

      if (!latestEnd) latestEnd = getEndFor(baseStart, Math.max(1, Number(group[0]?.duration ?? 1) || 1))

      for (const task of trackTasks) {
        const order = Number(task.sort_order ?? 0) || 0
        if (order <= maxSelectedOrder) continue
        if (!latestEnd) break
        const nextStart = formatISODate(addWorkDays(latestEnd, 1))
        const nextEnd = getEndFor(nextStart, task.duration)
        task.scheduled_start = nextStart
        task.scheduled_end = nextEnd
        task.updated_at = new Date().toISOString()
        latestEnd = nextEnd || latestEnd
      }
    }

    const impacted = selectedTasks
      .map((t) => ({
        task_id: t.id,
        old_start: (lot.tasks ?? []).find((x) => x.id === t.id)?.scheduled_start ?? null,
        new_start: t.scheduled_start,
      }))
      .filter((t) => t.new_start && t.old_start !== t.new_start)

    for (const task of tasks) {
      if (taskIds.includes(task.id)) continue
      const before = (lot.tasks ?? []).find((x) => x.id === task.id)?.scheduled_start ?? null
      if (before && before !== task.scheduled_start) {
        impacted.push({ task_id: task.id, old_start: before, new_start: task.scheduled_start })
      }
    }

    return { tasks, impacted }
  }

  const applyParallelizeSelection = async ({ lot, taskIds }) => {
    if (!lot || taskIds.length === 0) return
    const reason = 'Parallelized tasks'
    const community = communitiesById.get(lot.community_id) ?? null
    const plan = buildParallelCascadePlan(lot, taskIds)
    if (!plan.tasks || plan.tasks.length === 0) {
      alert('Unable to align tasks. Please check selected tasks.')
      return
    }

    const impacted = plan.impacted ?? []
    const ok = await runScheduleEditWithLock(lot.id, async () => {
      let op = null
      setApp((prev) => {
        const nextLots = (prev.lots ?? []).map((current) => {
          if (current.id !== lot.id) return current
          const now = new Date().toISOString()
          const changes = impacted.map((a) => ({
            id: uuid(),
            task_id: a.task_id,
            old_start: a.old_start,
            new_start: a.new_start,
            reason,
            notified: true,
            changed_at: now,
          }))
          const nextLot = {
            ...current,
            tasks: plan.tasks,
            schedule_changes: [...(current.schedule_changes ?? []), ...changes],
          }
          op = buildV2TasksBatchOp({ lotId: lot.id, prevLot: current, nextLot })
          return nextLot
        })
        return { ...prev, lots: nextLots }
      })

      if (op) {
        try {
          await outboxEnqueue(op)
        } catch {
          // ignore
        }
      }

      if (!syncV2Enabled && !isOnline) {
        enqueueSyncOp({
          type: 'task_dates',
          lot_id: lot.id,
          entity_type: 'task',
          entity_id: taskIds[0] ?? '',
          summary: `Parallelized ${taskIds.length} task(s) (${lotCode(lot)})`,
        })
      }
    })
    if (!ok) return

    if (impacted.length > 0) {
      pushNotification({
        type: 'schedule_change',
        title: `Schedule Changed - ${community?.name ?? ''} ${lotCode(lot)}`.trim(),
        body: `${reason}\n${impacted.length} task(s) updated`,
        entity_type: 'lot',
        entity_id: lot.id,
        lot_id: lot.id,
        priority: 'normal',
      })
      const messages = buildScheduleChangeMessages({
        lot,
        community,
        impactedTasks: impacted,
        changeReason: reason,
      })
      addMessages(messages)
    }

    clearScheduleSelection()
  }

  const resolveListScrollContainer = (el) => {
    if (typeof window === 'undefined') return null
    let node = el
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node)
      const overflowY = style?.overflowY ?? ''
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) return node
      node = node.parentElement
    }
    return document.scrollingElement || document.documentElement
  }

  const stopListAutoScroll = () => {
    const state = listDragRef.current
    if (state.scrollRaf) cancelAnimationFrame(state.scrollRaf)
    state.scrollRaf = null
  }

  const getListScrollTop = (state) => {
    const scrollEl = state.scrollEl ?? document.scrollingElement ?? document.documentElement
    if (!scrollEl) return 0
    return scrollEl.scrollTop ?? 0
  }

  const computeListDragOffset = (state) => {
    const scrollTop = getListScrollTop(state)
    const base = Number.isFinite(state.startScrollTop) ? state.startScrollTop : scrollTop
    const deltaScroll = scrollTop - base
    return state.lastY - state.startY + deltaScroll
  }

  const stepListAutoScroll = () => {
    const state = listDragRef.current
    if (!state.active) {
      stopListAutoScroll()
      return
    }
    const scrollEl = state.scrollEl ?? document.scrollingElement ?? document.documentElement
    if (!scrollEl || typeof window === 'undefined') {
      stopListAutoScroll()
      return
    }
    const rect =
      scrollEl === document.scrollingElement || scrollEl === document.documentElement
        ? { top: 0, bottom: window.innerHeight }
        : scrollEl.getBoundingClientRect()
    const zone = 72
    const distTop = state.lastY - rect.top
    const distBottom = rect.bottom - state.lastY
    let speed = 0
    if (distTop < zone) speed = -Math.ceil((zone - distTop) / 6)
    else if (distBottom < zone) speed = Math.ceil((zone - distBottom) / 6)
    if (speed === 0) {
      state.scrollRaf = null
      return
    }
    scrollEl.scrollTop += speed
    setListDragOffset(computeListDragOffset(state))
    updateListDropTarget(state.lastX, state.lastY)
    state.scrollRaf = requestAnimationFrame(stepListAutoScroll)
  }

  const maybeStartListAutoScroll = () => {
    const state = listDragRef.current
    if (!state.active || state.scrollRaf) return
    state.scrollRaf = requestAnimationFrame(stepListAutoScroll)
  }

  const clearListDrag = () => {
    const state = listDragRef.current
    if (state.timer) clearTimeout(state.timer)
    stopListAutoScroll()
    state.active = false
    state.timer = null
    state.pointerId = null
    state.taskId = null
    state.track = null
    state.scrollEl = null
    state.startScrollTop = 0
    setListDraggingTaskId(null)
    setListDropTaskId(null)
    setListDragOffset(0)
  }

  useEffect(() => {
    const onGlobalPointerUp = () => {
      if (!listDragRef.current.active && !listDraggingTaskId) return
      clearListDrag()
    }
    window.addEventListener('pointerup', onGlobalPointerUp)
    window.addEventListener('pointercancel', onGlobalPointerUp)
    return () => {
      window.removeEventListener('pointerup', onGlobalPointerUp)
      window.removeEventListener('pointercancel', onGlobalPointerUp)
    }
  }, [listDraggingTaskId])

  const updateListDropTarget = (clientX, clientY) => {
    const state = listDragRef.current
    if (typeof document === 'undefined') return
    const elements = document.elementsFromPoint(clientX, clientY)
    let nextRow = null
    for (const el of elements) {
      const row = el?.closest?.('[data-task-row="true"]')
      if (!row) continue
      const dropId = row.dataset?.taskId ?? null
      const dropTrack = row.dataset?.track ?? null
      if (!dropId || dropId === state.taskId || dropTrack !== state.track) continue
      nextRow = row
      break
    }
    if (!nextRow) return
    const dropId = nextRow.dataset?.taskId ?? null
    if (dropId && dropId !== listDropTaskId) setListDropTaskId(dropId)
  }

  const handleListDragPointerDown = (task, e) => {
    if (scheduleView !== 'list') return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const state = listDragRef.current
    if (state.timer) clearTimeout(state.timer)
    state.active = false
    state.pointerId = e.pointerId
    state.startX = e.clientX
    state.startY = e.clientY
    state.lastX = e.clientX
    state.lastY = e.clientY
    state.taskId = task.id
    state.track = task.track
    state.pointerType = e.pointerType
    state.scrollEl = resolveListScrollContainer(e.currentTarget)
    state.startScrollTop = getListScrollTop(state)

    const targetEl = e.currentTarget
    const pointerId = e.pointerId
    const delay = e.pointerType === 'touch' ? 90 : 40
    state.timer = setTimeout(() => {
      state.timer = null
      state.active = true
      setListDraggingTaskId(task.id)
      setListDropTaskId(task.id)
      state.startScrollTop = getListScrollTop(state)
      setListDragOffset(computeListDragOffset(state))
      if (!state.scrollEl) state.scrollEl = resolveListScrollContainer(targetEl)
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(12)
      if (targetEl?.setPointerCapture) {
        try {
          targetEl.setPointerCapture(pointerId)
        } catch (_err) {
          void _err
          // ignore pointer capture failures
        }
      }
    }, delay)
  }

  const handleListDragPointerMove = (task, e) => {
    const state = listDragRef.current
    if (state.taskId !== task.id) return
    state.lastX = e.clientX
    state.lastY = e.clientY
    const dx = Math.abs(state.lastX - state.startX)
    const dy = Math.abs(state.lastY - state.startY)

    if (!state.active) {
      if (state.pointerType !== 'touch' && (dx > 4 || dy > 4)) {
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
        state.active = true
        setListDraggingTaskId(task.id)
        setListDropTaskId(task.id)
        state.startScrollTop = getListScrollTop(state)
        setListDragOffset(computeListDragOffset(state))
        if (!state.scrollEl) state.scrollEl = resolveListScrollContainer(e.currentTarget)
        if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(10)
        if (e.currentTarget?.setPointerCapture && state.pointerId !== null) {
          try {
            e.currentTarget.setPointerCapture(state.pointerId)
          } catch (_err) {
            void _err
            // ignore pointer capture failures
          }
        }
      } else if (state.pointerType === 'touch' && (dx > 8 || dy > 8)) {
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
      }
      return
    }

    e.preventDefault()
    setListDragOffset(computeListDragOffset(state))
    updateListDropTarget(state.lastX, state.lastY)
    maybeStartListAutoScroll()
  }

  const handleListDragPointerUp = async (task, e) => {
    const state = listDragRef.current
    if (state.timer) clearTimeout(state.timer)
    state.timer = null

    if (!state.active) return
    state.active = false

    const dropId = listDropTaskId
    if (dropId && dropId !== task.id && selectedLot) {
      await runScheduleEditWithLock(selectedLot.id, async () => {
        let op = null
        setApp((prev) => {
          const nextLots = (prev.lots ?? []).map((lot) => {
            if (lot.id !== selectedLot.id) return lot
            const nextLot = applyListReorder(lot, task.id, dropId, prev.org)
            op = buildV2TasksBatchOp({ lotId: selectedLot.id, prevLot: lot, nextLot })
            return nextLot
          })
          return { ...prev, lots: nextLots }
        })

        if (op) {
          try {
            await outboxEnqueue(op)
          } catch {
            // ignore
          }
        }
      })
    }
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(6)
    if (dropId && dropId !== task.id) {
      setListDropPulseId(task.id)
      if (listDropPulseTimerRef.current) clearTimeout(listDropPulseTimerRef.current)
      listDropPulseTimerRef.current = setTimeout(() => {
        setListDropPulseId(null)
        listDropPulseTimerRef.current = null
      }, 200)
    }

    listSuppressClickRef.current = true
    setTimeout(() => {
      listSuppressClickRef.current = false
    }, 120)

    if (state.pointerId !== null && e.currentTarget?.releasePointerCapture) {
      try {
        e.currentTarget.releasePointerCapture(state.pointerId)
      } catch (_err) {
        void _err
        // ignore pointer capture failures
      }
    }

    clearListDrag()
  }

  const handleListDragPointerCancel = () => {
    clearListDrag()
  }

  const updateLotSoldStatus = (lotId, soldStatus) => {
    updateLot(lotId, (lot) => {
      const nextStatus = soldStatus || 'available'
      const nextSoldDate = nextStatus === 'sold' ? (lot.sold_date ?? todayIso) : nextStatus === 'pending' ? lot.sold_date ?? null : null
      return { ...lot, sold_status: nextStatus, sold_date: nextSoldDate }
    })
  }

  const updateCommunity = (communityId, updater) => {
    setApp((prev) => {
      const nextCommunities = (prev.communities ?? []).map((c) => (c.id === communityId ? updater(c, prev) : c))
      return { ...prev, communities: nextCommunities }
    })
  }

  const updateContactLibrary = (updater) => {
    setApp((prev) => {
      const current = prev.contact_library ?? { builders: [], realtors: [] }
      const next = updater(current)
      return { ...prev, contact_library: next }
    })
  }

  const markNotificationRead = (notificationId) => {
    setApp((prev) => ({
      ...prev,
      notifications: (prev.notifications ?? []).map((n) =>
        n.id !== notificationId ? n : { ...n, read: true, read_at: n.read_at ?? new Date().toISOString() },
      ),
    }))
  }

  const markAllNotificationsRead = () => {
    const now = new Date().toISOString()
    setApp((prev) => ({
      ...prev,
      notifications: (prev.notifications ?? []).map((n) => (n.read ? n : { ...n, read: true, read_at: now })),
    }))
  }

  const pushNotification = ({ type, title, body, entity_type, entity_id, lot_id, priority }) => {
    const notifType = type ?? 'system_announcement'
    const pref = app.notification_preferences?.preferences?.[notifType] ?? null
    if (pref && pref.enabled === false) return null
    if (pref && pref.channels?.in_app === false) return null

    const now = new Date().toISOString()
    const notif = {
      id: uuid(),
      user_id: '',
      user_type: 'superintendent',
      type: notifType,
      title: title ?? '',
      body: body ?? '',
      entity_type: entity_type ?? 'lot',
      entity_id: entity_id ?? '',
      lot_id: lot_id ?? null,
      channels: {
        push: { sent: false, sent_at: null, delivered: false },
        sms: { sent: false, sent_at: null, delivered: false },
        email: { sent: false, sent_at: null, opened: false },
        in_app: { created: true },
      },
      read: false,
      read_at: null,
      actioned: false,
      actioned_at: null,
      priority: priority ?? 'normal',
      scheduled_for: null,
      expires_at: null,
      created_at: now,
    }

    setApp((prev) => ({
      ...prev,
      notifications: [notif, ...(prev.notifications ?? [])],
    }))

    return notif.id
  }

  const addDedupeKey = (key) => {
    if (!key) return
    setApp((prev) => {
      const keys = Array.isArray(prev.dedupe?.keys) ? prev.dedupe.keys : []
      if (keys.includes(key)) return prev
      const nextKeys = [...keys, key].slice(-500)
      return { ...prev, dedupe: { ...(prev.dedupe ?? {}), keys: nextKeys } }
    })
  }

  const pushNotificationDeduped = ({ dedupeKey, ...payload }) => {
    if (dedupeKey && (app.dedupe?.keys ?? []).includes(dedupeKey)) return null
    const id = pushNotification(payload)
    if (id && dedupeKey) addDedupeKey(dedupeKey)
    return id
  }

  const addMessages = (messagesToAdd) => {
    if (!Array.isArray(messagesToAdd) || messagesToAdd.length === 0) return
    setApp((prev) => ({ ...prev, messages: [...(prev.messages ?? []), ...messagesToAdd] }))

    if (!isOnline) {
      for (const msg of messagesToAdd) {
        enqueueSyncOp({
          type: 'message_send',
          lot_id: msg?.lot_id ?? null,
          entity_type: 'message',
          entity_id: msg?.id ?? '',
          summary: `Message queued${msg?.lot_id ? ` (${lotCode(lotsById.get(msg.lot_id))})` : ''}`,
        })
      }
    }
  }

  const buildScheduleChangeMessages = ({ lot, community, impactedTasks, changeReason }) => {
    const now = new Date().toISOString()
    const out = []

    for (const impact of impactedTasks ?? []) {
      const t = (lot?.tasks ?? []).find((x) => x.id === impact.task_id)
      if (!t?.sub_id) continue
      const sub = (app.subcontractors ?? []).find((s) => s.id === t.sub_id)
      if (!sub) continue

      const body = fillTemplate(MESSAGE_TEMPLATES.schedule_change, {
        community: community?.name ?? '',
        block: lot?.block ?? '',
        lot: lot?.lot_number ?? '',
        sub_name: sub.company_name ?? '',
        task_name: t.name ?? '',
        old_start_date: formatShortDate(impact.old_start),
        new_start_date: formatShortDate(impact.new_start),
        change_reason: changeReason ?? '',
        builder_name: org?.builder_name ?? org?.name ?? 'BuildFlow',
      })

      out.push({
        id: uuid(),
        lot_id: lot?.id ?? null,
        task_id: t.id ?? null,
        sub_id: sub.id,
        body,
        channels: { sms: true, email: true, app: true },
        created_at: now,
        status: isOnline ? 'sent' : 'queued',
        sent_at: isOnline ? now : null,
        template_id: 'schedule_change',
      })
    }

    return out
  }

  const startTask = (lotId, taskId) => {
    if (!canEditLot(lotId)) {
      alert('Read-only: you are not assigned to this lot. Claim it in Overview to edit.')
      return
    }

    let op = null
    setApp((prev) => {
      const now = new Date().toISOString()
      const nextLots = (prev.lots ?? []).map((lot) => {
        if (lot.id !== lotId) return lot
        const nextTasks = refreshReadyStatuses((lot.tasks ?? []).map((t) => {
          if (t.id !== taskId) return t
          return { ...t, status: 'in_progress', actual_start: t.actual_start ?? todayIso, updated_at: now }
        }))
        const nextLot = { ...lot, tasks: nextTasks }
        op = buildV2TasksBatchOp({ lotId, prevLot: lot, nextLot, mode: 'task' })
        return nextLot
      })
      return { ...prev, lots: nextLots }
    })

    if (op) {
      void Promise.resolve()
        .then(() => outboxEnqueue(op))
        .catch(() => {})
    }

    if (!syncV2Enabled && !isOnline) {
      enqueueSyncOp({
        type: 'task_status',
        lot_id: lotId,
        entity_type: 'task',
        entity_id: taskId,
        summary: 'Task started',
      })
    }
  }

  const createPunchListFromTemplate = (nowIso) => {
    const now = nowIso ?? new Date().toISOString()
    const tradeFor = (entry) => {
      const subcat = String(entry?.subcategory ?? '').toLowerCase()
      const cat = String(entry?.category ?? '').toLowerCase()
      if (subcat.includes('electrical')) return 'electrical'
      if (subcat.includes('plumbing')) return 'plumbing'
      if (subcat.includes('hvac')) return 'hvac'
      if (subcat.includes('appliance')) return 'appliances'
      if (cat.includes('exterior') && subcat.includes('paint')) return 'paint'
      if (cat.includes('exterior') && subcat.includes('siding')) return 'siding'
      if (cat.includes('exterior') && subcat.includes('concrete')) return 'concrete'
      if (cat.includes('exterior') && subcat.includes('landscap')) return 'landscaping'
      if (cat.includes('interior') && subcat.includes('drywall')) return 'drywall'
      if (cat.includes('interior') && subcat.includes('paint')) return 'paint'
      if (cat.includes('interior') && subcat.includes('floor')) return 'flooring'
      if (cat.includes('interior') && subcat.includes('trim')) return 'trim'
      if (cat.includes('interior') && subcat.includes('cabinet')) return 'cabinets'
      if (cat.includes('final') && subcat.includes('clean')) return 'cleaning'
      if (cat.includes('doors')) return 'windows'
      return 'other'
    }

    return {
      id: uuid(),
      created_at: now,
      items: (PUNCH_TEMPLATE ?? []).map((entry) => ({
        id: uuid(),
        category: entry.category,
        subcategory: entry.subcategory,
        location: '',
        description: entry.description,
        photo_id: null,
        priority: 'standard',
        trade: tradeFor(entry),
        sub_id: null,
        source: 'super',
        status: 'open',
        created_at: now,
        updated_at: now,
      })),
    }
  }

  const completeTaskDirect = (lotId, taskId) => {
    const lotSnapshot = lotsById.get(lotId) ?? null
    if (lotSnapshot) {
      const before = getCurrentMilestone(lotSnapshot)
      const now = new Date().toISOString()
      const updatedTasks = refreshReadyStatuses((lotSnapshot.tasks ?? []).map((t) => {
        if (t.id !== taskId) return t
        return {
          ...t,
          status: 'complete',
          actual_start: t.actual_start ?? todayIso,
          actual_end: todayIso,
          updated_at: now,
        }
      }))
      const maybeCompleted = updatedTasks.find((t) => t.id === taskId)
      const nextPunch = !lotSnapshot.punch_list && maybeCompleted?.name === 'Final Clean' ? createPunchListFromTemplate(now) : lotSnapshot.punch_list
      const lotStatus = maybeCompleted?.name === 'Punch Complete' ? 'complete' : lotSnapshot.status
      const nextLotSnapshot = {
        ...lotSnapshot,
        status: lotStatus,
        actual_completion_date: lotStatus === 'complete' ? todayIso : lotSnapshot.actual_completion_date ?? null,
        tasks: updatedTasks,
        punch_list: nextPunch,
      }
      const after = getCurrentMilestone(nextLotSnapshot)
      if (after?.id && after.id !== before?.id) {
        const community = communitiesById.get(lotSnapshot.community_id) ?? null
        pushNotificationDeduped({
          dedupeKey: `milestone_reached:${lotId}:${after.id}`,
          type: 'milestone_reached',
          title: `Milestone Reached - ${community?.name ?? ''} ${lotCode(lotSnapshot)}`.trim(),
          body: `${after.label} (${after.pct}%)`,
          entity_type: 'lot',
          entity_id: lotId,
          lot_id: lotId,
          priority: after.pct >= 95 ? 'high' : 'normal',
        })
      }
    }

    if (!canEditLot(lotId)) {
      alert('Read-only: you are not assigned to this lot. Claim it in Overview to edit.')
      return
    }

    let op = null
    setApp((prev) => {
      const now = new Date().toISOString()
      const nextLots = (prev.lots ?? []).map((lot) => {
        if (lot.id !== lotId) return lot
        const updatedTasks = refreshReadyStatuses((lot.tasks ?? []).map((t) => {
          if (t.id !== taskId) return t
          return { ...t, status: 'complete', actual_start: t.actual_start ?? todayIso, actual_end: todayIso, updated_at: now }
        }))
        const maybeCompleted = updatedTasks.find((t) => t.id === taskId)
        const nextPunch = !lot.punch_list && maybeCompleted?.name === 'Final Clean' ? createPunchListFromTemplate(now) : lot.punch_list
        const lotStatus = maybeCompleted?.name === 'Punch Complete' ? 'complete' : lot.status
        const nextLot = {
          ...lot,
          status: lotStatus,
          actual_completion_date: lotStatus === 'complete' ? todayIso : lot.actual_completion_date ?? null,
          tasks: updatedTasks,
          punch_list: nextPunch,
        }

        // Include lot patch because status/completion date can change.
        op = buildV2TasksBatchOp({ lotId, prevLot: lot, nextLot, includeLotRow: true, mode: 'task' })
        return nextLot
      })
      return { ...prev, lots: nextLots }
    })

    if (op) {
      void Promise.resolve()
        .then(() => outboxEnqueue(op))
        .catch(() => {})
    }

    if (!syncV2Enabled && !isOnline) {
      enqueueSyncOp({
        type: 'task_status',
        lot_id: lotId,
        entity_type: 'task',
        entity_id: taskId,
        summary: 'Task completed',
      })
    }
  }

  const scheduleInspectionForTask = (lotId, taskId, payload) => {
    const inspectionId = uuid()
    updateLot(lotId, (lot) => {
      const now = new Date().toISOString()
      const inspection = {
        id: inspectionId,
        lot_id: lotId,
        task_id: taskId,
        type: payload.type,
        parent_inspection_id: payload.parent_inspection_id ?? null,
        status: 'scheduled',
        scheduled_date: payload.scheduled_date,
        scheduled_time: payload.scheduled_time,
        inspector: payload.inspector,
        notes: payload.notes ?? '',
        result: null,
        failure_items: [],
        report_document: null,
        created_at: now,
        updated_at: now,
      }

      const tasks = (lot.tasks ?? []).map((t) => {
        if (t.id !== taskId) return t
        return { ...t, inspection_id: inspectionId, updated_at: now }
      })

      return { ...lot, tasks, inspections: [...(lot.inspections ?? []), inspection] }
    })
    if (!isOnline) {
      enqueueSyncOp({
        type: 'inspection_scheduled',
        lot_id: lotId,
        entity_type: 'inspection',
        entity_id: inspectionId,
        summary: 'Inspection scheduled',
      })
    }
    return inspectionId
  }

  const saveInspectionResult = (lotId, inspectionId, resultPayload) => {
    updateLot(lotId, (lot) => {
      const now = new Date().toISOString()
      const inspections = (lot.inspections ?? []).map((i) => {
        if (i.id !== inspectionId) return i
        return {
          ...i,
          status: 'completed',
          result: resultPayload.result,
          failure_items: resultPayload.failure_items ?? [],
          report_document: resultPayload.report_document ?? i.report_document ?? null,
          checklist_completed: resultPayload.checklist_completed ?? i.checklist_completed ?? {},
          updated_at: now,
        }
      })
      return { ...lot, inspections }
    })
    if (!isOnline) {
      enqueueSyncOp({
        type: 'inspection_result',
        lot_id: lotId,
        entity_type: 'inspection',
        entity_id: inspectionId,
        summary: `Inspection result: ${resultPayload?.result ?? ''}`,
      })
    }
  }

  const addPhoto = async ({ lotId, taskId, inspectionId, punchItemId, dailyLogId, category, location, caption, tags, file }) => {
    if (!canEditLot(lotId)) {
      alert('Read-only: you are not assigned to this lot. Claim it in Overview to add photos.')
      return null
    }

    let normalized = null
    try {
      normalized = await normalizeImageBlob(file)
    } catch (err) {
      console.error(err)
      alert('Invalid image. Please try a different photo.')
      return null
    }
    if (!normalized) return null

    const blobId = uuid()
    await putBlob(blobId, normalized.blob)

    const photoId = uuid()
    const now = new Date().toISOString()
    const orgId = supabaseStatus?.orgId ?? app?.sync?.supabase_org_id ?? null
    const shouldQueueV2 = syncV2Enabled && Boolean(supabaseUser?.id) && Boolean(orgId)
    const storageBucket = 'photos'
    const storagePath = shouldQueueV2 ? `${orgId}/${lotId}/${photoId}/${sanitizeStorageFileName(normalized.fileName)}` : null
    const photo = {
      id: photoId,
      lot_id: lotId,
      task_id: taskId ?? null,
      inspection_id: inspectionId ?? null,
      punch_item_id: punchItemId ?? null,
      daily_log_id: dailyLogId ?? null,
      category,
      blob_id: blobId,
      file_name: normalized.fileName,
      mime: normalized.mime,
      file_size: normalized.size,
      caption: caption ?? '',
      location: location ?? '',
      tags: Array.isArray(tags) ? tags : [],
      taken_at: now,
      device_type: '',
      gps_lat: null,
      gps_lng: null,
      uploaded_at: now,
      uploaded_by: '',
      upload_source: 'gallery',
      synced: shouldQueueV2 ? false : isOnline,
      sync_error: null,
      storage_bucket: shouldQueueV2 ? storageBucket : null,
      storage_path: shouldQueueV2 ? storagePath : null,
      thumb_storage_path: null,
    }

    updateLot(lotId, (lot) => {
      const tasks = (lot.tasks ?? []).map((t) => {
        if (!taskId || t.id !== taskId) return t
        return { ...t, photos: [...(t.photos ?? []), photoId] }
      })
      const punch_list = punchItemId && lot.punch_list
        ? {
            ...lot.punch_list,
            items: (lot.punch_list.items ?? []).map((item) =>
              item.id !== punchItemId
                ? item
                : { ...item, photo_id: item.photo_id ?? photoId },
            ),
          }
        : lot.punch_list ?? null

      const daily_logs = dailyLogId
        ? (lot.daily_logs ?? []).map((log) =>
            log.id !== dailyLogId ? log : { ...log, photo_ids: [...(log.photo_ids ?? []), photoId] },
          )
        : lot.daily_logs ?? []

      return { ...lot, tasks, punch_list, daily_logs, photos: [...(lot.photos ?? []), photo] }
    })

    if (shouldQueueV2 && storagePath) {
      const op = buildV2AttachmentUpsertOp({
        attachmentId: photoId,
        lotId,
        taskId,
        kind: 'photo',
        category,
        caption: caption ?? '',
        mime: normalized.mime,
        fileName: normalized.fileName,
        fileSize: normalized.size,
        storageBucket,
        storagePath,
        thumbStoragePath: null,
        clientBlobId: blobId,
      })
      if (op) {
        void Promise.resolve()
          .then(() => outboxEnqueue(op))
          .catch(() => {})
      }
    } else if (!syncV2Enabled && !isOnline) {
      enqueueSyncOp({
        type: 'photo_upload',
        lot_id: lotId,
        entity_type: 'photo',
        entity_id: photoId,
        summary: `Photo queued${taskId ? ' (task)' : ''}`,
      })
    }

    return photoId
  }

  const removePhoto = async ({ lotId, photoId }) => {
    if (!lotId || !photoId) return
    const lot = lotsById.get(lotId) ?? null
    const photo = (lot?.photos ?? []).find((p) => p.id === photoId) ?? null

    updateLot(lotId, (l) => {
      const photos = (l.photos ?? []).filter((p) => p.id !== photoId)
      const tasks = (l.tasks ?? []).map((t) => ({
        ...t,
        photos: (t.photos ?? []).filter((id) => id !== photoId),
      }))
      const punch_list = l.punch_list
        ? {
            ...l.punch_list,
            items: (l.punch_list.items ?? []).map((item) =>
              item.photo_id === photoId ? { ...item, photo_id: null } : item,
            ),
          }
        : l.punch_list
      const daily_logs = (l.daily_logs ?? []).map((log) => ({
        ...log,
        photo_ids: (log.photo_ids ?? []).filter((id) => id !== photoId),
        deliveries: (log.deliveries ?? []).map((d) => (d.photo_id === photoId ? { ...d, photo_id: null } : d)),
        issues: (log.issues ?? []).map((i) => (i.photo_id === photoId ? { ...i, photo_id: null } : i)),
        safety_incidents: (log.safety_incidents ?? []).map((i) => (i.photo_id === photoId ? { ...i, photo_id: null } : i)),
      }))
      const inspections = (l.inspections ?? []).map((ins) => ({
        ...ins,
        failure_items: (ins.failure_items ?? []).map((item) => ({
          ...item,
          photo_id: item.photo_id === photoId ? null : item.photo_id,
          fix_photo_id: item.fix_photo_id === photoId ? null : item.fix_photo_id,
        })),
      }))
      const material_orders = (l.material_orders ?? []).map((o) => ({
        ...o,
        delivery_photo_ids: (o.delivery_photo_ids ?? []).filter((id) => id !== photoId),
      }))
      return { ...l, photos, tasks, punch_list, daily_logs, inspections, material_orders }
    })

    if (photo?.blob_id) await deleteBlob(photo.blob_id)

    if (!isOnline) {
      enqueueSyncOp({
        type: 'photo_delete',
        lot_id: lotId,
        entity_type: 'photo',
        entity_id: photoId,
        summary: `Photo deleted (${lot ? lotCode(lot) : lotId})`,
      })
    }
  }

  const addLotFile = async ({ lotId, label, description, file }) => {
    if (!file) return null
    const max = 50 * 1024 * 1024
    if (file.size > max) {
      alert('File must be ≤ 50MB.')
      return null
    }
    const safeLabel = String(label ?? '').trim()
    if (!safeLabel) {
      alert('File label is required.')
      return null
    }

    const blobId = uuid()
    await putBlob(blobId, file)
    const now = new Date().toISOString()
    const doc = {
      id: uuid(),
      type: 'lot_file',
      label: safeLabel,
      description: String(description ?? '').trim(),
      file_name: file.name,
      mime: file.type || 'application/octet-stream',
      file_size: file.size,
      blob_id: blobId,
      uploaded_at: now,
      synced: isOnline,
      sync_error: null,
    }

    updateLot(lotId, (lot) => ({ ...lot, documents: [...(lot.documents ?? []), doc] }))

    if (!isOnline) {
      const lot = lotsById.get(lotId) ?? null
      enqueueSyncOp({
        type: 'document_upload',
        lot_id: lotId,
        entity_type: 'lot_file',
        entity_id: doc.id,
        summary: `File queued (${lot ? lotCode(lot) : lotId})`,
      })
    }

    return doc
  }

  const removeLotFile = async ({ lotId, docId }) => {
    if (!docId) return
    const lot = lotsById.get(lotId) ?? null
    const doc = (lot?.documents ?? []).find((d) => d.id === docId) ?? null
    updateLot(lotId, (current) => ({ ...current, documents: (current.documents ?? []).filter((d) => d.id !== docId) }))
    if (doc?.blob_id) await deleteBlob(doc.blob_id)

    if (!isOnline) {
      enqueueSyncOp({
        type: 'document_delete',
        lot_id: lotId,
        entity_type: 'lot_file',
        entity_id: docId,
        summary: `File deleted (${lot ? lotCode(lot) : lotId})`,
      })
    }
  }

  const addTaskFile = async ({ lotId, taskId, label, description, file }) => {
    if (!file || !taskId) return null
    const max = 50 * 1024 * 1024
    if (file.size > max) {
      alert('File must be ≤ 50MB.')
      return null
    }
    const safeLabel = String(label ?? '').trim()
    if (!safeLabel) {
      alert('File label is required.')
      return null
    }

    const blobId = uuid()
    await putBlob(blobId, file)
    const now = new Date().toISOString()
    const doc = {
      id: uuid(),
      type: 'task_file',
      label: safeLabel,
      description: String(description ?? '').trim(),
      file_name: file.name,
      mime: file.type || 'application/octet-stream',
      file_size: file.size,
      blob_id: blobId,
      uploaded_at: now,
      synced: isOnline,
      sync_error: null,
    }

    updateLot(lotId, (lot) => {
      const tasks = (lot.tasks ?? []).map((t) =>
        t.id !== taskId ? t : { ...t, documents: [...(t.documents ?? []), doc], updated_at: now },
      )
      return { ...lot, tasks }
    })

    if (!isOnline) {
      const lot = lotsById.get(lotId) ?? null
      enqueueSyncOp({
        type: 'document_upload',
        lot_id: lotId,
        entity_type: 'task_file',
        entity_id: doc.id,
        summary: `Task file queued (${lot ? lotCode(lot) : lotId})`,
      })
    }

    return doc
  }

  const removeTaskFile = async ({ lotId, taskId, docId }) => {
    if (!docId || !taskId) return
    const lot = lotsById.get(lotId) ?? null
    const task = (lot?.tasks ?? []).find((t) => t.id === taskId) ?? null
    const doc = (task?.documents ?? []).find((d) => d.id === docId) ?? null
    updateLot(lotId, (current) => {
      const tasks = (current.tasks ?? []).map((t) =>
        t.id !== taskId ? t : { ...t, documents: (t.documents ?? []).filter((d) => d.id !== docId) },
      )
      return { ...current, tasks }
    })
    if (doc?.blob_id) await deleteBlob(doc.blob_id)

    if (!isOnline) {
      enqueueSyncOp({
        type: 'document_delete',
        lot_id: lotId,
        entity_type: 'task_file',
        entity_id: docId,
        summary: `Task file deleted (${lot ? lotCode(lot) : lotId})`,
      })
    }
  }

  const allocateChangeOrderNumber = () => {
    const year = new Date().getFullYear()
    const nextSeq = (app.counters?.change_orders ?? 0) + 1
    setApp((prev) => ({
      ...prev,
      counters: { ...(prev.counters ?? {}), change_orders: nextSeq },
    }))
    return `CO-${year}-${String(nextSeq).padStart(3, '0')}`
  }

  const openLotTab = (lotId, nextTab = 'overview') => {
    const lot = lotsById.get(lotId) ?? null
    if (lot?.community_id) setSelectedCommunityId(lot.community_id)
    setSelectedLotId(lotId)
    setLotDetailTab(nextTab)
    setTab('communities')
  }

  const openLot = (lotId) => openLotTab(lotId, 'overview')

  const lotHasDelay = (lot) => (lot?.tasks ?? []).some((t) => t.status === 'delayed')

  const dashboardStatusLots = useMemo(
    () => ({
      active: activeLots,
      on_track: activeLots.filter((lot) => !(lot?.tasks ?? []).some((t) => t.status === 'delayed')),
      delayed: activeLots.filter((lot) => (lot?.tasks ?? []).some((t) => t.status === 'delayed')),
    }),
    [activeLots],
  )

  const lotEta = (lot) => {
    const predicted = getPredictedCompletionDate(lot)
    return predicted ? formatShortDate(predicted) : '--'
  }

  const exportLotScheduleCsv = (lot) => {
    if (!lot) return
    const community = communitiesById.get(lot.community_id) ?? null
    const rows = [
      [
        'Community',
        'Lot',
        'Track',
        'Task',
        'Trade',
        'Sub',
        'Scheduled Start',
        'Scheduled End',
        'Duration (days)',
        'Status',
        'Delay Days',
        'Delay Reason',
      ],
    ]

    const tasks = (lot.tasks ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    for (const t of tasks) {
      const status = deriveTaskStatus(t, lot.tasks, lot.inspections)
      const tradeLabel = TRADES.find((x) => x.id === t.trade)?.label ?? t.trade
      const subLabel = t.sub_id ? app.subcontractors.find((s) => s.id === t.sub_id)?.company_name ?? '' : ''
      rows.push([
        community?.name ?? '',
        lotCode(lot),
        t.track ?? '',
        t.name ?? '',
        tradeLabel,
        subLabel,
        t.scheduled_start ?? '',
        t.scheduled_end ?? '',
        t.duration ?? '',
        status,
        t.delay_days ?? '',
        t.delay_reason ?? '',
      ])
    }

    const safeName = `${community?.name ?? 'Community'}-${lotCode(lot)}-schedule.csv`.replaceAll(/[^\w.-]+/g, '-')
    downloadTextFile(safeName, rowsToCsv(rows), 'text/csv;charset=utf-8')
  }

  const allocateReportNumber = () => {
    const nextSeq = (app.counters?.reports ?? 0) + 1
    setApp((prev) => ({
      ...prev,
      counters: { ...(prev.counters ?? {}), reports: nextSeq },
    }))
    return nextSeq
  }

  const isoFromDateTime = (dt) => (typeof dt === 'string' && dt.length >= 10 ? dt.slice(0, 10) : '')
  const isIsoInRange = (iso, fromIso, toIso) => Boolean(iso && fromIso && toIso && iso >= fromIso && iso <= toIso)

  const buildReportData = ({ reportType, fromIso, toIso, communityIds, includePhotos }) => {
    const communitySet = new Set(communityIds ?? [])
    const lots = (app.lots ?? []).filter((l) => (communitySet.size ? communitySet.has(l.community_id) : true))

    const delayEvents = []
    for (const lot of lots) {
      const community = communitiesById.get(lot.community_id) ?? null
      for (const task of lot.tasks ?? []) {
        const at = isoFromDateTime(task.delay_logged_at)
        if (!at || !isIsoInRange(at, fromIso, toIso)) continue
        const sub = task.sub_id ? app.subcontractors.find((s) => s.id === task.sub_id) ?? null : null
        delayEvents.push({
          community: community?.name ?? '',
          lot: lotCode(lot),
          task: task.name ?? '',
          trade: TRADES.find((t) => t.id === task.trade)?.label ?? task.trade ?? '',
          sub: sub?.company_name ?? '',
          delay_days: Number(task.delay_days ?? 0) || 0,
          reason: task.delay_reason ?? '',
          notes: task.delay_notes ?? '',
          logged_at: at,
        })
      }
    }

    if (reportType === 'progress') {
      const rows = [
        [
          'Community',
          'Lot',
          'Status',
          'Milestone',
          '% Complete',
          'Start Date',
          'Target Completion',
          'Predicted Completion',
          'Days Ahead/Behind',
          'Delays (range)',
          includePhotos ? 'Photos (range)' : null,
        ].filter(Boolean),
      ]

      const delayCountsByLot = new Map()
      for (const ev of delayEvents) {
        const key = `${ev.community}::${ev.lot}`
        delayCountsByLot.set(key, (delayCountsByLot.get(key) ?? 0) + 1)
      }

      const photoCountsByLot = new Map()
      if (includePhotos) {
        for (const lot of lots) {
          const community = communitiesById.get(lot.community_id) ?? null
          const key = `${community?.name ?? ''}::${lotCode(lot)}`
          const count = (lot.photos ?? []).filter((p) => {
            const when = isoFromDateTime(p.taken_at)
            return when && isIsoInRange(when, fromIso, toIso)
          }).length
          photoCountsByLot.set(key, count)
        }
      }

      const active = lots.filter((l) => l.status === 'in_progress')
      for (const lot of active) {
        const community = communitiesById.get(lot.community_id) ?? null
        const pct = calculateLotProgress(lot)
        const milestone = getCurrentMilestone(lot)
        const predicted = getPredictedCompletionDate(lot)
        const target = lot.target_completion_date ?? null
        const daysDelta = predicted && target ? daysBetweenCalendar(predicted, target) : 0
        const key = `${community?.name ?? ''}::${lotCode(lot)}`
        rows.push([
          community?.name ?? '',
          lotCode(lot),
          lot.status ?? '',
          milestone?.label ?? '',
          pct,
          lot.start_date ?? '',
          target ?? '',
          predicted ? formatISODate(predicted) : '',
          daysDelta,
          delayCountsByLot.get(key) ?? 0,
          includePhotos ? photoCountsByLot.get(key) ?? 0 : null,
        ].filter((c) => c !== null))
      }

      const delayRows = [
        ['Community', 'Lot', 'Task', 'Trade', 'Sub', 'Days', 'Reason', 'Notes', 'Logged At'],
        ...delayEvents
          .slice()
          .sort((a, b) => String(b.logged_at).localeCompare(String(a.logged_at)))
          .map((ev) => [ev.community, ev.lot, ev.task, ev.trade, ev.sub, ev.delay_days, ev.reason, ev.notes, ev.logged_at]),
      ]

      return { title: 'Progress Report', sheets: [{ name: 'Progress', rows }, { name: 'Delays', rows: delayRows }] }
    }

    if (reportType === 'community_summary') {
      const header = [
        'Community',
        'Not Started',
        'In Progress',
        'Complete',
        'Avg % Complete (active)',
        'Avg Build Days (complete)',
        'On-Time % (complete)',
        'Total Delays (all time)',
      ]
      const rows = [header]

      const byCommunity = new Map()
      for (const lot of lots) {
        const community = communitiesById.get(lot.community_id) ?? null
        const key = community?.id ?? lot.community_id
        if (!byCommunity.has(key)) byCommunity.set(key, { community, lots: [] })
        byCommunity.get(key).lots.push(lot)
      }

      for (const { community, lots: commLots } of byCommunity.values()) {
        const notStarted = commLots.filter((l) => l.status === 'not_started').length
        const inProgress = commLots.filter((l) => l.status === 'in_progress').length
        const complete = commLots.filter((l) => l.status === 'complete').length
        const avgPct = inProgress
          ? Math.round(commLots.filter((l) => l.status === 'in_progress').reduce((a, l) => a + calculateLotProgress(l), 0) / inProgress)
          : 0

        const completeLots = commLots.filter((l) => l.status === 'complete' && l.start_date && l.actual_completion_date)
        const avgBuild = completeLots.length
          ? Math.round(completeLots.reduce((a, l) => a + businessDaysBetweenInclusive(l.start_date, l.actual_completion_date), 0) / completeLots.length)
          : 0

        const onTime = completeLots.length
          ? Math.round(
              (100 *
                completeLots.filter((l) => (l.actual_completion_date ?? '') <= (l.target_completion_date ?? '')).length) /
                completeLots.length,
            )
          : 0

        const delayTotal = (commLots ?? []).reduce((acc, l) => acc + (l.tasks ?? []).filter((t) => Number(t.delay_days ?? 0) > 0).length, 0)

        rows.push([community?.name ?? '', notStarted, inProgress, complete, avgPct, avgBuild, onTime, delayTotal])
      }

      return { title: 'Community Summary', sheets: [{ name: 'Community Summary', rows }] }
    }

    if (reportType === 'delay_analysis') {
      const eventsRows = [
        ['Community', 'Lot', 'Task', 'Trade', 'Sub', 'Days', 'Reason', 'Notes', 'Logged At'],
        ...delayEvents.map((ev) => [ev.community, ev.lot, ev.task, ev.trade, ev.sub, ev.delay_days, ev.reason, ev.notes, ev.logged_at]),
      ]

      const groupSum = (keyFn) => {
        const map = new Map()
        for (const ev of delayEvents) {
          const k = keyFn(ev) || '—'
          const prev = map.get(k) ?? { count: 0, days: 0 }
          map.set(k, { count: prev.count + 1, days: prev.days + (Number(ev.delay_days ?? 0) || 0) })
        }
        return Array.from(map.entries()).sort((a, b) => b[1].days - a[1].days)
      }

      const byReasonRows = [['Reason', 'Delay Count', 'Total Days'], ...groupSum((e) => e.reason).map(([k, v]) => [k, v.count, v.days])]
      const bySubRows = [['Sub', 'Delay Count', 'Total Days'], ...groupSum((e) => e.sub).map(([k, v]) => [k, v.count, v.days])]
      const byCommunityRows = [['Community', 'Delay Count', 'Total Days'], ...groupSum((e) => e.community).map(([k, v]) => [k, v.count, v.days])]

      const trendMap = new Map()
      for (const ev of delayEvents) {
        const iso = ev.logged_at
        const d = parseISODate(iso)
        if (!d) continue
        const mondayOffset = (d.getDay() + 6) % 7
        const weekStart = new Date(d)
        weekStart.setDate(weekStart.getDate() - mondayOffset)
        const k = formatISODate(weekStart)
        trendMap.set(k, (trendMap.get(k) ?? 0) + (Number(ev.delay_days ?? 0) || 0))
      }
      const trendRows = [['Week Start', 'Total Delay Days'], ...Array.from(trendMap.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]

      return {
        title: 'Delay Analysis',
        sheets: [
          { name: 'Delay Events', rows: eventsRows },
          { name: 'By Reason', rows: byReasonRows },
          { name: 'By Sub', rows: bySubRows },
          { name: 'By Community', rows: byCommunityRows },
          { name: 'Trend', rows: trendRows },
        ],
      }
    }

    if (reportType === 'sub_performance') {
      const rows = [
        ['Subcontractor', 'Trade', 'Rating', 'On-Time %', 'Delay Count', 'Total Jobs', 'Insurance Expiration', 'Status'],
        ...app.subcontractors.map((s) => [
          s.company_name,
          TRADES.find((t) => t.id === s.trade)?.label ?? s.trade,
          s.rating ?? '',
          s.on_time_pct ?? '',
          s.delay_count ?? '',
          s.total_jobs ?? '',
          s.insurance_expiration ?? '',
          s.status ?? '',
        ]),
      ]
      return { title: 'Sub Performance', sheets: [{ name: 'Sub Performance', rows }] }
    }

    if (reportType === 'schedule_forecast') {
      const rows = [
        ['Community', 'Lot', 'Milestone', '% Complete', 'Target Completion', 'Predicted Completion', 'Delayed?'],
        ...lots
          .filter((l) => l.status === 'in_progress')
          .map((l) => {
            const community = communitiesById.get(l.community_id) ?? null
            const pct = calculateLotProgress(l)
            const milestone = getCurrentMilestone(l)
            const predicted = getPredictedCompletionDate(l)
            const delayed = (l.tasks ?? []).some((t) => t.status === 'delayed')
            return [
              community?.name ?? '',
              lotCode(l),
              milestone?.label ?? '',
              pct,
              l.target_completion_date ?? '',
              predicted ? formatISODate(predicted) : '',
              delayed ? 'YES' : 'NO',
            ]
          }),
      ]
      return { title: 'Schedule Forecast', sheets: [{ name: 'Forecast', rows }] }
    }

    return { title: 'Report', sheets: [{ name: 'Report', rows: [['Unsupported report type']] }] }
  }

  const generateReportExport = async ({ reportType, fromIso, toIso, communityIds, format, includePhotos }) => {
    if (!isOnline) {
      alert('Exporting reports requires an internet connection.')
      return
    }
    const { title, sheets } = buildReportData({ reportType, fromIso, toIso, communityIds, includePhotos })
    const reportNo = allocateReportNumber()
    const base = `${title}-${fromIso}-${toIso}-R${String(reportNo).padStart(3, '0')}`.replaceAll(/[^\w.-]+/g, '-')

    try {
      if (format === 'csv') {
        const first = sheets[0]
        const text = rowsToCsv(first.rows ?? [])
        downloadTextFile(`${base}.csv`, text, 'text/csv;charset=utf-8')
      } else if (format === 'excel') {
        const mod = await import('xlsx')
        const XLSX = mod.default ?? mod
        const wb = XLSX.utils.book_new()
        for (const sheet of sheets) {
          const ws = XLSX.utils.aoa_to_sheet(sheet.rows ?? [])
          XLSX.utils.book_append_sheet(wb, ws, String(sheet.name ?? 'Sheet').slice(0, 31))
        }
        XLSX.writeFile(wb, `${base}.xlsx`)
      } else if (format === 'pdf') {
        const mod = await import('jspdf')
        const jsPDF = mod.jsPDF ?? mod.default?.jsPDF ?? mod.default
        const defaultOrientation = sheets.some((s) => (s?.rows?.[0] ?? []).length > 7) ? 'landscape' : 'portrait'
        const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: defaultOrientation })

        const PAGE = {
          margin: 40,
          headerH: 56,
          footerH: 26,
        }

        const asText = (value) => {
          if (value === null || value === undefined) return ''
          if (value instanceof Date) return formatISODate(value)
          return String(value)
        }

        const formatCell = (value, header) => {
          const raw = asText(value)
          if (!raw) return ''
          const h = String(header ?? '').toLowerCase()
          if (h.includes('date') || h.includes('completion') || h.includes('logged')) {
            // Prefer M/D/YY for readability when value looks like ISO date.
            const iso = raw.length >= 10 ? raw.slice(0, 10) : raw
            if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return formatShortDate(iso)
            return raw
          }
          if (h.includes('status')) {
            return raw.replaceAll('_', ' ')
          }
          return raw
        }

        const scaleToFit = (widths, available) => {
          const sum = widths.reduce((a, b) => a + b, 0)
          if (sum <= available) return widths
          const ratio = available / sum
          return widths.map((w) => Math.max(28, Math.floor(w * ratio)))
        }

        const presetWidthsFor = (sheetName, headers, pageW) => {
          const available = pageW - PAGE.margin * 2
          const cols = headers.length
          const normalizedName = String(sheetName ?? '').toLowerCase()

          if (reportType === 'progress' && normalizedName === 'progress') {
            // Tuned for the Progress report. Remaining space is distributed by scaleToFit.
            const base = includePhotos
              ? [120, 54, 72, 118, 56, 72, 88, 96, 78, 68, 68]
              : [128, 58, 78, 130, 60, 78, 96, 110, 86, 78]
            return scaleToFit(base.slice(0, cols), available)
          }
          if (reportType === 'progress' && normalizedName === 'delays') {
            const base = [120, 54, 130, 84, 90, 44, 130, 130, 78]
            return scaleToFit(base.slice(0, cols), available)
          }

          // Generic fallback: first two columns narrower, middle wider.
          const first = Math.max(90, Math.floor(available * 0.18))
          const second = Math.max(54, Math.floor(available * 0.09))
          const rest = cols > 2 ? Math.floor((available - first - second) / (cols - 2)) : Math.floor(available / cols)
          const widths = []
          for (let i = 0; i < cols; i++) {
            if (i === 0) widths.push(first)
            else if (i === 1) widths.push(second)
            else widths.push(Math.max(56, rest))
          }
          return scaleToFit(widths, available)
        }

        const drawHeader = ({ sheetName, pageNo }) => {
          const pageW = doc.internal.pageSize.getWidth()
          doc.setFont('helvetica', 'bold')
          doc.setFontSize(16)
          doc.text(title, PAGE.margin, PAGE.margin)

          doc.setFont('helvetica', 'normal')
          doc.setFontSize(10)
          doc.text(`Date range: ${formatShortDate(fromIso)} to ${formatShortDate(toIso)}`, PAGE.margin, PAGE.margin + 18)
          doc.text(`Generated: ${new Date().toLocaleString()}`, PAGE.margin, PAGE.margin + 32)

          doc.setFont('helvetica', 'bold')
          doc.setFontSize(11)
          doc.text(String(sheetName ?? 'Report'), PAGE.margin, PAGE.margin + 50)

          // Page number
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9)
          doc.text(`Page ${pageNo}`, pageW - PAGE.margin, PAGE.margin + 50, { align: 'right' })

          // Divider line
          doc.setDrawColor(210, 210, 210)
          doc.setLineWidth(1)
          doc.line(PAGE.margin, PAGE.margin + PAGE.headerH, pageW - PAGE.margin, PAGE.margin + PAGE.headerH)
        }

        const drawFooter = ({ pageNo }) => {
          const pageW = doc.internal.pageSize.getWidth()
          const pageH = doc.internal.pageSize.getHeight()
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(9)
          doc.setTextColor(120, 120, 120)
          doc.text(`${title}`, PAGE.margin, pageH - PAGE.margin + 10)
          doc.text(`Page ${pageNo}`, pageW - PAGE.margin, pageH - PAGE.margin + 10, { align: 'right' })
          doc.setTextColor(0, 0, 0)
        }

        const drawTable = ({ sheetName, rows }) => {
          const pageW = doc.internal.pageSize.getWidth()
          const pageH = doc.internal.pageSize.getHeight()
          const tableTop = PAGE.margin + PAGE.headerH + 14
          const bottomLimit = pageH - PAGE.margin - PAGE.footerH

          const headerRow = (rows?.[0] ?? []).map((h) => String(h ?? ''))
          const bodyRows = (rows ?? []).slice(1)
          const colWidths = presetWidthsFor(sheetName, headerRow, pageW)

          const x0 = PAGE.margin
          let y = tableTop
          let pageNo = doc.getCurrentPageInfo?.().pageNumber ?? 1

          const newPage = () => {
            if ((doc.getNumberOfPages?.() ?? 1) > 0) drawFooter({ pageNo })
            doc.addPage()
            pageNo = doc.getCurrentPageInfo?.().pageNumber ?? pageNo + 1
            drawHeader({ sheetName, pageNo })
            y = tableTop
            drawHeaderRow()
          }

          const drawHeaderRow = () => {
            const rowH = 18
            doc.setFillColor(245, 246, 248)
            doc.setDrawColor(220, 220, 220)
            doc.rect(x0, y, colWidths.reduce((a, b) => a + b, 0), rowH, 'FD')
            doc.setFont('helvetica', 'bold')
            doc.setFontSize(9)
            let x = x0
            for (let c = 0; c < headerRow.length; c++) {
              const text = headerRow[c]
              const w = colWidths[c]
              const padded = doc.splitTextToSize(text, w - 8)
              doc.text(padded.slice(0, 2), x + 4, y + 12) // clamp to 2 lines
              x += w
              // vertical grid
              doc.setDrawColor(230, 230, 230)
              doc.line(x, y, x, y + rowH)
            }
            y += rowH
            doc.setFont('helvetica', 'normal')
            doc.setFontSize(9)
          }

          drawHeaderRow()

          const wrapCell = (text, w) => doc.splitTextToSize(String(text ?? ''), Math.max(10, w - 8))

          for (let r = 0; r < bodyRows.length; r++) {
            const row = bodyRows[r] ?? []
            const cells = headerRow.map((h, idx) => formatCell(row[idx], h))
            const wrappedByCol = cells.map((t, i) => wrapCell(t, colWidths[i]))
            const maxLines = Math.max(1, ...wrappedByCol.map((lines) => Math.min(4, lines.length)))
            const lineH = 11
            const rowH = Math.max(16, maxLines * lineH + 8)

            if (y + rowH > bottomLimit) newPage()

            // row background + border
            if (r % 2 === 0) {
              doc.setFillColor(252, 252, 252)
              doc.setDrawColor(235, 235, 235)
              doc.rect(x0, y, colWidths.reduce((a, b) => a + b, 0), rowH, 'FD')
            } else {
              doc.setDrawColor(235, 235, 235)
              doc.rect(x0, y, colWidths.reduce((a, b) => a + b, 0), rowH)
            }

            let x = x0
            for (let c = 0; c < headerRow.length; c++) {
              const w = colWidths[c]
              const lines = wrappedByCol[c].slice(0, 4)
              doc.text(lines, x + 4, y + 14)
              x += w
              doc.setDrawColor(240, 240, 240)
              doc.line(x, y, x, y + rowH)
            }

            y += rowH
          }

          drawFooter({ pageNo })
        }

        // Render each sheet on its own page set (keeps headers consistent).
        sheets.forEach((sheet, idx) => {
          if (idx > 0) doc.addPage()
          const pageNo = doc.getCurrentPageInfo?.().pageNumber ?? idx + 1
          drawHeader({ sheetName: sheet.name, pageNo })
          drawTable({ sheetName: sheet.name, rows: sheet.rows ?? [] })
        })

        doc.save(`${base}.pdf`)
      }

      pushNotification({
        type: 'report_ready',
        title: `Report Ready - ${title}`,
        body: `Generated ${format.toUpperCase()} (${fromIso} → ${toIso})`,
        entity_type: 'report',
        entity_id: uuid(),
        lot_id: null,
        priority: 'normal',
      })
    } catch (err) {
      console.error(err)
      alert('Failed to generate report export.')
    }
  }

  const daysElapsed = (lot) => {
    if (!lot?.start_date) return null
    return businessDaysBetweenInclusive(lot.start_date, todayIso)
  }

  const taskInRange = (task, dateIso) => {
    if (!task?.scheduled_start || !task?.scheduled_end) return false
    const d = parseISODate(dateIso)
    const s = parseISODate(task.scheduled_start)
    const e = parseISODate(task.scheduled_end)
    if (!d || !s || !e) return false
    return d >= s && d <= e
  }

  const todaysAssignments = useMemo(() => {
    const items = []
    for (const lot of activeLots) {
      for (const task of lot.tasks ?? []) {
        if (!taskInRange(task, todayIso)) continue
        const status = deriveTaskStatus(task, lot.tasks, lot.inspections)
        if (status !== 'ready' && status !== 'in_progress') continue
        const sub = app.subcontractors.find((s) => s.id === task.sub_id) ?? null
        items.push({ lot, task, status, sub })
      }
    }
    return items
  }, [activeLots, todayIso, app.subcontractors])

  const criticalDeadlines = useMemo(() => {
    const list = []
    for (const lot of app.lots ?? []) {
      if (lot.status === 'complete') continue
      const target = lot.hard_deadline || lot.target_completion_date
      if (!target) continue
      const daysRemaining = daysBetweenCalendar(parseISODate(target), parseISODate(todayIso))
      if (!Number.isFinite(daysRemaining)) continue
      if (daysRemaining < 0 || daysRemaining > 14) continue
      const community = communitiesById.get(lot.community_id) ?? null
      list.push({ lot, community, daysRemaining })
    }
    return list.sort((a, b) => a.daysRemaining - b.daysRemaining)
  }, [app.lots, communitiesById, todayIso])

  const upcomingInspections = useMemo(() => {
    const list = []
    for (const lot of app.lots ?? []) {
      for (const inspection of lot.inspections ?? []) {
        if (!inspection?.scheduled_date) continue
        if (inspection.type === 'NOTE') continue
        if (inspection.status && inspection.status !== 'scheduled') continue
        if (inspection.scheduled_date < todayIso) continue
        const community = communitiesById.get(lot.community_id) ?? null
        const task = lot.tasks?.find((t) => t.id === inspection.task_id) ?? null
        list.push({ lot, community, inspection, task })
      }
    }
    return list.sort((a, b) => {
      const dateSort = String(a.inspection.scheduled_date).localeCompare(String(b.inspection.scheduled_date))
      if (dateSort !== 0) return dateSort
      return String(a.inspection.scheduled_time ?? '').localeCompare(String(b.inspection.scheduled_time ?? ''))
    })
  }, [app.lots, communitiesById, todayIso])

  const todaysTasks = useMemo(() => {
    const items = []
    for (const lot of activeLots) {
      for (const task of lot.tasks ?? []) {
        if (!taskInRange(task, todayIso)) continue
        items.push({ lot, task })
      }
    }
    return items
  }, [activeLots, todayIso])

  const openPunchItems = useMemo(() => {
    let count = 0
    for (const lot of app.lots ?? []) {
      for (const item of lot.punch_list?.items ?? []) {
        if (item.status !== 'closed' && item.status !== 'verified') count += 1
      }
    }
    return count
  }, [app.lots])

  const openPunchLots = useMemo(() => {
    const rows = []
    for (const lot of app.lots ?? []) {
      const openCount = (lot.punch_list?.items ?? []).filter((item) => item.status !== 'closed' && item.status !== 'verified').length
      if (openCount <= 0) continue
      const community = communitiesById.get(lot.community_id) ?? null
      rows.push({ lot, community, openCount })
    }
    return rows.sort((a, b) => b.openCount - a.openCount || Number(a.lot.lot_number ?? 0) - Number(b.lot.lot_number ?? 0))
  }, [app.lots, communitiesById])

  const matchesSalesFilters = (lot, filters, ignoreKey = '') => {
    if (ignoreKey !== 'communityId' && filters.communityId !== 'all' && lot.community_id !== filters.communityId) return false
    if (ignoreKey !== 'productTypeId' && filters.productTypeId !== 'all' && lot.product_type_id !== filters.productTypeId) return false
    if (ignoreKey !== 'planId' && filters.planId !== 'all' && lot.plan_id !== filters.planId) return false
    if (ignoreKey !== 'soldStatus' && filters.soldStatus !== 'all' && (lot.sold_status ?? 'available') !== filters.soldStatus) return false
    if (ignoreKey !== 'completionBy' && filters.completionBy && lot.target_completion_date && lot.target_completion_date > filters.completionBy) return false
    return true
  }

  const filteredSalesLots = useMemo(() => {
    const filters = salesFilters ?? {}
    return (app.lots ?? []).filter((lot) => matchesSalesFilters(lot, filters))
  }, [app.lots, salesFilters])

  const salesFilterOptions = useMemo(() => {
    const lots = app.lots ?? []
    const filters = salesFilters ?? {}
    const communityIds = new Set(lots.filter((lot) => matchesSalesFilters(lot, filters, 'communityId')).map((lot) => lot.community_id))
    const productTypeIds = new Set(
      lots.filter((lot) => matchesSalesFilters(lot, filters, 'productTypeId')).map((lot) => lot.product_type_id),
    )
    const planIds = new Set(lots.filter((lot) => matchesSalesFilters(lot, filters, 'planId')).map((lot) => lot.plan_id))

    return {
      communities: communities.filter((c) => communityIds.has(c.id)),
      productTypes: productTypes.filter((pt) => productTypeIds.has(pt.id)),
      plans: plans.filter((p) => planIds.has(p.id)),
    }
  }, [app.lots, salesFilters, communities, productTypes, plans])

  useEffect(() => {
    setSalesFilters((prev) => {
      let changed = false
      const next = { ...prev }
      if (prev.communityId !== 'all' && !salesFilterOptions.communities.some((c) => c.id === prev.communityId)) {
        next.communityId = 'all'
        changed = true
      }
      if (prev.productTypeId !== 'all' && !salesFilterOptions.productTypes.some((pt) => pt.id === prev.productTypeId)) {
        next.productTypeId = 'all'
        changed = true
      }
      if (prev.planId !== 'all' && !salesFilterOptions.plans.some((p) => p.id === prev.planId)) {
        next.planId = 'all'
        changed = true
      }
      return changed ? next : prev
    })
  }, [salesFilterOptions])

  const salesStats = useMemo(() => {
    const lots = filteredSalesLots ?? []
    const available = lots.filter((l) => (l.sold_status ?? 'available') === 'available').length
    const pending = lots.filter((l) => (l.sold_status ?? 'available') === 'pending').length
    const sold = lots.filter((l) => (l.sold_status ?? 'available') === 'sold').length
    const completionDates = lots.map((l) => l.target_completion_date).filter(Boolean).sort()
    const communitiesCount = new Set(lots.map((l) => l.community_id)).size
    const productTypesCount = new Set(lots.map((l) => l.product_type_id)).size
    const plansCount = new Set(lots.map((l) => l.plan_id).filter(Boolean)).size
    return {
      total: lots.length,
      available,
      pending,
      sold,
      earliestCompletion: completionDates[0] ?? '',
      latestCompletion: completionDates[completionDates.length - 1] ?? '',
      communitiesCount,
      productTypesCount,
      plansCount,
    }
  }, [filteredSalesLots])

  const weatherByIso = useMemo(() => new Map((weather.forecast ?? []).map((d) => [d.date, d])), [weather.forecast])

  const weatherWarnings = useMemo(() => {
    const out = []
    const forecast = weather.forecast ?? []
    if (forecast.length === 0) return out

    for (const day of forecast) {
      const dateIso = day.date
      if (!dateIso) continue

      const outdoor = []
      for (const lot of activeLots) {
        const community = communitiesById.get(lot.community_id) ?? null
        for (const task of lot.tasks ?? []) {
          if (task.status === 'complete') continue
          if (!taskInRange(task, dateIso)) continue
          const isOutdoor = Boolean(task.is_outdoor) || OUTDOOR_TASK_NAMES.includes(task.name)
          if (!isOutdoor) continue
          outdoor.push({ lot, community, task })
        }
      }

      if (outdoor.length === 0) continue

      const rainChance = Number(day.rainChance ?? NaN)
      if (Number.isFinite(rainChance) && rainChance > WEATHER_THRESHOLDS.rain_probability) {
        out.push({
          date: dateIso,
          type: 'rain',
          severity: rainChance > 80 ? 'high' : 'medium',
          message: `${Math.round(rainChance)}% chance of rain`,
          affected: outdoor,
          recommendation: 'Consider rescheduling outdoor work',
        })
      }

      const low = Number(day.min ?? NaN)
      const concrete = outdoor.filter((x) => String(x.task.name ?? '').includes('Pour') || String(x.task.name ?? '').includes('Concrete'))
      if (concrete.length > 0 && Number.isFinite(low) && low < WEATHER_THRESHOLDS.temp_low) {
        out.push({
          date: dateIso,
          type: 'cold',
          severity: 'high',
          message: `Low of ${Math.round(low)}°F — too cold for concrete`,
          affected: concrete,
          recommendation: 'Reschedule concrete work or use cold-weather mix',
        })
      }

      const wind = Number(day.windMax ?? NaN)
      const elevated = outdoor.filter((x) => String(x.task.name ?? '').includes('Framing') || String(x.task.name ?? '').includes('Roof'))
      if (elevated.length > 0 && Number.isFinite(wind) && wind > WEATHER_THRESHOLDS.wind_speed) {
        out.push({
          date: dateIso,
          type: 'wind',
          severity: 'high',
          message: `Wind ${Math.round(wind)} mph — unsafe for elevated work`,
          affected: elevated,
          recommendation: 'Reschedule elevated work',
        })
      }
    }

    const rank = (w) => (w.severity === 'high' ? 0 : 1)
    return out.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || rank(a) - rank(b) || String(a.type).localeCompare(String(b.type)))
  }, [weather.forecast, activeLots, communitiesById, taskInRange])

  useEffect(() => {
    if (!isOnline) return
    for (const w of weatherWarnings) {
      const key = `weather_warning:${w.type}:${w.date}`
      const sample = (w.affected ?? [])[0]
      pushNotificationDeduped({
        dedupeKey: key,
        type: 'weather_warning',
        title: `Weather Alert - ${w.date}`,
        body: `${w.message}\nAffected: ${(w.affected ?? []).length} task(s)\n${sample ? `Example: ${(sample.community?.name ?? '')} ${lotCode(sample.lot)} • ${sample.task?.name ?? ''}` : ''}\n${w.recommendation}`.trim(),
        entity_type: 'weather',
        entity_id: `${w.type}:${w.date}`,
        lot_id: null,
        priority: w.severity === 'high' ? 'high' : 'normal',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, weatherWarnings])

  useEffect(() => {
    const subs = app.subcontractors ?? []
    for (const sub of subs) {
      const exp = sub?.insurance_expiration
      if (!exp) continue
      const daysUntil = daysBetweenCalendar(exp, todayIso)
      if (daysUntil < 0 || daysUntil > 30) continue
      pushNotificationDeduped({
        dedupeKey: `insurance_expiring:${sub.id}:${exp}`,
        type: 'compliance_expiring',
        title: `Insurance Expiring - ${sub.company_name}`,
        body: `Insurance expires ${formatLongDate(exp)} (${daysUntil} day${daysUntil === 1 ? '' : 's'}).`,
        entity_type: 'sub',
        entity_id: sub.id,
        lot_id: null,
        priority: daysUntil <= 7 ? 'high' : 'normal',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayIso, app.subcontractors])

  const weekStartIso = useMemo(() => {
    const base = parseISODate(calendarDate) ?? parseISODate(todayIso)
    if (!base) return todayIso
    const mondayOffset = (base.getDay() + 6) % 7
    const start = new Date(base)
    start.setDate(start.getDate() - mondayOffset)
    return formatISODate(start)
  }, [calendarDate, todayIso])

  const weekDates = useMemo(() => {
    const dates = []
    for (let i = 0; i < 7; i++) {
      const d = addCalendarDays(weekStartIso, i)
      if (!d) continue
      dates.push(formatISODate(d))
    }
    return dates
  }, [weekStartIso])

  const weekTimelineRows = useMemo(() => {
    const weekStart = parseISODate(weekDates[0])
    const weekEnd = parseISODate(weekDates[6])
    if (!weekStart || !weekEnd) return []
    const weekStartIso = formatISODate(weekStart)
    const rows = []

    for (const lot of activeLots) {
      if (calendarFilters.communityId !== 'all' && lot.community_id !== calendarFilters.communityId) continue
      const community = communitiesById.get(lot.community_id) ?? null
      const tasks = []

      for (const task of lot.tasks ?? []) {
        if (!task?.scheduled_start || !task?.scheduled_end) continue
        const status = deriveTaskStatus(task, lot.tasks, lot.inspections)
        if (calendarFilters.trade !== 'all' && task.trade !== calendarFilters.trade) continue
        if (calendarFilters.subId !== 'all' && task.sub_id !== calendarFilters.subId) continue
        if (!calendarFilters.showDelayed && status === 'delayed') continue

        const start = parseISODate(task.scheduled_start)
        const end = parseISODate(task.scheduled_end)
        if (!start || !end) continue
        if (end < weekStart || start > weekEnd) continue

        const clampedStart = start < weekStart ? weekStart : start
        const clampedEnd = end > weekEnd ? weekEnd : end
        const clampedStartIso = formatISODate(clampedStart)
        const clampedEndIso = formatISODate(clampedEnd)
        const startIndex = Math.max(0, Math.min(6, daysBetweenCalendar(clampedStartIso, weekStartIso)))
        const duration = Math.max(1, daysBetweenCalendar(clampedEndIso, clampedStartIso) + 1)
        const leftPercent = (startIndex / 7) * 100
        const widthPercent = (duration / 7) * 100
        const sub = (app.subcontractors ?? []).find((s) => s.id === task.sub_id) ?? null

        tasks.push({
          id: task.id,
          task,
          status,
          sub,
          leftPercent,
          widthPercent,
          duration,
          startIso: clampedStartIso,
          endIso: clampedEndIso,
        })
      }

      if (tasks.length > 0) {
        tasks.sort((a, b) => String(a.task.scheduled_start).localeCompare(String(b.task.scheduled_start)))
        rows.push({ lot, community, tasks })
      }
    }

    return rows.sort((a, b) => {
      const aComm = String(a.community?.name ?? '')
      const bComm = String(b.community?.name ?? '')
      if (aComm !== bComm) return aComm.localeCompare(bComm)
      return Number(a.lot.lot_number ?? 0) - Number(b.lot.lot_number ?? 0)
    })
  }, [activeLots, app.subcontractors, calendarFilters, communitiesById, weekDates])

  const monthGrid = useMemo(() => {
    const base = parseISODate(calendarDate) ?? parseISODate(todayIso)
    if (!base) return { monthStartIso: todayIso, gridStartIso: todayIso, cells: [] }
    const monthStart = new Date(base.getFullYear(), base.getMonth(), 1)
    const monthStartIso = formatISODate(monthStart)
    const gridStart = new Date(monthStart)
    gridStart.setDate(gridStart.getDate() - gridStart.getDay())
    const gridStartIso = formatISODate(gridStart)
    const cells = []
    for (let i = 0; i < 42; i++) {
      const d = addCalendarDays(gridStartIso, i)
      if (!d) continue
      const iso = formatISODate(d)
      const offset = daysBetweenCalendar(iso, monthStartIso)
      cells.push({ iso, offset })
    }
    return { monthStartIso, gridStartIso, cells }
  }, [calendarDate, todayIso])

  const matchesCalendarFilters = (lot, task, status) => {
    if (calendarFilters.communityId !== 'all' && lot.community_id !== calendarFilters.communityId) return false
    if (calendarFilters.trade !== 'all' && task.trade !== calendarFilters.trade) return false
    if (calendarFilters.subId !== 'all' && task.sub_id !== calendarFilters.subId) return false
    if (!calendarFilters.showDelayed && status === 'delayed') return false
    return true
  }

  const createInspectionNote = (lotId, payload) => {
    const inspectionId = uuid()
    updateLot(lotId, (lot) => {
      const now = new Date().toISOString()
      const inspection = {
        id: inspectionId,
        lot_id: lotId,
        task_id: payload.task_id ?? null,
        type: payload.type ?? 'NOTE',
        status: 'logged',
        scheduled_date: payload.scheduled_date ?? todayIso,
        scheduled_time: payload.scheduled_time ?? '',
        inspector: payload.inspector ?? '',
        notes: payload.notes ?? '',
        result: payload.result ?? null,
        documents: payload.documents ?? [],
        created_at: now,
        updated_at: now,
      }
      return { ...lot, inspections: [...(lot.inspections ?? []), inspection] }
    })
    if (!isOnline) {
      enqueueSyncOp({
        type: 'inspection_note',
        lot_id: lotId,
        entity_type: 'inspection',
        entity_id: inspectionId,
        summary: 'Inspection note added',
      })
    }
    return inspectionId
  }

  const updateInspection = (lotId, inspectionId, patch) => {
    updateLot(lotId, (lot) => {
      const now = new Date().toISOString()
      const inspections = (lot.inspections ?? []).map((i) => {
        if (i.id !== inspectionId) return i
        return { ...i, ...patch, updated_at: now }
      })
      return { ...lot, inspections }
    })
    if (!isOnline) {
      enqueueSyncOp({
        type: 'inspection_update',
        lot_id: lotId,
        entity_type: 'inspection',
        entity_id: inspectionId,
        summary: 'Inspection updated',
      })
    }
  }

  const deleteInspection = async (lotId, inspectionId) => {
    const lot = lotsById.get(lotId) ?? null
    const inspection = lot?.inspections?.find((i) => i.id === inspectionId) ?? null
    const blobs = []
    for (const doc of inspection?.documents ?? []) {
      if (doc?.blob_id) blobs.push(doc.blob_id)
    }
    if (inspection?.report_document?.blob_id) blobs.push(inspection.report_document.blob_id)
    await Promise.allSettled(blobs.map((id) => deleteBlob(id)))

    updateLot(lotId, (l) => {
      const inspections = (l.inspections ?? []).filter((i) => i.id !== inspectionId)
      const tasks = (l.tasks ?? []).map((t) => (t.inspection_id === inspectionId ? { ...t, inspection_id: null, updated_at: new Date().toISOString() } : t))
      return { ...l, tasks, inspections }
    })
    if (!isOnline) {
      enqueueSyncOp({
        type: 'inspection_delete',
        lot_id: lotId,
        entity_type: 'inspection',
        entity_id: inspectionId,
        summary: 'Inspection deleted',
      })
    }
  }

  const getCalendarDropStatus = ({ lot, task, targetDateIso }) => {
    if (!lot || !task || !targetDateIso) return { status: 'invalid', normalized: '', earliest: null }
    const normalized = formatISODate(getNextWorkDay(targetDateIso) ?? parseISODate(targetDateIso)) || targetDateIso
    return { status: 'valid', normalized, earliest: null }
  }

  const applyReschedule = ({ lot, task, targetDateIso, reason, notifySubs, preview }) => {
    if (!lot || !task) return { status: 'invalid' }
    const computed = preview ?? buildReschedulePreview({ lot, task, targetDateIso, org })
    const normalizedDate = computed.normalized_date || ''
    if (!normalizedDate) return { status: 'invalid' }

    const hasShift = (computed.affected ?? []).some((a) => a.old_start !== a.new_start || a.old_end !== a.new_end)
    if (!hasShift) return { status: 'noop', newStartDate: normalizedDate, preview: computed }

    const affectedById = new Map((computed.affected ?? []).map((a) => [a.task_id, a]))
    const community = communitiesById.get(lot.community_id) ?? null
    const impacted = (computed.affected ?? []).filter((a) => a.old_start !== a.new_start)

    let op = null
    setApp((prev) => {
      const nextLots = (prev.lots ?? []).map((l) => {
        if (l.id !== lot.id) return l
        const now = new Date().toISOString()
        const nextTasks = refreshReadyStatuses((l.tasks ?? []).map((t) => {
          const hit = affectedById.get(t.id)
          if (!hit) return t
          return { ...t, scheduled_start: hit.new_start, scheduled_end: hit.new_end, updated_at: now }
        }))
        const currentTask = (l.tasks ?? []).find((t) => t.id === task.id) ?? task
        const nextLot = {
          ...l,
          tasks: nextTasks,
          schedule_changes: [
            ...(l.schedule_changes ?? []),
            {
              id: uuid(),
              task_id: task.id,
              old_start: currentTask.scheduled_start,
              new_start: normalizedDate,
              reason: reason?.trim() || null,
              notified: Boolean(notifySubs),
              changed_at: now,
            },
          ],
        }

        op = buildV2TasksBatchOp({ lotId: lot.id, prevLot: l, nextLot })
        return nextLot
      })
      return { ...prev, lots: nextLots }
    })

    if (op) {
      void Promise.resolve()
        .then(() => outboxEnqueue(op))
        .catch(() => {})
    }

    pushNotification({
      type: 'schedule_change',
      title: `Schedule Changed - ${community?.name ?? ''} ${lotCode(lot)}`,
      body: `${task.name}\n${formatShortDate(task.scheduled_start)} → ${formatShortDate(normalizedDate)}${reason ? `\nReason: ${reason.trim()}` : ''}`,
      entity_type: 'task',
      entity_id: task.id,
      lot_id: lot.id,
      priority: 'normal',
    })

    if (notifySubs && impacted.length > 0) {
      const messages = buildScheduleChangeMessages({
        lot,
        community,
        impactedTasks: impacted,
        changeReason: reason?.trim() || 'Task rescheduled',
      })
      addMessages(messages)
    }

    if (!isOnline) {
      enqueueSyncOp({
        type: 'task_dates',
        lot_id: lot.id,
        entity_type: 'task',
        entity_id: task.id,
        summary: `Task rescheduled (${lotCode(lot)} - ${task.name})`,
      })
    }

    return { status: 'applied', newStartDate: normalizedDate, preview: computed }
  }

  const calendarAssignmentsForDate = (dateIso) => {
    const items = []
    for (const lot of activeLots) {
      for (const task of lot.tasks ?? []) {
        if (!taskInRange(task, dateIso)) continue
        const status = deriveTaskStatus(task, lot.tasks, lot.inspections)
        if (!matchesCalendarFilters(lot, task, status)) continue
        const sub = app.subcontractors.find((s) => s.id === task.sub_id) ?? null
        const community = communitiesById.get(lot.community_id) ?? null
        items.push({ lot, community, task, status, sub })
      }
    }
    return items
  }

  const headerTitle = selectedLot
    ? `${selectedCommunity ? selectedCommunity.name : 'Lot'} ${lotCode(selectedLot)}`
    : selectedCommunity
      ? selectedCommunity.name
      : 'BuildFlow'

  const tradeOptions = useMemo(() => mergeTradeOptions(app.custom_trades ?? []), [app.custom_trades])
  const tradeToCategory = useMemo(() => {
    const map = new Map()
    for (const preset of TASK_PRESETS) {
      if (preset.trade && preset.category) map.set(preset.trade, preset.category)
    }
    for (const template of app.templates ?? []) {
      for (const task of template?.tasks ?? []) {
        const trade = String(task?.trade ?? '').trim()
        const track = String(task?.track ?? task?.category ?? task?.phase ?? '').trim()
        if (trade && track) map.set(trade, track)
      }
    }
    return map
  }, [app.templates])

  const filteredSubs = useMemo(() => {
    const list = (app.subcontractors ?? []).slice()
    return list.filter((sub) => {
      const trades = new Set([sub?.trade, ...(sub?.secondary_trades ?? [])].filter(Boolean))
      if (subFilterTrade !== 'all' && !trades.has(subFilterTrade)) return false
      if (subFilterCategory !== 'all') {
        let match = false
        for (const trade of trades) {
          if (tradeToCategory.get(trade) === subFilterCategory) {
            match = true
            break
          }
        }
        if (!match) return false
      }
      return true
    })
  }, [app.subcontractors, subFilterCategory, subFilterTrade, tradeToCategory])

  const adminSections = [
    { id: 'product_types', label: 'Product Types', description: 'Define categories, build days, and templates.', count: productTypes.length },
    { id: 'plans', label: 'Plans', description: 'Attach floor plans to product types.', count: plans.length },
    { id: 'agencies', label: 'Agencies', description: 'Configure inspection agencies and types.', count: agencies.length },
    {
      id: 'contact_library',
      label: 'Contact Library',
      description: 'Save realtor and builder contacts for reuse.',
      count: (contactLibraryRealtors.length || 0) + (contactLibraryBuilders.length || 0),
    },
    { id: 'trades', label: 'Trades', description: 'Manage custom trade types for subs and filters.', count: tradeOptions.length },
    { id: 'custom_fields', label: 'Custom Fields', description: 'Extra fields for lot start and reporting.', count: (org.custom_fields ?? []).length },
  ]

  const [communityWizardStep, setCommunityWizardStep] = useState(1)
  const [realtorPersonaId, setRealtorPersonaId] = useState('')
  const [builderPersonaId, setBuilderPersonaId] = useState('')
  const [inspectorLibraryKey, setInspectorLibraryKey] = useState('')
  const [agencyLibraryKey, setAgencyLibraryKey] = useState('')
  const createDraftRealtor = () => ({ id: uuid(), name: '', phone: '', email: '', company: '' })
  const createDraftInspector = () => ({ id: uuid(), name: '', phone: '', email: '', agency_id: '' })
  const createDraftBuilder = (index = 0) => ({
    id: uuid(),
    name: '',
    phone: '',
    email: '',
    color: BUILDER_COLORS[index % BUILDER_COLORS.length] ?? '#3B82F6',
    lot_ranges: '',
  })

  const [communityDraft, setCommunityDraft] = useState(() => ({
    name: '',
    street: '',
    city: '',
    state: 'TX',
    zip: '',
    product_type_ids: (app.product_types ?? []).filter((pt) => pt.is_active !== false).map((pt) => pt.id),
    lot_count: 50,
    lot_type_ranges: {},
    plat_file: null,
    plat_skip: false,
    agency_ids: [],
    agencies: [],
    realtors: [createDraftRealtor()],
    inspectors: [createDraftInspector()],
    builders: [createDraftBuilder(0)],
  }))

  const draftLotCount = Math.max(1, Number(communityDraft.lot_count) || 1)
  const activeProductTypeIds = communityDraft.product_type_ids ?? []
  const draftProductTypeAssignments = activeProductTypeIds.map((ptId) => ({
    id: ptId,
    lots: normalizeRange(communityDraft.lot_type_ranges?.[ptId], draftLotCount),
  }))
  const draftProductTypeValidation = validateAssignments({ assignments: draftProductTypeAssignments, lotCount: draftLotCount })
  const activeBuilders = (communityDraft.builders ?? []).filter((b) => {
    const hasContact = String(b.name || b.email || b.phone).trim()
    const hasLots = normalizeRange(b.lot_ranges, draftLotCount).length > 0
    return hasContact || hasLots
  })
  const draftBuilderAssignments = activeBuilders.map((b) => ({
    id: b.id,
    lots: normalizeRange(b.lot_ranges, draftLotCount),
  }))
  const draftBuilderValidation = validateAssignments({ assignments: draftBuilderAssignments, lotCount: draftLotCount })
  const builderAssignmentsValid =
    draftBuilderValidation.missing.length === 0 &&
    draftBuilderValidation.duplicates.length === 0 &&
    draftBuilderValidation.out_of_range.length === 0
  const communityCreateIssues = []
  if (!communityDraft.name.trim()) {
    communityCreateIssues.push('Community name is required (Step 1).')
  }
  if (activeProductTypeIds.length === 0) {
    communityCreateIssues.push('Select at least one product type (Step 1).')
  }
  if (!builderAssignmentsValid) {
    const missing = draftBuilderValidation.missing.length
    const duplicates = draftBuilderValidation.duplicates.length
    const outOfRange = draftBuilderValidation.out_of_range.length
    const detail = [
      missing ? `missing: ${missing}` : null,
      duplicates ? `duplicates: ${duplicates}` : null,
      outOfRange ? `out of range: ${outOfRange}` : null,
    ]
      .filter(Boolean)
      .join(', ')
    communityCreateIssues.push(`Assign all lots to builders${detail ? ` (${detail})` : ''} (Step 4).`)
  }
  const availableDraftAgencies = [...agencies, ...(communityDraft.agencies ?? [])]

  const buildRangeNumbers = (startValue, endValue, max) => {
    const startNum = Number.parseInt(startValue, 10)
    const endNum = Number.parseInt(endValue || startValue, 10)
    if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) return []
    return normalizeRange(`${startNum}-${endNum}`, max)
  }

  const rangesFromLots = (lots) => {
    const rangeString = toRangeString(lots)
    if (!rangeString) return []
    return rangeString.split(',').map((part) => part.trim()).filter(Boolean)
  }

  const isBlankRealtor = (realtor) =>
    !String(realtor?.name ?? '').trim() &&
    !String(realtor?.phone ?? '').trim() &&
    !String(realtor?.email ?? '').trim() &&
    !String(realtor?.company ?? '').trim()

  const isBlankBuilder = (builder) =>
    !String(builder?.name ?? '').trim() &&
    !String(builder?.phone ?? '').trim() &&
    !String(builder?.email ?? '').trim()

  const isBlankInspector = (inspector) =>
    !String(inspector?.name ?? '').trim() &&
    !String(inspector?.phone ?? '').trim() &&
    !String(inspector?.email ?? '').trim()

  const inspectorLibrary = useMemo(() => {
    const list = []
    const seen = new Set()
    const orgAgencyById = new Map((agencies ?? []).map((a) => [a.id, a]))
    for (const community of app.communities ?? []) {
      const communityAgencies = community?.agencies ?? []
      const communityAgencyById = new Map(communityAgencies.map((a) => [a.id, a]))
      for (const inspector of community?.inspectors ?? []) {
        const name = String(inspector?.name ?? '').trim()
        const phone = String(inspector?.phone ?? '').trim()
        const email = String(inspector?.email ?? '').trim()
        const key = `${name}|${email}|${phone}`.toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        const agencyId = inspector?.agency_id ?? ''
        const agency = communityAgencyById.get(agencyId) ?? orgAgencyById.get(agencyId) ?? null
        list.push({
          key,
          name,
          phone,
          email,
          agency_id: agencyId,
          agency,
          source: community?.name ?? 'Community',
        })
      }
    }
    return list
  }, [app.communities, agencies])

  const agencyLibrary = useMemo(() => {
    const list = []
    const seen = new Set()
    const addAgency = (agency, source, isOrg) => {
      const name = String(agency?.name ?? '').trim()
      if (!name) return
      const key = name.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      list.push({
        key,
        id: agency?.id ?? null,
        name,
        inspection_types: agency?.inspection_types ?? [],
        source,
        isOrg,
      })
    }
    for (const agency of agencies ?? []) {
      addAgency(agency, 'Org', true)
    }
    for (const community of app.communities ?? []) {
      for (const agency of community?.agencies ?? []) {
        addAgency(agency, community?.name ?? 'Community', false)
      }
    }
    return list
  }, [agencies, app.communities])

  const addRealtorFromLibrary = (personaId) => {
    const persona = contactLibraryRealtors.find((r) => r.id === personaId)
    if (!persona) return
    setCommunityDraft((d) => {
      const nextRealtors = [...(d.realtors ?? [])]
      const blankIndex = nextRealtors.findIndex((r) => isBlankRealtor(r))
      const payload = {
        name: persona.name ?? '',
        phone: persona.phone ?? '',
        email: persona.email ?? '',
        company: persona.company ?? '',
      }

      if (blankIndex >= 0) {
        const existing = nextRealtors[blankIndex]
        nextRealtors[blankIndex] = { ...existing, ...payload }
      } else {
        nextRealtors.push({ id: uuid(), ...payload })
      }

      return { ...d, realtors: nextRealtors }
    })
  }

  const addInspectorFromLibrary = (key) => {
    const inspector = inspectorLibrary.find((i) => i.key === key)
    if (!inspector) return
    setCommunityDraft((d) => {
      const nextInspectors = [...(d.inspectors ?? [])]
      const blankIndex = nextInspectors.findIndex((i) => isBlankInspector(i))
      const hasAgency = (agencyId) =>
        Boolean(agencyId) &&
        ((agencies ?? []).some((a) => a.id === agencyId) || (d.agencies ?? []).some((a) => a.id === agencyId))
      const payload = {
        name: inspector.name ?? '',
        phone: inspector.phone ?? '',
        email: inspector.email ?? '',
        agency_id: hasAgency(inspector.agency_id) ? inspector.agency_id : '',
      }

      if (blankIndex >= 0) {
        const existing = nextInspectors[blankIndex]
        nextInspectors[blankIndex] = { ...existing, ...payload }
      } else {
        nextInspectors.push({ id: uuid(), ...payload })
      }
      return { ...d, inspectors: nextInspectors }
    })
  }

  const addAgencyFromLibrary = (key) => {
    const agency = agencyLibrary.find((a) => a.key === key)
    if (!agency) return
    if (agency.isOrg && agency.id) {
      setCommunityDraft((d) => {
        const next = new Set(d.agency_ids ?? [])
        next.add(agency.id)
        return { ...d, agency_ids: Array.from(next) }
      })
      return
    }
    setCommunityDraft((d) => {
      const exists = (d.agencies ?? []).some((a) => String(a.name ?? '').trim().toLowerCase() === agency.key)
      if (exists) return d
      return {
        ...d,
        agencies: [
          ...(d.agencies ?? []),
          { id: uuid(), name: agency.name, inspection_types: agency.inspection_types ?? [] },
        ],
      }
    })
  }

  const addBuilderFromLibrary = (personaId) => {
    const persona = contactLibraryBuilders.find((b) => b.id === personaId)
    if (!persona) return
    setCommunityDraft((d) => {
      const nextBuilders = [...(d.builders ?? [])]
      const blankIndex = nextBuilders.findIndex((b) => isBlankBuilder(b))
      const targetIndex = blankIndex >= 0 ? blankIndex : nextBuilders.length
      const existing = blankIndex >= 0 ? nextBuilders[blankIndex] : { id: uuid(), lot_ranges: '' }
      const color =
        persona.color ||
        existing.color ||
        (BUILDER_COLORS[targetIndex % BUILDER_COLORS.length] ?? '#3B82F6')

      const payload = {
        name: persona.name ?? '',
        phone: persona.phone ?? '',
        email: persona.email ?? '',
        color,
      }

      if (blankIndex >= 0) {
        nextBuilders[blankIndex] = { ...existing, ...payload }
      } else {
        nextBuilders.push({ ...existing, ...payload })
      }

      return { ...d, builders: nextBuilders }
    })
  }

  const updateProductTypeLots = (targetId, nextLots, removeFromOthers = true) => {
    setCommunityDraft((d) => {
      const lotCount = Math.max(1, Number(d.lot_count) || 1)
      const productTypeIds = d.product_type_ids ?? []
      const nextById = {}
      for (const id of productTypeIds) {
        nextById[id] = normalizeRange(d.lot_type_ranges?.[id], lotCount)
      }
      const nextSet = new Set(nextLots)
      if (removeFromOthers) {
        for (const id of productTypeIds) {
          if (id === targetId) continue
          nextById[id] = (nextById[id] ?? []).filter((lotNum) => !nextSet.has(lotNum))
        }
      }
      nextById[targetId] = Array.from(nextSet).sort((a, b) => a - b)
      const nextRanges = { ...(d.lot_type_ranges ?? {}) }
      for (const id of Object.keys(nextById)) {
        nextRanges[id] = toRangeString(nextById[id])
      }
      return { ...d, lot_type_ranges: nextRanges }
    })
  }

  const updateBuilderLots = (targetId, nextLots, removeFromOthers = true) => {
    setCommunityDraft((d) => {
      const lotCount = Math.max(1, Number(d.lot_count) || 1)
      const nextBuilders = (d.builders ?? []).map((b) => ({
        ...b,
        assigned: normalizeRange(b.lot_ranges, lotCount),
      }))
      const nextSet = new Set(nextLots)
      if (removeFromOthers) {
        for (const builder of nextBuilders) {
          if (builder.id === targetId) continue
          builder.assigned = builder.assigned.filter((lotNum) => !nextSet.has(lotNum))
        }
      }
      for (const builder of nextBuilders) {
        if (builder.id !== targetId) continue
        builder.assigned = Array.from(nextSet).sort((a, b) => a - b)
      }
      return {
        ...d,
        builders: nextBuilders.map((b) => ({
          id: b.id,
          name: b.name,
          phone: b.phone,
          email: b.email,
          color: b.color,
          lot_ranges: toRangeString(b.assigned),
        })),
      }
    })
  }

  const openCreateCommunity = () => {
    setCommunityWizardStep(1)
    setProductTypeRangeDrafts({})
    setBuilderRangeDrafts({})
    setRealtorPersonaId('')
    setBuilderPersonaId('')
    setCommunityDraft({
      name: '',
      street: '',
      city: '',
      state: 'TX',
      zip: '',
      product_type_ids: (app.product_types ?? []).filter((pt) => pt.is_active !== false).map((pt) => pt.id),
      lot_count: 50,
      lot_type_ranges: {},
      plat_file: null,
      plat_skip: false,
      agency_ids: [],
      agencies: [],
      realtors: [createDraftRealtor()],
      inspectors: [createDraftInspector()],
      builders: [createDraftBuilder(0)],
    })
    setShowCreateCommunity(true)
  }

  const createCommunity = async () => {
    try {
      const communityId = uuid()
      const lotCount = Math.max(1, Number(communityDraft.lot_count) || 1)
      const productTypeIds = communityDraft.product_type_ids ?? []
      const productTypeAssignments = productTypeIds.map((ptId) => ({
        id: ptId,
        lots: normalizeRange(communityDraft.lot_type_ranges?.[ptId], lotCount),
      }))
      const productTypeValidation = validateAssignments({ assignments: productTypeAssignments, lotCount })
      const lotsByProductType = {}
      for (const assignment of productTypeAssignments) {
        lotsByProductType[assignment.id] = Array.from(new Set(assignment.lots)).sort((a, b) => a - b)
      }
      if (productTypeValidation.missing.length > 0 && productTypeIds.length > 0) {
        const fallbackId = productTypeIds[0]
        lotsByProductType[fallbackId] = Array.from(
          new Set([...(lotsByProductType[fallbackId] ?? []), ...productTypeValidation.missing]),
        ).sort((a, b) => a - b)
      }

      const now = new Date().toISOString()
      const documents = []

      const platFile = communityDraft.plat_skip ? null : communityDraft.plat_file
      if (platFile) {
        const max = 50 * 1024 * 1024
        const okType = platFile.type === 'application/pdf' || String(platFile.type).startsWith('image/')
        if (!okType) throw new Error('Plat map must be a PDF or image.')
        if (platFile.size > max) throw new Error('Plat map must be ≤ 50MB.')
        if (!isOnline) throw new Error('Uploading documents requires an internet connection.')

        const blobId = uuid()
        await putBlob(blobId, platFile)
        documents.push({
          id: uuid(),
          type: 'plat_map',
          file_name: platFile.name,
          mime: platFile.type,
          file_size: platFile.size,
          blob_id: blobId,
          uploaded_at: now,
        })
      }

      const activeBuilders = (communityDraft.builders ?? []).filter((b) => {
        const hasContact = String(b.name || b.email || b.phone).trim()
        const hasLots = normalizeRange(b.lot_ranges, lotCount).length > 0
        return hasContact || hasLots
      })
      const builderAssignments = activeBuilders.map((b) => ({
        id: b.id,
        lots: normalizeRange(b.lot_ranges, lotCount),
      }))
      const builderValidation = validateAssignments({ assignments: builderAssignments, lotCount })
      if (builderValidation.missing.length || builderValidation.duplicates.length || builderValidation.out_of_range.length) {
        throw new Error('All lots must be assigned to exactly one builder.')
      }

      const builders = activeBuilders.map((b) => ({
        id: b.id,
        name: b.name.trim(),
        phone: b.phone.trim(),
        email: b.email.trim(),
        color: b.color || '#3B82F6',
        assigned_lots: normalizeRange(b.lot_ranges, lotCount),
      }))

      const realtors = (communityDraft.realtors ?? [])
        .filter((r) => String(r.name || r.email || r.phone).trim())
        .map((r) => ({ id: r.id, name: r.name.trim(), phone: r.phone.trim(), email: r.email.trim(), company: r.company.trim() }))

      const inspectors = (communityDraft.inspectors ?? [])
        .filter((i) => String(i.name || i.email || i.phone).trim())
        .map((i) => ({ id: i.id, name: i.name.trim(), phone: i.phone.trim(), email: i.email.trim(), agency_id: i.agency_id || '' }))

      const agencies = (communityDraft.agencies ?? [])
        .filter((a) => String(a.name).trim())
        .map((a) => ({
          id: a.id ?? uuid(),
          name: a.name.trim(),
          type: 'municipality',
          inspection_types: Array.isArray(a.inspection_types) ? a.inspection_types : [],
          is_org_level: false,
        }))

      const community = {
        id: communityId,
        name: communityDraft.name.trim(),
        address: {
          street: communityDraft.street.trim(),
          city: communityDraft.city.trim(),
          state: communityDraft.state.trim(),
          zip: communityDraft.zip.trim(),
        },
        product_type_ids: productTypeIds,
        lot_count: lotCount,
        lots_by_product_type: lotsByProductType,
        builders,
        realtors,
        inspectors,
        agency_ids: communityDraft.agency_ids ?? [],
        agencies,
        documents,
        specs: [],
      }

      const productTypesById = new Map((app.product_types ?? []).map((pt) => [pt.id, pt]))
      const builderByLot = new Map()
      for (const builder of builders) {
        for (const lotNum of builder.assigned_lots ?? []) builderByLot.set(lotNum, builder.id)
      }

      const newLots = []
      for (let i = 1; i <= lotCount; i++) {
        const productTypeId =
          Object.entries(lotsByProductType).find(([, lotNums]) => (lotNums ?? []).includes(i))?.[0] ??
          productTypeIds[0] ??
          null
        const buildDays = productTypesById.get(productTypeId)?.build_days ?? org.default_build_days ?? 135
        newLots.push({
          id: `${communityId}-${i}`,
          community_id: communityId,
          block: '',
          lot_number: String(i),
          product_type_id: productTypeId,
          plan_id: null,
          builder_id: builderByLot.get(i) ?? null,
          address: '',
          job_number: '',
          permit_number: null,
          model_type: '',
          status: 'not_started',
          start_date: null,
          hard_deadline: null,
          build_days: buildDays,
          target_completion_date: null,
          actual_completion_date: null,
          sold_status: 'available',
          sold_date: null,
          custom_fields: {},
          tasks: [],
          inspections: [],
          punch_list: null,
          daily_logs: [],
          change_orders: [],
          material_orders: [],
          documents: [],
          photos: [],
        })
      }

      setApp((prev) => ({ ...prev, communities: [...prev.communities, community], lots: [...prev.lots, ...newLots] }))
      setShowCreateCommunity(false)
    } catch (err) {
      console.error(err)
      alert(err?.message ?? 'Failed to create community.')
    }
  }

  const openStartLot = (lotId) => {
    const lot = lotId ? lotsById.get(lotId) : null
    setStartLotPrefill(() => {
      if (!lot) return null
      return { lot_id: lot.id }
    })
    setShowStartLot(true)
  }

  const unstartLot = async (lotId) => {
    const lot = lotId ? lotsById.get(lotId) : null
    if (!lot) return
    if (!isOnline) {
      alert('Unstart requires a connection right now.')
      return
    }

    if (syncV2Enabled) {
      const missingVersions = (lot.tasks ?? []).some((t) => !Number.isFinite(Number(t?.version)))
      if (missingVersions) {
        alert('Sync v2: this lot has tasks without server versions yet. Let sync finish, then retry unstart.')
        return
      }
    }

    const okConfirm =
      typeof window === 'undefined'
        ? false
        : window.confirm(
            `Reset ${lotCode(lot)} back to Not Started?\n\nThis will remove the schedule tasks and inspections for this lot.`,
          )
    if (!okConfirm) return

    await runScheduleEditWithLock(lotId, async () => {
      let op = null
      setApp((prev) => {
        const now = new Date().toISOString()
        const prevSync = prev.sync ?? {}
        const deleted = new Set(coerceArray(prevSync.deleted_task_ids))

        const nextLots = (prev.lots ?? []).map((l) => {
          if (l.id !== lotId) return l
          for (const t of l.tasks ?? []) {
            if (t?.id) deleted.add(t.id)
          }
          const nextLot = {
            ...l,
            status: 'not_started',
            start_date: null,
            target_completion_date: null,
            actual_completion_date: null,
            tasks: [],
            inspections: [],
            schedule_changes: [],
            updated_at: now,
          }
          op = buildV2TasksBatchOp({ lotId, prevLot: l, nextLot, includeLotRow: true })
          return nextLot
        })

        return {
          ...prev,
          lots: nextLots,
          sync: {
            ...prevSync,
            deleted_task_ids: Array.from(deleted),
          },
        }
      })

      if (op) {
        try {
          await outboxEnqueue(op)
        } catch {
          // ignore
        }
      }
    })
  }

  const closeStartLot = () => {
    setStartLotPrefill(null)
    setShowStartLot(false)
  }

  if (!authInitialized || showAuthLanding || !supabaseUser) {
    return (
      <AuthLandingPage
        authInitialized={authInitialized}
        supabaseStatus={supabaseStatus}
        supabaseUser={supabaseUser}
        authDraft={authDraft}
        authBusy={authBusy}
        authError={authError}
        uiLastCheckAt={uiLastCheckAt}
        onSetAuthField={setAuthField}
        onSignIn={signInWithSupabase}
        onCreateLogin={createSupabaseLogin}
        onContinueAsGuest={signInAsGuest}
        onContinueToApp={() => {
          if (!supabaseUser?.id) return
          setShowAuthLanding(false)
        }}
        onSignOut={signOutFromSupabase}
      />
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <style>{`@keyframes bfDropSnap{0%{transform:scale(1)}50%{transform:scale(1.02)}100%{transform:scale(1)}}`}</style>
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-4 py-3 flex items-center justify-between sticky top-0 z-30">
        {selectedLot || selectedCommunity ? (
          <button
            onClick={() => {
              if (selectedLot) setSelectedLotId(null)
              else setSelectedCommunityId(null)
              setLotDetailTab('overview')
            }}
            className="flex items-center gap-1"
          >
            <ChevronLeft className="w-5 h-5" /> Back
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <Building2 className="w-6 h-6" />
            <span className="font-bold text-lg">{headerTitle}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          {showSyncPill && (
            <button
              onClick={() => setShowOfflineStatus(true)}
              className={`px-2 py-1 rounded-lg text-xs flex items-center gap-1 ${
                !isOnline || writeSyncState.phase === 'error' ? 'bg-red-500/20' : writeSyncState.phase === 'syncing' ? 'bg-yellow-500/20' : 'bg-white/15'
              }`}
              title={!isOnline ? 'Offline mode' : 'Sync status'}
            >
              {isOnline ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
              {syncPillLabel}
              {pendingSyncCount > 0 ? ` • ${pendingSyncCount}` : ''}
            </button>
          )}
          <IconButton onClick={() => setShowNotifications(true)} title="Notifications">
            <div className="relative">
              <Bell className="w-5 h-5" />
              {unreadNotifications > 0 && (
                <span className="absolute -top-1 -right-1 text-[10px] bg-red-500 text-white rounded-full px-1">
                  {unreadNotifications}
                </span>
              )}
            </div>
          </IconButton>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {tab === 'dashboard' && !selectedLot && !selectedCommunity && (
          <div className="space-y-4">
            <Card className="border-blue-200 bg-blue-50/40">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Supabase</p>
                  <p className="text-sm text-gray-800 mt-1">{supabaseStatus.message}</p>
                  {supabaseStatus.orgId ? (
                    <p className="text-xs text-gray-600 mt-1">Org: {supabaseStatus.orgId}</p>
                  ) : null}
                  {supabaseStatus.role ? (
                    <p className="text-xs text-gray-600 mt-1">Role: {supabaseStatus.role}</p>
                  ) : null}
                  <p className="text-xs text-gray-500 mt-1">
                    Last check:{' '}
                    {uiLastCheckAt && formatSyncTimestamp(uiLastCheckAt)
                      ? formatSyncTimestamp(uiLastCheckAt)
                      : 'Not yet'}
                  </p>
                  {supabaseUser?.id ? (
                    <p
                      className={`text-xs mt-1 ${
                        writeSyncState.phase === 'error'
                          ? 'text-red-600'
                          : writeSyncState.phase === 'synced'
                            ? 'text-green-700'
                            : 'text-amber-700'
                      }`}
                    >
                      {writeSyncState.phase === 'error'
                        ? `Sync error: ${writeSyncState.error || 'write failed'}`
                        : writeSyncState.phase === 'syncing'
                          ? `Syncing changes...${uiLastSyncedAt ? ` Last synced: ${formatSyncTimestamp(uiLastSyncedAt)}` : ''}`
                          : uiLastSyncedAt && formatSyncTimestamp(uiLastSyncedAt)
                            ? `Last synced: ${formatSyncTimestamp(uiLastSyncedAt)}`
                            : writeSyncState.phase === 'idle'
                              ? 'Sync idle'
                              : 'Sync pending (not yet synced)'}
                    </p>
                  ) : null}
                  {supabaseStatus.warning ? (
                    <p className="text-xs text-amber-700 mt-2">{supabaseStatus.warning}</p>
                  ) : null}
                  {supabaseStatus.counts ? (
                    <p className="text-xs text-gray-700 mt-2">
                      Rows - Communities {supabaseStatus.counts.communities}, Lots {supabaseStatus.counts.lots}, Tasks {supabaseStatus.counts.tasks}, Subs {supabaseStatus.counts.subcontractors}
                    </p>
                  ) : null}
                </div>
                {supabaseUser?.email ? (
                  <p className="text-[11px] text-gray-600 text-right max-w-[11rem] break-words">
                    {supabaseUser.email}
                    {supabaseSession?.expires_at ? (
                      <span className="block text-[10px] text-gray-500 mt-1">
                        Session: {formatSyncTimestamp(new Date(Number(supabaseSession.expires_at) * 1000).toISOString())}
                      </span>
                    ) : null}
                  </p>
                ) : null}
              </div>

              {!supabaseUser ? (
                <div className="mt-3 space-y-2">
                  <input
                    type="email"
                    value={authDraft.email}
                    onChange={(e) => setAuthField('email', e.target.value)}
                    placeholder="Email"
                    className="w-full h-11 rounded-xl border border-blue-200 px-3 text-sm"
                    autoComplete="email"
                  />
                  <input
                    type="password"
                    value={authDraft.password}
                    onChange={(e) => setAuthField('password', e.target.value)}
                    placeholder="Password"
                    className="w-full h-11 rounded-xl border border-blue-200 px-3 text-sm"
                    autoComplete="current-password"
                  />
                  {authError ? <p className="text-xs text-red-600">{authError}</p> : null}
                  <div className="grid grid-cols-2 gap-2">
                    <PrimaryButton onClick={signInWithSupabase} disabled={authBusy}>
                      {authBusy ? 'Signing in...' : 'Sign In'}
                    </PrimaryButton>
                    <SecondaryButton onClick={createSupabaseLogin} disabled={authBusy} className="border-blue-200">
                      Create Login
                    </SecondaryButton>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <SecondaryButton
                      onClick={signInAsGuest}
                      disabled={authBusy}
                      className="col-span-2 border-blue-200"
                    >
                      Continue as Guest
                    </SecondaryButton>
                  </div>
                  <p className="text-xs text-gray-600">
                    Guest sign-in now uses an anonymous Supabase account so test edits persist to shared data.
                  </p>
                </div>
              ) : (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <SecondaryButton onClick={refreshSupabaseBootstrap} disabled={supabaseStatus.phase === 'loading'} className="border-blue-200">
                    Refresh Data
                  </SecondaryButton>
                  <SecondaryButton onClick={signOutFromSupabase} disabled={authBusy} className="border-blue-200">
                    Sign Out
                  </SecondaryButton>
                  <SecondaryButton
                    onClick={resetRemoteSeed}
                    disabled={resetSeedBusy || supabaseStatus.phase === 'loading'}
                    className="col-span-2 border-red-200 text-red-600"
                  >
                    {resetSeedBusy ? 'Resetting Seed...' : 'Reset Remote Data to Seed'}
                  </SecondaryButton>
                  {supabaseUser?.is_anonymous ? (
                    <p className="col-span-2 text-xs text-amber-700">
                      Guest reset affects the shared demo data for all guest users.
                    </p>
                  ) : null}
                </div>
              )}
            </Card>

            <div className="bg-gradient-to-r from-sky-400 to-blue-500 rounded-2xl p-4 text-white">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm opacity-90">7-Day Forecast</p>
                  <p className="text-2xl font-bold">
                    {weather.forecast?.[0]?.max ?? '--'}°F
                  </p>
                  <p className="text-xs opacity-75">
                    {weather.locationName}
                    {weatherLocationMode === 'auto' && weather.source === 'device' ? ' (Live)' : ''}
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  <select
                    value={weatherLocationMode}
                    onChange={(e) => setWeatherLocationMode(e.target.value)}
                    className="h-8 rounded-lg bg-white/20 border border-white/30 text-white text-xs px-2"
                    title="Weather location"
                  >
                    <option value="auto" className="text-gray-900">Auto Location</option>
                    <option value="madison" className="text-gray-900">Madison, AL</option>
                    <option value="huntsville" className="text-gray-900">Huntsville, AL</option>
                  </select>
                  <Sun className="w-12 h-12 opacity-90" />
                </div>
              </div>
              <div className="flex justify-between">
                {(weather.forecast ?? []).map((d) => (
                  <div key={d.date} className="text-center">
                    <p className="text-xs opacity-75">{d.label}</p>
                    <p className="text-[10px] opacity-75">{d.md}</p>
                    <d.icon className={`w-5 h-5 mx-auto my-1 ${d.rainChance > 50 ? 'text-yellow-200' : ''}`} />
                    <p className="text-xs font-medium">{d.max ?? '--'}°</p>
                    {d.rainChance > 50 ? <p className="text-xs text-yellow-200">☔ {d.rainChance}%</p> : null}
                  </div>
                ))}
              </div>

              {weatherLocationMode === 'auto' && weatherGeoRequested && !userWeatherLocation && communityWeatherLocation ? (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-xs opacity-90">Using community weather (device location unavailable).</p>
                  <button
                    type="button"
                    onClick={() => requestWeatherGeo(true)}
                    className="h-8 px-3 rounded-lg bg-white/20 border border-white/30 text-white text-xs font-semibold"
                    title="Retry device location"
                  >
                    Retry location
                  </button>
                </div>
              ) : null}
              {weatherWarnings.length > 0 ? (
                <div className="mt-3 bg-white/15 rounded-lg p-3">
                  <p className="text-sm font-semibold">⚠️ Weather Alerts</p>
                  <div className="space-y-2 mt-2">
                    {weatherWarnings.slice(0, 2).map((w) => (
                      <div key={`${w.type}-${w.date}`} className="text-sm">
                        <p className="font-semibold">
                          {formatShortDate(w.date)}: {w.message}
                        </p>
                        <p className="text-xs opacity-90">
                          {(w.affected ?? []).length} outdoor task(s) affected • {w.recommendation}
                        </p>
                        <div className="text-xs opacity-90 mt-1 space-y-0.5">
                          {(w.affected ?? []).slice(0, 3).map((a) => (
                            <p key={`${a.lot.id}-${a.task.id}`}>• {lotCode(a.lot)}: {a.task.name}</p>
                          ))}
                        </div>
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => {
                              setTab('calendar')
                              setCalendarView('day')
                              setCalendarDate(w.date)
                            }}
                            className="flex-1 h-10 rounded-xl bg-white/20 hover:bg-white/25 text-white text-sm font-semibold"
                          >
                            View Details
                          </button>
                          <button
                            onClick={() => {
                              const first = (w.affected ?? [])[0]
                              if (!first) return
                              const nextDay = formatISODate(addCalendarDays(w.date, 1))
                              setRescheduleModal({ lot_id: first.lot.id, task_id: first.task.id, initial_date: nextDay })
                              setTab('calendar')
                            }}
                            className="flex-1 h-10 rounded-xl bg-white text-blue-700 text-sm font-semibold"
                          >
                            Reschedule
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {(weather.loading || !isOnline) && (
                <div className="mt-3 bg-white/20 rounded-lg p-2 text-sm">
                  <AlertTriangle className="w-4 h-4 inline mr-1" />
                  {weather.loading ? 'Loading weather...' : 'Offline — weather paused'}
                </div>
              )}
            </div>

            <div className="grid grid-cols-4 gap-2">
              <button
                type="button"
                onClick={() => setDashboardStatusModal('active')}
                className="bg-white rounded-xl p-3 border text-center hover:border-blue-300 hover:bg-blue-50/40"
              >
                <p className="text-xl font-bold text-blue-600">{dashboardStatusLots.active.length}</p>
                <p className="text-xs text-gray-500">Active</p>
              </button>
              <button
                type="button"
                onClick={() => setDashboardStatusModal('on_track')}
                className="bg-white rounded-xl p-3 border text-center hover:border-green-300 hover:bg-green-50/40"
              >
                <p className="text-xl font-bold text-green-600">{dashboardStatusLots.on_track.length}</p>
                <p className="text-xs text-gray-500">On Track</p>
              </button>
              <button
                type="button"
                onClick={() => setDashboardStatusModal('delayed')}
                className="bg-white rounded-xl p-3 border text-center hover:border-red-300 hover:bg-red-50/40"
              >
                <p className="text-xl font-bold text-red-600">{dashboardStatusLots.delayed.length}</p>
                <p className="text-xs text-gray-500">Delayed</p>
              </button>
              <div className="bg-white rounded-xl p-3 border text-center">
                <p className="text-xl font-bold text-purple-600">
                  {activeLots.length === 0
                    ? 0
                    : Math.round(activeLots.reduce((acc, l) => acc + calculateLotProgress(l), 0) / activeLots.length)}
                  %
                </p>
                <p className="text-xs text-gray-500">Avg Done</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={openCreateCommunity}
                className="bg-blue-600 text-white rounded-xl p-4 flex flex-col items-center gap-2"
              >
                <Plus className="w-6 h-6" />
                <span className="text-sm font-medium">New Community</span>
              </button>
              <button
                onClick={() => openStartLot(null)}
                className="bg-green-600 text-white rounded-xl p-4 flex flex-col items-center gap-2 disabled:opacity-50"
                disabled={!isOnline}
                title={!isOnline ? 'Requires connection to generate schedules' : ''}
              >
                <Play className="w-6 h-6" />
                <span className="text-sm font-medium">Start Lot</span>
              </button>
            </div>

            <Card>
              <h3 className="font-semibold mb-3">On Site Today</h3>
              {todaysAssignments.length === 0 ? (
                <p className="text-sm text-gray-500">No active assignments today.</p>
              ) : (
                <div className="space-y-2">
                  {todaysAssignments.slice(0, 6).map(({ lot, task, status, sub }) => (
                    <button
                      key={`${lot.id}-${task.id}`}
                      onClick={() => setOnSiteLotModal({ lot_id: lot.id, task_id: task.id })}
                      className="w-full bg-gray-50 rounded-xl p-3 text-left"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-gray-900">{sub?.company_name ?? 'Unassigned'}</p>
                          <p className="text-[11px] text-gray-500 mt-1">{communitiesById.get(lot.community_id)?.name ?? 'Community'} | {lotCode(lot)}</p>
                          <p className="text-xs text-gray-600">{task.name}</p>
                        </div>
                        <TaskStatusBadge status={status} />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold">Active Lots</h3>
                <button onClick={resetDemo} className="text-xs text-blue-600">
                  Reset demo
                </button>
              </div>
              {activeLots.length === 0 ? (
                <p className="text-sm text-gray-500">No active lots yet.</p>
              ) : (
                <div className="space-y-2">
                  {activeLots.slice(0, 6).map((lot) => {
                    const community = communitiesById.get(lot.community_id)
                    const pct = calculateLotProgress(lot)
                    const milestone = getCurrentMilestone(lot)
                    const delayed = lotHasDelay(lot)
                    return (
                      <button
                        key={lot.id}
                        onClick={() => {
                          setSelectedCommunityId(lot.community_id)
                          openLot(lot.id)
                        }}
                        className="w-full bg-gray-50 rounded-xl p-3 text-left"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">
                              {community?.name ?? 'Community'} {lotCode(lot)}
                            </span>
                            {delayed ? <AlertTriangle className="w-4 h-4 text-red-500" /> : null}
                          </div>
                          <span className="text-sm font-bold text-blue-600">{pct}%</span>
                        </div>
                        <div className="mt-2 h-2 bg-gray-200 rounded-full overflow-hidden">
                          <div className="h-full bg-green-500" style={{ width: `${pct}%` }} />
                        </div>
                        <MilestoneDots lot={lot} />
                        <p className="mt-2 text-xs text-gray-600">Milestone: {milestone.label}</p>
                      </button>
                    )
                  })}
                </div>
              )}
            </Card>
            <Card>
              <h3 className="font-semibold mb-3">Critical Deadlines</h3>
              {criticalDeadlines.length === 0 ? (
                <p className="text-sm text-gray-500">No critical deadlines.</p>
              ) : (
                <div className="space-y-2">
                  {criticalDeadlines.slice(0, 5).map(({ lot, community, daysRemaining }) => (
                    <button
                      key={lot.id}
                      onClick={() => openLot(lot.id)}
                      className={`w-full p-3 rounded-xl text-left ${
                        daysRemaining <= 7 ? 'bg-red-50' : daysRemaining <= 14 ? 'bg-yellow-50' : 'bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{community?.name ?? ''} • {lotCode(lot)}</span>
                        <span className={`text-xs font-bold ${
                          daysRemaining <= 7 ? 'text-red-600' : daysRemaining <= 14 ? 'text-yellow-600' : 'text-gray-600'
                        }`}>
                          {daysRemaining} days
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        Target: {formatShortDate(lot.hard_deadline || lot.target_completion_date)}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </Card>
            <Card>
              <h3 className="font-semibold mb-3">Upcoming Inspections</h3>
              {upcomingInspections.length === 0 ? (
                <p className="text-sm text-gray-500">None scheduled currently.</p>
              ) : (
                <div className="space-y-2">
                  {upcomingInspections.slice(0, 5).map(({ lot, community, inspection, task }) => {
                    const label = INSPECTION_TYPES.find((t) => t.code === inspection.type)?.label ?? inspection.type
                    return (
                      <button
                        key={inspection.id}
                        onClick={() => setInspectionsLotId(lot.id)}
                        className="w-full p-3 rounded-xl text-left bg-gray-50"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{community?.name ?? ''} • {lotCode(lot)}</span>
                          <span className="text-xs text-gray-600">{inspection.scheduled_time ?? ''}</span>
                        </div>
                        <p className="text-xs text-gray-600 mt-1">
                          {label}{task?.name ? ` • ${task.name}` : ''}
                        </p>
                        <p className="text-xs text-gray-500 mt-1">
                          {formatShortDateWithWeekday(inspection.scheduled_date)}
                        </p>
                      </button>
                    )
                  })}
                </div>
              )}
            </Card>

            <Card>
              <h3 className="font-semibold mb-3">At a Glance</h3>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setTab('calendar')
                    setCalendarView('day')
                    setCalendarDate(todayIso)
                  }}
                  className="p-4 bg-blue-50 rounded-xl text-center hover:bg-blue-100"
                >
                  <p className="text-2xl font-bold text-blue-600">{todaysTasks.length}</p>
                  <p className="text-xs text-gray-600">Tasks Today</p>
                </button>
                <button
                  type="button"
                  onClick={() => setAtGlanceModal('on_site_today')}
                  className="p-4 bg-orange-50 rounded-xl text-center hover:bg-orange-100"
                >
                  <p className="text-2xl font-bold text-orange-600">{todaysAssignments.length}</p>
                  <p className="text-xs text-gray-600">On Site Today</p>
                </button>
                <button
                  type="button"
                  onClick={() => setAtGlanceModal('critical_deadlines')}
                  className="p-4 bg-red-50 rounded-xl text-center hover:bg-red-100"
                >
                  <p className="text-2xl font-bold text-red-600">{criticalDeadlines.length}</p>
                  <p className="text-xs text-gray-600">Critical Deadlines</p>
                </button>
                <button
                  type="button"
                  onClick={() => setAtGlanceModal('open_punch')}
                  className="p-4 bg-purple-50 rounded-xl text-center hover:bg-purple-100"
                >
                  <p className="text-2xl font-bold text-purple-600">{openPunchItems}</p>
                  <p className="text-xs text-gray-600">Open Punch Items</p>
                </button>
              </div>
            </Card>
          </div>
        )}

        {tab === 'calendar' && !selectedLot && !selectedCommunity && (
          <div className="space-y-4">
            <Card className="space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-gray-500">
                    {calendarView === 'day'
                      ? 'Day'
                      : calendarView === 'week'
                        ? 'Week'
                        : calendarView === 'week_timeline'
                          ? 'Week Timeline'
                        : calendarView === 'month'
                          ? 'Month'
                          : 'By Sub'}
                  </p>
                  <p className="font-bold text-lg">
                    {calendarView === 'day'
                      ? formatLongDate(calendarDate)
                      : calendarView === 'week'
                        ? `${formatShortDate(weekDates[0])} – ${formatShortDate(weekDates[6])}`
                        : calendarView === 'week_timeline'
                        ? `${formatShortDate(weekDates[0])} – ${formatShortDate(weekDates[6])}`
                        : calendarView === 'month'
                          ? (parseISODate(calendarDate) ?? new Date()).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                          : `${formatShortDate(weekDates[0])} – ${formatShortDate(weekDates[6])}`}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-gray-500">
                    {weather.locationName}
                  </p>
                  {calendarView === 'day' ? (
                    <p className="text-sm font-semibold">
                      {(weatherByIso.get(calendarDate)?.max ?? weather.forecast?.[0]?.max ?? '--')}° /{' '}
                      {(weatherByIso.get(calendarDate)?.min ?? weather.forecast?.[0]?.min ?? '--')}°
                    </p>
                  ) : null}
                </div>
              </div>

                <div className="grid grid-cols-3 gap-2">
                  <select value={calendarView} onChange={(e) => setCalendarView(e.target.value)} className="px-3 py-3 border rounded-xl text-sm">
                    <option value="day">Day</option>
                    <option value="week">Week</option>
                    <option value="week_timeline">Week Timeline</option>
                    <option value="month">Month</option>
                    <option value="sub">By Sub</option>
                  </select>
                  <button
                    onClick={() => {
                      const base = parseISODate(calendarDate)
                      if (!base) return
                      if (calendarView === 'day') setCalendarDate(formatISODate(addCalendarDays(base, -1)))
                      else if (calendarView === 'week' || calendarView === 'week_timeline' || calendarView === 'sub') setCalendarDate(formatISODate(addCalendarDays(base, -7)))
                      else {
                        const prevMonth = new Date(base.getFullYear(), base.getMonth() - 1, 1)
                        setCalendarDate(formatISODate(prevMonth))
                      }
                    }}
                  className="px-3 py-3 border rounded-xl text-sm font-semibold bg-white"
                >
                  Prev
                </button>
                  <button
                    onClick={() => {
                      const base = parseISODate(calendarDate)
                      if (!base) return
                      if (calendarView === 'day') setCalendarDate(formatISODate(addCalendarDays(base, 1)))
                      else if (calendarView === 'week' || calendarView === 'week_timeline' || calendarView === 'sub') setCalendarDate(formatISODate(addCalendarDays(base, 7)))
                      else {
                        const nextMonth = new Date(base.getFullYear(), base.getMonth() + 1, 1)
                        setCalendarDate(formatISODate(nextMonth))
                      }
                    }}
                  className="px-3 py-3 border rounded-xl text-sm font-semibold bg-white"
                >
                  Next
                </button>
              </div>

              {calendarView === 'day' ? (
                <input
                  type="date"
                  value={calendarDate}
                  onChange={(e) => setCalendarDate(e.target.value)}
                  className="w-full px-3 py-3 border rounded-xl"
                />
              ) : null}
            </Card>

            <Card>
              <p className="font-semibold mb-2">Filters</p>
              <div className="grid grid-cols-3 gap-2">
                <select
                  value={calendarFilters.communityId}
                  onChange={(e) => setCalendarFilters((p) => ({ ...p, communityId: e.target.value }))}
                  className="px-3 py-3 border rounded-xl text-sm"
                >
                  <option value="all">All Communities</option>
                  {app.communities.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  value={calendarFilters.trade}
                  onChange={(e) => setCalendarFilters((p) => ({ ...p, trade: e.target.value }))}
                  className="px-3 py-3 border rounded-xl text-sm"
                >
                  <option value="all">All Trades</option>
                  {TRADES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <select
                  value={calendarFilters.subId}
                  onChange={(e) => setCalendarFilters((p) => ({ ...p, subId: e.target.value }))}
                  className="px-3 py-3 border rounded-xl text-sm"
                >
                  <option value="all">All Subs</option>
                  {app.subcontractors.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.company_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={calendarFilters.showDelayed}
                    onChange={(e) => setCalendarFilters((p) => ({ ...p, showDelayed: e.target.checked }))}
                  />
                  Delayed
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={calendarFilters.showMilestones}
                    onChange={(e) => setCalendarFilters((p) => ({ ...p, showMilestones: e.target.checked }))}
                  />
                  Milestones
                </label>
              </div>
            </Card>

            {calendarView === 'day' && (() => {
              const assignments = calendarAssignmentsForDate(calendarDate)
              return (
                <>
                  <Card>
                    <h3 className="font-semibold mb-3">On Site</h3>
                    {assignments.length === 0 ? (
                      <p className="text-sm text-gray-500">No assignments.</p>
                    ) : (
                      <div className="space-y-2">
                        {assignments.map(({ lot, task, sub, status }) => (
                          <button
                            key={`${lot.id}-${task.id}`}
                            onClick={() => setOnSiteLotModal({ lot_id: lot.id, task_id: task.id })}
                            className="w-full bg-gray-50 rounded-xl p-3 text-left"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="font-semibold">{sub?.company_name ?? 'Unassigned'}</p>
                                <p className="text-[11px] text-gray-500 mt-1">{communitiesById.get(lot.community_id)?.name ?? 'Community'} | {lotCode(lot)}</p>
                                <p className="text-xs text-gray-600">{task.name}</p>
                                {sub?.primary_contact?.phone ? (
                                  <a
                                    href={`tel:${sub.primary_contact.phone}`}
                                    className="text-xs text-blue-600 inline-flex items-center gap-1 mt-1"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <Phone className="w-3 h-3" />
                                    {sub.primary_contact.phone}
                                  </a>
                                ) : null}
                              </div>
                              <TaskStatusBadge status={status} />
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </Card>                </>
              )
            })()}

            {calendarView === 'week_timeline' && (
              <Card>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-semibold">Week Timeline</p>
                    <p className="text-xs text-gray-500">
                      {formatShortDate(weekDates[0])} – {formatShortDate(weekDates[6])}
                    </p>
                    <p className="text-[11px] text-gray-500">Drag tasks to reschedule within the week.</p>
                  </div>
                  <p className="text-xs text-gray-500">{weekTimelineRows.length} active lot(s)</p>
                </div>
                <div className="overflow-x-auto border rounded-xl">
                  <div style={{ minWidth: '760px' }}>
                    <div className="flex border-b bg-gray-50 sticky top-0">
                      <div className="w-44 shrink-0 p-3 font-semibold border-r">Lot</div>
                      <div className="flex-1 flex">
                        {weekDates.map((iso) => (
                          <div key={iso} className="flex-1 p-2 text-center text-xs font-medium border-r last:border-r-0">
                            <div className="text-[10px] uppercase text-gray-500">
                              {parseISODate(iso)?.toLocaleDateString('en-US', { weekday: 'short' })}
                            </div>
                            <div className="text-xs font-semibold">{formatShortDate(iso)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    {weekTimelineRows.length === 0 ? (
                      <div className="p-4 text-sm text-gray-500">No scheduled tasks this week.</div>
                    ) : (
                      weekTimelineRows.map((row) => {
                        const lineHeight = 22
                        const padding = 6
                        const rowHeight = Math.max(1, row.tasks.length) * lineHeight + padding * 2
                        const drop = calendarDropTarget?.date ? calendarDropTarget : null
                        const dropCls =
                          drop?.status === 'invalid'
                            ? 'bg-red-100/60'
                            : drop?.status === 'valid'
                              ? 'bg-green-100/70'
                              : ''
                        return (
                          <div key={row.lot.id} className="flex border-b">
                            <div className="w-44 shrink-0 p-2 border-r">
                              <p className="text-sm font-semibold">{lotCode(row.lot)}</p>
                              <p className="text-xs text-gray-500">{row.community?.name ?? ''}</p>
                            </div>
                            <div
                              className="flex-1 relative"
                              style={{ height: rowHeight }}
                              onDragOver={(e) => {
                                if (!draggingCalendarTask) return
                                e.preventDefault()
                                const rect = e.currentTarget.getBoundingClientRect()
                                const ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0
                                const index = Math.max(0, Math.min(6, Math.floor(ratio * 7)))
                                const iso = weekDates[index]
                                if (!iso) return
                                const lot = lotsById.get(draggingCalendarTask.lot_id) ?? null
                                const task = lot?.tasks?.find((t) => t.id === draggingCalendarTask.task_id) ?? null
                                if (!lot || !task) return
                                const status = getCalendarDropStatus({ lot, task, targetDateIso: iso })
                                if (calendarDropTarget?.date === iso && calendarDropTarget?.status === status.status) return
                                setCalendarDropTarget({ date: iso, ...status })
                              }}
                              onDragLeave={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget)) setCalendarDropTarget(null)
                              }}
                              onDrop={(e) => {
                                if (!draggingCalendarTask) return
                                e.preventDefault()
                                const rect = e.currentTarget.getBoundingClientRect()
                                const ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0
                                const index = Math.max(0, Math.min(6, Math.floor(ratio * 7)))
                                const iso = weekDates[index]
                                if (!iso) return
                                const lot = lotsById.get(draggingCalendarTask.lot_id) ?? null
                                const task = lot?.tasks?.find((t) => t.id === draggingCalendarTask.task_id) ?? null
                                if (!lot || !task) return
                                const status = getCalendarDropStatus({ lot, task, targetDateIso: iso })
                                if (status.status === 'invalid') {
                                  setCalendarDropTarget(null)
                                  setDraggingCalendarTask(null)
                                  return
                                }
                                setRescheduleModal({ lot_id: lot.id, task_id: task.id, initial_date: status.normalized })
                                setCalendarDropTarget(null)
                                setDraggingCalendarTask(null)
                              }}
                            >
                              {weekDates.map((iso, i) => (
                                <div
                                  key={iso}
                                  className={`absolute top-0 bottom-0 ${drop?.date === iso ? dropCls : ''} pointer-events-none`}
                                  style={{ left: `${(i / 7) * 100}%`, width: `${100 / 7}%` }}
                                />
                              ))}
                              {weekDates.map((_, i) => (
                                <div
                                  key={i}
                                  className="absolute top-0 bottom-0 border-r border-gray-100"
                                  style={{ left: `${((i + 1) / 7) * 100}%` }}
                                />
                              ))}
                              {row.tasks.map((entry, idx) => {
                                const top = padding + idx * lineHeight
                                return (
                                  <button
                                    key={entry.id}
                                    type="button"
                                    onClick={() => setTaskModal({ lot_id: row.lot.id, task_id: entry.task.id })}
                                    draggable
                                    onDragStart={(e) => {
                                      e.dataTransfer.setData('text/plain', `${row.lot.id}:${entry.task.id}`)
                                      e.dataTransfer.effectAllowed = 'move'
                                      setDraggingCalendarTask({ lot_id: row.lot.id, task_id: entry.task.id })
                                    }}
                                    onDragEnd={() => {
                                      setDraggingCalendarTask(null)
                                      setCalendarDropTarget(null)
                                    }}
                                    className="absolute h-5 rounded-md px-2 text-[10px] text-white font-semibold truncate shadow-sm"
                                    style={{
                                      top,
                                      left: `${entry.leftPercent}%`,
                                      width: `${Math.max(entry.widthPercent, 3)}%`,
                                      backgroundColor: TASK_STATUS_COLORS[entry.status] || TASK_STATUS_COLORS.pending,
                                    }}
                                    title={`Drag to reschedule\n${entry.task.name}\n${formatShortDate(entry.startIso)} - ${formatShortDate(entry.endIso)}\n${entry.sub?.company_name ?? 'Unassigned'}`}
                                  >
                                    {entry.task.name}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              </Card>
            )}

            {(calendarView === 'week' || calendarView === 'sub') && (
              <Card>
                <h3 className="font-semibold mb-3">{calendarView === 'sub' ? 'Sub Schedule' : 'Week Schedule'}</h3>
                {calendarView === 'sub' ? (
                  <select
                    value={calendarFilters.subId}
                    onChange={(e) => setCalendarFilters((p) => ({ ...p, subId: e.target.value }))}
                    className="mb-3 w-full px-3 py-3 border rounded-xl text-sm"
                  >
                    <option value="all">Select a sub…</option>
                    {app.subcontractors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.company_name}
                      </option>
                    ))}
                  </select>
                ) : null}

                <div className="space-y-4">
                  {weekDates.map((iso) => {
                    const assignments = calendarAssignmentsForDate(iso)
                    if (calendarView === 'sub' && calendarFilters.subId === 'all') return null
                    const drop = calendarDropTarget?.date === iso ? calendarDropTarget : null
                    const dropCls =
                      drop?.status === 'invalid'
                        ? 'bg-red-50 border-red-200'
                        : drop?.status === 'valid'
                          ? 'bg-green-50 border-green-200'
                          : 'bg-transparent border-transparent'
                    return (
                      <div
                        key={iso}
                        className={`rounded-xl border p-2 ${dropCls}`}
                        onDragOver={(e) => {
                          if (!draggingCalendarTask) return
                          e.preventDefault()
                          const lot = lotsById.get(draggingCalendarTask.lot_id) ?? null
                          const task = lot?.tasks?.find((t) => t.id === draggingCalendarTask.task_id) ?? null
                          if (!lot || !task) return
                          const status = getCalendarDropStatus({ lot, task, targetDateIso: iso })
                          setCalendarDropTarget({ date: iso, ...status })
                        }}
                        onDragLeave={() => {
                          if (calendarDropTarget?.date === iso) setCalendarDropTarget(null)
                        }}
                        onDrop={(e) => {
                          if (!draggingCalendarTask) return
                          e.preventDefault()
                          const lot = lotsById.get(draggingCalendarTask.lot_id) ?? null
                          const task = lot?.tasks?.find((t) => t.id === draggingCalendarTask.task_id) ?? null
                          if (!lot || !task) return
                          const status = getCalendarDropStatus({ lot, task, targetDateIso: iso })
                          if (status.status === 'invalid') {
                            setCalendarDropTarget(null)
                            setDraggingCalendarTask(null)
                            return
                          }
                          setRescheduleModal({ lot_id: lot.id, task_id: task.id, initial_date: status.normalized })
                          setCalendarDropTarget(null)
                          setDraggingCalendarTask(null)
                        }}
                      >
                        <p className="text-sm font-semibold text-gray-800 mb-2">{formatLongDate(iso)}</p>
                        {assignments.length === 0 ? (
                          <p className="text-sm text-gray-500">No scheduled work.</p>
                        ) : (
                          <div className="space-y-2">
                            {assignments.map(({ lot, task, sub, status }) => (
                              <button
                                key={`${lot.id}-${task.id}`}
                                onClick={() => setOnSiteLotModal({ lot_id: lot.id, task_id: task.id })}
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.setData('text/plain', `${lot.id}:${task.id}`)
                                  e.dataTransfer.effectAllowed = 'move'
                                  setDraggingCalendarTask({ lot_id: lot.id, task_id: task.id })
                                }}
                                onDragEnd={() => {
                                  setDraggingCalendarTask(null)
                                  setCalendarDropTarget(null)
                                }}
                                className="w-full bg-gray-50 rounded-xl border border-gray-200 p-3 text-left"
                                title="Drag to reschedule"
                              >
                                <div className="flex items-center justify-between">
                                  <div>
                                    <p className="font-semibold">{sub?.company_name ?? 'Unassigned'}</p>
                                    <p className="text-[11px] text-gray-500 mt-1">{communitiesById.get(lot.community_id)?.name ?? 'Community'} | {lotCode(lot)}</p>
                                    <p className="text-xs text-gray-600">{task.name}</p>
                                  </div>
                                  <TaskStatusBadge status={status} />
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </Card>
            )}

            {calendarView === 'month' && (
              <Card>
                <h3 className="font-semibold mb-3">Month Overview</h3>
                <div className="grid grid-cols-7 gap-2 text-xs text-gray-500 mb-2">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                    <div key={d} className="text-center">
                      {d}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-2">
                  {monthGrid.cells.map(({ iso, offset }) => {
                    const d = parseISODate(iso)
                    const inMonth = d ? d.getMonth() === (parseISODate(monthGrid.monthStartIso)?.getMonth() ?? d.getMonth()) : false
                    const assignments = calendarAssignmentsForDate(iso)
                    const workCount = assignments.length
                    const totalCount = workCount
                    const previewTasks = assignments.slice(0, 2)
                    const hasActivity = totalCount > 0
                    return (
                      <button
                        key={iso}
                        onClick={() => {
                          setCalendarDate(iso)
                          setCalendarView('day')
                        }}
                        className={`aspect-square rounded-xl border text-left p-2 overflow-hidden ${
                          inMonth
                            ? hasActivity
                              ? 'bg-blue-50/40 border-blue-200'
                              : 'bg-white border-gray-200'
                            : 'bg-gray-50 border-gray-100 text-gray-400'
                        }`}
                        title={offset === 0 ? 'Month start' : ''}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold">{d ? d.getDate() : ''}</span>
                          {hasActivity ? (
                            <span className="text-[10px] font-semibold text-blue-700 bg-white border border-blue-100 rounded-full px-1.5 py-0.5">
                              {totalCount}
                            </span>
                          ) : null}
                        </div>
                        {hasActivity ? (
                          <div className="mt-2 space-y-1">
                            {previewTasks.map(({ lot, task, status }) => (
                              <div key={`${lot.id}-${task.id}`} className="flex items-center gap-1 text-[10px] text-gray-700">
                                <span
                                  className="w-1.5 h-1.5 rounded-full"
                                  style={{ backgroundColor: TASK_STATUS_COLORS[status] || '#3B82F6' }}
                                />
                                <span className="truncate">{lotCode(lot)} • {task.name}</span>
                              </div>
                            ))}                            {workCount > previewTasks.length ? (
                              <p className="text-[10px] text-gray-500">+{workCount - previewTasks.length} more</p>
                            ) : null}
                          </div>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </Card>
            )}
          </div>
        )}

        {tab === 'communities' && !selectedCommunity && !selectedLot && (
          <div className="space-y-4">
            <button
              onClick={openCreateCommunity}
              className="w-full bg-blue-600 text-white rounded-xl p-4 flex items-center justify-center gap-2"
            >
              <Plus className="w-5 h-5" /> New Community
            </button>

            {app.communities.map((c) => {
              const lots = app.lots.filter((l) => l.community_id === c.id)
              const complete = lots.filter((l) => l.status === 'complete').length
              const active = lots.filter((l) => l.status === 'in_progress').length
              const pct = lots.length === 0 ? 0 : Math.round((complete / lots.length) * 100)
              const blockCount = c.blocks?.length ?? 0
              const lotCount = c.lot_count ?? lots.length

              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedCommunityId(c.id)}
                  className="w-full bg-white rounded-xl border p-4 text-left"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-lg">🏘️ {c.name}</h3>
                    <span className="text-sm font-bold text-blue-600">{pct}%</span>
                  </div>
                  <p className="text-sm text-gray-500">
                    {blockCount ? `${blockCount} blocks • ` : ''}
                    {lotCount} lots
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {active} active • {complete} complete • {lots.length - active - complete} not started
                  </p>
                </button>
              )
            })}
          </div>
        )}

        {selectedCommunity && !selectedLot && tab === 'communities' && (
          <div className="space-y-4">
            <Card>
              <h2 className="font-bold text-lg">{selectedCommunity.name}</h2>
              <p className="text-sm text-gray-600">
                {selectedCommunity.address?.street ? `${selectedCommunity.address.street}, ` : ''}
                {selectedCommunity.address?.city ?? ''} {selectedCommunity.address?.state ?? ''}{' '}
                {selectedCommunity.address?.zip ?? ''}
              </p>
              <p className="text-xs text-gray-500 mt-2">
                Product Types:{' '}
                {(selectedCommunity.product_type_ids ?? [])
                  .map((id) => productTypes.find((p) => p.id === id)?.name ?? id)
                  .join(', ') || '—'}
              </p>
            </Card>

            <Card>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold">Lots</h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => setLotViewMode('grid')}
                    className={`px-3 py-1 rounded-lg text-sm border ${lotViewMode === 'grid' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-700'}`}
                  >
                    Grid
                  </button>
                  <button
                    onClick={() => setLotViewMode('list')}
                    className={`px-3 py-1 rounded-lg text-sm border ${lotViewMode === 'list' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-700'}`}
                  >
                    List
                  </button>
                  <button
                    onClick={() => setLotViewMode('kanban')}
                    className={`px-3 py-1 rounded-lg text-sm border ${lotViewMode === 'kanban' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-700'}`}
                  >
                    Kanban
                  </button>
                </div>
              </div>

              {lotViewMode === 'grid' && (
                <div className="space-y-4">
                  {selectedCommunityBuilders.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedCommunityBuilders.map((b) => (
                        <span key={b.id} className="inline-flex items-center gap-2 text-xs text-gray-700">
                          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: b.color || '#CBD5F5' }} />
                          {b.name || 'Builder'}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {(selectedCommunity.blocks ?? []).length > 0 ? (
                    (selectedCommunity.blocks ?? []).map((b) => {
                      const lots = app.lots
                        .filter((l) => l.community_id === selectedCommunity.id && l.block === b.label)
                        .slice()
                        .sort(compareCommunityLots)
                      return (
                        <div key={b.id}>
                          <p className="text-sm font-semibold text-gray-700 mb-2">Block {b.label}</p>
                          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                            {lots.map((lot) => {
                              const status =
                                lot.status === 'complete'
                                  ? '✅'
                                  : lot.status === 'in_progress'
                                    ? lotHasDelay(lot)
                                      ? '🟡'
                                      : '🔵'
                                    : '⚪'
                              const builder = selectedCommunityBuilderById.get(lot.builder_id)
                              const builderColor = builder?.color ?? ''
                              const style = builderColor
                                ? { backgroundColor: tintHex(builderColor), borderColor: builderColor }
                                : undefined
                              const productLabel = productTypesById.get(lot.product_type_id)?.name ?? 'Product'
                              return (
                                <button
                                  key={lot.id}
                                  onClick={() => openLot(lot.id)}
                                  className={`rounded-xl border p-2 text-center ${builderColor ? 'border-2' : 'border-gray-200 bg-gray-50'}`}
                                  style={style}
                                >
                                  <p className="text-sm font-semibold">{lot.lot_number}</p>
                                  <div className="mt-1">
                                    <span className="inline-block max-w-full px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/80 text-gray-700 border border-white/60 truncate">
                                      {productLabel}
                                    </span>
                                  </div>
                                  <p className="text-xs mt-1">{status}</p>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                      {app.lots
                        .filter((l) => l.community_id === selectedCommunity.id)
                        .slice()
                        .sort(compareCommunityLots)
                        .map((lot) => {
                          const status =
                            lot.status === 'complete'
                              ? '✅'
                              : lot.status === 'in_progress'
                                ? lotHasDelay(lot)
                                  ? '🟡'
                                  : '🔵'
                                : '⚪'
                          const builder = selectedCommunityBuilderById.get(lot.builder_id)
                          const builderColor = builder?.color ?? ''
                          const style = builderColor
                            ? { backgroundColor: tintHex(builderColor), borderColor: builderColor }
                            : undefined
                          const productLabel = productTypesById.get(lot.product_type_id)?.name ?? 'Product'
                          return (
                            <button
                              key={lot.id}
                              onClick={() => openLot(lot.id)}
                              className={`rounded-xl border p-2 text-center ${builderColor ? 'border-2' : 'border-gray-200 bg-gray-50'}`}
                              style={style}
                            >
                              <p className="text-sm font-semibold">{lot.lot_number}</p>
                              <div className="mt-1">
                                <span className="inline-block max-w-full px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/80 text-gray-700 border border-white/60 truncate">
                                  {productLabel}
                                </span>
                              </div>
                              <p className="text-xs mt-1">{status}</p>
                            </button>
                          )
                        })}
                    </div>
                  )}
                </div>
              )}

              {lotViewMode === 'list' && (
                <div className="space-y-2">
                  {app.lots
                    .filter((l) => l.community_id === selectedCommunity.id)
                    .slice()
                    .sort(compareCommunityLots)
                    .map((lot) => {
                      const pct = lot.status === 'not_started' ? 0 : calculateLotProgress(lot)
                      const statusLabel =
                        lot.status === 'complete'
                          ? '✅ Complete'
                          : lot.status === 'in_progress'
                            ? lotHasDelay(lot)
                              ? '🟡 Delayed'
                              : '🔵 On Track'
                            : '⚪ Not Started'
                      const elapsed = lot.status === 'in_progress' ? daysElapsed(lot) : null
                      const productLabel = productTypesById.get(lot.product_type_id)?.name ?? 'Product'
                      return (
                        <button
                          key={lot.id}
                          onClick={() => openLot(lot.id)}
                          className="w-full bg-gray-50 rounded-xl p-3 text-left"
                        >
                          <div className="flex items-center justify-between">
                            <p className="font-semibold">
                              {lotCode(lot)} {lot.model_type ? `• ${lot.model_type}` : ''}
                            </p>
                            <p className="text-sm font-bold text-blue-600">{pct}%</p>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white text-gray-700 border border-gray-200">
                              {productLabel}
                            </span>
                            <span className="text-xs text-gray-600">
                              {statusLabel} • Days: {elapsed ?? '--'} • ETA: {lotEta(lot)}
                            </span>
                          </div>
                        </button>
                      )
                    })}
                </div>
              )}

            {lotViewMode === 'kanban' && (
                <div className="grid grid-cols-1 gap-3">
                  {[
                    { key: 'not_started', title: 'Not Started' },
                    { key: 'in_progress', title: 'In Progress' },
                    { key: 'complete', title: 'Complete' },
                  ].map((col) => {
                    const lots = app.lots
                      .filter((l) => l.community_id === selectedCommunity.id && l.status === col.key)
                      .slice()
                      .sort(compareCommunityLots)
                    return (
                      <div key={col.key} className="bg-gray-50 rounded-xl border border-gray-200 p-3">
                        <p className="font-semibold text-gray-800 mb-2">
                          {col.title} <span className="text-gray-500">({lots.length})</span>
                        </p>
                        <div className="space-y-2">
                          {lots.slice(0, 6).map((lot) => (
                            <button
                              key={lot.id}
                              onClick={() => openLot(lot.id)}
                              className="w-full bg-white rounded-xl border border-gray-200 p-3 text-left"
                            >
                              <p className="font-semibold">{lotCode(lot)}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-50 text-gray-700 border border-gray-200">
                                  {productTypesById.get(lot.product_type_id)?.name ?? 'Product'}
                                </span>
                                <span className="text-xs text-gray-600">{lot.model_type || '—'}</span>
                              </div>
                            </button>
                          ))}
                          {lots.length > 6 ? <p className="text-xs text-gray-500">+ {lots.length - 6} more</p> : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>

            <Card>
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold">Documents</h3>
                <button
                  onClick={() => setCommunityDocsCommunityId(selectedCommunity.id)}
                  className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
                >
                  View
                </button>
              </div>
              {(() => {
                const plat = (selectedCommunity.documents ?? [])
                  .filter((d) => d.type === 'plat_map')
                  .slice()
                  .sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)))[0]
                return (
                  <p className="text-sm text-gray-600">
                    Plat map: <span className="font-semibold">{plat ? 'Uploaded' : 'Not uploaded'}</span>
                  </p>
                )
              })()}
            </Card>

            <Card>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold">Community Contacts</h3>
                <button
                  onClick={() => setCommunityContactsModalId(selectedCommunity.id)}
                  className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
                >
                  Edit
                </button>
              </div>
              <div className="space-y-3 text-sm">
                <div>
                  <p className="text-xs text-gray-500 mb-1">Builders</p>
                  {selectedCommunityBuilders.length === 0 ? (
                    <p className="text-gray-600">None assigned.</p>
                  ) : (
                    <div className="space-y-1">
                      {selectedCommunityBuilders.map((b) => (
                        <div key={b.id} className="flex items-center justify-between">
                          <span className="inline-flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: b.color || '#CBD5F5' }} />
                            {b.name || 'Builder'}
                          </span>
                          {b.phone ? (
                            <a href={`tel:${b.phone}`} className="text-blue-600 inline-flex items-center gap-1">
                              <Phone className="w-3 h-3" />
                              {b.phone}
                            </a>
                          ) : (
                            <span className="text-gray-500">—</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-xs text-gray-500 mb-1">Realtors</p>
                  {selectedCommunityRealtors.length === 0 ? (
                    <p className="text-gray-600">None added.</p>
                  ) : (
                    <div className="space-y-1">
                      {selectedCommunityRealtors.map((r) => (
                        <div key={r.id} className="flex items-center justify-between">
                          <span>{r.name || 'Realtor'}{r.company ? ` • ${r.company}` : ''}</span>
                          {r.phone ? (
                            <a href={`tel:${r.phone}`} className="text-blue-600 inline-flex items-center gap-1">
                              <Phone className="w-3 h-3" />
                              {r.phone}
                            </a>
                          ) : (
                            <span className="text-gray-500">—</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-xs text-gray-500 mb-1">Inspectors</p>
                  {selectedCommunityInspectors.length === 0 ? (
                    <p className="text-gray-600">None added.</p>
                  ) : (
                    <div className="space-y-1">
                      {selectedCommunityInspectors.map((i) => {
                        const agency = [...agencies, ...(selectedCommunity.agencies ?? [])].find((a) => a.id === i.agency_id)
                        return (
                          <div key={i.id} className="flex items-center justify-between">
                            <span>{i.name || 'Inspector'}{agency?.name ? ` • ${agency.name}` : ''}</span>
                            {i.phone ? (
                              <a href={`tel:${i.phone}`} className="text-blue-600 inline-flex items-center gap-1">
                                <Phone className="w-3 h-3" />
                                {i.phone}
                              </a>
                            ) : (
                              <span className="text-gray-500">—</span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </Card>

            <Card>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold">Community Specs</h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSpecBulkModal({ community_id: selectedCommunity.id })}
                    className="text-sm text-purple-700 bg-purple-50 border border-purple-200 px-3 py-2 rounded-xl"
                  >
                    Bulk Add
                  </button>
                  <button
                    onClick={() => setSpecEditorModal({ community_id: selectedCommunity.id, spec_id: null })}
                    className="text-sm text-purple-700 bg-purple-50 border border-purple-200 px-3 py-2 rounded-xl"
                  >
                    + Add Spec
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <select
                  value={communitySpecFilters.productTypeId}
                  onChange={(e) =>
                    setCommunitySpecFilters((p) => ({
                      ...p,
                      productTypeId: e.target.value,
                      planId: e.target.value === 'all' ? p.planId : p.planId,
                    }))
                  }
                  className="px-3 py-2 border rounded-xl text-sm"
                >
                  <option value="all">All Product Types</option>
                  {productTypes.map((pt) => (
                    <option key={pt.id} value={pt.id}>
                      {pt.name}
                    </option>
                  ))}
                </select>
                <select
                  value={communitySpecFilters.planId}
                  onChange={(e) => setCommunitySpecFilters((p) => ({ ...p, planId: e.target.value }))}
                  className="px-3 py-2 border rounded-xl text-sm"
                >
                  <option value="all">All Plans</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              {(() => {
                const specs = selectedCommunity.specs ?? []
                const filtered = specs.filter((spec) => {
                  const appliesTo = spec.applies_to ?? 'all'

                  if (communitySpecFilters.productTypeId !== 'all') {
                    if (appliesTo === 'product_type') {
                      if (!(spec.product_type_ids ?? []).includes(communitySpecFilters.productTypeId)) return false
                    } else if (appliesTo === 'plan') {
                      const match = (spec.plan_ids ?? []).some(
                        (id) => plans.find((p) => p.id === id)?.product_type_id === communitySpecFilters.productTypeId,
                      )
                      if (!match) return false
                    }
                  }

                  if (communitySpecFilters.planId !== 'all') {
                    if (appliesTo === 'plan') {
                      if (!(spec.plan_ids ?? []).includes(communitySpecFilters.planId)) return false
                    } else if (appliesTo === 'product_type') {
                      const plan = plans.find((p) => p.id === communitySpecFilters.planId)
                      if (plan && !(spec.product_type_ids ?? []).includes(plan.product_type_id)) return false
                    }
                  }

                  return true
                })

                if (filtered.length === 0) return <p className="text-sm text-gray-500">No specs yet.</p>

                return (
                  <div className="space-y-2">
                    {filtered.map((spec) => {
                      const category = COMMUNITY_SPEC_CATEGORIES.find((c) => c.id === spec.category)
                      const appliesLabel =
                        spec.applies_to === 'product_type'
                          ? 'Product Types'
                          : spec.applies_to === 'plan'
                            ? 'Plans'
                            : 'All Lots'
                      return (
                        <button
                          key={spec.id}
                          onClick={() => setSpecEditorModal({ community_id: selectedCommunity.id, spec_id: spec.id })}
                          className="w-full bg-gray-50 rounded-xl p-3 border border-gray-200 text-left"
                        >
                          <p className="font-semibold">
                            {category?.label ?? '📋 Spec'} {spec.title}
                          </p>
                          <p className="text-xs text-gray-600 mt-1">
                            Trade: {spec.trade_trigger || '—'} • Trigger: {spec.task_trigger || '—'} • Priority: {spec.priority}
                          </p>
                          <p className="text-xs text-gray-500 mt-1">Applies to: {appliesLabel}</p>
                        </button>
                      )
                    })}
                  </div>
                )
              })()}
            </Card>
          </div>
        )}

        {selectedLot && tab === 'communities' && (
          <div className="space-y-4">
            <Card>
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-gray-500">{selectedCommunity?.name ?? ''}</p>
                  <h2 className="font-bold text-lg">
                    {lotCode(selectedLot)} {selectedLot.model_type ? `• ${selectedLot.model_type}` : ''}
                  </h2>
                  {selectedLot.address ? <p className="text-sm text-gray-600">{selectedLot.address}</p> : null}
                  {shouldEnforceLotAssignments ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      {(() => {
                        const assignment = activeSuperAssignmentByLotId.get(selectedLot.id) ?? null
                        const isMine = assignment?.profile_id && assignment.profile_id === supabaseUser?.id
                        if (isMine) {
                          return <span className="px-2 py-1 rounded-full bg-green-50 text-green-700 border border-green-200">Assigned to you</span>
                        }
                        if (assignment) {
                          return <span className="px-2 py-1 rounded-full bg-gray-50 text-gray-700 border border-gray-200">Assigned</span>
                        }
                        return <span className="px-2 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200">Unassigned</span>
                      })()}

                      {!canEditLot(selectedLot.id) && !activeSuperAssignmentByLotId.get(selectedLot.id) ? (
                        <button
                          type="button"
                          onClick={() => claimLot(selectedLot.id)}
                          disabled={!isOnline || claimLotBusyId === selectedLot.id}
                          className="px-2 py-1 rounded-full bg-blue-600 text-white font-semibold disabled:opacity-50"
                          title={!isOnline ? 'Claim requires connection' : ''}
                        >
                          {claimLotBusyId === selectedLot.id ? 'Claiming...' : 'Claim Lot'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {selectedLot.status === 'not_started' ? (
                  <button
                    onClick={() => openStartLot(selectedLot.id)}
                    className="bg-green-600 text-white px-3 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                    disabled={!isOnline || !canEditLot(selectedLot.id)}
                    title={
                      !isOnline
                        ? 'Requires connection to generate schedules'
                        : !canEditLot(selectedLot.id)
                          ? 'Claim this lot to start schedules'
                          : ''
                    }
                  >
                    Start Lot
                  </button>
                ) : (
                  <button
                    onClick={() => unstartLot(selectedLot.id)}
                    className="bg-white border border-red-200 text-red-700 px-3 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                    disabled={!isOnline || !canEditLot(selectedLot.id)}
                    title={
                      !isOnline
                        ? 'Requires connection'
                        : !canEditLot(selectedLot.id)
                          ? 'Claim this lot to edit schedules'
                          : 'Reset lot back to Not Started'
                    }
                  >
                    Unstart
                  </button>
                )}
              </div>

              {selectedLot.status !== 'not_started' ? (
                <div className="mt-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-600">Progress</p>
                    <p className="text-sm font-bold text-blue-600">{calculateLotProgress(selectedLot)}%</p>
                  </div>
                  <div className="mt-2 h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div className="h-full bg-green-500" style={{ width: `${calculateLotProgress(selectedLot)}%` }} />
                  </div>
                  <MilestoneDots lot={selectedLot} />
                  <div className="mt-2 flex items-center justify-between text-xs text-gray-600">
                    <span>Days: {daysElapsed(selectedLot) ?? '--'} of {selectedLot.build_days}</span>
                    <span>ETA: {lotEta(selectedLot)}</span>
                  </div>
                </div>
              ) : null}
            </Card>

            {selectedLot.status !== 'not_started' ? (
              <Card>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold">Lot</h3>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setLotDetailTab('overview')}
                      className={`px-3 py-1 rounded-lg text-sm border ${lotDetailTab === 'overview' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-700'}`}
                    >
                      Overview
                    </button>
                    <button
                      onClick={() => setLotDetailTab('schedule')}
                      className={`px-3 py-1 rounded-lg text-sm border ${lotDetailTab === 'schedule' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-700'}`}
                    >
                      Schedule
                    </button>
                    <button
                      onClick={() => setLotDetailTab('photos')}
                      className={`px-3 py-1 rounded-lg text-sm border ${lotDetailTab === 'photos' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-700'}`}
                    >
                      Photos
                    </button>
                  </div>
                </div>

                {lotDetailTab === 'overview' ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: 'Full Schedule', onClick: () => setLotDetailTab('schedule') },
                        { label: 'Add Photos', onClick: () => setPhotoSourceModal({ lot_id: selectedLot.id, task_id: null }) },
                        { label: 'Files', onClick: () => setLotFilesLotId(selectedLot.id) },
                        { label: 'Inspections', onClick: () => setInspectionsLotId(selectedLot.id) },
                        { label: 'Punch List', onClick: () => setPunchListLotId(selectedLot.id) },
                        { label: 'Site Plan', onClick: () => setSitePlanLotId(selectedLot.id) },
                      ].map((a) => (
                        <button
                          key={a.label}
                          onClick={a.onClick}
                          className="bg-gray-50 rounded-xl p-3 border border-gray-200 text-sm font-semibold"
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>

                    <div>
                      <p className="text-sm font-semibold text-gray-800 mb-2">Today&apos;s Tasks</p>
                      <div className="space-y-2">
                        {(selectedLot.tasks ?? [])
                          .filter((t) => taskInRange(t, todayIso))
                          .slice(0, 3)
                          .map((task) => {
                            const status = deriveTaskStatus(task, selectedLot.tasks, selectedLot.inspections)
                            const sub = app.subcontractors.find((s) => s.id === task.sub_id) ?? null
                            return (
                              <div key={task.id} className="bg-gray-50 rounded-xl p-3 border border-gray-200">
                                <div className="flex items-center justify-between">
                                  <p className="font-semibold">{task.name}</p>
                                  <TaskStatusBadge status={status} />
                                </div>
                                <p className="text-xs text-gray-600 mt-1">
                                  {sub?.company_name ?? 'Unassigned'} • {formatShortDateWithWeekday(task.scheduled_start)} -{' '}
                                  {formatShortDateWithWeekday(task.scheduled_end)}
                                </p>
                              </div>
                            )
                          })}
                        {(selectedLot.tasks ?? []).filter((t) => taskInRange(t, todayIso)).length === 0 ? (
                          <p className="text-sm text-gray-500">No scheduled work today.</p>
                        ) : null}
                      </div>
                    </div>

                    <Card className="bg-gray-50">
                      <p className="font-semibold mb-2">Milestones</p>
                      <div className="space-y-2 text-sm">
                        <label className="flex items-center justify-between gap-3">
                          <span>Permit Issued</span>
                          <input
                            type="checkbox"
                            checked={Boolean((selectedLot.manual_milestones ?? {}).permit_issued)}
                            onChange={(e) => toggleManualMilestone(selectedLot.id, 'permit_issued', e.target.checked)}
                          />
                        </label>
                        <label className="flex items-center justify-between gap-3">
                          <span>CO Received</span>
                          <input
                            type="checkbox"
                            checked={Boolean((selectedLot.manual_milestones ?? {}).co)}
                            onChange={(e) => toggleManualMilestone(selectedLot.id, 'co', e.target.checked)}
                          />
                        </label>
                      </div>
                    </Card>
                  </div>
                ) : lotDetailTab === 'photos' ? (
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => setPhotoSourceModal({ lot_id: selectedLot.id, task_id: null })}
                        className="flex-1 py-3 bg-blue-50 text-blue-700 rounded-xl font-medium border border-blue-200"
                      >
                        + Add Photo
                      </button>
                      <button
                        onClick={() => setPhotoTimelineLotId(selectedLot.id)}
                        className="flex-1 py-3 bg-gray-50 text-gray-700 rounded-xl font-medium border border-gray-200"
                      >
                        View Timeline
                      </button>
                    </div>

                    {(selectedLot.photos ?? []).length === 0 ? (
                      <p className="text-sm text-gray-500">No photos yet.</p>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        {(selectedLot.photos ?? []).map((p) => (
                          <div key={p.id} className="bg-gray-50 border border-gray-200 rounded-xl p-2">
                            <button type="button" onClick={() => setPhotoViewer({ blobId: p.blob_id, title: p.caption || p.location || 'Photo' })} className="w-full">
                              <PhotoThumb blobId={p.blob_id} alt={p.caption || 'Photo'} />
                            </button>
                            <p className="text-[11px] text-gray-600 mt-1 truncate">
                              {p.caption || p.location || PHOTO_CATEGORIES.find((c) => c.id === p.category)?.label || 'Photo'}
                            </p>
                            <div className="mt-1 flex justify-between gap-2">
                              <button type="button" onClick={() => setPhotoViewer({ blobId: p.blob_id, title: p.caption || p.location || 'Photo' })} className="text-[11px] text-blue-600">
                                View
                              </button>
                              <button
                                type="button"
                                onClick={() => removePhoto({ lotId: selectedLot.id, photoId: p.id })}
                                className="text-[11px] text-red-600"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-500">Predicted Completion</p>
                        <p className="font-semibold">{lotEta(selectedLot)}</p>
                      </div>
                      <div className="flex flex-wrap gap-2 justify-end">
                        <button
                          onClick={() => setAddTaskModal({ lot_id: selectedLot.id })}
                          className="px-3 py-2 rounded-xl bg-blue-50 border border-blue-200 text-sm font-semibold text-blue-700 w-full sm:w-auto"
                        >
                          <Plus className="w-4 h-4 inline mr-1" />
                          Create Task
                        </button>
                        <button
                          onClick={() => setCreateBufferModal({ lot_id: selectedLot.id })}
                          className="px-3 py-2 rounded-xl bg-white border border-gray-200 text-sm font-semibold w-full sm:w-auto"
                        >
                          <Plus className="w-4 h-4 inline mr-1" />
                          Create Buffer
                        </button>
                        <button
                          onClick={() => exportLotScheduleCsv(selectedLot)}
                          className="px-3 py-2 rounded-xl bg-white border border-gray-200 text-sm font-semibold w-full sm:w-auto"
                          disabled={!isOnline}
                          title={!isOnline ? 'Requires connection to export' : 'Export schedule to CSV'}
                        >
                          <Download className="w-4 h-4 inline mr-1" />
                          Export
                        </button>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => setScheduleView('list')}
                        className={`px-3 py-1 rounded-lg text-sm border ${scheduleView === 'list' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-700'}`}
                      >
                        List View
                      </button>
                      <button
                        onClick={() => setScheduleView('timeline')}
                        className={`px-3 py-1 rounded-lg text-sm border ${scheduleView === 'timeline' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-700'}`}
                      >
                        Timeline View
                      </button>
                    </div>

                    {scheduleEditLock.lotId === selectedLot.id && (scheduleEditLock.warning || scheduleEditLock.error) ? (
                      <Card className={`border ${scheduleEditLock.error ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
                        <p className={`text-xs font-semibold ${scheduleEditLock.error ? 'text-red-800' : 'text-amber-900'}`}>
                          {scheduleEditLock.error ? 'Schedule locked' : 'Schedule lock notice'}
                        </p>
                        <p className={`text-xs mt-1 ${scheduleEditLock.error ? 'text-red-700' : 'text-amber-800'}`}>
                          {scheduleEditLock.error || scheduleEditLock.warning}
                        </p>
                      </Card>
                    ) : null}

                    {scheduleView === 'timeline' ? (
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => setScheduleTimelineScale('week')}
                            className={`px-3 py-1 rounded-lg text-sm border ${scheduleTimelineScale === 'week' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-700'}`}
                          >
                            Week
                          </button>
                          <button
                            onClick={() => setScheduleTimelineScale('work_week')}
                            className={`px-3 py-1 rounded-lg text-sm border ${scheduleTimelineScale === 'work_week' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-gray-200 text-gray-700'}`}
                          >
                            Work Week
                          </button>
                        </div>
                        <HybridScheduleView
                          lot={selectedLot}
                          subcontractors={app.subcontractors ?? []}
                          org={org}
                          scale={scheduleTimelineScale}
                          onSelectTask={(taskId) => setTaskModal({ lot_id: selectedLot.id, task_id: taskId })}
                          onRescheduleTask={async ({ task, targetDateIso, preview }) => {
                            if (!selectedLot || !task) return
                            const canEdit = await runScheduleEditWithLock(selectedLot.id, async () => {})
                            if (!canEdit) return
                            const outcome = applyReschedule({ lot: selectedLot, task, targetDateIso, preview })
                            if (outcome.status === 'invalid') alert('Could not reschedule task.')
                          }}
                        />
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {selectedScheduleTaskIds.length > 0 ? (
                          <Card className="bg-blue-50 border border-blue-200">
                            <div className="flex flex-col gap-3">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-semibold text-blue-900">
                                  {selectedScheduleTaskIds.length} task{selectedScheduleTaskIds.length === 1 ? '' : 's'} selected
                                </p>
                                <button
                                  type="button"
                                  onClick={clearScheduleSelection}
                                  className="text-xs font-semibold px-2 py-1 rounded-lg border border-blue-200 bg-white"
                                >
                                  Clear
                                </button>
                              </div>
                              <div className="flex gap-2">
                                <PrimaryButton
                                  className="flex-1 bg-blue-600"
                                  onClick={() =>
                                    applyParallelizeSelection({
                                      lot: selectedLot,
                                      taskIds: selectedScheduleTaskIds,
                                      overrideDependencies: parallelOverrideDeps,
                                    })
                                  }
                                >
                                  Make Parallel
                                </PrimaryButton>
                              </div>
                            </div>
                          </Card>
                        ) : null}

                        {['foundation', 'structure', 'interior', 'exterior', 'final', 'misc'].map((track) => {
                          const tasks = (selectedLot.tasks ?? []).filter((t) => t.track === track).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
                          if (tasks.length === 0) return null
                          const title =
                            track === 'foundation'
                              ? 'Foundation'
                              : track === 'structure'
                                ? 'Structure'
                                : track === 'interior'
                                  ? 'Interior Track'
                                  : track === 'exterior'
                                    ? 'Exterior Track'
                                    : track === 'final'
                                      ? 'Final'
                                      : 'Miscellaneous'
                          return (
                            <div key={track}>
                              <p className="text-sm font-semibold text-gray-800 mb-2">{title}</p>
                              <div className="space-y-2">
                                {tasks.map((task) => {
                                  const status = deriveTaskStatus(task, selectedLot.tasks, selectedLot.inspections)
                                  const subsForSelect = getSubsForTrade(task.trade)
                                  const validSubIds = new Set(subsForSelect.map((s) => s.id))
                                  const effectiveSubId = validSubIds.has(task.sub_id) ? task.sub_id : ''
                                  const isDragging = listDraggingTaskId === task.id
                                  const isDropTarget = listDropTaskId === task.id && listDraggingTaskId
                                  const isPulse = listDropPulseId === task.id && !isDragging
                                  const bufferTask = isBufferTask(task)
                                  const dragStyle = isDragging
                                    ? {
                                        transform: `translateY(${listDragOffset}px) scale(1.02)`,
                                        transformOrigin: 'center',
                                        willChange: 'transform',
                                        zIndex: 30,
                                        boxShadow: '0 12px 24px rgba(15, 23, 42, 0.18)',
                                      }
                                    : undefined
                                  const rowStyle = {
                                    ...(dragStyle ?? {}),
                                    ...(isPulse ? { animation: 'bfDropSnap 180ms ease' } : {}),
                                  }
                                  return (
                                    <div
                                      key={task.id}
                                      data-task-row="true"
                                      data-task-id={task.id}
                                      data-track={task.track ?? ''}
                                      style={rowStyle}
                                      className={`w-full rounded-xl p-3 border text-left ${bufferTask ? 'bg-gray-100 border-dashed border-gray-300' : 'bg-gray-50 border-gray-200'} ${isDragging ? 'border-blue-300 bg-blue-50/50 transition-none' : 'transition-transform'} ${isDropTarget ? 'ring-2 ring-blue-300' : ''}`}
                                    >
                                      <div className="flex items-start gap-3">
                                        <input
                                          type="checkbox"
                                          checked={selectedScheduleTaskIds.includes(task.id)}
                                          onChange={() => toggleScheduleTaskSelection(task.id)}
                                          onClick={(e) => e.stopPropagation()}
                                          className="mt-1"
                                        />
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-start justify-between gap-3">
                                            <button
                                              type="button"
                                              onClick={() => {
                                                if (listSuppressClickRef.current) return
                                                setTaskModal({ lot_id: selectedLot.id, task_id: task.id })
                                              }}
                                              className="text-left flex-1 min-w-0"
                                            >
                                              <p
                                                className="font-semibold leading-tight text-gray-900"
                                                style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}
                                              >
                                                {task.name}
                                              </p>
                                              <div className="text-[11px] text-gray-600 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                                                <span className="min-w-0">
                                                  {formatShortDateWithWeekday(task.scheduled_start)} - {formatShortDateWithWeekday(task.scheduled_end)}
                                                </span>
                                                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                                  <span className="text-[10px] uppercase text-gray-500">Duration</span>
                                                  {bufferTask ? (
                                                    <div className="inline-flex items-center gap-1">
                                                      <button
                                                        type="button"
                                                        onClick={(e) => {
                                                          e.stopPropagation()
                                                          const current = Math.max(1, Number(task.duration ?? 1) || 1)
                                                          updateTaskDuration(selectedLot.id, task.id, Math.max(1, current - 1))
                                                        }}
                                                        disabled={Math.max(1, Number(task.duration ?? 1) || 1) <= 1 || task.status === 'complete'}
                                                        className="w-6 h-6 rounded-md border border-gray-200 bg-white text-xs font-semibold disabled:opacity-50"
                                                        title="Decrease"
                                                      >
                                                        –
                                                      </button>
                                                      <input
                                                        type="number"
                                                        min="1"
                                                        value={Math.max(1, Number(task.duration ?? 1) || 1)}
                                                        onChange={(e) =>
                                                          updateTaskDuration(selectedLot.id, task.id, Math.max(1, Number(e.target.value) || 1))
                                                        }
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="w-14 h-6 border border-gray-200 rounded-md text-[11px] bg-white text-center"
                                                        inputMode="numeric"
                                                        disabled={task.status === 'complete'}
                                                      />
                                                      <button
                                                        type="button"
                                                        onClick={(e) => {
                                                          e.stopPropagation()
                                                          const current = Math.max(1, Number(task.duration ?? 1) || 1)
                                                          updateTaskDuration(selectedLot.id, task.id, current + 1)
                                                        }}
                                                        disabled={task.status === 'complete'}
                                                        className="w-6 h-6 rounded-md border border-gray-200 bg-white text-xs font-semibold disabled:opacity-50"
                                                        title="Increase"
                                                      >
                                                        +
                                                      </button>
                                                    </div>
                                                  ) : (
                                                    <select
                                                      value={task.duration ?? 1}
                                                      disabled={task.status === 'complete'}
                                                      onChange={(e) => updateTaskDuration(selectedLot.id, task.id, e.target.value)}
                                                      onClick={(e) => e.stopPropagation()}
                                                      className="border rounded-md px-1 py-0.5 text-[11px] bg-white"
                                                    >
                                                      {DURATION_OPTIONS.map((d) => (
                                                        <option key={d} value={d}>
                                                          {d}d
                                                        </option>
                                                      ))}
                                                    </select>
                                                  )}
                                                </span>
                                              </div>
                                              <div className="mt-2 flex items-center gap-2">
                                                <span className="text-[10px] uppercase text-gray-500">Start</span>
                                                <input
                                                  type="date"
                                                  value={task.scheduled_start ?? ''}
                                                  onChange={(e) => updateTaskStartDate(selectedLot.id, task.id, e.target.value)}
                                                  onClick={(e) => e.stopPropagation()}
                                                  onPointerDown={(e) => e.stopPropagation()}
                                                  className="h-8 px-2 border border-gray-200 rounded-md text-[11px] bg-white disabled:opacity-50"
                                                  disabled={task.status === 'complete' || bufferTask}
                                                />
                                              </div>
                                            </button>
                                            <TaskStatusBadge status={status} />
                                          </div>
                                          {!bufferTask ? (
                                            <div className="mt-2 flex flex-col gap-2">
                                              <label className="text-xs text-gray-600">
                                                Sub
                                                <select
                                                  value={effectiveSubId}
                                                  onChange={(e) => updateTaskSub(selectedLot.id, task.id, e.target.value)}
                                                  onClick={(e) => e.stopPropagation()}
                                                  className="mt-1 w-full px-2 py-1 border rounded-lg text-xs bg-white"
                                                >
                                                  <option value="">Unassigned</option>
                                                  {subsForSelect.map((s) => (
                                                    <option key={s.id} value={s.id}>
                                                      {s.company_name}
                                                    </option>
                                                  ))}
                                                </select>
                                              </label>
                                            </div>
                                          ) : (
                                            <p className="mt-2 text-[11px] text-gray-600">Buffer block (no subcontractor)</p>
                                          )}
                                        </div>
                                        <button
                                          type="button"
                                          onPointerDown={(e) => handleListDragPointerDown(task, e)}
                                          onPointerMove={(e) => handleListDragPointerMove(task, e)}
                                          onPointerUp={(e) => handleListDragPointerUp(task, e)}
                                          onPointerCancel={handleListDragPointerCancel}
                                          onContextMenu={(e) => e.preventDefault()}
                                          className="mt-1 p-2 rounded-lg border border-gray-200 bg-white text-gray-500 hover:text-gray-700 cursor-grab active:cursor-grabbing select-none"
                                          style={{ touchAction: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
                                          title="Drag to reorder"
                                        >
                                          <GripVertical className="w-4 h-4" />
                                        </button>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            ) : (
              <Card>
                <p className="text-sm text-gray-600">
                  This lot is not started yet. Use <span className="font-semibold">Start Lot</span> to generate the schedule.
                </p>
              </Card>
            )}
          </div>
        )}

        {tab === 'subs' && !selectedLot && !selectedCommunity && (
          <div className="space-y-4">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold mb-3">Subcontractors</h3>
                <button
                  onClick={() => setEditingSubId('new')}
                  className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
                >
                  + Add Sub
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                <label className="block">
                  <span className="text-xs text-gray-500">Filter by Category</span>
                  <select
                    value={subFilterCategory}
                    onChange={(e) => setSubFilterCategory(e.target.value)}
                    className="mt-1 w-full px-3 py-2 border rounded-xl text-sm"
                  >
                    <option value="all">All categories</option>
                    {TASK_CATEGORIES.map((c) => (
                      <option key={c.id} value={c.track}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-gray-500">Filter by Task Type</span>
                  <select
                    value={subFilterTrade}
                    onChange={(e) => setSubFilterTrade(e.target.value)}
                    className="mt-1 w-full px-3 py-2 border rounded-xl text-sm"
                  >
                    <option value="all">All task types</option>
                    {tradeOptions.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="space-y-2">
                {filteredSubs.map((sub) => {
                  const tradeLabel = tradeOptions.find((t) => t.id === sub.trade)?.label ?? sub.trade
                  return (
                    <SubcontractorCard
                      key={sub.id}
                      sub={sub}
                      tradeLabel={tradeLabel}
                      onEdit={() => setEditingSubId(sub.id)}
                      onMessage={() => setSubContactModalId(sub.id)}
                    />
                  )
                })}
              </div>
            </Card>
          </div>
        )}

        {tab === 'reports' && !selectedLot && !selectedCommunity && (
          <div className="space-y-4">
            <Card>
              <h3 className="font-semibold mb-2">Reporting & Analytics</h3>
              <p className="text-sm text-gray-600">Generate Progress, Community Summary, Delay Analysis, Sub Performance, and Forecast exports.</p>
              <div className="mt-3 flex gap-2">
                <PrimaryButton onClick={() => setReportModal(true)} className="flex-1" disabled={!isOnline} title={!isOnline ? 'Export requires connection' : ''}>
                  Generate Report
                </PrimaryButton>
                <SecondaryButton onClick={() => setScheduledReportModal(true)} className="flex-1">
                  Scheduled Reports
                </SecondaryButton>
              </div>
              {!isOnline ? (
                <div className="mt-3 bg-orange-50 border border-orange-200 rounded-xl p-3 text-sm text-orange-800">
                  Offline — report exports are disabled (spec 5.19).
                </div>
              ) : null}
            </Card>
            <Card>
              <h3 className="font-semibold mb-2">Schedule Summary</h3>
              <p className="text-sm text-gray-600">
                Active lots: <span className="font-semibold">{activeLots.length}</span>
              </p>
              <p className="text-sm text-gray-600">
                Avg completion: <span className="font-semibold">{activeLots.length ? Math.round(activeLots.reduce((a, l) => a + calculateLotProgress(l), 0) / activeLots.length) : 0}%</span>
              </p>
            </Card>
          </div>
        )}

        {tab === 'sales' && !selectedLot && !selectedCommunity && (
          <div className="space-y-4">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Sales</p>
                  <h3 className="text-lg font-semibold">Sales Overview</h3>
                  <p className="text-sm text-gray-600 mt-1">Track availability, pipeline, and completion ranges.</p>
                </div>
                <div className="text-right text-xs text-gray-500">
                  <p>{salesStats.total} lots in view</p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'Available', value: salesStats.available, tone: 'text-green-700', bg: 'bg-green-50' },
                  { label: 'Pending', value: salesStats.pending, tone: 'text-yellow-700', bg: 'bg-yellow-50' },
                  { label: 'Sold', value: salesStats.sold, tone: 'text-gray-700', bg: 'bg-gray-100' },
                  { label: 'Total', value: salesStats.total, tone: 'text-blue-700', bg: 'bg-blue-50' },
                ].map((stat) => (
                  <div key={stat.label} className={`rounded-xl border border-gray-200 p-3 ${stat.bg}`}>
                    <p className="text-xs text-gray-500">{stat.label}</p>
                    <p className={`text-2xl font-semibold ${stat.tone}`}>{stat.value}</p>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-gray-600">
                <div className="bg-white border border-gray-200 rounded-xl p-2">
                  Communities: <span className="font-semibold">{salesStats.communitiesCount}</span>
                </div>
                <div className="bg-white border border-gray-200 rounded-xl p-2">
                  Product Types: <span className="font-semibold">{salesStats.productTypesCount}</span>
                </div>
                <div className="bg-white border border-gray-200 rounded-xl p-2">
                  Plans: <span className="font-semibold">{salesStats.plansCount}</span>
                </div>
                <div className="bg-white border border-gray-200 rounded-xl p-2">
                  Completion: <span className="font-semibold">{salesStats.earliestCompletion ? `${formatShortDate(salesStats.earliestCompletion)} – ${formatShortDate(salesStats.latestCompletion)}` : '—'}</span>
                </div>
              </div>
            </Card>

            <Card className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">Filters</p>
                  <p className="text-xs text-gray-500 mt-1">Narrow inventory by community, product type, plan, and status.</p>
                </div>
                <button
                  onClick={() => setSalesFilters({ communityId: 'all', productTypeId: 'all', planId: 'all', soldStatus: 'all', completionBy: '' })}
                  className="text-xs font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
                >
                  Reset
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
                <select
                  value={salesFilters.communityId}
                  onChange={(e) => setSalesFilters((p) => ({ ...p, communityId: e.target.value }))}
                  className="px-3 py-2 border rounded-xl"
                >
                  <option value="all">All Communities</option>
                  {salesFilterOptions.communities.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  value={salesFilters.productTypeId}
                  onChange={(e) =>
                    setSalesFilters((p) => ({
                      ...p,
                      productTypeId: e.target.value,
                      planId: e.target.value === 'all' ? p.planId : 'all',
                    }))
                  }
                  className="px-3 py-2 border rounded-xl"
                >
                  <option value="all">All Product Types</option>
                  {salesFilterOptions.productTypes.map((pt) => (
                    <option key={pt.id} value={pt.id}>
                      {pt.name}
                    </option>
                  ))}
                </select>
                <select
                  value={salesFilters.planId}
                  onChange={(e) => setSalesFilters((p) => ({ ...p, planId: e.target.value }))}
                  className="px-3 py-2 border rounded-xl"
                >
                  <option value="all">All Plans</option>
                  {salesFilterOptions.plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  value={salesFilters.soldStatus}
                  onChange={(e) => setSalesFilters((p) => ({ ...p, soldStatus: e.target.value }))}
                  className="px-3 py-2 border rounded-xl"
                >
                  <option value="all">All Statuses</option>
                  <option value="available">Available</option>
                  <option value="pending">Pending</option>
                  <option value="sold">Sold</option>
                </select>
                <div className="col-span-2 md:col-span-1">
                  <label className="text-xs text-gray-600">Available by date</label>
                  <input
                    type="date"
                    value={salesFilters.completionBy}
                    onChange={(e) => setSalesFilters((p) => ({ ...p, completionBy: e.target.value }))}
                    className="mt-1 w-full px-3 py-2 border rounded-xl text-sm"
                  />
                </div>
              </div>
            </Card>

            <div className="space-y-3">
              {filteredSalesLots.length === 0 ? (
                <p className="text-sm text-gray-500">No lots match these filters.</p>
              ) : (
                filteredSalesLots.map((lot) => {
                  const community = communitiesById.get(lot.community_id) ?? null
                  const productType = productTypes.find((pt) => pt.id === lot.product_type_id) ?? null
                  const plan = plans.find((p) => p.id === lot.plan_id) ?? null
                  return (
                    <Card key={lot.id}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold">{community?.name ?? ''} • {lotCode(lot)}</p>
                          <p className="text-xs text-gray-600 mt-1">
                            {productType?.name ?? 'Product'}{plan ? ` • ${plan.name}` : ''}{lot.address ? ` • ${lot.address}` : ''}
                          </p>
                          {lot.target_completion_date ? (
                            <p className="text-xs text-blue-600 mt-1">Est. completion: {formatShortDate(lot.target_completion_date)}</p>
                          ) : null}
                        </div>
                        <div className="text-right">
                          <span
                            className={`px-3 py-1 rounded-full text-xs font-semibold ${
                              (lot.sold_status ?? 'available') === 'available'
                                ? 'bg-green-100 text-green-700'
                                : (lot.sold_status ?? 'available') === 'pending'
                                  ? 'bg-yellow-100 text-yellow-700'
                                  : 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            {(lot.sold_status ?? 'available').toUpperCase()}
                          </span>
                          <div className="mt-2">
                            <select
                              value={lot.sold_status ?? 'available'}
                              onChange={(e) => updateLotSoldStatus(lot.id, e.target.value)}
                              className="text-xs px-2 py-1 border rounded-lg"
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
                })
              )}
            </div>
          </div>
        )}

        {tab === 'admin' && !selectedLot && !selectedCommunity && (
          <div className="space-y-4">
            <Card className="bg-gray-50 border-gray-200">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Admin</p>
                  <h3 className="text-lg font-semibold">Company Settings</h3>
                  <p className="text-sm text-gray-600 mt-1">
                    Manage product types, plans, agencies, contacts, and custom fields used across BuildFlow.
                  </p>
                </div>
                <div className="text-right text-xs text-gray-500">
                  <p>Changes save automatically</p>
                </div>
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-[240px,1fr]">
              <Card className="p-3 space-y-2">
                {adminSections.map((section) => {
                  const active = adminSection === section.id
                  return (
                    <button
                      key={section.id}
                      onClick={() => setAdminSection(section.id)}
                      className={`w-full text-left rounded-xl border p-3 ${active ? 'bg-blue-50 border-blue-200 text-blue-900' : 'bg-white border-gray-200 text-gray-800'}`}
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold">{section.label}</p>
                        <span className={`text-xs font-semibold ${active ? 'text-blue-700' : 'text-gray-500'}`}>{section.count}</span>
                      </div>
                      <p className="text-xs text-gray-600 mt-1">{section.description}</p>
                    </button>
                  )
                })}
              </Card>

              <div className="space-y-4">
                {adminSection === 'product_types' && (
                  <Card className="space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                      <div>
                        <p className="font-semibold">Product Types</p>
                        <p className="text-xs text-gray-500 mt-1">Define build duration and template defaults for lots.</p>
                      </div>
                      <SecondaryButton
                        onClick={() =>
                          setApp((prev) => ({
                            ...prev,
                            product_types: [
                              ...(prev.product_types ?? []),
                              { id: uuid(), name: 'New Type', build_days: 120, template_id: prev.templates?.[0]?.id ?? '', is_active: true },
                            ],
                          }))
                        }
                        className="h-10 w-full sm:w-auto"
                      >
                        + Add Product Type
                      </SecondaryButton>
                    </div>
                    {productTypes.length === 0 ? (
                      <p className="text-sm text-gray-600">No product types configured yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {productTypes.map((pt) => (
                          <div key={pt.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-3">
                            <div className="flex items-start justify-between gap-3">
                              <label className="block flex-1">
                                <span className="text-xs text-gray-500">Name</span>
                                <input
                                  value={pt.name}
                                  onChange={(e) =>
                                    setApp((prev) => ({
                                      ...prev,
                                      product_types: (prev.product_types ?? []).map((x) => (x.id === pt.id ? { ...x, name: e.target.value } : x)),
                                    }))
                                  }
                                  className="mt-1 w-full px-3 py-2 border rounded-xl font-semibold"
                                  placeholder="Name"
                                />
                              </label>
                              <button
                                onClick={() =>
                                  setApp((prev) => ({
                                    ...prev,
                                    product_types: (prev.product_types ?? []).filter((x) => x.id !== pt.id),
                                  }))
                                }
                                className="text-xs text-red-600"
                              >
                                Remove
                              </button>
                            </div>
                            <div className="grid md:grid-cols-3 gap-3">
                              <label className="block">
                                <span className="text-xs text-gray-500">Build days</span>
                                <input
                                  type="number"
                                  min="1"
                                  value={pt.build_days}
                                  onChange={(e) =>
                                    setApp((prev) => ({
                                      ...prev,
                                      product_types: (prev.product_types ?? []).map((x) =>
                                        x.id === pt.id ? { ...x, build_days: Number(e.target.value) || 1 } : x,
                                      ),
                                    }))
                                  }
                                  className="mt-1 w-full px-3 py-2 border rounded-xl"
                                  placeholder="Build days"
                                />
                              </label>
                              <label className="block">
                                <span className="text-xs text-gray-500">Template</span>
                                <select
                                  value={pt.template_id ?? ''}
                                  onChange={(e) =>
                                    setApp((prev) => ({
                                      ...prev,
                                      product_types: (prev.product_types ?? []).map((x) => (x.id === pt.id ? { ...x, template_id: e.target.value } : x)),
                                    }))
                                  }
                                  className="mt-1 w-full px-3 py-2 border rounded-xl text-sm"
                                >
                                  <option value="">Select template...</option>
                                  {(app.templates ?? []).map((t) => (
                                    <option key={t.id} value={t.id}>
                                      {t.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="flex items-center gap-2 text-sm md:mt-6">
                                <input
                                  type="checkbox"
                                  checked={pt.is_active !== false}
                                  onChange={(e) =>
                                    setApp((prev) => ({
                                      ...prev,
                                      product_types: (prev.product_types ?? []).map((x) => (x.id === pt.id ? { ...x, is_active: e.target.checked } : x)),
                                    }))
                                  }
                                />
                                Active
                              </label>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                )}

                {adminSection === 'trades' && (
                  <Card className="space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">Trades</p>
                        <p className="text-xs text-gray-500 mt-1">Add custom trades for subs and filters.</p>
                      </div>
                      <SecondaryButton
                        onClick={() =>
                          setApp((prev) => ({
                            ...prev,
                            custom_trades: [
                              ...(prev.custom_trades ?? []),
                              { id: uuid(), label: 'New Trade' },
                            ],
                          }))
                        }
                        className="h-10 w-full sm:w-auto"
                      >
                        + Add Trade
                      </SecondaryButton>
                    </div>
                    <div className="space-y-3">
                      {(app.custom_trades ?? []).length === 0 ? (
                        <p className="text-sm text-gray-600">No custom trades added yet.</p>
                      ) : (
                        (app.custom_trades ?? []).map((trade) => (
                          <div key={trade.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <label className="block flex-1">
                                <span className="text-xs text-gray-500">Label</span>
                                <input
                                  value={trade.label ?? ''}
                                  onChange={(e) => {
                                    const nextLabel = e.target.value
                                    setApp((prev) => ({
                                      ...prev,
                                      custom_trades: (prev.custom_trades ?? []).map((x) =>
                                        x.id === trade.id ? { ...x, label: nextLabel } : x,
                                      ),
                                    }))
                                  }}
                                  className="mt-1 w-full px-3 py-2 border rounded-xl"
                                />
                              </label>
                              <button
                                onClick={() =>
                                  setApp((prev) => ({
                                    ...prev,
                                    custom_trades: (prev.custom_trades ?? []).filter((x) => x.id !== trade.id),
                                  }))
                                }
                                className="text-xs text-red-600"
                              >
                                Remove
                              </button>
                            </div>
                            <p className="text-xs text-gray-500">ID: {trade.id}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </Card>
                )}

                {adminSection === 'plans' && (
                  <Card className="space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">Plans</p>
                        <p className="text-xs text-gray-500 mt-1">Plans define model options tied to a product type.</p>
                      </div>
                      <SecondaryButton
                        onClick={() =>
                          setApp((prev) => ({
                            ...prev,
                            plans: [
                              ...(prev.plans ?? []),
                              { id: uuid(), name: 'New Plan', product_type_id: prev.product_types?.[0]?.id ?? '', sq_ft: 0 },
                            ],
                          }))
                        }
                        className="h-10"
                      >
                        + Add Plan
                      </SecondaryButton>
                    </div>
                    {plans.length === 0 ? (
                      <p className="text-sm text-gray-600">No plans configured yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {plans.map((plan) => (
                          <div key={plan.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-3">
                            <div className="flex items-start justify-between gap-3">
                              <label className="block flex-1">
                                <span className="text-xs text-gray-500">Plan name</span>
                                <input
                                  value={plan.name}
                                  onChange={(e) =>
                                    setApp((prev) => ({
                                      ...prev,
                                      plans: (prev.plans ?? []).map((x) => (x.id === plan.id ? { ...x, name: e.target.value } : x)),
                                    }))
                                  }
                                  className="mt-1 w-full px-3 py-2 border rounded-xl font-semibold"
                                  placeholder="Plan name"
                                />
                              </label>
                              <button
                                onClick={() =>
                                  setApp((prev) => ({
                                    ...prev,
                                    plans: (prev.plans ?? []).filter((x) => x.id !== plan.id),
                                  }))
                                }
                                className="text-xs text-red-600"
                              >
                                Remove
                              </button>
                            </div>
                            <div className="grid md:grid-cols-3 gap-3">
                              <label className="block">
                                <span className="text-xs text-gray-500">Product type</span>
                                <select
                                  value={plan.product_type_id ?? ''}
                                  onChange={(e) =>
                                    setApp((prev) => ({
                                      ...prev,
                                      plans: (prev.plans ?? []).map((x) => (x.id === plan.id ? { ...x, product_type_id: e.target.value } : x)),
                                    }))
                                  }
                                  className="mt-1 w-full px-3 py-2 border rounded-xl text-sm"
                                >
                                  <option value="">Select product type...</option>
                                  {productTypes.map((pt) => (
                                    <option key={pt.id} value={pt.id}>
                                      {pt.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="block">
                                <span className="text-xs text-gray-500">Square feet</span>
                                <input
                                  type="number"
                                  min="0"
                                  value={plan.sq_ft ?? ''}
                                  onChange={(e) =>
                                    setApp((prev) => ({
                                      ...prev,
                                      plans: (prev.plans ?? []).map((x) => (x.id === plan.id ? { ...x, sq_ft: Number(e.target.value) || 0 } : x)),
                                    }))
                                  }
                                  className="mt-1 w-full px-3 py-2 border rounded-xl"
                                  placeholder="Sq Ft"
                                />
                              </label>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                )}

                {adminSection === 'agencies' && (
                  <Card className="space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">Agencies</p>
                        <p className="text-xs text-gray-500 mt-1">Maintain city or third-party inspection agencies.</p>
                      </div>
                      <SecondaryButton
                        onClick={() =>
                          setApp((prev) => ({
                            ...prev,
                            agencies: [
                              ...(prev.agencies ?? []),
                              { id: uuid(), name: 'New Agency', type: 'municipality', inspection_types: [], is_org_level: true },
                            ],
                          }))
                        }
                        className="h-10"
                      >
                        + Add Agency
                      </SecondaryButton>
                    </div>
                    {agencies.length === 0 ? (
                      <p className="text-sm text-gray-600">No agencies configured yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {agencies.map((agency) => (
                          <div key={agency.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-3">
                            <div className="flex items-start justify-between gap-3">
                              <label className="block flex-1">
                                <span className="text-xs text-gray-500">Agency name</span>
                                <input
                                  value={agency.name}
                                  onChange={(e) =>
                                    setApp((prev) => ({
                                      ...prev,
                                      agencies: (prev.agencies ?? []).map((x) => (x.id === agency.id ? { ...x, name: e.target.value } : x)),
                                    }))
                                  }
                                  className="mt-1 w-full px-3 py-2 border rounded-xl font-semibold"
                                  placeholder="Agency name"
                                />
                              </label>
                              <button
                                onClick={() =>
                                  setApp((prev) => ({
                                    ...prev,
                                    agencies: (prev.agencies ?? []).filter((x) => x.id !== agency.id),
                                  }))
                                }
                                className="text-xs text-red-600"
                              >
                                Remove
                              </button>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500 mb-2">Inspection types</p>
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                                {INSPECTION_TYPES.map((t) => (
                                  <label key={t.code} className="inline-flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-2 py-2">
                                    <input
                                      type="checkbox"
                                      checked={(agency.inspection_types ?? []).includes(t.code)}
                                      onChange={(e) =>
                                        setApp((prev) => ({
                                          ...prev,
                                          agencies: (prev.agencies ?? []).map((x) => {
                                            if (x.id !== agency.id) return x
                                            const next = new Set(x.inspection_types ?? [])
                                            if (e.target.checked) next.add(t.code)
                                            else next.delete(t.code)
                                            return { ...x, inspection_types: Array.from(next) }
                                          }),
                                        }))
                                      }
                                    />
                                    {t.code}
                                  </label>
                                ))}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                )}

                {adminSection === 'contact_library' && (
                  <Card className="space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">Contact Library</p>
                        <p className="text-xs text-gray-500 mt-1">
                          Save realtors and builders/superintendents for quick add in new communities.
                        </p>
                      </div>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="font-semibold">Realtors</p>
                          <button
                            onClick={() =>
                              updateContactLibrary((current) => ({
                                ...current,
                                realtors: [...(current.realtors ?? []), { id: uuid(), name: '', phone: '', email: '', company: '' }],
                              }))
                            }
                            className="text-sm font-semibold px-3 py-1 rounded-xl border border-gray-200 bg-white"
                          >
                            + Add
                          </button>
                        </div>
                        {contactLibraryRealtors.length === 0 ? (
                          <p className="text-xs text-gray-600">No saved realtors yet.</p>
                        ) : (
                          contactLibraryRealtors.map((r) => (
                            <div key={r.id} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                              <input
                                value={r.name ?? ''}
                                onChange={(e) =>
                                  updateContactLibrary((current) => ({
                                    ...current,
                                    realtors: (current.realtors ?? []).map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)),
                                  }))
                                }
                                className="w-full px-3 py-2 border rounded-xl"
                                placeholder="Name"
                              />
                              <input
                                value={r.company ?? ''}
                                onChange={(e) =>
                                  updateContactLibrary((current) => ({
                                    ...current,
                                    realtors: (current.realtors ?? []).map((x) => (x.id === r.id ? { ...x, company: e.target.value } : x)),
                                  }))
                                }
                                className="w-full px-3 py-2 border rounded-xl"
                                placeholder="Company"
                              />
                              <div className="grid grid-cols-2 gap-2">
                                <input
                                  value={r.phone ?? ''}
                                  onChange={(e) =>
                                    updateContactLibrary((current) => ({
                                      ...current,
                                      realtors: (current.realtors ?? []).map((x) => (x.id === r.id ? { ...x, phone: formatPhoneInput(e.target.value) } : x)),
                                    }))
                                  }
                                  className="w-full px-3 py-2 border rounded-xl"
                                  placeholder="Phone"
                                />
                                <input
                                  value={r.email ?? ''}
                                  onChange={(e) =>
                                    updateContactLibrary((current) => ({
                                      ...current,
                                      realtors: (current.realtors ?? []).map((x) => (x.id === r.id ? { ...x, email: e.target.value } : x)),
                                    }))
                                  }
                                  className="w-full px-3 py-2 border rounded-xl"
                                  placeholder="Email"
                                />
                              </div>
                              <button
                                onClick={() =>
                                  updateContactLibrary((current) => ({
                                    ...current,
                                    realtors: (current.realtors ?? []).filter((x) => x.id !== r.id),
                                  }))
                                }
                                className="text-xs text-red-600"
                              >
                                Remove
                              </button>
                            </div>
                          ))
                        )}
                      </div>

                      <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="font-semibold">Builders / Superintendents</p>
                          <button
                            onClick={() =>
                              updateContactLibrary((current) => ({
                                ...current,
                                builders: [
                                  ...(current.builders ?? []),
                                  {
                                    id: uuid(),
                                    name: '',
                                    phone: '',
                                    email: '',
                                    color: BUILDER_COLORS[(current.builders ?? []).length % BUILDER_COLORS.length] ?? '#3B82F6',
                                  },
                                ],
                              }))
                            }
                            className="text-sm font-semibold px-3 py-1 rounded-xl border border-gray-200 bg-white"
                          >
                            + Add
                          </button>
                        </div>
                        {contactLibraryBuilders.length === 0 ? (
                          <p className="text-xs text-gray-600">No saved builders yet.</p>
                        ) : (
                          contactLibraryBuilders.map((b) => (
                            <div key={b.id} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                              <div className="grid grid-cols-2 gap-2">
                                <input
                                  value={b.name ?? ''}
                                  onChange={(e) =>
                                    updateContactLibrary((current) => ({
                                      ...current,
                                      builders: (current.builders ?? []).map((x) => (x.id === b.id ? { ...x, name: e.target.value } : x)),
                                    }))
                                  }
                                  className="w-full px-3 py-2 border rounded-xl"
                                  placeholder="Name"
                                />
                                <input
                                  type="color"
                                  value={b.color || '#3B82F6'}
                                  onChange={(e) =>
                                    updateContactLibrary((current) => ({
                                      ...current,
                                      builders: (current.builders ?? []).map((x) => (x.id === b.id ? { ...x, color: e.target.value } : x)),
                                    }))
                                  }
                                  className="w-full h-10 border rounded-xl"
                                />
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <input
                                  value={b.phone ?? ''}
                                  onChange={(e) =>
                                    updateContactLibrary((current) => ({
                                      ...current,
                                      builders: (current.builders ?? []).map((x) => (x.id === b.id ? { ...x, phone: formatPhoneInput(e.target.value) } : x)),
                                    }))
                                  }
                                  className="w-full px-3 py-2 border rounded-xl"
                                  placeholder="Phone"
                                />
                                <input
                                  value={b.email ?? ''}
                                  onChange={(e) =>
                                    updateContactLibrary((current) => ({
                                      ...current,
                                      builders: (current.builders ?? []).map((x) => (x.id === b.id ? { ...x, email: e.target.value } : x)),
                                    }))
                                  }
                                  className="w-full px-3 py-2 border rounded-xl"
                                  placeholder="Email"
                                />
                              </div>
                              <button
                                onClick={() =>
                                  updateContactLibrary((current) => ({
                                    ...current,
                                    builders: (current.builders ?? []).filter((x) => x.id !== b.id),
                                  }))
                                }
                                className="text-xs text-red-600"
                              >
                                Remove
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </Card>
                )}

                {adminSection === 'custom_fields' && (
                  <Card className="space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">Custom Fields</p>
                        <p className="text-xs text-gray-500 mt-1">Shown on Start Lot and available in exports.</p>
                      </div>
                      <SecondaryButton
                        onClick={() =>
                          setApp((prev) => ({
                            ...prev,
                            org: {
                              ...(prev.org ?? {}),
                              custom_fields: [...(prev.org?.custom_fields ?? []), { id: uuid(), label: 'New Field' }],
                            },
                          }))
                        }
                        className="h-10"
                      >
                        + Add Field
                      </SecondaryButton>
                    </div>
                    {(org.custom_fields ?? []).length === 0 ? (
                      <p className="text-sm text-gray-600">No custom fields configured yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {(org.custom_fields ?? []).map((field) => (
                          <div key={field.id} className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-xl p-2">
                            <input
                              value={field.label}
                              onChange={(e) =>
                                setApp((prev) => ({
                                  ...prev,
                                  org: {
                                    ...(prev.org ?? {}),
                                    custom_fields: (prev.org?.custom_fields ?? []).map((x) => (x.id === field.id ? { ...x, label: e.target.value } : x)),
                                  },
                                }))
                              }
                              className="flex-1 px-3 py-2 border rounded-xl bg-white"
                              placeholder="Field label"
                            />
                            <button
                              onClick={() =>
                                setApp((prev) => ({
                                  ...prev,
                                  org: {
                                    ...(prev.org ?? {}),
                                    custom_fields: (prev.org?.custom_fields ?? []).filter((x) => x.id !== field.id),
                                  },
                                }))
                              }
                              className="text-xs text-red-600 px-2"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {showNotifications && (
        <Modal
          title="🔔 Notifications"
          onClose={() => setShowNotifications(false)}
          footer={
            <div className="flex gap-2">
              <SecondaryButton onClick={() => setShowNotifications(false)} className="flex-1">
                Close
              </SecondaryButton>
              <PrimaryButton onClick={markAllNotificationsRead} className="flex-1" disabled={unreadNotifications === 0}>
                Mark All Read
              </PrimaryButton>
            </div>
          }
        >
          <div className="space-y-3">
            <button
              onClick={() => setShowNotificationPrefs(true)}
              className="w-full h-11 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
            >
              Notification Preferences
            </button>

            {!isOnline ? (
              <div className="bg-white border border-gray-200 rounded-xl p-3 text-sm text-gray-700">
                📴 You&apos;re offline. Notifications that require sending will queue until connected.
              </div>
            ) : null}

            <div className="text-sm text-gray-600">{unreadNotifications} unread</div>

            {(app.notifications ?? []).length === 0 ? (
              <p className="text-sm text-gray-600">No notifications yet.</p>
            ) : (
              <div className="space-y-2">
                {(app.notifications ?? []).map((n) => (
                  <button
                    key={n.id}
                    onClick={() => markNotificationRead(n.id)}
                    className={`w-full text-left rounded-xl border p-3 ${n.read ? 'bg-white border-gray-200' : 'bg-blue-50 border-blue-200'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate">{n.title}</p>
                        <p className="text-sm text-gray-700 whitespace-pre-line mt-1">{n.body}</p>
                        <p className="text-xs text-gray-500 mt-2">
                          {n.created_at ? new Date(n.created_at).toLocaleString() : ''}
                        </p>
                      </div>
                      {!n.read ? <span className="text-xs font-semibold text-blue-700">NEW</span> : null}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {showNotificationPrefs ? (
        <NotificationPreferencesModal
          prefs={app.notification_preferences}
          onClose={() => setShowNotificationPrefs(false)}
          onSave={(next) => {
            setApp((prev) => ({ ...prev, notification_preferences: next }))
            setShowNotificationPrefs(false)
          }}
        />
      ) : null}

      {showOfflineStatus && (
        <OfflineStatusModal
          isOnline={isOnline}
          pending={pendingSyncOps}
          lastSyncedAt={lastSyncedAt}
          supabaseStatus={supabaseStatus}
          writeSyncState={writeSyncState}
          supabaseUser={supabaseUser}
          isGuestSession={isGuestSession}
          cloudHasPending={cloudHasPending}
          cloudQueueCount={cloudQueueCount}
          cloudLastSyncedAt={cloudLastSyncedAt}
          cloudLastError={cloudLastError}
          cloudLastErrorAt={cloudLastErrorAt}
          cloudNextRetryAt={cloudNextRetryAt}
          syncV2Enabled={syncV2Enabled}
          syncV2Status={syncV2Status}
          onToggleSyncV2={(next) => {
            setSyncV2Enabled(Boolean(next))
            writeFlag('bf:sync_v2', Boolean(next))
          }}
          onClose={() => setShowOfflineStatus(false)}
          onSyncNow={() => {
            syncNow()
            setShowOfflineStatus(false)
          }}
        />
      )}

      {showCreateCommunity && (
        <Modal
          title="Create New Community"
          onClose={() => setShowCreateCommunity(false)}
          footer={
            <div className="flex gap-2">
              <SecondaryButton
                onClick={() => {
                  if (communityWizardStep === 1) return setShowCreateCommunity(false)
                  setCommunityWizardStep((s) => Math.max(1, s - 1))
                }}
                className="flex-1"
              >
                {communityWizardStep === 1 ? 'Cancel' : 'Back'}
              </SecondaryButton>
              {communityWizardStep < 5 ? (
                <PrimaryButton
                  onClick={() => setCommunityWizardStep((s) => Math.min(5, s + 1))}
                  className="flex-1"
                  disabled={
                    communityWizardStep === 1 &&
                    (!communityDraft.name.trim() || (communityDraft.product_type_ids ?? []).length === 0)
                  }
                >
                  Next
                </PrimaryButton>
              ) : (
                <PrimaryButton
                  onClick={createCommunity}
                  className="flex-1"
                  disabled={communityCreateIssues.length > 0}
                >
                  Create
                </PrimaryButton>
              )}
            </div>
          }
        >
          <div className="text-xs text-gray-500 mb-3">Step {communityWizardStep} of 5</div>

          {communityWizardStep === 1 && (
            <div className="space-y-3">
              <label className="block">
                <span className="text-sm font-semibold">Community Name *</span>
                <input
                  value={communityDraft.name}
                  onChange={(e) => setCommunityDraft((d) => ({ ...d, name: e.target.value }))}
                  className="mt-1 w-full px-3 py-3 border rounded-xl"
                  placeholder="The Grove"
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold">Street Address</span>
                <input
                  value={communityDraft.street}
                  onChange={(e) => setCommunityDraft((d) => ({ ...d, street: e.target.value }))}
                  className="mt-1 w-full px-3 py-3 border rounded-xl"
                  placeholder="1234 Oak Valley Road"
                />
              </label>
              <div className="grid grid-cols-3 gap-2">
                <label className="block col-span-1">
                  <span className="text-sm font-semibold">City</span>
                  <input
                    value={communityDraft.city}
                    onChange={(e) => setCommunityDraft((d) => ({ ...d, city: e.target.value }))}
                    className="mt-1 w-full px-3 py-3 border rounded-xl"
                    placeholder="Dallas"
                  />
                </label>
                <label className="block col-span-1">
                  <span className="text-sm font-semibold">State</span>
                  <input
                    value={communityDraft.state}
                    onChange={(e) => setCommunityDraft((d) => ({ ...d, state: e.target.value }))}
                    className="mt-1 w-full px-3 py-3 border rounded-xl"
                    placeholder="TX"
                  />
                </label>
                <label className="block col-span-1">
                  <span className="text-sm font-semibold">ZIP</span>
                  <input
                    value={communityDraft.zip}
                    onChange={(e) => setCommunityDraft((d) => ({ ...d, zip: e.target.value }))}
                    className="mt-1 w-full px-3 py-3 border rounded-xl"
                    placeholder="75001"
                  />
                </label>
              </div>
              <div>
                <p className="text-sm font-semibold">Product Types *</p>
                {productTypes.length === 0 ? (
                  <p className="text-xs text-gray-500 mt-1">No product types configured yet.</p>
                ) : (
                  <div className="mt-2 space-y-2">
                    {productTypes.map((pt) => {
                      const checked = (communityDraft.product_type_ids ?? []).includes(pt.id)
                      return (
                        <label key={pt.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setCommunityDraft((d) => {
                                const next = new Set(d.product_type_ids ?? [])
                                if (e.target.checked) next.add(pt.id)
                                else next.delete(pt.id)
                                const nextRanges = { ...(d.lot_type_ranges ?? {}) }
                                if (!e.target.checked) delete nextRanges[pt.id]
                                return { ...d, product_type_ids: Array.from(next), lot_type_ranges: nextRanges }
                              })
                            }
                          />
                          <span>{pt.name}</span>
                          <span className="text-xs text-gray-500">({pt.build_days}d)</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {communityWizardStep === 2 && (
            <div className="space-y-3">
              <label className="block">
                <span className="text-sm font-semibold">Lot Count</span>
                <input
                  type="number"
                  value={communityDraft.lot_count}
                  onChange={(e) => setCommunityDraft((d) => ({ ...d, lot_count: Number(e.target.value) || 1 }))}
                  className="mt-1 w-full px-3 py-3 border rounded-xl"
                />
              </label>

              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-700">Assign Product Types to Lots</p>
                  <span className="text-xs text-gray-500">
                    Assigned: {draftProductTypeValidation.assignedCount} / {draftLotCount}
                  </span>
                </div>
                {activeProductTypeIds.length === 0 ? (
                  <p className="text-sm text-gray-600">Select product types in Step 1.</p>
                ) : (
                  <div className="space-y-2">
                    {activeProductTypeIds.map((ptId) => {
                      const pt = productTypes.find((p) => p.id === ptId)
                      const parsedLots = normalizeRange(communityDraft.lot_type_ranges?.[ptId], draftLotCount)
                      const rangeTokens = rangesFromLots(parsedLots)
                      const draftRange = productTypeRangeDrafts[ptId] ?? { start: '', end: '' }
                      return (
                        <div key={ptId} className="bg-white border border-gray-200 rounded-xl p-3">
                          <div className="flex items-center justify-between mb-2">
                            <p className="font-semibold text-sm">{pt?.name ?? 'Product Type'}</p>
                            <span className="text-xs text-gray-500">{parsedLots.length} lots</span>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-sm">
                            <input
                              type="number"
                              min="1"
                              max={draftLotCount}
                              value={draftRange.start}
                              onChange={(e) =>
                                setProductTypeRangeDrafts((prev) => ({
                                  ...prev,
                                  [ptId]: { ...draftRange, start: e.target.value },
                                }))
                              }
                              className="px-3 py-2 border rounded-xl"
                              placeholder="Start"
                            />
                            <input
                              type="number"
                              min="1"
                              max={draftLotCount}
                              value={draftRange.end}
                              onChange={(e) =>
                                setProductTypeRangeDrafts((prev) => ({
                                  ...prev,
                                  [ptId]: { ...draftRange, end: e.target.value },
                                }))
                              }
                              className="px-3 py-2 border rounded-xl"
                              placeholder="End"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const nextLots = buildRangeNumbers(draftRange.start, draftRange.end, draftLotCount)
                                if (nextLots.length === 0) return
                                updateProductTypeLots(ptId, [...parsedLots, ...nextLots])
                                setProductTypeRangeDrafts((prev) => ({ ...prev, [ptId]: { start: '', end: '' } }))
                              }}
                              className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                            >
                              + Add Range
                            </button>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {rangeTokens.length === 0 ? (
                              <span className="text-xs text-gray-500">No lots assigned yet.</span>
                            ) : (
                              rangeTokens.map((token) => (
                                <button
                                  key={token}
                                  type="button"
                                  onClick={() => {
                                    const removeSet = new Set(normalizeRange(token, draftLotCount))
                                    updateProductTypeLots(
                                      ptId,
                                      parsedLots.filter((lotNum) => !removeSet.has(lotNum)),
                                      false,
                                    )
                                  }}
                                  className="text-xs px-2 py-1 rounded-full border border-gray-200 bg-gray-50"
                                  title="Remove range"
                                >
                                  {token} ×
                                </button>
                              ))
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs">
                            <button
                              type="button"
                              onClick={() => {
                                if (draftProductTypeValidation.missing.length === 0) return
                                updateProductTypeLots(ptId, [...parsedLots, ...draftProductTypeValidation.missing])
                              }}
                              className="px-2 py-1 rounded-lg border border-gray-200 bg-white text-gray-700"
                            >
                              Assign remaining
                            </button>
                            <button
                              type="button"
                              onClick={() => updateProductTypeLots(ptId, [], false)}
                              className="px-2 py-1 rounded-lg border border-gray-200 bg-white text-gray-500"
                            >
                              Clear
                            </button>
                            <span className="text-[11px] text-gray-500">Assigning here removes lots from other types.</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                {draftProductTypeValidation.missing.length > 0 ? (
                  <p className="text-xs text-orange-700">
                    Unassigned lots: {draftProductTypeValidation.missing.slice(0, 20).join(', ')}
                    {draftProductTypeValidation.missing.length > 20 ? '…' : ''}
                  </p>
                ) : null}
                {draftProductTypeValidation.duplicates.length > 0 ? (
                  <p className="text-xs text-red-600">
                    Duplicate assignments: {draftProductTypeValidation.duplicates.slice(0, 20).join(', ')}
                    {draftProductTypeValidation.duplicates.length > 20 ? '…' : ''}
                  </p>
                ) : null}
              </div>
            </div>
          )}

          {communityWizardStep === 3 && (
            <div className="space-y-3">
              <Card className="bg-gray-50">
                <p className="text-sm font-semibold">Plat Map</p>
                <p className="text-xs text-gray-600 mt-1">Supported: PDF or image • Max: 50MB</p>
                {!isOnline ? <p className="text-xs text-orange-700 mt-2">Offline — upload requires connection.</p> : null}
              </Card>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(communityDraft.plat_skip)}
                  onChange={(e) =>
                    setCommunityDraft((d) => ({
                      ...d,
                      plat_skip: e.target.checked,
                      plat_file: e.target.checked ? null : d.plat_file,
                    }))
                  }
                />
                Skip for now (can add later)
              </label>

              {!communityDraft.plat_skip ? (
                <div className="space-y-2">
                  <div className={`${!isOnline ? 'opacity-50' : ''}`}>
                    <span className="text-sm font-semibold block mb-1">Upload Plat Map</span>
                    <label
                      className={`w-full h-16 rounded-xl border-2 border-dashed border-gray-300 bg-white flex items-center justify-center text-sm font-semibold text-gray-700 ${
                        !isOnline ? 'cursor-not-allowed' : 'cursor-pointer hover:border-blue-300 hover:bg-blue-50/30'
                      }`}
                    >
                      Click to choose a file
                      <input
                        type="file"
                        accept="application/pdf,image/*"
                        disabled={!isOnline}
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          const max = 50 * 1024 * 1024
                          const okType = file.type === 'application/pdf' || String(file.type).startsWith('image/')
                          if (!okType) return alert('Plat map must be a PDF or image.')
                          if (file.size > max) return alert('Plat map must be ≤ 50MB.')
                          setCommunityDraft((d) => ({ ...d, plat_file: file, plat_skip: false }))
                          e.target.value = ''
                        }}
                        className="hidden"
                      />
                    </label>
                  </div>

                  {communityDraft.plat_file ? (
                    <Card className="bg-white">
                      <p className="text-sm font-semibold">{communityDraft.plat_file.name}</p>
                      <p className="text-xs text-gray-600 mt-1">
                        {(communityDraft.plat_file.size / (1024 * 1024)).toFixed(1)} MB
                      </p>
                      <button
                        onClick={() => setCommunityDraft((d) => ({ ...d, plat_file: null }))}
                        className="mt-2 text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
                      >
                        Remove
                      </button>
                    </Card>
                  ) : (
                    <div className="bg-white border border-gray-200 rounded-xl p-4 text-sm text-gray-600">
                      Drag &amp; drop isn&apos;t available in this demo — choose a file above.
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {communityWizardStep === 4 && (
            <div className="space-y-4">
              <Card className="bg-gray-50">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold">Realtors</p>
                  <div className="flex items-center gap-2">
                    {contactLibraryRealtors.length > 0 ? (
                      <select
                        value={realtorPersonaId}
                        onChange={(e) => {
                          const nextId = e.target.value
                          if (!nextId) return
                          addRealtorFromLibrary(nextId)
                          setRealtorPersonaId('')
                        }}
                        className="text-sm px-2 py-1 rounded-xl border border-gray-200 bg-white"
                      >
                        <option value="">Add from library...</option>
                        {contactLibraryRealtors.map((r) => (
                          <option key={r.id} value={r.id}>
                            {(r.name ?? 'Unnamed') + (r.company ? ` - ${r.company}` : '')}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <button
                      onClick={() => setCommunityDraft((d) => ({ ...d, realtors: [...(d.realtors ?? []), createDraftRealtor()] }))}
                      className="text-sm font-semibold px-3 py-1 rounded-xl border border-gray-200 bg-white"
                    >
                      + Add
                    </button>
                  </div>
                </div>
                {contactLibraryRealtors.length === 0 ? (
                  <p className="text-xs text-gray-500">No saved realtors yet. Add them in Admin &gt; Contact Library.</p>
                ) : null}
                <div className="space-y-2">
                  {(communityDraft.realtors ?? []).map((r) => (
                    <div key={r.id} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                      <input
                        value={r.name}
                        onChange={(e) =>
                          setCommunityDraft((d) => ({
                            ...d,
                            realtors: (d.realtors ?? []).map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)),
                          }))
                        }
                        className="w-full px-3 py-2 border rounded-xl"
                        placeholder="Name"
                      />
                      <input
                        value={r.company}
                        onChange={(e) =>
                          setCommunityDraft((d) => ({
                            ...d,
                            realtors: (d.realtors ?? []).map((x) => (x.id === r.id ? { ...x, company: e.target.value } : x)),
                          }))
                        }
                        className="w-full px-3 py-2 border rounded-xl"
                        placeholder="Company"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          value={r.phone}
                          onChange={(e) =>
                            setCommunityDraft((d) => ({
                              ...d,
                              realtors: (d.realtors ?? []).map((x) => (x.id === r.id ? { ...x, phone: formatPhoneInput(e.target.value) } : x)),
                            }))
                          }
                          className="w-full px-3 py-2 border rounded-xl"
                          placeholder="Phone"
                        />
                        <input
                          value={r.email}
                          onChange={(e) =>
                            setCommunityDraft((d) => ({
                              ...d,
                              realtors: (d.realtors ?? []).map((x) => (x.id === r.id ? { ...x, email: e.target.value } : x)),
                            }))
                          }
                          className="w-full px-3 py-2 border rounded-xl"
                          placeholder="Email"
                        />
                      </div>
                      <button
                        onClick={() =>
                          setCommunityDraft((d) => ({ ...d, realtors: (d.realtors ?? []).filter((x) => x.id !== r.id) }))
                        }
                        className="text-xs text-red-600"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="bg-gray-50">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-2">
                  <p className="font-semibold">City Inspectors</p>
                  <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                    {inspectorLibrary.length > 0 ? (
                      <select
                        value={inspectorLibraryKey}
                        onChange={(e) => {
                          const nextKey = e.target.value
                          if (!nextKey) return
                          addInspectorFromLibrary(nextKey)
                          setInspectorLibraryKey('')
                        }}
                        className="flex-1 min-w-[150px] text-xs px-2 py-2 rounded-xl border border-gray-200 bg-white"
                      >
                        <option value="">Add existing</option>
                        {inspectorLibrary.map((i) => (
                          <option key={i.key} value={i.key}>
                            {(i.name || 'Inspector') + (i.email ? ` - ${i.email}` : '') + (i.phone ? ` - ${i.phone}` : '')}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <button
                      onClick={() => setCommunityDraft((d) => ({ ...d, inspectors: [...(d.inspectors ?? []), createDraftInspector()] }))}
                      className="text-xs font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
                    >
                      + Add
                    </button>
                  </div>
                </div>
                {inspectorLibrary.length === 0 ? (
                  <p className="text-xs text-gray-500">No saved inspectors yet. Add them in another community first.</p>
                ) : null}
                <div className="space-y-2">
                  {(communityDraft.inspectors ?? []).map((i) => (
                    <div key={i.id} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                      <input
                        value={i.name}
                        onChange={(e) =>
                          setCommunityDraft((d) => ({
                            ...d,
                            inspectors: (d.inspectors ?? []).map((x) => (x.id === i.id ? { ...x, name: e.target.value } : x)),
                          }))
                        }
                        className="w-full px-3 py-2 border rounded-xl"
                        placeholder="Name"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          value={i.phone}
                          onChange={(e) =>
                            setCommunityDraft((d) => ({
                              ...d,
                              inspectors: (d.inspectors ?? []).map((x) => (x.id === i.id ? { ...x, phone: formatPhoneInput(e.target.value) } : x)),
                            }))
                          }
                          className="w-full px-3 py-2 border rounded-xl"
                          placeholder="Phone"
                        />
                        <input
                          value={i.email}
                          onChange={(e) =>
                            setCommunityDraft((d) => ({
                              ...d,
                              inspectors: (d.inspectors ?? []).map((x) => (x.id === i.id ? { ...x, email: e.target.value } : x)),
                            }))
                          }
                          className="w-full px-3 py-2 border rounded-xl"
                          placeholder="Email"
                        />
                      </div>
                      <select
                        value={i.agency_id}
                        onChange={(e) =>
                          setCommunityDraft((d) => ({
                            ...d,
                            inspectors: (d.inspectors ?? []).map((x) => (x.id === i.id ? { ...x, agency_id: e.target.value } : x)),
                          }))
                        }
                        className="w-full px-3 py-2 border rounded-xl text-sm"
                      >
                        <option value="">Select agency...</option>
                        {availableDraftAgencies.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() =>
                          setCommunityDraft((d) => ({ ...d, inspectors: (d.inspectors ?? []).filter((x) => x.id !== i.id) }))
                        }
                        className="text-xs text-red-600"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="bg-gray-50">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold">Agencies</p>
                  {agencyLibrary.length > 0 ? (
                    <select
                      value={agencyLibraryKey}
                      onChange={(e) => {
                        const nextKey = e.target.value
                        if (!nextKey) return
                        addAgencyFromLibrary(nextKey)
                        setAgencyLibraryKey('')
                      }}
                      className="text-sm px-2 py-1 rounded-xl border border-gray-200 bg-white"
                    >
                      <option value="">Add existing...</option>
                      {agencyLibrary.map((a) => (
                        <option key={a.key} value={a.key}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {agencies.length === 0 ? <p className="text-xs text-gray-600">No org agencies yet.</p> : null}
                  {agencies.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={(communityDraft.agency_ids ?? []).includes(a.id)}
                        onChange={(e) =>
                          setCommunityDraft((d) => {
                            const next = new Set(d.agency_ids ?? [])
                            if (e.target.checked) next.add(a.id)
                            else next.delete(a.id)
                            return { ...d, agency_ids: Array.from(next) }
                          })
                        }
                      />
                      <span>{a.name}</span>
                    </label>
                  ))}
                </div>
                <div className="mt-3 border-t pt-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Community Agencies</p>
                    <button
                      onClick={() =>
                        setCommunityDraft((d) => ({
                          ...d,
                          agencies: [...(d.agencies ?? []), { id: uuid(), name: '', inspection_types: [] }],
                        }))
                      }
                      className="text-sm font-semibold px-3 py-1 rounded-xl border border-gray-200 bg-white"
                    >
                      + Add
                    </button>
                  </div>
                  {(communityDraft.agencies ?? []).map((a) => (
                    <div key={a.id} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                      <input
                        value={a.name}
                        onChange={(e) =>
                          setCommunityDraft((d) => ({
                            ...d,
                            agencies: (d.agencies ?? []).map((x) => (x.id === a.id ? { ...x, name: e.target.value } : x)),
                          }))
                        }
                        className="w-full px-3 py-2 border rounded-xl"
                        placeholder="Agency Name"
                      />
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        {INSPECTION_TYPES.map((t) => (
                          <label key={t.code} className="inline-flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={(a.inspection_types ?? []).includes(t.code)}
                              onChange={(e) =>
                                setCommunityDraft((d) => ({
                                  ...d,
                                  agencies: (d.agencies ?? []).map((x) => {
                                    if (x.id !== a.id) return x
                                    const next = new Set(x.inspection_types ?? [])
                                    if (e.target.checked) next.add(t.code)
                                    else next.delete(t.code)
                                    return { ...x, inspection_types: Array.from(next) }
                                  }),
                                }))
                              }
                            />
                            {t.code}
                          </label>
                        ))}
                      </div>
                      <button
                        onClick={() =>
                          setCommunityDraft((d) => ({ ...d, agencies: (d.agencies ?? []).filter((x) => x.id !== a.id) }))
                        }
                        className="text-xs text-red-600"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="bg-gray-50">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-2">
                  <p className="font-semibold">Builders / Superintendents</p>
                  <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                    {contactLibraryBuilders.length > 0 ? (
                      <select
                        value={builderPersonaId}
                        onChange={(e) => {
                          const nextId = e.target.value
                          if (!nextId) return
                          addBuilderFromLibrary(nextId)
                          setBuilderPersonaId('')
                        }}
                        className="flex-1 min-w-[150px] text-xs px-2 py-2 rounded-xl border border-gray-200 bg-white"
                      >
                        <option value="">Add from library</option>
                        {contactLibraryBuilders.map((b) => (
                          <option key={b.id} value={b.id}>
                            {(b.name ?? 'Unnamed') + (b.email ? ` - ${b.email}` : '')}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <button
                      onClick={() =>
                        setCommunityDraft((d) => ({
                          ...d,
                          builders: [...(d.builders ?? []), createDraftBuilder((d.builders ?? []).length)],
                        }))
                      }
                      className="text-xs font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
                    >
                      + Add
                    </button>
                  </div>
                </div>
                {contactLibraryBuilders.length === 0 ? (
                  <p className="text-xs text-gray-500">No saved builders yet. Add them in Admin &gt; Contact Library.</p>
                ) : null}
                <div className="space-y-2">
                  {(communityDraft.builders ?? []).map((b) => {
                    const assignedLots = normalizeRange(b.lot_ranges, draftLotCount)
                    const rangeTokens = rangesFromLots(assignedLots)
                    const draftRange = builderRangeDrafts[b.id] ?? { start: '', end: '' }
                    return (
                      <div key={b.id} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            value={b.name}
                            onChange={(e) =>
                              setCommunityDraft((d) => ({
                                ...d,
                                builders: (d.builders ?? []).map((x) => (x.id === b.id ? { ...x, name: e.target.value } : x)),
                              }))
                            }
                            className="w-full px-3 py-2 border rounded-xl"
                            placeholder="Name"
                          />
                          <input
                            type="color"
                            value={b.color || '#3B82F6'}
                            onChange={(e) =>
                              setCommunityDraft((d) => ({
                                ...d,
                                builders: (d.builders ?? []).map((x) => (x.id === b.id ? { ...x, color: e.target.value } : x)),
                              }))
                            }
                            className="w-full h-10 border rounded-xl"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            value={b.phone}
                            onChange={(e) =>
                              setCommunityDraft((d) => ({
                                ...d,
                                builders: (d.builders ?? []).map((x) => (x.id === b.id ? { ...x, phone: formatPhoneInput(e.target.value) } : x)),
                              }))
                            }
                            className="w-full px-3 py-2 border rounded-xl"
                            placeholder="Phone"
                          />
                          <input
                            value={b.email}
                            onChange={(e) =>
                              setCommunityDraft((d) => ({
                                ...d,
                                builders: (d.builders ?? []).map((x) => (x.id === b.id ? { ...x, email: e.target.value } : x)),
                              }))
                            }
                            className="w-full px-3 py-2 border rounded-xl"
                            placeholder="Email"
                          />
                        </div>
                        <div className="bg-gray-50 border border-gray-200 rounded-xl p-2 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold text-gray-700">Assigned lots</p>
                            <span className="text-xs text-gray-500">{assignedLots.length} lots</span>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-sm">
                            <input
                              type="number"
                              min="1"
                              max={draftLotCount}
                              value={draftRange.start}
                              onChange={(e) =>
                                setBuilderRangeDrafts((prev) => ({
                                  ...prev,
                                  [b.id]: { ...draftRange, start: e.target.value },
                                }))
                              }
                              className="px-3 py-2 border rounded-xl bg-white"
                              placeholder="Start"
                            />
                            <input
                              type="number"
                              min="1"
                              max={draftLotCount}
                              value={draftRange.end}
                              onChange={(e) =>
                                setBuilderRangeDrafts((prev) => ({
                                  ...prev,
                                  [b.id]: { ...draftRange, end: e.target.value },
                                }))
                              }
                              className="px-3 py-2 border rounded-xl bg-white"
                              placeholder="End"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const nextLots = buildRangeNumbers(draftRange.start, draftRange.end, draftLotCount)
                                if (nextLots.length === 0) return
                                updateBuilderLots(b.id, [...assignedLots, ...nextLots])
                                setBuilderRangeDrafts((prev) => ({ ...prev, [b.id]: { start: '', end: '' } }))
                              }}
                              className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                            >
                              + Add Range
                            </button>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {rangeTokens.length === 0 ? (
                              <span className="text-xs text-gray-500">No lots assigned yet.</span>
                            ) : (
                              rangeTokens.map((token) => (
                                <button
                                  key={token}
                                  type="button"
                                  onClick={() => {
                                    const removeSet = new Set(normalizeRange(token, draftLotCount))
                                    updateBuilderLots(
                                      b.id,
                                      assignedLots.filter((lotNum) => !removeSet.has(lotNum)),
                                      false,
                                    )
                                  }}
                                  className="text-xs px-2 py-1 rounded-full border border-gray-200 bg-white"
                                  title="Remove range"
                                >
                                  {token} ×
                                </button>
                              ))
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2 text-xs">
                            <button
                              type="button"
                              onClick={() => {
                                if (draftBuilderValidation.missing.length === 0) return
                                updateBuilderLots(b.id, [...assignedLots, ...draftBuilderValidation.missing])
                              }}
                              className="px-2 py-1 rounded-lg border border-gray-200 bg-white text-gray-700"
                            >
                              Assign remaining
                            </button>
                            <button
                              type="button"
                              onClick={() => updateBuilderLots(b.id, [], false)}
                              className="px-2 py-1 rounded-lg border border-gray-200 bg-white text-gray-500"
                            >
                              Clear
                            </button>
                            <span className="text-[11px] text-gray-500">Assigning here removes lots from other builders.</span>
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            setCommunityDraft((d) => ({ ...d, builders: (d.builders ?? []).filter((x) => x.id !== b.id) }))
                          }
                          className="text-xs text-red-600"
                        >
                          Remove
                        </button>
                      </div>
                    )
                  })}
                </div>
                <div className="mt-2 text-xs">
                  {builderAssignmentsValid ? (
                    <span className="text-green-700">✓ All lots assigned to a builder</span>
                  ) : (
                    <span className="text-red-600">
                      Assign all lots (missing: {draftBuilderValidation.missing.length}, duplicates: {draftBuilderValidation.duplicates.length})
                    </span>
                  )}
                </div>
              </Card>
            </div>
          )}

          {communityWizardStep === 5 && (
            <div className="space-y-3">
              {communityCreateIssues.length > 0 ? (
                <Card className="border-orange-200 bg-orange-50">
                  <p className="text-sm font-semibold text-orange-800">Finish these to enable Create</p>
                  <ul className="mt-2 text-sm text-orange-800 list-disc pl-5 space-y-1">
                    {communityCreateIssues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </Card>
              ) : (
                <Card className="border-green-200 bg-green-50">
                  <p className="text-sm font-semibold text-green-800">Ready to create this community.</p>
                </Card>
              )}
              <Card className="p-3">
                <p className="text-sm text-gray-500">Community</p>
                <p className="font-semibold">{communityDraft.name || '—'}</p>
                <p className="text-xs text-gray-600 mt-1">
                  {communityDraft.street ? `${communityDraft.street}, ` : ''}
                  {communityDraft.city || ''} {communityDraft.state || ''} {communityDraft.zip || ''}
                </p>
              </Card>
              <Card className="p-3">
                <p className="text-sm text-gray-500">Lots</p>
                <p className="text-sm text-gray-700">{draftLotCount} total</p>
                <p className="text-xs text-gray-600 mt-1">
                  Product Types: {(communityDraft.product_type_ids ?? []).map((id) => productTypes.find((p) => p.id === id)?.name ?? id).join(', ') || '—'}
                </p>
              </Card>
              <Card className="p-3">
                <p className="text-sm text-gray-500">Plat Map</p>
                {communityDraft.plat_skip ? (
                  <p className="text-sm text-gray-700">Skipped (can add later)</p>
                ) : communityDraft.plat_file ? (
                  <p className="text-sm text-gray-700">{communityDraft.plat_file.name}</p>
                ) : (
                  <p className="text-sm text-gray-700">None</p>
                )}
              </Card>
              <Card className="p-3">
                <p className="text-sm text-gray-500">Builders Assigned</p>
                <p className="text-sm text-gray-700">{(communityDraft.builders ?? []).filter((b) => b.name.trim()).length || 0}</p>
              </Card>
            </div>
          )}
        </Modal>
      )}

      {showStartLot && (
        <StartLotModal
          app={app}
          org={org}
          isOnline={isOnline}
          prefill={startLotPrefill}
          onClose={closeStartLot}
          onStart={async ({ lotId, form, draftTasks }) => {
            let startedLot = null

            const ok = await runScheduleEditWithLock(lotId, async () => {
              let op = null

              setApp((prev) => {
                const nextLots = prev.lots.map((l) => {
                  if (l.id !== lotId) return l
                  const productType = (prev.product_types ?? []).find((pt) => pt.id === l.product_type_id) ?? null
                  const resolvedTemplate =
                    productType?.template_id ? (prev.templates ?? []).find((t) => t.id === productType.template_id) ?? null : null
                  const plan = (prev.plans ?? []).find((p) => p.id === form.plan_id) ?? null
                  const next = startLotFromTemplate({
                    lot: l,
                    start_date: form.start_date,
                    model_type: plan?.name ?? l.model_type ?? '',
                    plan_id: form.plan_id,
                    job_number: form.job_number,
                    custom_fields: form.custom_fields,
                    address: form.address,
                    permit_number: form.permit_number,
                    hard_deadline: form.hard_deadline,
                    template: resolvedTemplate ?? prev.template,
                    orgSettings: prev.org,
                    subcontractors: prev.subcontractors,
                    draftTasks: Array.isArray(draftTasks) ? draftTasks : [],
                  })
                  startedLot = next
                  op = buildV2TasksBatchOp({ lotId, prevLot: l, nextLot: next, includeLotRow: true })
                  return next
                })

                const community = startedLot ? (prev.communities ?? []).find((c) => c.id === startedLot.community_id) ?? null : null
                const tasks = startedLot?.tasks ?? []
                const bySub = new Map()
                for (const t of tasks) {
                  if (!t?.sub_id || !t?.scheduled_start) continue
                  const prevEntry = bySub.get(t.sub_id)
                  if (!prevEntry) {
                    bySub.set(t.sub_id, t)
                    continue
                  }
                  if (String(t.scheduled_start) < String(prevEntry.scheduled_start)) bySub.set(t.sub_id, t)
                }

                const now = new Date().toISOString()
                const scheduleMessages = Array.from(bySub.entries()).map(([subId, firstTask]) => {
                  const sub = (prev.subcontractors ?? []).find((s) => s.id === subId) ?? null
                  const body = fillTemplate(MESSAGE_TEMPLATES.schedule_notification, {
                    community: community?.name ?? '',
                    block: startedLot?.block ?? '',
                    lot: startedLot?.lot_number ?? '',
                    sub_name: sub?.company_name ?? '',
                    task_name: firstTask?.name ?? '',
                    start_date: formatShortDate(firstTask?.scheduled_start),
                    end_date: formatShortDate(firstTask?.scheduled_end),
                    lot_address: startedLot?.address ?? '',
                    builder_name: prev.org?.builder_name ?? prev.org?.name ?? 'BuildFlow',
                    super_phone: prev.org?.super_phone ?? '',
                  })

                  return {
                    id: uuid(),
                    lot_id: startedLot?.id ?? null,
                    task_id: firstTask?.id ?? null,
                    sub_id: subId,
                    body,
                    channels: { sms: true, email: true, app: true },
                    created_at: now,
                    status: 'sent',
                    sent_at: now,
                    template_id: 'schedule_notification',
                  }
                })

                return { ...prev, lots: nextLots, messages: [...(prev.messages ?? []), ...scheduleMessages] }
              })

              if (op) {
                try {
                  await outboxEnqueue(op)
                } catch {
                  // ignore
                }
              }
            })

            if (!ok) return

            setSelectedCommunityId(startedLot?.community_id ?? lotsById.get(lotId)?.community_id ?? null)
            setSelectedLotId(lotId)
            setLotDetailTab('schedule')
            setTab('communities')
            closeStartLot()
          }}
        />
      )}

      {onSiteLotModal && (() => {
        const lot = lotsById.get(onSiteLotModal.lot_id) ?? null
        const task = lot?.tasks?.find((t) => t.id === onSiteLotModal.task_id) ?? null
        if (!lot || !task) return null
        const community = communitiesById.get(lot.community_id) ?? null
        const status = deriveTaskStatus(task, lot.tasks, lot.inspections)
        const sub = app.subcontractors.find((s) => s.id === task.sub_id) ?? null
        const phone = String(sub?.primary_contact?.phone ?? '').trim()

        return (
          <Modal
            title="On Site"
            onClose={() => setOnSiteLotModal(null)}
            footer={(
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setOnSiteLotModal(null)}
                  className="h-12 px-4 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOnSiteLotModal(null)
                    openLotTab(lot.id, 'overview')
                  }}
                  className="h-12 px-4 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                >
                  Overview
                </button>
                <PrimaryButton
                  onClick={() => {
                    setOnSiteLotModal(null)
                    openLotTab(lot.id, 'schedule')
                  }}
                >
                  Schedule
                </PrimaryButton>
              </div>
            )}
          >
            <div className="space-y-3">
              <Card className="bg-gray-50">
                <p className="text-xs text-gray-500">Community</p>
                <p className="font-semibold">{community?.name ?? 'Community'} | {lotCode(lot)}</p>
              </Card>

              <Card className="bg-gray-50">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-gray-500">Task</p>
                    <p className="font-semibold truncate">{task.name ?? ''}</p>
                    <p className="text-xs text-gray-600 mt-1">
                      {formatShortDateWithWeekday(task.scheduled_start)} - {formatShortDateWithWeekday(task.scheduled_end)}
                    </p>
                  </div>
                  <TaskStatusBadge status={status} />
                </div>
              </Card>

              <Card className="bg-gray-50">
                <p className="text-xs text-gray-500">Sub</p>
                <p className="font-semibold">{sub?.company_name ?? 'Unassigned'}</p>
                {phone ? (
                  <a
                    href={`tel:${phone}`}
                    className="text-sm font-semibold text-blue-600 inline-flex items-center gap-2 mt-2"
                  >
                    <Phone className="w-4 h-4" />
                    {phone}
                  </a>
                ) : null}

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setOnSiteLotModal(null)
                      setTaskModal({ lot_id: lot.id, task_id: task.id })
                    }}
                    className="h-12 px-4 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                  >
                    Open Task
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOnSiteLotModal(null)
                      setMessageModal({ lot_id: lot.id, task_id: task.id, sub_id: sub?.id ?? null })
                    }}
                    className="h-12 px-4 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                  >
                    Message
                  </button>
                </div>
              </Card>
            </div>
          </Modal>
        )
      })()}

      {taskModal && (() => {
        const lot = lotsById.get(taskModal.lot_id) ?? null
        const task = lot?.tasks?.find((t) => t.id === taskModal.task_id) ?? null
        if (!lot || !task) return null
        const community = communitiesById.get(lot.community_id) ?? null
        const status = deriveTaskStatus(task, lot.tasks, lot.inspections)
        const sub = app.subcontractors.find((s) => s.id === task.sub_id) ?? null
        return (
          <TaskModal
            key={`${lot.id}-${task.id}`}
            lot={lot}
            community={community}
            task={task}
            status={status}
            sub={sub}
            onOpenTask={(taskId) => setTaskModal({ lot_id: lot.id, task_id: taskId })}
            isOnline={isOnline}
            specAcknowledgements={lot.spec_acknowledgements ?? {}}
            specDismissals={lot.spec_dismissals ?? {}}
            onToggleSpecAck={(specId) =>
              updateLot(lot.id, (current) => ({
                ...current,
                spec_acknowledgements: {
                  ...(current.spec_acknowledgements ?? {}),
                  [specId]: !(current.spec_acknowledgements ?? {})[specId],
                },
              }))
            }
            onDismissSpec={(specId) =>
              updateLot(lot.id, (current) => ({
                ...current,
                spec_dismissals: { ...(current.spec_dismissals ?? {}), [specId]: true },
              }))
            }
            onClose={() => setTaskModal(null)}
            onStart={() => startTask(lot.id, task.id)}
            onRequestComplete={() => completeTaskDirect(lot.id, task.id)}
            onDelay={() => setDelayModal({ lot_id: lot.id, task_id: task.id })}
            onReschedule={() => setRescheduleModal({ lot_id: lot.id, task_id: task.id })}
            onBuffer={() => setBufferModal({ lot_id: lot.id, task_id: task.id })}
            onAddPhoto={() => setPhotoSourceModal({ lot_id: lot.id, task_id: task.id })}
            onMessage={() => setMessageModal({ lot_id: lot.id, task_id: task.id, sub_id: sub?.id ?? null })}
            onMarkIncomplete={() => markTaskIncomplete(lot.id, task.id)}
            onDeleteTask={async () => {
              const ok = window.confirm(`Delete this task?\n\n${task.name}\n\nThis cannot be undone.`)
              if (!ok) return
              const canEdit = await runScheduleEditWithLock(lot.id, async () => {})
              if (!canEdit) return
              deleteLotTask(lot.id, task.id, task.name)
              setTaskModal(null)
            }}
            onAddFile={async ({ label, description, file }) =>
              addTaskFile({ lotId: lot.id, taskId: task.id, label, description, file })
            }
            onRemoveFile={async (docId) => removeTaskFile({ lotId: lot.id, taskId: task.id, docId })}
          />
        )
      })()}

      {addTaskModal && (() => {
        const lot = lotsById.get(addTaskModal.lot_id) ?? null
        if (!lot) return null
        return (
          <AddTaskModal
            lot={lot}
            org={org}
            subcontractors={app.subcontractors ?? []}
            onClose={() => setAddTaskModal(null)}
            onSave={async (task) => {
              const canEdit = await runScheduleEditWithLock(lot.id, async () => {})
              if (!canEdit) return
              let op = null
              setApp((prev) => {
                const nextLots = (prev.lots ?? []).map((l) => {
                  if (l.id !== lot.id) return l
                  const nextLot = normalizeTrackSortOrderBySchedule({ ...l, tasks: [...(l.tasks ?? []), task] }, task.track)
                  op = buildV2TasksBatchOp({ lotId: lot.id, prevLot: l, nextLot })
                  return nextLot
                })
                return { ...prev, lots: nextLots }
              })

              if (op) {
                void Promise.resolve()
                  .then(() => outboxEnqueue(op))
                  .catch(() => {})
              }
              setAddTaskModal(null)
            }}
          />
        )
      })()}

      {delayModal && (() => {
        const lot = lotsById.get(delayModal.lot_id) ?? null
        const task = lot?.tasks?.find((t) => t.id === delayModal.task_id) ?? null
        if (!lot || !task) return null
        return (
          <DelayModal
            lot={lot}
            task={task}
            org={org}
            onClose={() => setDelayModal(null)}
            onApply={async ({ days, reason, notes, photoFile, notifySubs }) => {
              const canEdit = await runScheduleEditWithLock(lot.id, async () => {})
              if (!canEdit) return

              const preview = previewDelayImpact(lot, task.id, days, org)
              const affected = (preview.affected ?? []).filter((a) => a.old_start !== a.new_start)

              let op = null
              setApp((prev) => {
                const nextLots = (prev.lots ?? []).map((l) => {
                  if (l.id !== lot.id) return l
                  const nextLot = applyDelayCascade(l, task.id, days, reason, notes, prev.org)
                  op = buildV2TasksBatchOp({ lotId: lot.id, prevLot: l, nextLot })
                  return nextLot
                })
                return { ...prev, lots: nextLots }
              })

              if (op) {
                void Promise.resolve()
                  .then(() => outboxEnqueue(op))
                  .catch(() => {})
              }
              pushNotification({
                type: 'delay_logged',
                title: `Delay Logged - ${communitiesById.get(lot.community_id)?.name ?? ''} ${lotCode(lot)}`,
                body: `${task.name}\n+${days} day(s)\nReason: ${DELAY_REASONS.find((r) => r.id === reason)?.label ?? reason}${notes ? `\n\nNotes: ${notes}` : ''}`,
                entity_type: 'task',
                entity_id: task.id,
                lot_id: lot.id,
                priority: 'high',
              })

              if (notifySubs && affected.length > 0) {
                const community = communitiesById.get(lot.community_id) ?? null
                const reasonLabel = DELAY_REASONS.find((r) => r.id === reason)?.label ?? reason
                const messages = buildScheduleChangeMessages({
                  lot,
                  community,
                  impactedTasks: affected,
                  changeReason: `${reasonLabel} delay on ${task.name}${notes ? ` — ${notes.trim()}` : ''}`,
                })
                addMessages(messages)
              }

              if (!isOnline) {
                enqueueSyncOp({
                  type: 'delay',
                  lot_id: lot.id,
                  entity_type: 'task',
                  entity_id: task.id,
                  summary: `Delay logged (${lotCode(lot)} - ${task.name})`,
                })
              }
              if (photoFile) {
                await addPhoto({
                  lotId: lot.id,
                  taskId: task.id,
                  category: 'issue',
                  location: '',
                  caption: `Delay: ${reason}`,
                  tags: [],
                  file: photoFile,
                })
              }
              setDelayModal(null)
            }}
          />
        )
      })()}

      {rescheduleModal && (() => {
        const lot = lotsById.get(rescheduleModal.lot_id) ?? null
        const task = lot?.tasks?.find((t) => t.id === rescheduleModal.task_id) ?? null
        if (!lot || !task) return null
        const community = communitiesById.get(lot.community_id) ?? null
        return (
          <RescheduleTaskModal
            lot={lot}
            task={task}
            community={community}
            org={org}
            isOnline={isOnline}
            initialDate={rescheduleModal.initial_date ?? null}
            onClose={() => setRescheduleModal(null)}
            onApply={async ({ newStartDate, reason, notifySubs, preview }) => {
              const canEdit = await runScheduleEditWithLock(lot.id, async () => {})
              if (!canEdit) return
              applyReschedule({ lot, task, targetDateIso: newStartDate, reason, notifySubs, preview })
              setRescheduleModal(null)
            }}
          />
        )
      })()}

      {bufferModal && (() => {
        const lot = lotsById.get(bufferModal.lot_id) ?? null
        const task = lot?.tasks?.find((t) => t.id === bufferModal.task_id) ?? null
        if (!lot || !task) return null
        return (
            <BufferModal
              lot={lot}
              task={task}
              org={org}
              onClose={() => setBufferModal(null)}
              onApply={async ({ days, bufferTaskId }) => {
                const value = Math.max(1, Number(days) || 1)
                if (value <= 0) return
                const ok = await runScheduleEditWithLock(lot.id, async () => {
                  let op = null
                  setApp((prev) => {
                    const nextLots = (prev.lots ?? []).map((l) => {
                      if (l.id !== lot.id) return l
                      const nextLot = insertBufferTaskAfter(l, task.id, value, prev.org, { buffer_task_id: bufferTaskId }) ?? l
                      op = buildV2TasksBatchOp({ lotId: lot.id, prevLot: l, nextLot })
                      return nextLot
                    })
                    return { ...prev, lots: nextLots }
                  })

                  if (op) {
                    try {
                      await outboxEnqueue(op)
                    } catch {
                      // ignore
                    }
                  }

                  if (!syncV2Enabled && !isOnline) {
                    enqueueSyncOp({
                      type: 'task_dates',
                      lot_id: lot.id,
                      entity_type: 'task',
                      entity_id: task.id,
                      summary: `Buffer inserted (${lotCode(lot)} - ${task.name})`,
                    })
                  }
                })
                if (!ok) return
                setBufferModal(null)
              }}
            />
          )
      })()}

      {createBufferModal && (() => {
        const lot = lotsById.get(createBufferModal.lot_id) ?? null
        if (!lot) return null
        return (
            <CreateBufferModal
              lot={lot}
              org={org}
              onClose={() => setCreateBufferModal(null)}
              onCreate={async ({ anchorTaskId, days, bufferTaskId }) => {
                const value = Math.max(1, Number(days) || 1)
                if (!anchorTaskId || value <= 0) return
                const ok = await runScheduleEditWithLock(lot.id, async () => {
                  let op = null
                  setApp((prev) => {
                    const nextLots = (prev.lots ?? []).map((l) => {
                      if (l.id !== lot.id) return l
                      const nextLot = insertBufferTaskAfter(l, anchorTaskId, value, prev.org, { buffer_task_id: bufferTaskId }) ?? l
                      op = buildV2TasksBatchOp({ lotId: lot.id, prevLot: l, nextLot })
                      return nextLot
                    })
                    return { ...prev, lots: nextLots }
                  })

                  if (op) {
                    try {
                      await outboxEnqueue(op)
                    } catch {
                      // ignore
                    }
                  }

                  if (!syncV2Enabled && !isOnline) {
                    enqueueSyncOp({
                      type: 'task_dates',
                      lot_id: lot.id,
                      entity_type: 'task',
                      entity_id: anchorTaskId,
                      summary: `Buffer created (${lotCode(lot)})`,
                    })
                  }
                })
                if (!ok) return
                setCreateBufferModal(null)
              }}
            />
          )
      })()}

      {scheduleInspectionModal && (() => {
        const lot = lotsById.get(scheduleInspectionModal.lot_id) ?? null
        const task = lot?.tasks?.find((t) => t.id === scheduleInspectionModal.task_id) ?? null
        if (!lot) return null
        const community = communitiesById.get(lot.community_id) ?? null
        return (
          <ScheduleInspectionModal
            lot={lot}
            task={task}
            community={community}
            agencies={[...agencies, ...(community?.agencies ?? [])]}
            initialType={scheduleInspectionModal.type_override ?? null}
            onClose={() => setScheduleInspectionModal(null)}
            onSchedule={(payload) => {
              const taskId = task?.id ?? null
              const inspectionId = scheduleInspectionForTask(lot.id, taskId, {
                ...payload,
                parent_inspection_id: scheduleInspectionModal.parent_inspection_id ?? null,
              })
              pushNotification({
                type: 'inspection_scheduled',
                title: `Inspection Scheduled - ${community?.name ?? ''} ${lotCode(lot)}`,
                body: `${INSPECTION_TYPES.find((t) => t.code === payload.type)?.label ?? payload.type}\n${formatShortDate(payload.scheduled_date)} ${payload.scheduled_time ? `• ${payload.scheduled_time}` : ''}`,
                entity_type: 'inspection',
                entity_id: inspectionId,
                lot_id: lot.id,
                priority: 'normal',
              })
              setScheduleInspectionModal(null)
              setTaskModal(null)
              setInspectionResultModal({ lot_id: lot.id, inspection_id: inspectionId })
            }}
          />
        )
      })()}

      {inspectionResultModal && (() => {
        const lot = lotsById.get(inspectionResultModal.lot_id) ?? null
        const inspection = lot?.inspections?.find((i) => i.id === inspectionResultModal.inspection_id) ?? null
        const task = inspection ? lot?.tasks?.find((t) => t.id === inspection.task_id) ?? null : null
        if (!lot || !inspection) return null
        const community = communitiesById.get(lot.community_id) ?? null
        return (
          <InspectionResultModal
            lot={lot}
            task={task}
            inspection={inspection}
            subcontractors={app.subcontractors}
            isOnline={isOnline}
            onClose={() => setInspectionResultModal(null)}
            onOpenNotes={() => setInspectionNoteModal({ lot_id: lot.id, inspection_id: inspection.id })}
            onAddInspectionPhoto={async ({ file, caption }) => {
              if (!file) return null
              return addPhoto({
                lotId: lot.id,
                taskId: null,
                inspectionId: inspection.id,
                category: 'inspection',
                location: '',
                caption: caption ?? 'Inspection',
                tags: [],
                file,
              })
            }}
            onSave={(payload) => {
              saveInspectionResult(lot.id, inspection.id, payload)
              const label = INSPECTION_TYPES.find((t) => t.code === inspection.type)?.label ?? inspection.type
              pushNotification({
                type: 'inspection_result',
                title: `${payload.result === 'pass' ? '✅' : payload.result === 'fail' ? '❌' : '⚠️'} ${label} - ${communitiesById.get(lot.community_id)?.name ?? ''} ${lotCode(lot)}`,
                body:
                  payload.result === 'pass'
                    ? 'Inspection passed.'
                    : `${payload.result?.toUpperCase?.() ?? 'RESULT'} • ${(payload.failure_items ?? []).length} item(s)`,
                entity_type: 'inspection',
                entity_id: inspection.id,
                lot_id: lot.id,
                priority: payload.result === 'fail' ? 'urgent' : payload.result === 'partial' ? 'high' : 'normal',
              })

              if (payload.result === 'fail' || payload.result === 'partial') {
                const items = payload.failure_items ?? []
                const groups = new Map()
                for (const item of items) {
                  if (!item?.sub_id) continue
                  if (!groups.has(item.sub_id)) groups.set(item.sub_id, [])
                  groups.get(item.sub_id).push(item)
                }

                const { addWorkDays } = makeWorkdayHelpers(org)
                const targetDate = formatShortDate(addWorkDays(inspection.scheduled_date ?? todayIso, 3))
                const now = new Date().toISOString()
                const messages = []

                for (const [subId, subItems] of groups.entries()) {
                  const sub = app.subcontractors.find((s) => s.id === subId) ?? null
                  if (!sub) continue
                  const failureList = subItems
                    .map((i) => `• ${i.description}${i.location ? ` (${i.location})` : ''}`)
                    .join('\n')

                  const body = fillTemplate(MESSAGE_TEMPLATES.inspection_failed, {
                    community: community?.name ?? '',
                    block: lot?.block ?? '',
                    lot: lot?.lot_number ?? '',
                    sub_name: sub.company_name ?? '',
                    inspection_type: label,
                    failure_items_list: failureList,
                    target_date: targetDate,
                    super_phone: org?.super_phone ?? '',
                    builder_name: org?.builder_name ?? org?.name ?? 'BuildFlow',
                  })

                  messages.push({
                    id: uuid(),
                    lot_id: lot.id,
                    task_id: task.id,
                    sub_id: sub.id,
                    body,
                    channels: { sms: true, email: true, app: true },
                    created_at: now,
                    status: isOnline ? 'sent' : 'queued',
                    sent_at: isOnline ? now : null,
                    template_id: 'inspection_failed',
                  })
                }

                addMessages(messages)
              }

              if (payload.schedule_reinspection) {
                setScheduleInspectionModal({
                  lot_id: lot.id,
                  task_id: task.id,
                  parent_inspection_id: inspection.id,
                  type_override: inspection.type,
                })
              }
              setInspectionResultModal(null)
            }}
          />
        )
      })()}

      {inspectionNoteModal && (() => {
        const lot = lotsById.get(inspectionNoteModal.lot_id) ?? null
        if (!lot) return null
        const community = communitiesById.get(lot.community_id) ?? null
        const inspection = inspectionNoteModal.inspection_id ? (lot.inspections ?? []).find((i) => i.id === inspectionNoteModal.inspection_id) ?? null : null
        const tasks = (lot.tasks ?? []).slice().sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
        return (
          <InspectionNoteModal
            lot={lot}
            community={community}
            tasks={tasks}
            inspection={inspection}
            isOnline={isOnline}
            onClose={() => setInspectionNoteModal(null)}
            onDelete={async () => {
              if (!inspection?.id) return
              const ok = window.confirm('Delete this inspection note?')
              if (!ok) return
              await deleteInspection(lot.id, inspection.id)
              setInspectionNoteModal(null)
            }}
            onSave={(draft) => {
              const patch = {
                type: draft.type ?? 'NOTE',
                scheduled_date: draft.scheduled_date ?? todayIso,
                scheduled_time: draft.scheduled_time ?? '',
                task_id: draft.task_id ? draft.task_id : null,
                notes: draft.notes ?? '',
                documents: draft.documents ?? [],
              }
              if (inspection?.id) {
                updateInspection(lot.id, inspection.id, patch)
              } else {
                createInspectionNote(lot.id, patch)
              }
              setInspectionNoteModal(null)
            }}
          />
        )
      })()}

      {photoCaptureModal && (() => {
        const lot = lotsById.get(photoCaptureModal.lot_id) ?? null
        const task = photoCaptureModal.task_id ? lot?.tasks?.find((t) => t.id === photoCaptureModal.task_id) ?? null : null
        if (!lot) return null
        return (
          <PhotoCaptureModal
            lot={lot}
            task={task}
            source={photoCaptureModal.source ?? null}
            onClose={() => setPhotoCaptureModal(null)}
            onSave={async (payload) => {
              await addPhoto(payload)
              setPhotoCaptureModal(null)
            }}
          />
        )
      })()}

      {photoSourceModal && (() => {
        const lot = lotsById.get(photoSourceModal.lot_id) ?? null
        const task = photoSourceModal.task_id ? lot?.tasks?.find((t) => t.id === photoSourceModal.task_id) ?? null : null
        if (!lot) return null
        return (
          <PhotoSourceModal
            lot={lot}
            task={task}
            onClose={() => setPhotoSourceModal(null)}
            onSelect={(source) => {
              setPhotoSourceModal(null)
              setPhotoCaptureModal({ lot_id: lot.id, task_id: task?.id ?? null, source })
            }}
          />
        )
      })()}

      {photoTimelineLotId && (() => {
        const lot = lotsById.get(photoTimelineLotId) ?? null
        if (!lot) return null
        return (
          <PhotoTimelineModal
            lot={lot}
            onClose={() => setPhotoTimelineLotId(null)}
            onTakePhoto={() => setPhotoSourceModal({ lot_id: lot.id, task_id: null })}
            onDeletePhoto={(photoId) => removePhoto({ lotId: lot.id, photoId })}
          />
        )
      })()}

      {photoViewer && (
        <PhotoViewerModal
          blobId={photoViewer.blobId}
          title={photoViewer.title}
          photos={photoViewer.photos}
          startIndex={photoViewer.startIndex ?? 0}
          onClose={() => setPhotoViewer(null)}
        />
      )}

      {inspectionsLotId && (() => {
        const lot = lotsById.get(inspectionsLotId) ?? null
        const community = lot ? communitiesById.get(lot.community_id) ?? null : null
        if (!lot) return null
        return (
          <InspectionsModal
            lot={lot}
            community={community}
            onClose={() => setInspectionsLotId(null)}
            onOpenInspection={(inspectionId) => {
              const inspection = (lot.inspections ?? []).find((i) => i.id === inspectionId) ?? null
              if (!inspection) return
              if (inspection.type === 'NOTE') {
                setInspectionNoteModal({ lot_id: lot.id, inspection_id: inspectionId })
                return
              }
              setInspectionResultModal({ lot_id: lot.id, inspection_id: inspectionId })
            }}
            onScheduleInspectionForTask={(taskId) => setScheduleInspectionModal({ lot_id: lot.id, task_id: taskId })}
          />
        )
      })()}

      {messageModal && (() => {
        const lot = messageModal.lot_id ? lotsById.get(messageModal.lot_id) ?? null : null
        const community = lot ? communitiesById.get(lot.community_id) ?? null : null
        const task = lot && messageModal.task_id ? lot?.tasks?.find((t) => t.id === messageModal.task_id) ?? null : null
        const sub = messageModal.sub_id ? app.subcontractors.find((s) => s.id === messageModal.sub_id) ?? null : null
        return (
          <MessageModal
            lot={lot}
            community={community}
            task={task}
            org={org}
            isOnline={isOnline}
            subcontractors={app.subcontractors}
            initialSubId={sub?.id ?? null}
            onClose={() => setMessageModal(null)}
            onSend={({ sub_id, body, channels }) => {
              const now = new Date().toISOString()
              const msg = {
                id: uuid(),
                lot_id: lot?.id ?? null,
                task_id: task?.id ?? null,
                sub_id,
                body,
                channels,
                created_at: now,
                status: isOnline ? 'sent' : 'queued',
                sent_at: isOnline ? now : null,
              }
              setApp((prev) => ({ ...prev, messages: [...(prev.messages ?? []), msg] }))
              if (!isOnline) {
                enqueueSyncOp({
                  type: 'message_send',
                  lot_id: lot?.id ?? null,
                  entity_type: 'message',
                  entity_id: msg.id,
                  summary: `Message queued${lot ? ` (${lotCode(lot)})` : ''}`,
                })
              }
              setMessageModal(null)
            }}
          />
        )
      })()}

      {specEditorModal && (() => {
        const community = communitiesById.get(specEditorModal.community_id) ?? null
        if (!community) return null
        const spec = specEditorModal.spec_id ? (community.specs ?? []).find((s) => s.id === specEditorModal.spec_id) ?? null : null
        return (
          <CommunitySpecEditorModal
            community={community}
            spec={spec}
            templateTasks={(app.templates ?? []).flatMap((t) => t.tasks ?? [])}
            productTypes={productTypes}
            plans={plans}
            isOnline={isOnline}
            onClose={() => setSpecEditorModal(null)}
            onDelete={(specId) => {
              updateCommunity(community.id, (c) => ({ ...c, specs: (c.specs ?? []).filter((s) => s.id !== specId) }))
              setSpecEditorModal(null)
            }}
            onSave={async (nextSpec) => {
              const id = nextSpec.id ?? uuid()
              updateCommunity(community.id, (c) => ({
                ...c,
                specs: [
                  ...(c.specs ?? []).filter((s) => s.id !== id),
                  { ...nextSpec, id },
                ],
              }))
              setSpecEditorModal(null)
            }}
          />
        )
      })()}

      {specBulkModal && (() => {
        const community = communitiesById.get(specBulkModal.community_id) ?? null
        if (!community) return null
        return (
          <CommunitySpecBulkModal
            community={community}
            productTypes={productTypes}
            plans={plans}
            onClose={() => setSpecBulkModal(null)}
            onSave={(specsToAdd) => {
              updateCommunity(community.id, (c) => ({
                ...c,
                specs: [...(c.specs ?? []), ...(specsToAdd ?? [])],
              }))
              setSpecBulkModal(null)
            }}
          />
        )
      })()}

      {communityContactsModalId && (() => {
        const community = communitiesById.get(communityContactsModalId) ?? null
        if (!community) return null
        const availableAgencies = [...agencies, ...(community.agencies ?? [])]
        return (
          <CommunityContactsModal
            community={community}
            agencies={availableAgencies}
            contactLibraryRealtors={contactLibraryRealtors}
            contactLibraryBuilders={contactLibraryBuilders}
            onClose={() => setCommunityContactsModalId(null)}
            onSave={({ builders, realtors, inspectors }) => {
              updateCommunity(community.id, (c) => ({
                ...c,
                builders,
                realtors,
                inspectors,
              }))
              setCommunityContactsModalId(null)
            }}
          />
        )
      })()}

      {punchListLotId && (() => {
        const lot = lotsById.get(punchListLotId) ?? null
        if (!lot) return null
        const community = communitiesById.get(lot.community_id) ?? null
        return (
          <PunchListModal
            lot={lot}
            community={community}
            subcontractors={app.subcontractors}
            onClose={() => setPunchListLotId(null)}
            onPreviewPhoto={(payload) => {
              if (payload?.photos) {
                setPhotoViewer({ photos: payload.photos, startIndex: payload.startIndex ?? 0, title: payload.title || 'Photos' })
                return
              }
              if (payload?.blob_id) {
                setPhotoViewer({ blobId: payload.blob_id, title: payload.caption || payload.location || 'Photo' })
                return
              }
              if (payload?.photo?.blob_id) {
                setPhotoViewer({ blobId: payload.photo.blob_id, title: payload.photo.caption || payload.photo.location || 'Photo' })
              }
            }}
            onUpdate={(nextPunchList) => {
              updateLot(lot.id, (l) => ({ ...l, punch_list: nextPunchList }))
              if (!isOnline) {
                enqueueSyncOp({
                  type: 'punch_list',
                  lot_id: lot.id,
                  entity_type: 'punch_list',
                  entity_id: nextPunchList?.id ?? '',
                  summary: `Punch list updated (${lotCode(lot)})`,
                })
              }
            }}
            onAddPunchPhoto={async ({ punchItemId, file, caption }) => {
              return addPhoto({
                lotId: lot.id,
                taskId: null,
                punchItemId,
                category: 'punch',
                location: '',
                caption,
                tags: [],
                file,
              })
            }}
            onNotifyAssignment={(item) => {
              const sub = app.subcontractors.find((s) => s.id === item.sub_id) ?? null
              if (!sub) return
              const body = fillTemplate(MESSAGE_TEMPLATES.punch_item_assigned, {
                community: community?.name ?? '',
                block: lot?.block ?? '',
                lot: lot?.lot_number ?? '',
                sub_name: sub.company_name ?? '',
                description: item.description ?? '',
                location: item.location ?? '—',
                priority: String(item.priority ?? 'standard').toUpperCase(),
                builder_name: org?.builder_name ?? org?.name ?? 'BuildFlow',
              })
              const now = new Date().toISOString()
              addMessages([
                {
                  id: uuid(),
                  lot_id: lot.id,
                  task_id: null,
                  sub_id: sub.id,
                  body,
                  channels: { sms: true, email: false, app: true },
                  created_at: now,
                  status: isOnline ? 'sent' : 'queued',
                  sent_at: isOnline ? now : null,
                  template_id: 'punch_item_assigned',
                },
              ])
              pushNotification({
                type: 'punch_assigned',
                title: `Punch Item Assigned - ${community?.name ?? ''} ${lotCode(lot)}`,
                body: `${sub.company_name}\n${item.description}${item.location ? `\n📍 ${item.location}` : ''}`,
                entity_type: 'lot',
                entity_id: lot.id,
                lot_id: lot.id,
                priority: item.priority === 'critical' ? 'urgent' : 'normal',
              })
            }}
          />
        )
      })()}

      {dailyLogLotId && (() => {
        const lot = lotsById.get(dailyLogLotId) ?? null
        const community = lot ? communitiesById.get(lot.community_id) ?? null : null
        if (!lot) return null
        return (
          <DailyLogModal
            lot={lot}
            community={community}
            org={org}
            todayIso={todayIso}
            subcontractors={app.subcontractors}
            isOnline={isOnline}
            onClose={() => setDailyLogLotId(null)}
            onSave={(log) => {
              updateLot(lot.id, (l) => ({
                ...l,
                daily_logs: [
                  ...(l.daily_logs ?? []).filter((x) => x.id !== log.id),
                  log,
                ],
              }))
              const noShows = (log.subs_on_site ?? []).filter((s) => s.no_show)
              if (noShows.length > 0) {
                pushNotification({
                  type: 'sub_no_show',
                  title: `Sub No-Show - ${community?.name ?? ''} ${lotCode(lot)}`,
                  body: noShows.map((s) => `• ${s.sub_name || 'Sub'}`).join('\n'),
                  entity_type: 'lot',
                  entity_id: lot.id,
                  lot_id: lot.id,
                  priority: 'high',
                })
              }
              const notifyIssues = (log.issues ?? []).filter((i) => i.notify_manager && i.description)
              if (notifyIssues.length > 0) {
                pushNotification({
                  type: 'system_announcement',
                  title: `Issues Logged - ${community?.name ?? ''} ${lotCode(lot)}`,
                  body: notifyIssues.map((i) => `• (${i.severity}) ${i.description}`).slice(0, 6).join('\n'),
                  entity_type: 'daily_log',
                  entity_id: log.id,
                  lot_id: lot.id,
                  priority: notifyIssues.some((i) => i.severity === 'critical') ? 'urgent' : 'normal',
                })
              }
              if (!isOnline) {
                enqueueSyncOp({
                  type: 'daily_log',
                  lot_id: lot.id,
                  entity_type: 'daily_log',
                  entity_id: log.id,
                  summary: `Daily log saved (${lotCode(lot)})`,
                })
              }
            }}
            onAddDailyPhoto={async ({ dailyLogId, file, caption, category }) => {
              return addPhoto({
                lotId: lot.id,
                taskId: null,
                dailyLogId,
                category: category || 'daily',
                location: '',
                caption,
                tags: [],
                file,
              })
            }}
          />
        )
      })()}

      {materialsLotId && (() => {
        const lot = lotsById.get(materialsLotId) ?? null
        const community = lot ? communitiesById.get(lot.community_id) ?? null : null
        if (!lot) return null
        return (
          <MaterialsModal
            lot={lot}
            community={community}
            onClose={() => setMaterialsLotId(null)}
            onUpdate={(nextOrders) => {
              updateLot(lot.id, (l) => ({ ...l, material_orders: nextOrders }))
              if (!isOnline) {
                enqueueSyncOp({
                  type: 'materials',
                  lot_id: lot.id,
                  entity_type: 'material',
                  entity_id: lot.id,
                  summary: `Materials updated (${lotCode(lot)})`,
                })
              }
            }}
            onAddDeliveryPhoto={async ({ orderId, file, caption }) => {
              const max = 10 * 1024 * 1024
              if (file.size > max) {
                alert('Delivery photo must be ≤ 10MB.')
                return null
              }
              const photoId = await addPhoto({
                lotId: lot.id,
                taskId: null,
                inspectionId: null,
                punchItemId: null,
                dailyLogId: null,
                category: 'delivery',
                location: '',
                caption: caption ?? '',
                tags: ['material'],
                file,
              })
              if (!photoId) return null
              updateLot(lot.id, (l) => ({
                ...l,
                material_orders: (l.material_orders ?? []).map((o) =>
                  o.id !== orderId ? o : { ...o, delivery_photo_ids: [...(o.delivery_photo_ids ?? []), photoId], updated_at: new Date().toISOString() },
                ),
              }))
              return photoId
            }}
            onNotify={(alert) => {
              pushNotification({
                type: 'material_alert',
                title: alert.title,
                body: alert.body,
                entity_type: 'material',
                entity_id: alert.entity_id,
                lot_id: lot.id,
                priority: alert.priority ?? 'high',
              })
            }}
          />
        )
      })()}

      {changeOrdersLotId && (() => {
        const lot = lotsById.get(changeOrdersLotId) ?? null
        const community = lot ? communitiesById.get(lot.community_id) ?? null : null
        if (!lot) return null
        return (
          <ChangeOrdersModal
            lot={lot}
            community={community}
            org={org}
            isOnline={isOnline}
            subcontractors={app.subcontractors ?? []}
            onClose={() => setChangeOrdersLotId(null)}
            onAllocateNumber={allocateChangeOrderNumber}
            onUpdate={(nextOrders) => {
              updateLot(lot.id, (l) => ({ ...l, change_orders: nextOrders }))
              if (!isOnline) {
                enqueueSyncOp({
                  type: 'change_orders',
                  lot_id: lot.id,
                  entity_type: 'change_order',
                  entity_id: lot.id,
                  summary: `Change orders updated (${lotCode(lot)})`,
                })
              }
            }}
            onApplyScheduleImpact={({ taskId, daysAdded, reason }) => {
              if (!taskId || !daysAdded) return
              void runScheduleEditWithLock(lot.id, async () => {
                let op = null
                setApp((prev) => {
                  const nextLots = (prev.lots ?? []).map((current) => {
                    if (current.id !== lot.id) return current
                    const preview = previewDelayImpact(current, taskId, Math.max(1, Number(daysAdded) || 1), prev.org)
                    const now = new Date().toISOString()
                    const nextTasks = (current.tasks ?? []).map((t) => {
                      const hit = (preview.affected ?? []).find((a) => a.task_id === t.id)
                      if (!hit) return t
                      return { ...t, scheduled_start: hit.new_start, scheduled_end: hit.new_end, updated_at: now }
                    })
                    const nextLot = {
                      ...current,
                      tasks: nextTasks,
                      schedule_changes: [
                        ...(current.schedule_changes ?? []),
                        {
                          id: uuid(),
                          task_id: taskId,
                          old_start: (current.tasks ?? []).find((t) => t.id === taskId)?.scheduled_start ?? null,
                          new_start: (preview.affected ?? []).find((a) => a.task_id === taskId)?.new_start ?? null,
                          reason: reason ?? 'Change order schedule impact',
                          notified: false,
                          changed_at: now,
                        },
                      ],
                    }
                    op = buildV2TasksBatchOp({ lotId: lot.id, prevLot: current, nextLot, mode: 'schedule' })
                    return nextLot
                  })
                  return { ...prev, lots: nextLots }
                })

                if (op) {
                  void Promise.resolve()
                    .then(() => outboxEnqueue(op))
                    .catch(() => {})
                }

                if (!syncV2Enabled && !isOnline) {
                  enqueueSyncOp({
                    type: 'task_dates',
                    lot_id: lot.id,
                    entity_type: 'task',
                    entity_id: taskId,
                    summary: `Schedule impacted by change order (${lotCode(lot)})`,
                  })
                }
              })
            }}
            onAddPhoto={async ({ changeOrderId, stage, file }) => {
              const max = 10 * 1024 * 1024
              if (file.size > max) {
                alert('Photo must be ≤ 10MB.')
                return null
              }
              const photoId = await addPhoto({
                lotId: lot.id,
                taskId: null,
                inspectionId: null,
                punchItemId: null,
                dailyLogId: null,
                category: 'progress',
                location: '',
                caption: `Change order ${stage}`,
                tags: ['change_order', stage, changeOrderId],
                file,
              })
              return photoId
            }}
            onNotify={(alert) => {
              pushNotification({
                type: 'change_order_update',
                title: alert.title,
                body: alert.body,
                entity_type: 'change_order',
                entity_id: alert.entity_id,
                lot_id: lot.id,
                priority: alert.priority ?? 'normal',
              })
            }}
          />
        )
      })()}

      {sitePlanLotId && (() => {
        const lot = lotsById.get(sitePlanLotId) ?? null
        if (!lot) return null
        return (
          <SitePlanModal
            lot={lot}
            isOnline={isOnline}
            onClose={() => setSitePlanLotId(null)}
            onUpload={async (file, nameOverride) => {
              if (!isOnline) {
                alert('Uploading documents requires an internet connection.')
                return
              }
              const max = 50 * 1024 * 1024
              const okType = file.type === 'application/pdf' || String(file.type).startsWith('image/')
              if (!okType) {
                alert('Site plan must be a PDF or image.')
                return
              }
              if (file.size > max) {
                alert('Site plan must be ≤ 50MB.')
                return
              }
              const blobId = uuid()
              await putBlob(blobId, file)
              const doc = {
                id: uuid(),
                type: 'site_plan',
                file_name: nameOverride?.trim() || file.name,
                mime: file.type,
                file_size: file.size,
                blob_id: blobId,
                uploaded_at: new Date().toISOString(),
              }
              updateLot(lot.id, (l) => ({ ...l, documents: [...(l.documents ?? []), doc] }))
            }}
            onDelete={async (doc) => {
              if (!doc?.id) return
              updateLot(lot.id, (l) => ({ ...l, documents: (l.documents ?? []).filter((d) => d.id !== doc.id) }))
              if (doc.blob_id) await deleteBlob(doc.blob_id)
              if (!isOnline) {
                enqueueSyncOp({
                  type: 'document_delete',
                  lot_id: lot.id,
                  entity_type: 'document',
                  entity_id: doc.id,
                  summary: `Site plan deleted (${lotCode(lot)})`,
                })
              }
            }}
          />
        )
      })()}

      {lotFilesLotId && (() => {
        const lot = lotsById.get(lotFilesLotId) ?? null
        if (!lot) return null
        return (
          <LotFilesModal
            lot={lot}
            isOnline={isOnline}
            onClose={() => setLotFilesLotId(null)}
            onAddFile={async ({ label, description, file }) => addLotFile({ lotId: lot.id, label, description, file })}
            onRemoveFile={async (docId) => removeLotFile({ lotId: lot.id, docId })}
          />
        )
      })()}

      {subContactModalId && (() => {
        const sub = (app.subcontractors ?? []).find((s) => s.id === subContactModalId) ?? null
        if (!sub) return null
        return <SubContactModal sub={sub} onClose={() => setSubContactModalId(null)} />
      })()}

      {editingSubId && (() => {
        const sub =
          editingSubId === 'new'
            ? {
                id: uuid(),
                company_name: '',
                trade: 'other',
                secondary_trades: [],
                primary_contact: { name: '', phone: '', email: '' },
                additional_contacts: [],
                office_phone: '',
                insurance_expiration: null,
                license_number: null,
                w9_on_file: false,
                crew_size: null,
                is_preferred: false,
                is_backup: false,
                rating: 0,
                total_jobs: 0,
                on_time_pct: null,
                delay_count: 0,
                blackout_dates: [],
                notes: '',
                status: 'active',
              }
            : (app.subcontractors ?? []).find((s) => s.id === editingSubId) ?? null
        if (!sub) return null
        return (
          <SubEditModal
            sub={sub}
            tradeOptions={tradeOptions}
            onClose={() => setEditingSubId(null)}
            onSave={(nextSub) => {
              setApp((prev) => ({
                ...prev,
                subcontractors: editingSubId === 'new'
                  ? [...(prev.subcontractors ?? []), nextSub]
                  : (prev.subcontractors ?? []).map((s) => (s.id === nextSub.id ? nextSub : s)),
              }))
              setEditingSubId(null)
            }}
          />
        )
      })()}

      {communityDocsCommunityId && (() => {
        const community = communitiesById.get(communityDocsCommunityId) ?? null
        if (!community) return null
        return (
          <CommunityDocumentsModal
            community={community}
            isOnline={isOnline}
            onClose={() => setCommunityDocsCommunityId(null)}
            onUpload={async (file) => {
              if (!isOnline) {
                alert('Uploading documents requires an internet connection.')
                return
              }
              const max = 50 * 1024 * 1024
              const okType = file.type === 'application/pdf' || String(file.type).startsWith('image/')
              if (!okType) {
                alert('Plat map must be a PDF or image.')
                return
              }
              if (file.size > max) {
                alert('Plat map must be ≤ 50MB.')
                return
              }
              const blobId = uuid()
              await putBlob(blobId, file)
              const doc = {
                id: uuid(),
                type: 'plat_map',
                file_name: file.name,
                mime: file.type,
                file_size: file.size,
                blob_id: blobId,
                uploaded_at: new Date().toISOString(),
              }
              updateCommunity(community.id, (c) => ({ ...c, documents: [...(c.documents ?? []), doc] }))
            }}
            onDelete={async (doc) => {
              if (!doc?.id) return
              updateCommunity(community.id, (c) => ({ ...c, documents: (c.documents ?? []).filter((d) => d.id !== doc.id) }))
              if (doc.blob_id) await deleteBlob(doc.blob_id)
              if (!isOnline) {
                enqueueSyncOp({
                  type: 'document_delete',
                  lot_id: null,
                  entity_type: 'document',
                  entity_id: doc.id,
                  summary: `Plat map deleted (${community.name})`,
                })
              }
            }}
          />
        )
      })()}

      {reportModal ? (
        <GenerateReportModal
          communities={app.communities ?? []}
          isOnline={isOnline}
          onClose={() => setReportModal(false)}
          onGenerate={generateReportExport}
        />
      ) : null}

      {dashboardStatusModal ? (
        <DashboardStatusLotsModal
          kind={dashboardStatusModal}
          lots={dashboardStatusLots[dashboardStatusModal] ?? []}
          communitiesById={communitiesById}
          onOpenLot={(lotId) => {
            setDashboardStatusModal(null)
            openLot(lotId)
          }}
          onClose={() => setDashboardStatusModal(null)}
        />
      ) : null}

      {atGlanceModal ? (
        <Modal
          title={
            atGlanceModal === 'on_site_today'
              ? `On Site Today (${todaysAssignments.length})`
              : atGlanceModal === 'critical_deadlines'
                ? `Critical Deadlines (${criticalDeadlines.length})`
                : `Open Punch Items (${openPunchItems})`
          }
          onClose={() => setAtGlanceModal(null)}
        >
          {atGlanceModal === 'on_site_today' ? (
            todaysAssignments.length === 0 ? (
              <p className="text-sm text-gray-600">No active assignments today.</p>
            ) : (
              <div className="space-y-2">
                {todaysAssignments.map(({ lot, task, status, sub }) => (
                  <button
                    key={`${lot.id}-${task.id}`}
                    onClick={() => {
                      setAtGlanceModal(null)
                      setOnSiteLotModal({ lot_id: lot.id, task_id: task.id })
                    }}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 p-3 text-left"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold text-gray-900">{sub?.company_name ?? 'Unassigned'}</p>
                        <p className="text-xs text-gray-600 mt-1">{communitiesById.get(lot.community_id)?.name ?? 'Community'} | {lotCode(lot)}</p>
                        <p className="text-xs text-gray-500 mt-1">{task.name}</p>
                      </div>
                      <TaskStatusBadge status={status} />
                    </div>
                  </button>
                ))}
              </div>
            )
          ) : atGlanceModal === 'critical_deadlines' ? (
            criticalDeadlines.length === 0 ? (
              <p className="text-sm text-gray-600">No critical deadlines.</p>
            ) : (
              <div className="space-y-2">
                {criticalDeadlines.map(({ lot, community, daysRemaining }) => (
                  <button
                    key={lot.id}
                    onClick={() => {
                      setAtGlanceModal(null)
                      openLot(lot.id)
                    }}
                    className={`w-full rounded-xl p-3 text-left border ${
                      daysRemaining <= 7 ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-gray-900">{community?.name ?? 'Community'} {lotCode(lot)}</p>
                      <p className={`text-xs font-bold ${daysRemaining <= 7 ? 'text-red-700' : 'text-yellow-700'}`}>{daysRemaining} days</p>
                    </div>
                    <p className="text-xs text-gray-600 mt-1">Target: {formatShortDate(lot.hard_deadline || lot.target_completion_date)}</p>
                  </button>
                ))}
              </div>
            )
          ) : openPunchLots.length === 0 ? (
            <p className="text-sm text-gray-600">No open punch items.</p>
          ) : (
            <div className="space-y-2">
              {openPunchLots.map(({ lot, community, openCount }) => (
                <button
                  key={lot.id}
                  onClick={() => {
                    setAtGlanceModal(null)
                    setPunchListLotId(lot.id)
                  }}
                  className="w-full rounded-xl border border-gray-200 bg-purple-50 p-3 text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-gray-900">{community?.name ?? 'Community'} {lotCode(lot)}</p>
                    <p className="text-xs font-bold text-purple-700">{openCount} open</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Modal>
      ) : null}

      {scheduledReportModal ? (
        <ScheduledReportsModal
          reports={app.scheduled_reports ?? []}
          communities={app.communities ?? []}
          onClose={() => setScheduledReportModal(false)}
          onUpdate={(next) => setApp((prev) => ({ ...prev, scheduled_reports: next }))}
        />
      ) : null}

      <BottomNav value={tab} onChange={navigateRoot} />
    </div>
  )
}

function OfflineStatusModal({
  isOnline,
  pending,
  lastSyncedAt,
  supabaseStatus,
  writeSyncState,
  supabaseUser,
  isGuestSession,
  cloudHasPending,
  cloudQueueCount,
  cloudLastSyncedAt,
  cloudLastError,
  cloudLastErrorAt,
  cloudNextRetryAt,
  syncV2Enabled,
  syncV2Status,
  onToggleSyncV2,
  onClose,
  onSyncNow,
}) {
  const pendingList = useMemo(() => (Array.isArray(pending) ? pending : []), [pending])
  const pendingCount = pendingList.length

  const byType = useMemo(() => {
    const map = new Map()
    for (const op of pendingList) {
      const k = op?.type ?? 'other'
      map.set(k, (map.get(k) ?? 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [pendingList])

  const cloudPhaseLabel = (() => {
    if (!supabaseUser?.id) return 'Signed out (local only)'
    if (supabaseStatus?.phase !== 'ready') return 'Connecting to Supabase...'
    if (writeSyncState?.phase === 'error') return `Sync error: ${writeSyncState?.error || 'write failed'}`
    if (writeSyncState?.phase === 'syncing') return 'Syncing changes...'
    if (writeSyncState?.phase === 'pending') return 'Pending sync'
    if (writeSyncState?.phase === 'synced') return 'Synced'
    return 'Idle'
  })()

  const syncV2PhaseLabel = (() => {
    if (!syncV2Enabled) return 'Disabled'
    if (!supabaseUser?.id) return 'Disabled (sign in required)'
    if (!isOnline) return 'Offline (will sync when connected)'
    const phase = syncV2Status?.phase ?? 'idle'
    if (phase === 'syncing') return 'Syncing...'
    if (phase === 'ready') return 'Ready'
    if (phase === 'error') return `Error: ${syncV2Status?.error || 'sync failed'}`
    return 'Idle'
  })()

  const conflictPolicyText = syncV2Enabled
    ? 'Sync v2: Conflicts are detected. Server rejects edits when the item changed on another device (no silent overwrite). Your edit stays queued locally until you refresh/retry.'
    : 'Snapshot sync: Last write wins. If the same item is edited on two devices, the most recent sync overwrites earlier edits.'

  return (
    <Modal
      title={isOnline ? 'Sync Status' : '📴 You\u2019re Offline'}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Close
          </SecondaryButton>
          <PrimaryButton
            onClick={onSyncNow}
            className="flex-1"
            disabled={!isOnline || (pendingCount === 0 && !cloudHasPending)}
          >
            Sync Now
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm font-semibold">{isOnline ? 'Online' : 'Offline'}</p>
          <p className="text-sm text-gray-700 mt-1">
            {isOnline ? 'Pending changes will sync now.' : 'Changes save locally and sync when connected.'}
          </p>
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold">Cloud Sync (Supabase)</p>
          <p className="text-sm text-gray-700 mt-1">{cloudPhaseLabel}</p>
          {supabaseUser?.id ? (
            <p className="text-xs text-gray-600 mt-1">
              {isGuestSession ? 'Guest session — edits sync to this org.' : 'Signed in — edits sync to this org.'}
            </p>
          ) : null}
          {cloudLastSyncedAt ? (
            <p className="text-xs text-gray-600 mt-1">Last cloud sync: {formatSyncTimestamp(cloudLastSyncedAt)}</p>
          ) : null}
          <p className="text-xs text-gray-600 mt-1">Queue: {cloudQueueCount ?? 0} snapshot{cloudQueueCount === 1 ? '' : 's'}</p>
          {cloudLastError ? (
            <div className="text-xs text-red-600 mt-1">
              <p className="font-semibold">Last error: {cloudLastError}</p>
              {cloudLastErrorAt ? <p>Seen at {formatSyncTimestamp(cloudLastErrorAt)}</p> : null}
            </div>
          ) : null}
          {cloudNextRetryAt ? (
            <p className="text-xs text-amber-700 mt-1">Next retry: {formatSyncTimestamp(cloudNextRetryAt)}</p>
          ) : null}
          {supabaseStatus?.warning ? <p className="text-xs text-amber-700 mt-1">{supabaseStatus.warning}</p> : null}
        </Card>

        <Card className="bg-gray-50">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Sync v2 (Beta)</p>
              <p className="text-sm text-gray-700 mt-1">{syncV2PhaseLabel}</p>
              {syncV2Status?.warning ? <p className="text-xs text-amber-700 mt-1">{syncV2Status.warning}</p> : null}
              {syncV2Enabled && syncV2Status?.last_pulled_at ? (
                <p className="text-xs text-gray-600 mt-1">Last pull: {formatSyncTimestamp(syncV2Status.last_pulled_at)}</p>
              ) : null}
              {syncV2Enabled && syncV2Status?.last_pushed_at ? (
                <p className="text-xs text-gray-600 mt-1">Last push: {formatSyncTimestamp(syncV2Status.last_pushed_at)}</p>
              ) : null}
            </div>
            <label className="text-sm font-semibold flex items-center gap-2">
              <input type="checkbox" checked={Boolean(syncV2Enabled)} onChange={(e) => onToggleSyncV2?.(e.target.checked)} />
              Enabled
            </label>
          </div>
          {syncV2Enabled ? (
            <p className="text-[11px] text-gray-500 mt-2">
              Requires Supabase RPCs `sync_push` and `sync_pull` (see `supabase/sql/009_sync_v2_rpc.sql`).
            </p>
          ) : null}
        </Card>

        <Card className="bg-blue-50 border-blue-200">
          <p className="text-sm font-semibold text-blue-900">Conflict Policy</p>
          <p className="text-xs text-blue-800 mt-1">
            {conflictPolicyText}
          </p>
        </Card>

        <Card>
          <p className="font-semibold mb-2">{pendingCount} changes pending</p>
          {pendingCount === 0 ? (
            <p className="text-sm text-gray-600">All caught up.</p>
          ) : (
            <div className="space-y-2">
              {byType.map(([type, count]) => (
                <div key={type} className="flex items-center justify-between text-sm bg-gray-50 border border-gray-200 rounded-xl p-3">
                  <span className="font-semibold text-gray-900">{type}</span>
                  <span className="text-gray-700">{count}</span>
                </div>
              ))}
              <div className="text-xs text-gray-500">
                {pendingList.slice(0, 3).map((op) => (
                  <div key={op.id}>• {op.summary || op.type}</div>
                ))}
              </div>
            </div>
          )}
        </Card>

        <div className="text-xs text-gray-600">
          Local last synced:{' '}
          <span className="font-semibold">{lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : '—'}</span>
        </div>
      </div>
    </Modal>
  )
}

function StartLotModal({ app, org, isOnline, prefill, onClose, onStart }) {
  const communities = app.communities ?? []
  const lots = app.lots ?? []
  const templates = app.templates ?? []
  const productTypes = app.product_types ?? []
  const plans = app.plans ?? []

  const [communityId, setCommunityId] = useState(() => {
    if (prefill?.lot_id) return lots.find((l) => l.id === prefill.lot_id)?.community_id ?? ''
    return ''
  })
  const [lotNumber, setLotNumber] = useState(() =>
    prefill?.lot_id ? lots.find((l) => l.id === prefill.lot_id)?.lot_number ?? '' : '',
  )

  const selectedCommunity = communities.find((c) => c.id === communityId) ?? null
  const availableLots = lots
    .filter((l) => l.community_id === communityId && l.status === 'not_started')
    .slice()
    .sort((a, b) => Number(a.lot_number) - Number(b.lot_number))

  const resolvedLotId = (() => {
    if (prefill?.lot_id) return prefill.lot_id
    const hit = availableLots.find((l) => l.lot_number === String(lotNumber))
    return hit?.id ?? null
  })()
  const resolvedLot = resolvedLotId ? lots.find((l) => l.id === resolvedLotId) : null

  const resolvedProductType = productTypes.find((pt) => pt.id === resolvedLot?.product_type_id) ?? null
  const template = resolvedProductType
    ? templates.find((t) => t.id === resolvedProductType.template_id) ?? null
    : null
  const buildDays = resolvedProductType?.build_days ?? template?.build_days ?? org.default_build_days ?? 135
  const availablePlans = resolvedProductType ? plans.filter((p) => p.product_type_id === resolvedProductType.id) : []

  const [form, setForm] = useState(() => ({
    start_date: '',
    plan_id: '',
    hard_deadline: '',
    address: '',
    permit_number: '',
    job_number: '',
    custom_fields: {},
  }))

  const [draftTasks, setDraftTasks] = useState([])
  const [previewTouched, setPreviewTouched] = useState(false)
  const [previewAddTaskOpen, setPreviewAddTaskOpen] = useState(false)
  const [previewBufferOpen, setPreviewBufferOpen] = useState(false)
  const [previewDraggingTaskId, setPreviewDraggingTaskId] = useState(null)
  const [previewDropTaskId, setPreviewDropTaskId] = useState(null)
  const previewDragRef = useRef({
    active: false,
    timer: null,
    pointerId: null,
    taskId: null,
    track: null,
    lastX: 0,
    lastY: 0,
    offsetX: 0,
    offsetY: 0,
    rowRect: null,
  })
  const previewScrollRef = useRef(null)
  const previewAutoScrollRef = useRef({ raf: null, vy: 0, lastY: 0 })
  const [previewGhost, setPreviewGhost] = useState(null)
  const previewGhostPosRef = useRef({ raf: null, x: 0, y: 0 })
  const [previewCollapsedTracks, setPreviewCollapsedTracks] = useState(() => new Set())
  const previewKey = `${resolvedLotId ?? ''}:${form.start_date ?? ''}:${template?.id ?? ''}`

  useEffect(() => {
    if (!resolvedLotId) return
    const defaultPlanId = plans.find((p) => p.product_type_id === resolvedLot?.product_type_id)?.id ?? ''
    const fieldDefaults = {}
    for (const field of org.custom_fields ?? []) {
      fieldDefaults[field.id] = resolvedLot?.custom_fields?.[field.id] ?? ''
    }
    setForm((prev) => ({
      ...prev,
      plan_id: resolvedLot?.plan_id ?? defaultPlanId,
      address: resolvedLot?.address ?? '',
      permit_number: resolvedLot?.permit_number ?? '',
      job_number: resolvedLot?.job_number ?? '',
      custom_fields: { ...fieldDefaults, ...(prev.custom_fields ?? {}) },
    }))
  }, [resolvedLotId])

  useEffect(() => {
    if (!resolvedLot || !form.start_date) {
      setDraftTasks([])
      setPreviewTouched(false)
      return
    }

    const nextLot = startLotFromTemplate({
      lot: resolvedLot,
      start_date: form.start_date,
      model_type: resolvedLot?.model_type ?? '',
      plan_id: form.plan_id || null,
      job_number: form.job_number,
      custom_fields: form.custom_fields ?? {},
      address: form.address,
      permit_number: form.permit_number,
      hard_deadline: form.hard_deadline || null,
      template,
      orgSettings: org,
      subcontractors: app.subcontractors,
    })

    const nextTasks = nextLot?.tasks ?? []
    setDraftTasks(nextTasks)
    setPreviewCollapsedTracks(new Set(nextTasks.map((t) => t?.track ?? 'misc')))
    setPreviewTouched(false)
  }, [previewKey])

  useEffect(() => {
    return () => {
      if (previewDragRef.current.timer) clearTimeout(previewDragRef.current.timer)
      if (previewAutoScrollRef.current.raf) cancelAnimationFrame(previewAutoScrollRef.current.raf)
      if (previewGhostPosRef.current.raf) cancelAnimationFrame(previewGhostPosRef.current.raf)
    }
  }, [])

  const targetCompletion = form.start_date ? calculateTargetCompletionDate(form.start_date, buildDays, org) : null
  const previewCompletion = useMemo(() => {
    if (!draftTasks || draftTasks.length === 0) return null
    const completion = getPredictedCompletionDate({ tasks: draftTasks })
    return completion ? formatISODate(completion) : null
  }, [draftTasks])

  const canStart = Boolean(resolvedLotId && form.start_date)

  const previewLot = useMemo(() => (resolvedLot ? { ...resolvedLot, tasks: draftTasks } : null), [resolvedLot, draftTasks])

  const allSubs = useMemo(
    () => (app.subcontractors ?? []).slice().sort((a, b) => String(a.company_name).localeCompare(String(b.company_name))),
    [app.subcontractors],
  )

  const subsByTrade = useMemo(() => {
    const out = new Map()
    for (const sub of allSubs) {
      const trades = new Set([sub?.trade, ...(sub?.secondary_trades ?? [])].filter(Boolean))
      for (const trade of trades) {
        const list = out.get(trade) ?? []
        list.push(sub)
        out.set(trade, list)
      }
    }
    return out
  }, [allSubs])

  const getSubsForTask = (task) => {
    const trade = String(task?.trade ?? '').trim()
    if (!trade) return { trade: '', subs: allSubs, showingAll: allSubs.length > 0, hadMatches: allSubs.length > 0 }
    const matched = subsByTrade.get(trade) ?? []
    if (matched.length > 0) return { trade, subs: matched, showingAll: false, hadMatches: true }
    return { trade, subs: allSubs, showingAll: allSubs.length > 0, hadMatches: false }
  }

  const previewTracks = useMemo(() => {
    const ordered = TASK_CATEGORIES.map((c) => c.track)
    const seen = new Set(ordered)
    for (const task of draftTasks ?? []) {
      const track = task?.track ?? 'misc'
      if (seen.has(track)) continue
      seen.add(track)
      ordered.push(track)
    }
    return ordered
  }, [draftTasks])

  const getTrackLabel = (track) => TASK_CATEGORIES.find((c) => c.track === track)?.label ?? String(track ?? 'misc')

  const togglePreviewTrack = (track) => {
    setPreviewCollapsedTracks((prev) => {
      const next = new Set(prev)
      if (next.has(track)) next.delete(track)
      else next.add(track)
      return next
    })
  }

  const updateDraftLot = (updater) => {
    if (!resolvedLot) return
    setPreviewTouched(true)
    setDraftTasks((prev) => {
      const base = { ...resolvedLot, tasks: prev }
      const next = updater(base)
      return next?.tasks ?? prev
    })
  }

  const clearPreviewDrag = () => {
    const state = previewDragRef.current
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    state.active = false
    state.pointerId = null
    state.taskId = null
    state.track = null
    state.rowRect = null
    setPreviewDraggingTaskId(null)
    setPreviewDropTaskId(null)
    setPreviewGhost(null)
    const auto = previewAutoScrollRef.current
    auto.vy = 0
    if (auto.raf) cancelAnimationFrame(auto.raf)
    auto.raf = null
  }

  const updatePreviewDropTarget = (x, y) => {
    if (typeof document === 'undefined') return
    const el = document.elementFromPoint(x, y)
    const row = el?.closest?.('[data-preview-task-id]')
    const nextId = row?.dataset?.previewTaskId ?? null
    const nextTrack = row?.dataset?.previewTaskTrack ?? null
    const activeTrack = previewDragRef.current.track
    if (!nextId) return
    if (activeTrack && nextTrack && String(activeTrack) !== String(nextTrack)) return
    setPreviewDropTaskId(nextId)
  }

  const queuePreviewGhostPosition = () => {
    const pos = previewGhostPosRef.current
    if (pos.raf) return
    pos.raf = requestAnimationFrame(() => {
      pos.raf = null
      setPreviewGhost((prev) => (prev ? { ...prev, x: pos.x, y: pos.y } : prev))
    })
  }

  const updatePreviewGhostPosition = (clientX, clientY) => {
    const state = previewDragRef.current
    if (!state.rowRect) return
    previewGhostPosRef.current.x = clientX - state.offsetX
    previewGhostPosRef.current.y = clientY - state.offsetY
    queuePreviewGhostPosition()
  }

  const tickPreviewAutoScroll = () => {
    const auto = previewAutoScrollRef.current
    const el = previewScrollRef.current
    if (!el) {
      auto.raf = null
      return
    }
    if (!auto.vy) {
      auto.raf = null
      return
    }

    el.scrollTop += auto.vy
    auto.raf = requestAnimationFrame(tickPreviewAutoScroll)
  }

  const updatePreviewAutoScroll = (clientY) => {
    const el = previewScrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return
    const edge = Math.max(44, Math.min(72, rect.height * 0.18))

    const distTop = clientY - rect.top
    const distBottom = rect.bottom - clientY

    let vy = 0
    if (distTop >= 0 && distTop < edge) {
      const t = 1 - distTop / edge
      vy = -Math.round(2 + 14 * t * t)
    } else if (distBottom >= 0 && distBottom < edge) {
      const t = 1 - distBottom / edge
      vy = Math.round(2 + 14 * t * t)
    }

    const auto = previewAutoScrollRef.current
    auto.vy = vy
    auto.lastY = clientY
    if (vy && !auto.raf) {
      auto.raf = requestAnimationFrame(tickPreviewAutoScroll)
    }
    if (!vy && auto.raf) {
      cancelAnimationFrame(auto.raf)
      auto.raf = null
    }
  }

  const handlePreviewDragPointerDown = (task, e) => {
    const state = previewDragRef.current
    if (state.timer) clearTimeout(state.timer)
    state.active = false
    state.pointerId = e.pointerId
    state.taskId = task.id
    state.track = task.track
    state.lastX = e.clientX
    state.lastY = e.clientY
    const rowEl = e.currentTarget?.closest?.('[data-preview-task-id]')
    const rect = rowEl?.getBoundingClientRect?.() ?? null
    state.rowRect = rect
    if (rect) {
      state.offsetX = Math.max(12, Math.min(rect.width - 12, e.clientX - rect.left))
      state.offsetY = Math.max(12, Math.min(rect.height - 12, e.clientY - rect.top))
    } else {
      state.offsetX = 16
      state.offsetY = 16
    }

    const targetEl = e.currentTarget
    const pointerId = e.pointerId
    state.timer = setTimeout(() => {
      state.timer = null
      state.active = true
      setPreviewDraggingTaskId(task.id)
      setPreviewDropTaskId(task.id)
      const width = Math.max(260, Math.min(520, Number(state.rowRect?.width ?? 360) || 360))
      const ghostX = state.lastX - state.offsetX
      const ghostY = state.lastY - state.offsetY
      previewGhostPosRef.current.x = ghostX
      previewGhostPosRef.current.y = ghostY
      setPreviewGhost({
        taskId: task.id,
        name: task.name,
        trade: task.trade ?? '',
        start: task.scheduled_start ?? '',
        end: task.scheduled_end ?? '',
        width,
        x: ghostX,
        y: ghostY,
      })
      if (targetEl?.setPointerCapture) {
        try {
          targetEl.setPointerCapture(pointerId)
        } catch (_err) {
          void _err
        }
      }
    }, 60)
  }

  const handlePreviewDragPointerMove = (task, e) => {
    const state = previewDragRef.current
    if (state.taskId !== task.id) return
    state.lastX = e.clientX
    state.lastY = e.clientY
    if (!state.active) return
    e.preventDefault()
    updatePreviewDropTarget(e.clientX, e.clientY)
    updatePreviewAutoScroll(e.clientY)
    updatePreviewGhostPosition(e.clientX, e.clientY)
  }

  const handlePreviewDragPointerUp = (task, e) => {
    const state = previewDragRef.current
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    if (!state.active) return
    state.active = false

    const dropId = previewDropTaskId
    if (dropId && dropId !== task.id) {
      updateDraftLot((current) => applyListReorder(current, task.id, dropId, org))
    }

    if (state.pointerId !== null && e.currentTarget?.releasePointerCapture) {
      try {
        e.currentTarget.releasePointerCapture(state.pointerId)
      } catch (_err) {
        void _err
      }
    }

    clearPreviewDrag()
  }

  const handlePreviewDragPointerCancel = () => {
    clearPreviewDrag()
  }

  const resetPreview = () => {
    if (!resolvedLot || !form.start_date) return
    const nextLot = startLotFromTemplate({
      lot: resolvedLot,
      start_date: form.start_date,
      model_type: resolvedLot?.model_type ?? '',
      plan_id: form.plan_id || null,
      job_number: form.job_number,
      custom_fields: form.custom_fields ?? {},
      address: form.address,
      permit_number: form.permit_number,
      hard_deadline: form.hard_deadline || null,
      template,
      orgSettings: org,
      subcontractors: app.subcontractors,
    })
    const nextTasks = nextLot?.tasks ?? []
    setDraftTasks(nextTasks)
    setPreviewCollapsedTracks(new Set(nextTasks.map((t) => t?.track ?? 'misc')))
    setPreviewTouched(false)
  }

  return (
    <>
      <Modal
      title="Start Lot"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            className="flex-1 bg-green-600"
            disabled={!isOnline || !canStart}
            title={!isOnline ? 'Requires connection to generate schedules' : ''}
            onClick={() => onStart({ lotId: resolvedLotId, form, draftTasks })}
          >
            Start Lot & View Schedule
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        {!prefill?.lot_id ? (
          <>
            <label className="block">
              <span className="text-sm font-semibold">Community *</span>
              <select
                value={communityId}
                onChange={(e) => {
                  const nextCommunityId = e.target.value
                  setCommunityId(nextCommunityId)
                  setLotNumber('')
                  setForm((prev) => ({ ...prev, plan_id: '' }))
                }}
                className="mt-1 w-full px-3 py-3 border rounded-xl"
              >
                <option value="">Select community...</option>
                {communities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-semibold">Lot *</span>
              <select
                value={lotNumber}
                onChange={(e) => setLotNumber(e.target.value)}
                className="mt-1 w-full px-3 py-3 border rounded-xl"
                disabled={!communityId}
              >
                <option value="">Select lot...</option>
                {availableLots.map((l) => (
                  <option key={l.id} value={l.lot_number}>
                    {l.lot_number}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <Card className="p-3">
            <p className="text-sm text-gray-500">{selectedCommunity?.name ?? 'Community'}</p>
            <p className="font-semibold">{resolvedLot ? lotCode(resolvedLot) : '—'}</p>
          </Card>
        )}

        <label className="block">
          <span className="text-sm font-semibold">Start Date *</span>
          <input
            type="date"
            value={form.start_date}
            onChange={(e) => setForm((prev) => ({ ...prev, start_date: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Product Type</span>
          <input
            value={resolvedProductType?.name ?? ''}
            readOnly
            className="mt-1 w-full px-3 py-3 border rounded-xl bg-gray-50"
            placeholder="Select a lot to view"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Plan</span>
          <select
            value={form.plan_id}
            onChange={(e) => setForm((prev) => ({ ...prev, plan_id: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            disabled={!resolvedLotId}
          >
            <option value="">Select plan...</option>
            {availablePlans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Schedule Template</span>
          <input
            value={template?.name ?? 'Default Template'}
            readOnly
            className="mt-1 w-full px-3 py-3 border rounded-xl bg-gray-50"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Build Days Target</span>
          <input type="number" value={buildDays} readOnly className="mt-1 w-full px-3 py-3 border rounded-xl bg-gray-50" />
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Hard Deadline (optional)</span>
          <input
            type="date"
            value={form.hard_deadline}
            onChange={(e) => setForm((prev) => ({ ...prev, hard_deadline: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
          />
          <p className="text-xs text-gray-500 mt-1">Alerts if schedule at risk.</p>
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Address</span>
          <input
            value={form.address}
            onChange={(e) => setForm((prev) => ({ ...prev, address: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            placeholder="456 Oak Valley Drive"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Job Number</span>
          <input
            value={form.job_number}
            onChange={(e) => setForm((prev) => ({ ...prev, job_number: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            placeholder="JOB-2024-001"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Permit Number</span>
          <input
            value={form.permit_number}
            onChange={(e) => setForm((prev) => ({ ...prev, permit_number: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            placeholder="BP-2024-12345"
          />
        </label>

        {(org.custom_fields ?? []).length > 0 ? (
          <Card className="bg-gray-50 border border-gray-200">
            <p className="text-sm font-semibold mb-2">Custom Fields</p>
            <div className="space-y-2">
              {(org.custom_fields ?? []).map((field) => (
                <label key={field.id} className="block">
                  <span className="text-xs text-gray-600">{field.label}</span>
                  <input
                    value={form.custom_fields?.[field.id] ?? ''}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        custom_fields: { ...(prev.custom_fields ?? {}), [field.id]: e.target.value },
                      }))
                    }
                    className="mt-1 w-full px-3 py-2 border rounded-xl text-sm"
                    placeholder={field.label}
                  />
                </label>
              ))}
            </div>
          </Card>
        ) : null}

        <Card className="bg-gray-50 border border-gray-200">
          <p className="text-sm font-semibold text-gray-800 mb-1">📅 Calculated Schedule</p>
          <p className="text-sm text-gray-700">
            Start: <span className="font-semibold">{form.start_date ? formatShortDate(form.start_date) : '—'}</span>
          </p>
          <p className="text-sm text-gray-700">
            Preview Completion:{' '}
            <span className="font-semibold">
              {previewCompletion ? formatShortDate(previewCompletion) : targetCompletion ? formatShortDate(targetCompletion) : '—'}
            </span>
          </p>
          <p className="text-xs text-gray-600 mt-1">{(draftTasks?.length || template?.tasks?.length || 0)} tasks</p>
          <p className="text-[11px] text-gray-500 mt-1">Inspections are recorded in Overview and do not block scheduling.</p>
        </Card>

        {canStart ? (
          <Card className="border border-blue-200 bg-blue-50/40">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">Schedule Preview (before starting)</p>
                <p className="text-xs text-gray-600 mt-1">
                  Drag the handle to swap tasks within a track. Adjust durations, subs, add/delete tasks, then click Start Lot to save.
                </p>
                {previewTouched ? <p className="text-xs text-blue-700 mt-1">Preview modified — changes will be used when you start the lot.</p> : null}
              </div>
              <div className="flex flex-col sm:flex-row gap-2 shrink-0">
                <button
                  type="button"
                  onClick={resetPreview}
                  className="h-10 px-3 rounded-xl border border-gray-200 bg-white text-sm font-semibold disabled:opacity-50"
                  disabled={!previewTouched}
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewAddTaskOpen(true)}
                  className="h-10 px-3 rounded-xl bg-blue-600 text-white text-sm font-semibold"
                >
                  + Add Task
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewBufferOpen(true)}
                  className="h-10 px-3 rounded-xl border border-amber-200 bg-amber-50 text-amber-900 text-sm font-semibold"
                >
                  + Add Buffer
                </button>
              </div>
            </div>

            {draftTasks.length === 0 ? (
              <p className="text-sm text-gray-600 mt-3">Select a lot and start date to generate a preview schedule.</p>
            ) : (
              <div className="mt-3">
                <div className="relative mt-2">
                  <div
                    ref={previewScrollRef}
                    className="max-h-[52vh] overflow-y-auto overscroll-contain rounded-xl border border-blue-200 bg-white/70 p-2"
                    style={{ WebkitOverflowScrolling: 'touch' }}
                  >
                    <div className="space-y-3">
                      {previewTracks.map((track) => {
                        const tasksForTrack = (draftTasks ?? [])
                          .filter((t) => (t?.track ?? 'misc') === track)
                          .slice()
                          .sort(
                            (a, b) =>
                              (Number(a.sort_order ?? 0) || 0) - (Number(b.sort_order ?? 0) || 0) ||
                              String(a.name).localeCompare(String(b.name)),
                          )
                        if (tasksForTrack.length === 0) return null
                        const collapsed = previewCollapsedTracks.has(track)

                        return (
                          <div key={track}>
                            <button
                              type="button"
                              onClick={() => togglePreviewTrack(track)}
                              className="w-full flex items-center justify-between px-1 py-2 rounded-lg hover:bg-blue-50/60"
                              aria-expanded={!collapsed}
                            >
                              <span className="text-[11px] font-semibold text-gray-700 flex items-center gap-2">
                                {collapsed ? <ChevronRight className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
                                {getTrackLabel(track)}
                                <span className="text-[10px] text-gray-500 font-semibold">{tasksForTrack.length}</span>
                              </span>
                              <span className="text-[11px] text-blue-700">{collapsed ? 'Show' : 'Hide'}</span>
                            </button>

                            {!collapsed ? <div className="space-y-2">
                              {tasksForTrack.map((task) => {
                                const dropHot = Boolean(previewDraggingTaskId) && previewDropTaskId === task.id
                                const dragging = previewDraggingTaskId === task.id
                                const subOptions = getSubsForTask(task)
                                return (
                                  <div
                                    key={task.id}
                                    data-preview-task-id={task.id}
                                    data-preview-task-track={task.track ?? 'misc'}
                                    className={`p-3 rounded-xl border transition-colors ${
                                      dropHot ? 'border-blue-400 bg-blue-100/60' : 'border-gray-200 bg-white'
                                    } ${dragging ? 'opacity-30' : ''}`}
                                  >
                                    <div className="flex items-start gap-2">
                                      <button
                                        type="button"
                                        className="touch-none select-none shrink-0 w-11 h-11 rounded-xl border border-gray-200 bg-white text-gray-500 flex items-center justify-center cursor-grab active:cursor-grabbing"
                                        title="Drag to reorder (swap)"
                                        onPointerDown={(e) => handlePreviewDragPointerDown(task, e)}
                                        onPointerMove={(e) => handlePreviewDragPointerMove(task, e)}
                                        onPointerUp={(e) => handlePreviewDragPointerUp(task, e)}
                                        onPointerCancel={handlePreviewDragPointerCancel}
                                      >
                                        <GripVertical className="w-5 h-5" />
                                      </button>

                                      <div className="min-w-0 flex-1">
                                        <p className="text-sm font-semibold text-gray-900">{task.name}</p>
                                        <p className="text-[11px] text-gray-600 mt-0.5">
                                          {task.scheduled_start ? formatShortDateWithWeekday(task.scheduled_start) : '—'} –{' '}
                                          {task.scheduled_end ? formatShortDateWithWeekday(task.scheduled_end) : '—'}
                                          {task.trade ? ` • ${task.trade}` : ''}
                                        </p>
                                      </div>

                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (!resolvedLot) return
                                          const ok = window.confirm(`Delete this task from the preview?\n\n${task.name}`)
                                          if (!ok) return
                                          setPreviewTouched(true)
                                          setDraftTasks((prev) => {
                                            const nextTasks = prev.filter((t) => t.id !== task.id)
                                            const nextLot = rebuildTrackSchedule({ ...resolvedLot, tasks: nextTasks }, task.track, org)
                                            return nextLot?.tasks ?? nextTasks
                                          })
                                        }}
                                        className="shrink-0 h-10 px-3 rounded-xl border border-red-200 bg-red-50 text-red-700 text-xs font-semibold"
                                      >
                                        Delete
                                      </button>
                                    </div>

                                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <label className="block">
                                        <span className="text-[11px] font-semibold text-gray-600">Start date</span>
                                        <input
                                          type="date"
                                          value={task.scheduled_start ?? ''}
                                          onChange={(e) => updateDraftLot((current) => applyManualStartDate(current, task.id, e.target.value, org))}
                                          className="mt-1 w-full px-3 py-3 border border-gray-200 rounded-xl text-sm"
                                          disabled={isBufferTask(task)}
                                        />
                                      </label>

                                      <label className="block">
                                        <span className="text-[11px] font-semibold text-gray-600">Duration (days)</span>
                                        <div className="mt-1 grid grid-cols-[44px_1fr_44px] gap-2">
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const currentDuration = Math.max(1, Number(task.duration ?? 1) || 1)
                                              const next = Math.max(1, currentDuration - 1)
                                              updateDraftLot((current) => applyDurationChange(current, task.id, next, org))
                                            }}
                                            disabled={Math.max(1, Number(task.duration ?? 1) || 1) <= 1}
                                            className="h-11 w-11 rounded-xl border border-gray-200 bg-white text-gray-900 font-semibold disabled:opacity-50"
                                            aria-label="Decrease duration"
                                          >
                                            –
                                          </button>
                                          <input
                                            type="number"
                                            min="1"
                                            value={Math.max(1, Number(task.duration ?? 1) || 1)}
                                            onChange={(e) => {
                                              const next = Math.max(1, Number(e.target.value) || 1)
                                              updateDraftLot((current) => applyDurationChange(current, task.id, next, org))
                                            }}
                                            className="h-11 w-full px-3 border border-gray-200 rounded-xl text-sm text-center"
                                            inputMode="numeric"
                                          />
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const currentDuration = Math.max(1, Number(task.duration ?? 1) || 1)
                                              const next = currentDuration + 1
                                              updateDraftLot((current) => applyDurationChange(current, task.id, next, org))
                                            }}
                                            className="h-11 w-11 rounded-xl border border-gray-200 bg-white text-gray-900 font-semibold"
                                            aria-label="Increase duration"
                                          >
                                            +
                                          </button>
                                        </div>
                                      </label>

                                      <label className="block sm:col-span-2">
                                        <span className="text-[11px] font-semibold text-gray-600">Assign Sub</span>
                                        <select
                                          value={task.sub_id ?? ''}
                                          onChange={(e) => {
                                            const nextSubId = e.target.value || null
                                            setPreviewTouched(true)
                                            setDraftTasks((prev) =>
                                              prev.map((t) => (t.id === task.id ? { ...t, sub_id: nextSubId } : t)),
                                            )
                                          }}
                                          className="mt-1 w-full px-3 py-3 border border-gray-200 rounded-xl text-sm"
                                        >
                                          <option value="">Unassigned</option>
                                          {subOptions.subs.map((s) => (
                                            <option key={s.id} value={s.id}>
                                              {s.company_name}
                                            </option>
                                          ))}
                                        </select>
                                        {subOptions.trade && subOptions.showingAll && !subOptions.hadMatches ? (
                                          <p className="text-[11px] text-gray-500 mt-1">
                                            No subs match “{subOptions.trade}” — showing all subs.
                                          </p>
                                        ) : null}
                                      </label>
                                    </div>
                                  </div>
                                )
                              })}
                            </div> : null}
                          </div>
                        )
                      })}
                    </div>

                    <div className="h-10" />
                  </div>
                </div>
              </div>
            )}
          </Card>
        ) : null}
      </div>
      </Modal>

      {previewAddTaskOpen && previewLot ? (
        <AddTaskModal
          lot={previewLot}
          org={org}
          subcontractors={app.subcontractors}
          onClose={() => setPreviewAddTaskOpen(false)}
          onSave={(newTask) => {
            setPreviewAddTaskOpen(false)
            if (!resolvedLot) return
            setPreviewTouched(true)
            setDraftTasks((prev) => {
              const nextTasks = [...prev, newTask]
              const normalized = normalizeTrackSortOrderBySchedule({ ...resolvedLot, tasks: nextTasks }, newTask.track)
              return normalized?.tasks ?? nextTasks
            })
          }}
        />
      ) : null}

      {previewBufferOpen && previewLot ? (
        <CreateBufferModal
          lot={previewLot}
          org={org}
          onClose={() => setPreviewBufferOpen(false)}
          onCreate={({ anchorTaskId, days, bufferTaskId }) => {
            setPreviewBufferOpen(false)
            if (!resolvedLot || !anchorTaskId) return
            const value = Math.max(1, Number(days) || 1)
            setPreviewTouched(true)
            setDraftTasks((prev) => {
              const base = { ...resolvedLot, tasks: prev }
              const nextLot = insertBufferTaskAfter(base, anchorTaskId, value, org, { buffer_task_id: bufferTaskId })
              return nextLot?.tasks ?? prev
            })
          }}
        />
      ) : null}

      {previewGhost ? (
        <div
          className="fixed left-0 top-0 z-[9999] pointer-events-none"
          style={{
            transform: `translate3d(${Math.round(previewGhost.x)}px, ${Math.round(previewGhost.y)}px, 0)`,
            width: previewGhost.width,
          }}
        >
          <div className="rounded-2xl border border-blue-300 bg-white shadow-2xl ring-2 ring-blue-200/40">
            <div className="p-3">
              <div className="flex items-start gap-2">
                <div className="shrink-0 w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center">
                  <GripVertical className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-900 truncate">{previewGhost.name}</p>
                  <p className="text-[11px] text-gray-600 mt-0.5 truncate">
                    {previewGhost.start ? formatShortDateWithWeekday(previewGhost.start) : '—'} –{' '}
                    {previewGhost.end ? formatShortDateWithWeekday(previewGhost.end) : '—'}
                    {previewGhost.trade ? ` • ${previewGhost.trade}` : ''}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

function TaskModal({
  lot,
  community,
  task,
  status,
  sub,
  isOnline,
  onOpenTask,
  specAcknowledgements,
  specDismissals,
  onToggleSpecAck,
  onDismissSpec,
  onClose,
  onStart,
  onRequestComplete,
  onDelay,
  onReschedule,
  onBuffer,
  onAddPhoto,
  onMessage,
  onMarkIncomplete,
  onDeleteTask,
  onAddFile,
  onRemoveFile,
}) {
  const relevantSpecs = useMemo(() => {
    const specs = community?.specs ?? []
    return specs.filter((s) => {
      const appliesTo = s.applies_to ?? 'all'
      const productTypeMatch = appliesTo === 'product_type' ? (s.product_type_ids ?? []).includes(lot.product_type_id) : true
      const planMatch = appliesTo === 'plan' ? (s.plan_ids ?? []).includes(lot.plan_id) : true
      const appliesOk = appliesTo === 'all' || (appliesTo === 'product_type' && productTypeMatch) || (appliesTo === 'plan' && planMatch)
      if (!appliesOk) return false
      const tradeTrigger = String(s.trade_trigger ?? '').trim()
      const taskTrigger = String(s.task_trigger ?? '').trim()
      const tradeOk = !tradeTrigger || tradeTrigger === task.trade
      const taskOk = !taskTrigger || String(task.name ?? '').toLowerCase().includes(taskTrigger.toLowerCase())
      return tradeOk && taskOk
    })
  }, [community, task, lot])

  const visibleSpecs = useMemo(() => relevantSpecs.filter((s) => !(specDismissals ?? {})[s.id]), [relevantSpecs, specDismissals])
  const requiredSpecs = visibleSpecs.filter((s) => s.priority === 'required')
  const preferredSpecs = visibleSpecs.filter((s) => s.priority === 'preferred')
  const infoSpecs = visibleSpecs.filter((s) => s.priority === 'info')
  const [specExpanded, setSpecExpanded] = useState(() => requiredSpecs.length > 0)
  const taskDocuments = useMemo(() => (Array.isArray(task.documents) ? task.documents : []), [task.documents])
  const [fileLabel, setFileLabel] = useState('')
  const [fileDescription, setFileDescription] = useState('')
  const [fileAttachment, setFileAttachment] = useState(null)

  const getReq = (taskName) => {
    if (!taskName) return null
    const directKey = Object.keys(PHOTO_REQUIREMENTS ?? {}).find((k) => String(taskName).includes(k))
    if (directKey) return { key: directKey, ...PHOTO_REQUIREMENTS[directKey] }
    if (taskName === 'Final Clean' && PHOTO_REQUIREMENTS['Final Inspection']) {
      return { key: 'Final Inspection', ...PHOTO_REQUIREMENTS['Final Inspection'] }
    }
    return null
  }

  const photoReq = getReq(task.name)
  const taskPhotoIds = new Set(task.photos ?? [])
  const taskPhotos = (lot.photos ?? []).filter((p) => taskPhotoIds.has(p.id))
  const photoCountOk = !photoReq || taskPhotos.length >= Number(photoReq.min ?? 0)

  const presentAngles = new Set()
  for (const p of taskPhotos) {
    for (const tag of p.tags ?? []) presentAngles.add(tag)
  }
  const requiredAngles = Array.isArray(photoReq?.angles) ? photoReq.angles : []
  const missingAngles = requiredAngles.filter((a) => !presentAngles.has(a))
  const anglesOk = !photoReq || requiredAngles.length === 0 || missingAngles.length === 0

  const specsOk = requiredSpecs.length === 0 || requiredSpecs.every((s) => Boolean(specAcknowledgements?.[s.id]))
  const canComplete = specsOk
  const photoMissing = Boolean(photoReq && (!photoCountOk || !anglesOk))
  const canStart = status !== 'complete' && status !== 'in_progress'
  const startLabel = 'Start Task'

  const taskTrack = task?.track ?? 'misc'
  const inProgressSameTrack = useMemo(() => {
    const list = lot?.tasks ?? []
    return list.filter((t) => t && t.id !== task?.id && (t.track ?? 'misc') === taskTrack && t.status === 'in_progress')
  }, [lot, task, taskTrack])

  const possibleBlockers = useMemo(() => {
    if (status !== 'blocked') return []
    const list = (lot?.tasks ?? []).filter(Boolean)
    const group = list.filter((t) => (t.track ?? 'misc') === taskTrack && t.id !== task?.id && t.status !== 'complete')

    const currentStart = task?.scheduled_start ? parseISODate(task.scheduled_start)?.getTime() ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
    const currentOrder = Number(task?.sort_order ?? 0) || 0

    group.sort((a, b) => {
      const aStart = a.scheduled_start ? parseISODate(a.scheduled_start)?.getTime() ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
      const bStart = b.scheduled_start ? parseISODate(b.scheduled_start)?.getTime() ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
      if (aStart !== bStart) return aStart - bStart
      return (Number(a.sort_order ?? 0) || 0) - (Number(b.sort_order ?? 0) || 0)
    })

    const earlier = group.filter((t) => {
      const tStart = t.scheduled_start ? parseISODate(t.scheduled_start)?.getTime() ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
      const tOrder = Number(t.sort_order ?? 0) || 0
      if (tStart < currentStart) return true
      if (tStart === currentStart && tOrder < currentOrder) return true
      return false
    })

    return earlier.slice(0, 3)
  }, [status, lot, task, taskTrack])

  const handleStart = () => {
    if (!canStart) return

    const warnings = []
    if (inProgressSameTrack.length > 0) {
      const label = inProgressSameTrack[0]?.name ?? 'another task'
      warnings.push(`Another task is already In Progress in this track: ${label}.`)
    }
    if (status === 'blocked') warnings.push('This task is marked Blocked.')

    if (warnings.length > 0) {
      const ok = window.confirm(`Start this task?\n\nHeads up:\n- ${warnings.join('\n- ')}\n\nYou can still start it if needed.`)
      if (!ok) return
    }

    onStart?.()
  }

  return (
    <Modal title={task.name} onClose={onClose}>
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-gray-500">
                {community?.name ?? 'Community'} • {lotCode(lot)}
              </p>
              <p className="text-xs text-gray-600 mt-1">
                Scheduled: {formatShortDateWithWeekday(task.scheduled_start)} - {formatShortDateWithWeekday(task.scheduled_end)} • {task.duration}d
              </p>
              <p className="text-xs text-gray-600 mt-1">
                Sub: {sub?.company_name ?? 'Unassigned'}
              </p>
            </div>
            <TaskStatusBadge status={status} />
          </div>
        </Card>

        {status === 'blocked' ? (
          <Card className="border-orange-200 bg-orange-50">
            <p className="text-sm font-semibold text-orange-800">Blocked</p>
            {possibleBlockers.length > 0 ? (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-orange-800">Possible blockers in this track:</p>
                {possibleBlockers.map((t) => (
                  <div key={t.id} className="bg-white/70 border border-orange-200 rounded-xl p-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{t.name}</p>
                      <p className="text-[11px] text-gray-600 mt-0.5">
                        {t.scheduled_start ? formatShortDateWithWeekday(t.scheduled_start) : '—'} -{' '}
                        {t.scheduled_end ? formatShortDateWithWeekday(t.scheduled_end) : '—'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenTask?.(t.id)}
                      className="shrink-0 h-9 px-3 rounded-xl bg-white border border-orange-200 text-orange-800 text-sm font-semibold"
                    >
                      Open
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-orange-800 mt-1">
                This task is blocked. Common reasons: waiting on a prior task, an inspection, or a required spec.
              </p>
            )}
          </Card>
        ) : null}

        {visibleSpecs.length > 0 && (
          <Card className="border-purple-200 bg-purple-50">
            <button onClick={() => setSpecExpanded((v) => !v)} className="w-full flex items-center justify-between">
              <p className="text-sm font-semibold text-purple-800 flex items-center gap-2">
                📋 Community Spec
                {requiredSpecs.length > 0 ? <span className="text-xs">(Required)</span> : null}
                {infoSpecs.length > 0 ? <span className="text-xs bg-white/70 border border-purple-200 px-2 py-0.5 rounded-full">Info {infoSpecs.length}</span> : null}
              </p>
              <span className="text-purple-700 text-sm font-semibold">{specExpanded ? '▲' : '▼'}</span>
            </button>

            {specExpanded ? (
              <div className="mt-2 space-y-3">
                {requiredSpecs.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-purple-800">REQUIRED</p>
                    {requiredSpecs.map((spec) => {
                      const checked = Boolean(specAcknowledgements?.[spec.id])
                      return (
                        <div key={spec.id} className="bg-white rounded-xl border border-purple-100 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-semibold text-gray-900">{spec.title}</p>
                              <p className="text-xs text-gray-600 mt-1">{spec.description}</p>
                            </div>
                            <label className="inline-flex items-center gap-2 text-xs text-gray-700">
                              <input type="checkbox" checked={checked} onChange={() => onToggleSpecAck?.(spec.id)} />
                              Ack
                            </label>
                          </div>
                        </div>
                      )
                    })}
                    {!specsOk ? (
                      <p className="text-xs text-purple-800">Acknowledge required specs to enable completion.</p>
                    ) : null}
                  </div>
                ) : null}

                {preferredSpecs.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-purple-800">PREFERRED</p>
                    {preferredSpecs.map((spec) => (
                      <div key={spec.id} className="bg-white rounded-xl border border-purple-100 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-900">{spec.title}</p>
                            <p className="text-xs text-gray-600 mt-1">{spec.description}</p>
                          </div>
                          <button
                            onClick={() => onDismissSpec?.(spec.id)}
                            className="text-xs font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {infoSpecs.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-purple-800">INFO</p>
                    {infoSpecs.map((spec) => (
                      <div key={spec.id} className="bg-white rounded-xl border border-purple-100 p-3">
                        <p className="font-semibold text-gray-900">{spec.title}</p>
                        <p className="text-xs text-gray-600 mt-1">{spec.description}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </Card>
        )}

        {photoReq ? (
          <Card className={`border ${photoCountOk && anglesOk ? 'border-green-200 bg-green-50' : 'border-orange-200 bg-orange-50'}`}>
            <p className="text-sm font-semibold text-gray-900 flex items-center justify-between">
              📷 Photo Checklist <span className="text-xs font-semibold text-gray-600">(Recommended)</span>
              <span className="text-xs font-semibold">
                {taskPhotos.length}/{photoReq.min}
              </span>
            </p>
            <p className="text-xs text-gray-700 mt-1">
              {photoReq.key} • Minimum {photoReq.min} photo(s)
            </p>
            {requiredAngles.length > 0 ? (
              <div className="mt-2 text-xs text-gray-700">
                <p className="font-semibold">Required angles:</p>
                <p className="mt-1">
                  {requiredAngles.map((a) => (missingAngles.includes(a) ? `❌ ${a}` : `✅ ${a}`)).join(' • ')}
                </p>
              </div>
            ) : null}
            {!photoCountOk || !anglesOk ? (
              <p className="text-xs text-orange-800 mt-2">
                Missing recommended photos/angles. You can still mark complete, but photos help with documentation.
              </p>
            ) : null}
          </Card>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onDelay}
            className="h-12 rounded-xl bg-red-50 text-red-700 border border-red-200 font-semibold"
          >
            ⚠️ Delay
          </button>
          <button
            onClick={onReschedule}
            className="h-12 rounded-xl bg-white border border-gray-200 text-gray-900 font-semibold flex items-center justify-center gap-2"
          >
            <Calendar className="w-5 h-5" /> Reschedule
          </button>
          <button
            onClick={onBuffer}
            className="h-12 rounded-xl bg-white border border-gray-200 text-gray-900 font-semibold flex items-center justify-center gap-2"
          >
            <Plus className="w-5 h-5" /> Buffer
          </button>
          <button
            onClick={onAddPhoto}
            className="h-12 rounded-xl bg-white border border-gray-200 text-gray-900 font-semibold flex items-center justify-center gap-2"
          >
            <Image className="w-5 h-5" /> Add Photo
          </button>
          <button
            onClick={onMessage}
            disabled={!sub}
            className="h-12 rounded-xl bg-white border border-gray-200 text-gray-900 font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <MessageSquare className="w-5 h-5" /> Message
          </button>
        </div>

        <div className="flex gap-2">
          {canStart ? (
            <PrimaryButton onClick={handleStart} className="flex-1 bg-green-600">
              {startLabel}
            </PrimaryButton>
          ) : null}
          {status === 'in_progress' ? (
            <PrimaryButton onClick={onRequestComplete} className="flex-1" disabled={!canComplete}>
              <Check className="w-4 h-4 inline mr-1" /> Mark Complete
            </PrimaryButton>
          ) : null}
        </div>

        <div className="flex gap-2">
          {status === 'complete' ? (
            <SecondaryButton onClick={onMarkIncomplete} className="flex-1">
              Mark Incomplete
            </SecondaryButton>
          ) : null}
          <button
            type="button"
            onClick={onDeleteTask}
            disabled={status === 'in_progress'}
            className="flex-1 h-11 rounded-xl border border-red-200 bg-red-50 text-red-700 font-semibold disabled:opacity-50"
            title={status === 'in_progress' ? 'Complete or stop the task before deleting.' : 'Delete task'}
          >
            Delete Task
          </button>
        </div>

        <Card>
          <div className="flex items-center justify-between">
            <p className="font-semibold">Files</p>
            <span className="text-xs text-gray-500">{taskDocuments.length} attached</span>
          </div>
          {!isOnline ? <p className="text-xs text-gray-500 mt-1">Offline — files save locally and sync later.</p> : null}
          <div className="mt-2 space-y-2">
            {taskDocuments.length === 0 ? (
              <p className="text-xs text-gray-500">No files attached.</p>
            ) : (
              taskDocuments
                .slice()
                .sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)))
                .map((doc) => (
                  <div key={doc.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate">{doc.label || doc.file_name || 'File'}</p>
                        {doc.description ? <p className="text-xs text-gray-600 mt-1">{doc.description}</p> : null}
                        <p className="text-[11px] text-gray-500 mt-1">{doc.file_name}</p>
                      </div>
                      <div className="flex flex-col gap-2">
                        <button
                          type="button"
                          onClick={() => openBlobInNewTab(doc.blob_id)}
                          className="px-2 py-1 rounded-lg border border-gray-200 bg-white text-xs font-semibold"
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveFile?.(doc.id)}
                          className="px-2 py-1 rounded-lg border border-red-200 bg-red-50 text-xs font-semibold text-red-700"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                ))
            )}
          </div>

          <div className="mt-3 space-y-2">
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Label *</span>
              <input
                value={fileLabel}
                onChange={(e) => setFileLabel(e.target.value)}
                className="mt-1 w-full px-3 py-2 border rounded-lg text-sm"
                placeholder="Permit, scope sheet, inspection memo..."
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Description</span>
              <input
                value={fileDescription}
                onChange={(e) => setFileDescription(e.target.value)}
                className="mt-1 w-full px-3 py-2 border rounded-lg text-sm"
                placeholder="Optional context"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">File</span>
              <label className="mt-1 w-full h-11 inline-flex items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold cursor-pointer">
                <span className="truncate">{fileAttachment ? fileAttachment.name : 'Choose file'}</span>
                <span className="text-xs text-gray-500">Browse</span>
                <input
                  type="file"
                  accept={FILE_ACCEPT}
                  onChange={(e) => {
                    const nextFile = e.target.files?.[0] ?? null
                    setFileAttachment(nextFile)
                    if (nextFile && !fileLabel.trim()) setFileLabel(nextFile.name ?? '')
                    e.target.value = ''
                  }}
                  className="hidden"
                />
              </label>
              <p className="text-[11px] text-gray-500 mt-1">CSV, Excel, Word, PDF, or images • Max 50MB.</p>
            </label>
            <PrimaryButton
              onClick={async () => {
                if (!fileAttachment || !fileLabel.trim()) return
                const added = await onAddFile?.({ label: fileLabel, description: fileDescription, file: fileAttachment })
                if (added) {
                  setFileLabel('')
                  setFileDescription('')
                  setFileAttachment(null)
                }
              }}
              className="w-full"
              disabled={!fileAttachment || !fileLabel.trim()}
            >
              Add File
            </PrimaryButton>
          </div>
        </Card>

        {!isOnline ? (
          <div className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-xl p-3">
            Offline mode: changes save locally; notifications send when back online.
          </div>
        ) : null}

        {photoMissing ? (
          <div className="text-xs text-gray-700 bg-yellow-50 border border-yellow-200 rounded-xl p-3">
            ⚠️ Photos are recommended for this task, but not required to complete.
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

function AddTaskModal({ lot, org, subcontractors, onClose, onSave }) {
  const [categoryId, setCategoryId] = useState(() => TASK_CATEGORIES[3]?.id ?? 'exterior')
  const category = TASK_CATEGORIES.find((c) => c.id === categoryId) ?? TASK_CATEGORIES[0]
  const presetsForCategory = TASK_PRESETS.filter((p) => p.category === categoryId)
  const presets = [...presetsForCategory, CUSTOM_TASK_PRESET]
  const defaultPreset = presets[0] ?? CUSTOM_TASK_PRESET
  const [presetId, setPresetId] = useState(defaultPreset.id)
  const [draft, setDraft] = useState(() => ({
    name: defaultPreset.name,
    trade: defaultPreset.trade,
    duration: defaultPreset.duration,
    start_date: formatISODate(new Date()),
    sub_id: '',
  }))
  const { getNextWorkDay, addWorkDays } = makeWorkdayHelpers(org)

  useEffect(() => {
    const nextPreset = presets[0] ?? CUSTOM_TASK_PRESET
    setPresetId(nextPreset.id)
    setDraft((prev) => ({
      ...prev,
      name: nextPreset.name,
      trade: nextPreset.trade,
      duration: nextPreset.duration,
      sub_id: '',
    }))
  }, [categoryId, presets])

  useEffect(() => {
    const preset = presets.find((p) => p.id === presetId)
    if (!preset || preset.id === 'custom') return
    setDraft((prev) => ({
      ...prev,
      name: preset.name,
      trade: preset.trade,
      duration: preset.duration,
    }))
  }, [presetId, presets])

  const allSubs = useMemo(
    () => (subcontractors ?? []).slice().sort((a, b) => String(a.company_name).localeCompare(String(b.company_name))),
    [subcontractors],
  )
  const matchingSubs = useMemo(
    () => allSubs.filter((s) => s.trade === draft.trade || (s.secondary_trades ?? []).includes(draft.trade)),
    [allSubs, draft.trade],
  )
  const subsForSelect = matchingSubs.length > 0 ? matchingSubs : allSubs
  const showingAllSubs = matchingSubs.length === 0 && allSubs.length > 0
  const validSubIds = useMemo(() => new Set(subsForSelect.map((s) => s.id)), [subsForSelect])
  const effectiveSubId = validSubIds.has(draft.sub_id) ? draft.sub_id : ''

  const normalizedStart = useMemo(() => {
    if (!draft.start_date) return ''
    const next = getNextWorkDay(draft.start_date) ?? parseISODate(draft.start_date)
    return next ? formatISODate(next) : draft.start_date
  }, [draft.start_date, getNextWorkDay])

  const durationValue = Math.max(1, Number(draft.duration) || 1)
  const endDate = normalizedStart ? formatISODate(addWorkDays(normalizedStart, durationValue - 1)) : ''
  const canSave = Boolean(draft.name.trim()) && Boolean(normalizedStart)

  return (
    <Modal
      title="Create Task"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() => {
              if (!canSave) return
              const trackTasks = (lot.tasks ?? []).filter((t) => t.track === category.track)
              const maxSort = Math.max(0, ...trackTasks.map((t) => Number(t.sort_order ?? 0) || 0))
              const now = new Date().toISOString()
              onSave?.({
                id: uuid(),
                lot_id: lot.id,
                name: draft.name.trim(),
                description: null,
                trade: draft.trade,
                phase: category.phase ?? 'misc',
                track: category.track ?? 'misc',
                sub_id: effectiveSubId || null,
                duration: durationValue,
                scheduled_start: normalizedStart,
                scheduled_end: endDate,
                actual_start: null,
                actual_end: null,
                status: 'pending',
                delay_days: 0,
                delay_reason: null,
                delay_notes: null,
                delay_logged_at: null,
                delay_logged_by: null,
                requires_inspection: false,
                inspection_type: null,
                inspection_id: null,
                is_outdoor: Boolean(category.is_outdoor),
                is_critical_path: false,
                blocks_final: false,
                lead_time_days: 0,
                photos: [],
                documents: [],
                notes: [],
                sort_order: maxSort + 1,
                created_at: now,
                updated_at: now,
              })
            }}
            className="flex-1"
            disabled={!canSave}
          >
            Add Task
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">
            {lotCode(lot)} • Manual tasks flow into the schedule by date and duration.
          </p>
        </Card>

        <label className="block">
          <span className="text-sm font-semibold">Category</span>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
          >
            {TASK_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Preset</span>
          <select
            value={presetId}
            onChange={(e) => setPresetId(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Task Name</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            placeholder="Exterior Paint"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-sm font-semibold">Trade</span>
            <select
              value={draft.trade}
              onChange={(e) => setDraft((prev) => ({ ...prev, trade: e.target.value, sub_id: '' }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
            >
              {TRADES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-semibold">Duration (days)</span>
            <input
              type="number"
              min="1"
              value={draft.duration}
              onChange={(e) => setDraft((prev) => ({ ...prev, duration: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-sm font-semibold">Start Date</span>
          <input
            type="date"
            value={draft.start_date}
            onChange={(e) => setDraft((prev) => ({ ...prev, start_date: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
          />
          {normalizedStart && normalizedStart !== draft.start_date ? (
            <p className="text-xs text-gray-600 mt-1">Adjusted to next workday: {formatShortDate(normalizedStart)}</p>
          ) : null}
          {endDate ? <p className="text-xs text-gray-600 mt-1">Ends: {formatShortDate(endDate)}</p> : null}
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Assign Sub (optional)</span>
          <select
            value={effectiveSubId}
            onChange={(e) => setDraft((prev) => ({ ...prev, sub_id: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
          >
            <option value="">Unassigned</option>
            {subsForSelect.map((s) => (
              <option key={s.id} value={s.id}>
                {s.company_name}
              </option>
            ))}
          </select>
          {showingAllSubs ? (
            <p className="text-xs text-gray-600 mt-1">No subs match this trade yet — showing all subs.</p>
          ) : null}
          {!showingAllSubs && subsForSelect.length === 0 ? (
            <p className="text-xs text-gray-600 mt-1">No subcontractors available yet.</p>
          ) : null}
        </label>
      </div>
    </Modal>
  )
}

function ImpactDatePill({ tone = 'old', label }) {
  const cls =
    tone === 'new'
      ? 'bg-blue-50 border-blue-200 text-blue-800'
      : tone === 'buffer'
        ? 'bg-amber-50 border-amber-200 text-amber-900'
        : 'bg-white border-gray-200 text-gray-700'
  return <span className={`inline-flex items-center px-2 py-1 rounded-full border text-[11px] font-semibold ${cls}`}>{label}</span>
}

function ImpactDeltaPill({ delta }) {
  if (!delta) return null
  const cls = delta > 0 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-emerald-700 bg-emerald-50 border-emerald-200'
  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-full border text-[11px] font-semibold ${cls}`}>
      {delta > 0 ? `+${delta}` : delta}d
    </span>
  )
}

function ImpactPreviewCard({ affected, buffer, oldCompletion, newCompletion, maxItems = 8 }) {
  const trackIndex = useMemo(() => new Map(TASK_CATEGORIES.map((c, idx) => [c.track, idx])), [])
  const sorted = useMemo(() => {
    const list = Array.isArray(affected) ? affected.slice() : []
    list.sort((a, b) => {
      const ai = trackIndex.get(a?.track) ?? 999
      const bi = trackIndex.get(b?.track) ?? 999
      if (ai !== bi) return ai - bi
      const sa = String(a?.old_start ?? a?.new_start ?? '')
      const sb = String(b?.old_start ?? b?.new_start ?? '')
      const sd = sa.localeCompare(sb)
      if (sd !== 0) return sd
      return String(a?.task_name ?? '').localeCompare(String(b?.task_name ?? ''))
    })
    return list
  }, [affected, trackIndex])

  const completionDelta = useMemo(() => {
    if (!oldCompletion || !newCompletion) return null
    return daysBetweenCalendar(newCompletion, oldCompletion)
  }, [newCompletion, oldCompletion])

  return (
    <Card className="bg-gradient-to-b from-white to-gray-50">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-800">Impact Preview</p>
          <p className="text-xs text-gray-600">
            {sorted.length} task{sorted.length === 1 ? '' : 's'} shifting
            {newCompletion ? ` • New completion: ${formatShortDateWithWeekday(newCompletion)}` : ''}
          </p>
        </div>
        {oldCompletion && newCompletion ? (
          <div className="text-right">
            <p className="text-[11px] text-gray-500 font-semibold">Completion</p>
            <div className="mt-1 flex items-center justify-end gap-2">
              <ImpactDatePill tone="old" label={formatShortDateWithWeekday(oldCompletion)} />
              <span className="text-[11px] text-gray-400">→</span>
              <ImpactDatePill tone="new" label={formatShortDateWithWeekday(newCompletion)} />
              {completionDelta ? <ImpactDeltaPill delta={completionDelta} /> : null}
            </div>
          </div>
        ) : null}
      </div>

      {buffer?.start && buffer?.end ? (
        <div className="mt-3 bg-white border border-dashed border-amber-300 rounded-xl p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-amber-900">New Buffer Block</p>
            <span className="text-xs text-amber-900">
              {typeof buffer?.duration_days === 'number' ? `${buffer.duration_days}d` : ''}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <ImpactDatePill tone="buffer" label={formatShortDateWithWeekday(buffer.start)} />
            <span className="text-[11px] text-amber-700">to</span>
            <ImpactDatePill tone="buffer" label={formatShortDateWithWeekday(buffer.end)} />
          </div>
        </div>
      ) : null}

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-600 mt-3">No downstream date changes yet.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {sorted.slice(0, maxItems).map((a) => {
            const oldStart = a?.old_start ?? ''
            const newStart = a?.new_start ?? ''
            const oldEnd = a?.old_end ?? ''
            const newEnd = a?.new_end ?? ''
            const delta = oldStart && newStart ? daysBetweenCalendar(newStart, oldStart) : 0
            return (
              <div key={a.task_id} className="bg-white border border-gray-200 rounded-xl p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate">{a.task_name}</p>
                    <p className="text-[11px] text-gray-500 mt-1">
                      {(TASK_CATEGORIES.find((c) => c.track === a.track)?.label ?? a.track ?? 'Track').toString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <ImpactDatePill tone="old" label={oldStart ? formatShortDateWithWeekday(oldStart) : '—'} />
                    <span className="text-[11px] text-gray-400">→</span>
                    <ImpactDatePill tone="new" label={newStart ? formatShortDateWithWeekday(newStart) : '—'} />
                    <ImpactDeltaPill delta={delta} />
                  </div>
                </div>
                {oldEnd && newEnd ? (
                  <p className="text-[11px] text-gray-600 mt-2">
                    End: {formatShortDateWithWeekday(oldEnd)} → {formatShortDateWithWeekday(newEnd)}
                  </p>
                ) : null}
              </div>
            )
          })}
          {sorted.length > maxItems ? <p className="text-xs text-gray-500">…and {sorted.length - maxItems} more</p> : null}
        </div>
      )}
    </Card>
  )
}

function BufferModal({ lot, task, org, onClose, onApply }) {
  const [days, setDays] = useState(1)
  const [bufferTaskId] = useState(() => uuid())

  const preview = useMemo(() => {
    const nextLot = insertBufferTaskAfter(lot, task.id, days, org, { buffer_task_id: bufferTaskId })
    const beforeById = new Map((lot.tasks ?? []).map((t) => [t.id, t]))
    const affected = (nextLot?.tasks ?? [])
      .map((t) => {
        const before = beforeById.get(t.id)
        if (!before) return null
        if (before.scheduled_start === t.scheduled_start && before.scheduled_end === t.scheduled_end) return null
        return {
          task_id: t.id,
          task_name: t.name,
          old_start: before.scheduled_start,
          new_start: t.scheduled_start,
          old_end: before.scheduled_end,
          new_end: t.scheduled_end,
          track: t.track,
        }
      })
      .filter(Boolean)

    const oldCompletion = getPredictedCompletionDate(lot)
    const newCompletion = nextLot ? getPredictedCompletionDate(nextLot) : null
    const bufferTask = (nextLot?.tasks ?? []).find((t) => t?.id === bufferTaskId) ?? null
    const buffer = bufferTask
      ? { start: bufferTask.scheduled_start, end: bufferTask.scheduled_end, duration_days: Number(bufferTask.duration_days ?? days) || null }
      : null
    return {
      affected,
      oldCompletion: oldCompletion ? formatISODate(oldCompletion) : null,
      newCompletion: newCompletion ? formatISODate(newCompletion) : null,
      buffer,
    }
  }, [lot, task.id, days, org, bufferTaskId])

  const affected = preview.affected ?? []
  const canApply = Math.max(0, Number(days) || 0) > 0

  return (
    <Modal
      title="Insert Buffer Task"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton onClick={() => onApply({ days, bufferTaskId })} className="flex-1" disabled={!canApply}>
            Insert Buffer Task
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">
            Inserts a buffer block after <span className="font-semibold">{task.name}</span> so the gap is visible on the schedule.
          </p>
        </Card>

        <label className="block">
          <span className="text-sm font-semibold">Buffer duration (workdays)</span>
          <div className="mt-1 grid grid-cols-[44px_1fr_44px] gap-2">
            <button
              type="button"
              onClick={() => setDays((d) => Math.max(1, (Number(d) || 1) - 1))}
              className="h-11 rounded-xl border border-gray-200 bg-white text-xl font-semibold"
              title="Decrease"
            >
              −
            </button>
            <input
              type="number"
              min="1"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="h-11 w-full px-3 border rounded-xl text-center"
            />
            <button
              type="button"
              onClick={() => setDays((d) => (Number(d) || 1) + 1)}
              className="h-11 rounded-xl border border-gray-200 bg-white text-xl font-semibold"
              title="Increase"
            >
              +
            </button>
          </div>
        </label>

        <ImpactPreviewCard
          affected={affected}
          buffer={preview.buffer}
          oldCompletion={preview.oldCompletion}
          newCompletion={preview.newCompletion}
          maxItems={6}
        />
      </div>
    </Modal>
  )
}

function CreateBufferModal({ lot, org, onClose, onCreate }) {
  const getEligibleTasksInDisplayOrder = (sourceLot) => {
    const tasks = (sourceLot?.tasks ?? [])
      .filter((t) => !isBufferTask(t))
      .filter((t) => t.status !== 'complete')
      .slice()

    const baseTracks = TASK_CATEGORIES.map((c) => c.track)
    const known = new Set(baseTracks)
    const extraTracks = []
    for (const task of tasks) {
      const track = task?.track ?? 'misc'
      if (known.has(track)) continue
      known.add(track)
      extraTracks.push(track)
    }
    const tracks = [...baseTracks, ...extraTracks]

    const ordered = []
    for (const track of tracks) {
      const group = tasks
        .filter((t) => (t?.track ?? 'misc') === track)
        .sort(
          (a, b) =>
            (Number(a.sort_order ?? 0) || 0) - (Number(b.sort_order ?? 0) || 0) ||
            String(a.scheduled_start ?? '').localeCompare(String(b.scheduled_start ?? '')) ||
            String(a.name ?? '').localeCompare(String(b.name ?? '')),
        )
      ordered.push(...group)
    }
    return ordered
  }

  const [anchorTaskId, setAnchorTaskId] = useState(() => getEligibleTasksInDisplayOrder(lot)[0]?.id ?? '')
  const [days, setDays] = useState(1)
  const [bufferTaskId, setBufferTaskId] = useState(() => uuid())

  useEffect(() => {
    setBufferTaskId(uuid())
  }, [anchorTaskId])

  const anchorTask = useMemo(() => (lot?.tasks ?? []).find((t) => t.id === anchorTaskId) ?? null, [lot, anchorTaskId])

  const preview = useMemo(() => {
    if (!anchorTaskId) return { affected: [], oldCompletion: null, newCompletion: null, buffer: null }
    const nextLot = insertBufferTaskAfter(lot, anchorTaskId, days, org, { buffer_task_id: bufferTaskId })
    const beforeById = new Map((lot.tasks ?? []).map((t) => [t.id, t]))
    const affected = (nextLot?.tasks ?? [])
      .map((t) => {
        const before = beforeById.get(t.id)
        if (!before) return null
        if (before.scheduled_start === t.scheduled_start && before.scheduled_end === t.scheduled_end) return null
        return {
          task_id: t.id,
          task_name: t.name,
          old_start: before.scheduled_start,
          new_start: t.scheduled_start,
          old_end: before.scheduled_end,
          new_end: t.scheduled_end,
          track: t.track,
        }
      })
      .filter(Boolean)
    const oldCompletion = getPredictedCompletionDate(lot)
    const newCompletion = nextLot ? getPredictedCompletionDate(nextLot) : null
    const bufferTask = (nextLot?.tasks ?? []).find((t) => t?.id === bufferTaskId) ?? null
    const buffer = bufferTask
      ? { start: bufferTask.scheduled_start, end: bufferTask.scheduled_end, duration_days: Number(bufferTask.duration_days ?? days) || null }
      : null
    return {
      affected,
      oldCompletion: oldCompletion ? formatISODate(oldCompletion) : null,
      newCompletion: newCompletion ? formatISODate(newCompletion) : null,
      buffer,
    }
  }, [lot, anchorTaskId, days, org, bufferTaskId])

  const eligibleTasks = useMemo(() => {
    return getEligibleTasksInDisplayOrder(lot)
  }, [lot])

  const canCreate = Boolean(anchorTaskId) && Math.max(1, Number(days) || 1) > 0 && Boolean(anchorTask?.scheduled_end)

  return (
    <Modal
      title="Create Buffer"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() => onCreate({ anchorTaskId, days, bufferTaskId })}
            className="flex-1"
            disabled={!canCreate}
          >
            Create Buffer
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">Creates a standalone Buffer task that shows up in the schedule.</p>
        </Card>

        <label className="block">
          <span className="text-sm font-semibold">Insert after task</span>
          <select
            value={anchorTaskId}
            onChange={(e) => setAnchorTaskId(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
          >
            {eligibleTasks.length === 0 ? <option value="">No eligible tasks</option> : null}
            {eligibleTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {(TASK_CATEGORIES.find((c) => c.track === t.track)?.label ?? t.track ?? 'Track')} • {t.name}
              </option>
            ))}
          </select>
          {!anchorTask?.scheduled_end && anchorTask ? (
            <p className="text-xs text-red-700 mt-1">Selected task has no schedule dates yet.</p>
          ) : null}
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Buffer duration (workdays)</span>
          <div className="mt-1 grid grid-cols-[44px_1fr_44px] gap-2">
            <button
              type="button"
              onClick={() => setDays((d) => Math.max(1, (Number(d) || 1) - 1))}
              className="h-11 rounded-xl border border-gray-200 bg-white text-xl font-semibold"
              title="Decrease"
            >
              −
            </button>
            <input
              type="number"
              min="1"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="h-11 w-full px-3 border rounded-xl text-center"
            />
            <button
              type="button"
              onClick={() => setDays((d) => (Number(d) || 1) + 1)}
              className="h-11 rounded-xl border border-gray-200 bg-white text-xl font-semibold"
              title="Increase"
            >
              +
            </button>
          </div>
        </label>

        <ImpactPreviewCard
          affected={preview.affected ?? []}
          buffer={preview.buffer}
          oldCompletion={preview.oldCompletion}
          newCompletion={preview.newCompletion}
          maxItems={6}
        />
      </div>
    </Modal>
  )
}

function DelayModal({ lot, task, org, onClose, onApply }) {
  const [days, setDays] = useState(1)
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [photoFile, setPhotoFile] = useState(null)
  const [notifySubs, setNotifySubs] = useState(true)

  const preview = useMemo(() => previewDelayImpact(lot, task.id, days, org), [lot, task.id, days, org])
  const affected = preview.affected ?? []
  const affectsExterior = affected.some((a) => a.track === 'exterior')

  return (
    <Modal
      title="Log Delay"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() => onApply({ days, reason: reason || 'other', notes, photoFile, notifySubs })}
            className="flex-1 bg-red-600"
            disabled={!reason}
          >
            Apply Delay & Notify Subs
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="bg-red-50 rounded-xl p-3 border border-red-200">
          <p className="font-semibold text-red-800">{task.name}</p>
          <p className="text-sm text-gray-600">
            {formatShortDate(task.scheduled_start)} → {formatShortDate(task.scheduled_end)}
          </p>
        </div>

        <div>
          <p className="text-sm font-semibold mb-2">Days Delayed</p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setDays((d) => Math.max(1, d - 1))}
              className="w-12 h-12 bg-gray-100 rounded-xl text-xl font-bold"
            >
              −
            </button>
            <div className="flex-1 text-center">
              <span className="text-4xl font-bold text-red-600">{days}</span>
              <p className="text-sm text-gray-500">days</p>
            </div>
            <button
              onClick={() => setDays((d) => Math.min(30, d + 1))}
              className="w-12 h-12 bg-gray-100 rounded-xl text-xl font-bold"
            >
              +
            </button>
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold mb-2">Reason</p>
          <div className="grid grid-cols-3 gap-2">
            {DELAY_REASONS.map((r) => (
              <button
                key={r.id}
                onClick={() => setReason(r.id)}
                className={`p-3 rounded-xl border text-left ${reason === r.id ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'}`}
              >
                <p className="text-lg">{r.icon}</p>
                <p className="text-xs font-semibold">{r.label}</p>
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold mb-2">Notes (optional)</p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full px-3 py-3 border rounded-xl"
            rows={3}
            placeholder="Add context for the delay..."
          />
        </div>

        <div>
          <p className="text-sm font-semibold mb-2">Photo (optional)</p>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
            className="w-full"
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={notifySubs} onChange={(e) => setNotifySubs(e.target.checked)} />
          Notify affected subs
        </label>

        <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
          <p className="text-sm font-semibold text-gray-800 mb-2">Impact Preview</p>
          {affected.length === 0 ? (
            <p className="text-sm text-gray-600">No downstream shifts detected.</p>
          ) : (
            <div className="space-y-1 text-sm text-gray-700">
              {affected.slice(0, 8).map((a) => (
                <div key={a.task_id} className="flex items-center justify-between gap-3">
                  <span className="truncate">{a.task_name}</span>
                  <span className="text-xs text-gray-600">
                    {formatShortDate(a.old_start)} → {formatShortDate(a.new_start)}
                  </span>
                </div>
              ))}
              {affected.length > 8 ? <p className="text-xs text-gray-600 mt-1">…and {affected.length - 8} more</p> : null}
            </div>
          )}
          <p className="text-xs text-gray-600 mt-3">
            Exterior track: {affectsExterior ? 'AFFECTED' : 'NOT AFFECTED ✓'}
          </p>
          <p className="text-xs text-gray-600 mt-1">
            New completion: {preview.newCompletion ? formatShortDate(preview.newCompletion) : '—'}
          </p>
        </div>
      </div>
    </Modal>
  )
}

function RescheduleTaskModal({ lot, task, community, org, isOnline, initialDate, onClose, onApply }) {
  const [date, setDate] = useState(initialDate ?? task.scheduled_start ?? '')
  const [reason, setReason] = useState('')
  const [notifySubs, setNotifySubs] = useState(false)

  const preview = useMemo(() => buildReschedulePreview({ lot, task, targetDateIso: date, org }), [date, lot, task, org])
  const normalizedDate = preview.normalized_date || ''

  const oldStart = task.scheduled_start ?? ''
  const canApply = Boolean(normalizedDate) && task.status !== 'complete'
  const impacted = (preview.affected ?? []).filter((a) => a.old_start !== a.new_start)

  return (
    <Modal
      title="Reschedule Task"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() => onApply({ newStartDate: normalizedDate, reason, notifySubs, preview })}
            className="flex-1"
            disabled={!canApply}
          >
            Confirm Reschedule
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">
            {community?.name ?? 'Community'} • {lotCode(lot)}
          </p>
          <p className="font-semibold">{task.name}</p>
          <p className="text-xs text-gray-600 mt-1">
            Move from {formatShortDate(oldStart)} to {formatShortDate(normalizedDate)}
          </p>
        </Card>

        {!isOnline ? (
          <div className="bg-white border border-gray-200 rounded-xl p-3 text-sm text-gray-700">
            📴 Offline — reschedules save locally and will sync later.
          </div>
        ) : null}

        <label className="block">
          <span className="text-sm font-semibold">New Start Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
          />
          {normalizedDate && normalizedDate !== date ? <p className="text-xs text-gray-600 mt-1">Adjusted to next workday: {formatShortDate(normalizedDate)}</p> : null}
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Reason (optional)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            rows={3}
            placeholder="Waiting on drywall delivery…"
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={notifySubs} onChange={(e) => setNotifySubs(e.target.checked)} />
          Notify affected subs
        </label>

        <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
          <p className="text-sm font-semibold text-gray-800 mb-2">Impact Preview</p>
          {impacted.length === 0 ? (
            <p className="text-sm text-gray-600">No downstream shifts detected.</p>
          ) : (
            <div className="space-y-1 text-sm text-gray-700">
              {impacted.slice(0, 8).map((a) => (
                <div key={a.task_id} className="flex items-center justify-between gap-3">
                  <span className="truncate">{a.task_name}</span>
                  <span className="text-xs text-gray-600">
                    {formatShortDate(a.old_start)} → {formatShortDate(a.new_start)}
                  </span>
                </div>
              ))}
              {impacted.length > 8 ? <p className="text-xs text-gray-600 mt-1">…and {impacted.length - 8} more</p> : null}
            </div>
          )}
          <p className="text-xs text-gray-600 mt-3">
            New completion: {preview.newCompletion ? formatShortDate(preview.newCompletion) : '—'}
          </p>
        </div>
      </div>
    </Modal>
  )
}

function ScheduleInspectionModal({ lot, task, community, agencies, initialType, onClose, onSchedule }) {
  const inspectorOptions = community?.inspectors ?? []
  const defaultInspector = inspectorOptions[0] ?? { name: '', phone: '', email: '', agency_id: '' }
  const scheduleableTypes = useMemo(() => INSPECTION_TYPES.filter((t) => t.code !== 'NOTE'), [])
  const requestedType = initialType ?? task?.inspection_type ?? 'RME'
  const defaultType = scheduleableTypes.some((t) => t.code === requestedType) ? requestedType : scheduleableTypes[0]?.code ?? 'RME'
  const [type, setType] = useState(defaultType)
  const [scheduledDate, setScheduledDate] = useState(task?.scheduled_end ?? formatISODate(new Date()))
  const [scheduledTime, setScheduledTime] = useState('10:00 AM')
  const [inspectorMode, setInspectorMode] = useState(() => (inspectorOptions.length > 0 ? 'existing' : 'new'))
  const [selectedInspectorId, setSelectedInspectorId] = useState(defaultInspector.id ?? '')
  const [inspector, setInspector] = useState({
    name: defaultInspector.name ?? '',
    phone: defaultInspector.phone ?? '',
    email: defaultInspector.email ?? '',
    agency_id: defaultInspector.agency_id ?? '',
  })
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (inspectorMode !== 'existing') return
    if (!selectedInspectorId) return
    const selected = inspectorOptions.find((i) => i.id === selectedInspectorId)
    if (!selected) return
    setInspector((prev) => ({
      ...prev,
      name: selected.name ?? '',
      phone: selected.phone ?? '',
      email: selected.email ?? '',
      agency_id: selected.agency_id ?? '',
    }))
  }, [inspectorMode, inspectorOptions, selectedInspectorId])

  useEffect(() => {
    if (inspectorOptions.length > 0) return
    if (inspectorMode === 'new') return
    setInspectorMode('new')
    setSelectedInspectorId('')
  }, [inspectorMode, inspectorOptions.length])

  const typeLabel = INSPECTION_TYPES.find((t) => t.code === type)?.label ?? type

  return (
    <Modal
      title="Schedule Inspection"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() =>
              onSchedule({
                type,
                scheduled_date: scheduledDate,
                scheduled_time: scheduledTime,
                inspector,
                notes,
              })
            }
            className="flex-1"
            disabled={!scheduledDate}
          >
            Schedule Inspection
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">
            {community?.name ?? 'Community'} • {lotCode(lot)}
          </p>
          <p className="font-semibold">{typeLabel}</p>
        </Card>

        <label className="block">
          <span className="text-sm font-semibold">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 w-full px-3 py-3 border rounded-xl">
            {scheduleableTypes.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label} ({t.code})
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Date</span>
          <input
            type="date"
            value={scheduledDate}
            onChange={(e) => setScheduledDate(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Time</span>
          <input
            value={scheduledTime}
            onChange={(e) => setScheduledTime(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            placeholder="10:00 AM"
          />
        </label>

        <div className="space-y-2">
          <p className="text-sm font-semibold">Inspector</p>
          <div className="flex items-center gap-4 text-sm">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="inspection-inspector-mode"
                checked={inspectorMode === 'existing'}
                disabled={inspectorOptions.length === 0}
                onChange={() => {
                  setInspectorMode('existing')
                  const next = inspectorOptions[0] ?? null
                  setSelectedInspectorId(next?.id ?? '')
                  setInspector({
                    name: next?.name ?? '',
                    phone: next?.phone ?? '',
                    email: next?.email ?? '',
                    agency_id: next?.agency_id ?? '',
                  })
                }}
              />
              Use existing
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="inspection-inspector-mode"
                checked={inspectorMode === 'new'}
                onChange={() => {
                  setInspectorMode('new')
                  setSelectedInspectorId('')
                  setInspector({ name: '', phone: '', email: '', agency_id: '' })
                }}
              />
              New inspector
            </label>
          </div>
          {inspectorMode === 'existing' ? (
            inspectorOptions.length > 0 ? (
              <select
                value={selectedInspectorId}
                onChange={(e) => setSelectedInspectorId(e.target.value)}
                className="w-full px-3 py-3 border rounded-xl text-sm"
              >
                <option value="">Select inspector...</option>
                {inspectorOptions.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name || 'Inspector'}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-gray-500">No saved inspectors yet.</p>
            )
          ) : null}
          <input
            value={inspector.name}
            onChange={(e) => setInspector((prev) => ({ ...prev, name: e.target.value }))}
            className="w-full px-3 py-3 border rounded-xl"
            placeholder="Name"
          />
          <input
            value={inspector.phone}
            onChange={(e) => setInspector((prev) => ({ ...prev, phone: formatPhoneInput(e.target.value) }))}
            className="w-full px-3 py-3 border rounded-xl"
            placeholder="Phone"
          />
          <input
            value={inspector.email}
            onChange={(e) => setInspector((prev) => ({ ...prev, email: e.target.value }))}
            className="w-full px-3 py-3 border rounded-xl"
            placeholder="Email"
          />
          <select
            value={inspector.agency_id}
            onChange={(e) => setInspector((prev) => ({ ...prev, agency_id: e.target.value }))}
            className="w-full px-3 py-3 border rounded-xl text-sm"
          >
            <option value="">Select agency...</option>
            {(agencies ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <label className="block">
          <span className="text-sm font-semibold">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            rows={3}
            placeholder="Enter any special notes..."
          />
        </label>
      </div>
    </Modal>
  )
}

function InspectionResultModal({ lot, task, inspection, subcontractors, isOnline, onClose, onSave, onAddInspectionPhoto, onOpenNotes }) {
  const [result, setResult] = useState(inspection.result ?? 'pass')
  const [failureItems, setFailureItems] = useState(() => inspection.failure_items ?? [])
  const [reportDoc, setReportDoc] = useState(() => inspection.report_document ?? null)
  const checklist = INSPECTION_CHECKLISTS?.[inspection.type] ?? []
  const [checklistState, setChecklistState] = useState(() => inspection.checklist_completed ?? {})

  const [draft, setDraft] = useState({ description: '', location: '', trade: 'other', sub_id: '', status: 'open' })
  const [draftPhotoFile, setDraftPhotoFile] = useState(null)

  const openBlob = async (blobId) => {
    if (!blobId) return
    try {
      const blob = await getBlob(blobId)
      if (!blob) return
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      console.error(err)
      alert('Unable to open file.')
    }
  }

  const uploadReport = async (file) => {
    if (!file) return
    if (!isOnline) return alert('Uploading documents requires an internet connection.')
    const max = 10 * 1024 * 1024
    const okType = file.type === 'application/pdf' || String(file.type).startsWith('image/')
    if (!okType) return alert('Inspection report must be a PDF or image.')
    if (file.size > max) return alert('Inspection report must be ≤ 10MB.')

    if (reportDoc?.blob_id) await deleteBlob(reportDoc.blob_id)
    const blobId = uuid()
    await putBlob(blobId, file)
    setReportDoc({
      id: uuid(),
      file_name: file.name,
      mime: file.type,
      file_size: file.size,
      blob_id: blobId,
      uploaded_at: new Date().toISOString(),
      type: 'inspection_report',
    })
  }

  const addFailureItem = async () => {
    if (!draft.description.trim()) return
    if (!draftPhotoFile) return alert('Photo is required for a failure item.')
    const photoId = await onAddInspectionPhoto?.({ file: draftPhotoFile, caption: `Inspection: ${draft.description.trim()}` })
    setFailureItems((prev) => [
      ...prev,
      {
        id: uuid(),
        description: draft.description.trim(),
        location: draft.location.trim(),
        trade: draft.trade,
        sub_id: draft.sub_id || null,
        status: draft.status,
        photo_id: photoId ?? null,
        fix_photo_id: null,
      },
    ])
    setDraft({ description: '', location: '', trade: 'other', sub_id: '', status: 'open' })
    setDraftPhotoFile(null)
  }

  const requiredChecklist = checklist.filter((c) => c.required)
  const allRequiredChecked = requiredChecklist.every((c) => checklistState?.[c.id])
  const canReinspect = (result === 'fail' || result === 'partial') && failureItems.length > 0 && failureItems.every((i) => i.status !== 'open')
  const canSave = result !== 'pass' || allRequiredChecked

  return (
    <Modal
      title={`${inspection.type} Inspection`}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          {canReinspect ? (
            <SecondaryButton
              onClick={() =>
                onSave({ result, failure_items: failureItems, report_document: reportDoc, checklist_completed: checklistState, schedule_reinspection: true })
              }
              className="flex-1"
            >
              Save + Re-Inspect
            </SecondaryButton>
          ) : null}
          <PrimaryButton
            onClick={() => onSave({ result, failure_items: failureItems, report_document: reportDoc, checklist_completed: checklistState })}
            className="flex-1"
            disabled={!canSave}
          >
            Save & Notify Subs
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">
            {lotCode(lot)} • {task?.name ?? 'Manual Inspection'}
          </p>
          <p className="text-xs text-gray-600 mt-1">
            Scheduled: {formatShortDate(inspection.scheduled_date)} {inspection.scheduled_time ? `• ${inspection.scheduled_time}` : ''}
          </p>
          {inspection.parent_inspection_id ? <p className="text-xs text-gray-600 mt-1">Re-inspection</p> : null}
          {onOpenNotes ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={onOpenNotes}
                className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
              >
                Add Notes / Files
              </button>
            </div>
          ) : null}
        </Card>

        {!isOnline ? (
          <div className="bg-white border border-gray-200 rounded-xl p-3 text-sm text-gray-700">
            📴 Offline — result saves locally; report upload is disabled.
          </div>
        ) : null}

        {checklist.length > 0 ? (
          <Card className="bg-gray-50">
            <p className="text-sm font-semibold mb-2">Checklist</p>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {checklist.map((item) => (
                <label
                  key={item.id}
                  className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer ${
                    checklistState?.[item.id] ? 'bg-green-50' : 'bg-white'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(checklistState?.[item.id])}
                    onChange={() => setChecklistState((prev) => ({ ...prev, [item.id]: !prev?.[item.id] }))}
                    className="w-5 h-5 rounded"
                  />
                  <span className={checklistState?.[item.id] ? 'text-green-700' : ''}>{item.label}</span>
                  {item.required ? <span className="text-xs text-red-500 ml-auto">Required</span> : null}
                </label>
              ))}
            </div>
            <div className="mt-3 pt-3 border-t text-xs text-gray-600">
              {Object.values(checklistState ?? {}).filter(Boolean).length} / {checklist.length} checked
              {!allRequiredChecked ? <span className="text-red-500 ml-2">(complete all required)</span> : null}
            </div>
            <button
              onClick={() => setResult('pass')}
              disabled={!allRequiredChecked}
              className="mt-3 w-full py-2 rounded-xl bg-green-600 text-white font-semibold disabled:opacity-50"
            >
              ✓ Mark Inspection as Passed
            </button>
          </Card>
        ) : null}

        <div>
          <p className="text-sm font-semibold mb-2">Result</p>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'pass', label: '✅ PASS' },
              { id: 'partial', label: '⚠️ PARTIAL' },
              { id: 'fail', label: '❌ FAIL' },
            ].map((r) => (
              <button
                key={r.id}
                onClick={() => setResult(r.id)}
                className={`p-3 rounded-xl border font-semibold ${result === r.id ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-gray-200 text-gray-800'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {(result === 'fail' || result === 'partial') && (
          <div className="space-y-3">
            <p className="text-sm font-semibold">Failure Items</p>

            {failureItems.length === 0 ? <p className="text-sm text-gray-600">No items yet.</p> : null}
            {failureItems.map((item) => (
              <div key={item.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2">
                <p className="font-semibold text-gray-900">{item.description}</p>
                <p className="text-xs text-gray-600">📍 {item.location || '—'}</p>
                <p className="text-xs text-gray-600">
                  👷 {TRADES.find((t) => t.id === item.trade)?.label ?? item.trade}{' '}
                  {item.sub_id ? `- ${(subcontractors.find((s) => s.id === item.sub_id)?.company_name ?? '')}` : ''}
                </p>

                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={item.status}
                    onChange={(e) => setFailureItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, status: e.target.value } : x)))}
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                  >
                    <option value="open">Open</option>
                    <option value="fixed">Fixed</option>
                    <option value="verified">Verified</option>
                  </select>
                  <label className="w-full px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold cursor-pointer text-center">
                    {item.photo_id ? 'Replace Photo' : 'Add Photo'}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        const photoId = await onAddInspectionPhoto?.({ file, caption: `Inspection item: ${item.description}` })
                        setFailureItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, photo_id: photoId ?? x.photo_id } : x)))
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>

                {item.photo_id ? (
                  <button
                    onClick={() => {
                      const photo = (lot.photos ?? []).find((p) => p.id === item.photo_id)
                      if (photo?.blob_id) openBlob(photo.blob_id)
                    }}
                    className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold w-full"
                  >
                    View Failure Photo
                  </button>
                ) : null}

                <label className="w-full px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold cursor-pointer text-center">
                  {item.fix_photo_id ? 'Replace Fix Photo' : 'Add Fix Photo'}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      const photoId = await onAddInspectionPhoto?.({ file, caption: `Fix: ${item.description}` })
                      setFailureItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, fix_photo_id: photoId ?? x.fix_photo_id } : x)))
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
            ))}

            <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
              <p className="text-sm font-semibold">+ Add Failure Item</p>
              <textarea
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                className="w-full px-3 py-2 border rounded-xl"
                rows={2}
                placeholder="Description"
              />
              <input
                value={draft.location}
                onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value }))}
                className="w-full px-3 py-2 border rounded-xl"
                placeholder="Location (e.g., Master Bathroom)"
              />
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={draft.trade}
                  onChange={(e) => setDraft((d) => ({ ...d, trade: e.target.value, sub_id: '' }))}
                  className="w-full px-3 py-2 border rounded-xl text-sm"
                >
                  {TRADES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <select
                  value={draft.sub_id}
                  onChange={(e) => setDraft((d) => ({ ...d, sub_id: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-xl text-sm"
                >
                  <option value="">Assign sub…</option>
                  {subcontractors
                    .filter((s) => s.trade === draft.trade || (s.secondary_trades ?? []).includes(draft.trade))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.company_name}
                      </option>
                    ))}
                </select>
              </div>
              <label className="w-full px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold cursor-pointer text-center">
                {draftPhotoFile ? 'Photo selected' : 'Photo (required)'}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => setDraftPhotoFile(e.target.files?.[0] ?? null)} />
              </label>
              <button onClick={addFailureItem} className="w-full h-11 rounded-xl bg-blue-600 text-white font-semibold" disabled={!draft.description.trim() || !draftPhotoFile}>
                Add Item
              </button>
            </div>
          </div>
        )}

        <Card>
          <p className="font-semibold mb-2">Upload Inspection Report</p>
          {reportDoc ? (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
              <p className="text-sm font-semibold">{reportDoc.file_name}</p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => openBlob(reportDoc.blob_id)}
                  className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                >
                  Open
                </button>
                <label className={`px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold ${!isOnline ? 'opacity-50' : 'cursor-pointer'}`}>
                  Replace
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    className="hidden"
                    disabled={!isOnline}
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      await uploadReport(file)
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
            </div>
          ) : (
            <label className={`w-full h-11 rounded-xl border border-gray-200 bg-white text-sm font-semibold inline-flex items-center justify-center ${!isOnline ? 'opacity-50' : 'cursor-pointer'}`}>
              Choose File
              <input
                type="file"
                accept="application/pdf,image/*"
                className="hidden"
                disabled={!isOnline}
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  await uploadReport(file)
                  e.target.value = ''
                }}
              />
            </label>
          )}
          <p className="text-xs text-gray-600 mt-2">PDF/image up to 10MB (upload requires connection).</p>
        </Card>
      </div>
    </Modal>
  )
}

function InspectionNoteModal({ lot, community, tasks, inspection, isOnline, onClose, onSave, onDelete }) {
  const isEdit = Boolean(inspection?.id)
  const [draft, setDraft] = useState(() => ({
    type: inspection?.type ?? 'NOTE',
    scheduled_date: inspection?.scheduled_date ?? formatISODate(new Date()),
    scheduled_time: inspection?.scheduled_time ?? '',
    task_id: inspection?.task_id ?? '',
    notes: inspection?.notes ?? '',
    documents: inspection?.documents ?? [],
  }))

  useEffect(() => {
    setDraft({
      type: inspection?.type ?? 'NOTE',
      scheduled_date: inspection?.scheduled_date ?? formatISODate(new Date()),
      scheduled_time: inspection?.scheduled_time ?? '',
      task_id: inspection?.task_id ?? '',
      notes: inspection?.notes ?? '',
      documents: inspection?.documents ?? [],
    })
  }, [inspection?.id])

  const openAttachment = async (blobId) => {
    if (!blobId) return
    try {
      const blob = await getBlob(blobId)
      if (!blob) return alert('File not found on this device.')
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      console.error(err)
      alert('Unable to open file.')
    }
  }

  const addAttachment = async (file) => {
    if (!file) return
    const max = 50 * 1024 * 1024
    if (file.size > max) return alert('File must be ≤ 50MB.')

    const blobId = uuid()
    await putBlob(blobId, file)
    const doc = {
      id: uuid(),
      file_name: file.name,
      mime: file.type,
      file_size: file.size,
      blob_id: blobId,
      uploaded_at: new Date().toISOString(),
      type: 'inspection_attachment',
    }
    setDraft((p) => ({ ...p, documents: [...(p.documents ?? []), doc] }))
  }

  const removeAttachment = async (docId) => {
    const doc = (draft.documents ?? []).find((d) => d.id === docId) ?? null
    if (!doc) return
    const ok = window.confirm(`Remove this file?\n\n${doc.file_name ?? 'File'}`)
    if (!ok) return
    if (doc.blob_id) await deleteBlob(doc.blob_id)
    setDraft((p) => ({ ...p, documents: (p.documents ?? []).filter((d) => d.id !== docId) }))
  }

  const canSave = Boolean(draft.scheduled_date) && (String(draft.notes ?? '').trim() || (draft.documents ?? []).length > 0 || draft.type !== 'NOTE')

  return (
    <Modal
      title={isEdit ? 'Inspection Note' : 'Add Inspection Note'}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          {isEdit ? (
            <SecondaryButton onClick={onDelete} className="flex-1 border-red-200 text-red-700 bg-red-50">
              Delete
            </SecondaryButton>
          ) : (
            <SecondaryButton onClick={onClose} className="flex-1">
              Cancel
            </SecondaryButton>
          )}
          <PrimaryButton onClick={() => onSave(draft)} className="flex-1" disabled={!canSave}>
            Save
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">
            {community?.name ?? 'Community'} • {lotCode(lot)}
          </p>
          <p className="text-xs text-gray-600 mt-1">Quick notes + files (mobile-friendly).</p>
          {!isOnline ? <p className="text-xs text-orange-700 mt-1">Offline — files save on-device; sync later.</p> : null}
        </Card>

        <label className="block">
          <span className="text-sm font-semibold">Type</span>
          <select
            value={draft.type}
            onChange={(e) => setDraft((p) => ({ ...p, type: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
          >
            {INSPECTION_TYPES.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-sm font-semibold">Date</span>
            <input
              type="date"
              value={draft.scheduled_date}
              onChange={(e) => setDraft((p) => ({ ...p, scheduled_date: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl"
            />
          </label>
          <label className="block">
            <span className="text-sm font-semibold">Time</span>
            <input
              type="time"
              value={draft.scheduled_time}
              onChange={(e) => setDraft((p) => ({ ...p, scheduled_time: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-sm font-semibold">Related task (optional)</span>
          <select
            value={draft.task_id}
            onChange={(e) => setDraft((p) => ({ ...p, task_id: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
          >
            <option value="">None</option>
            {(tasks ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {(TASK_CATEGORIES.find((c) => c.track === t.track)?.label ?? t.track ?? 'Track')} • {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Notes</span>
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            rows={4}
            placeholder="Add notes about an inspection, inspector feedback, next steps, etc."
          />
        </label>

        <Card>
          <div className="flex items-center justify-between">
            <p className="font-semibold">Files</p>
            <label className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold cursor-pointer">
              + Add file
              <input
                type="file"
                accept={FILE_ACCEPT}
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  await addAttachment(file)
                  e.target.value = ''
                }}
              />
            </label>
          </div>

          {(draft.documents ?? []).length === 0 ? (
            <p className="text-sm text-gray-600 mt-2">No files yet.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {(draft.documents ?? []).map((doc) => (
                <div key={doc.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                  <p className="font-semibold text-sm break-words">{doc.file_name || 'File'}</p>
                  <p className="text-xs text-gray-600 mt-1">{doc.file_size ? `${Math.round(doc.file_size / 1024)} KB` : ''}</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => openAttachment(doc.blob_id)}
                      className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                    >
                      Open
                    </button>
                    <button type="button" onClick={() => removeAttachment(doc.id)} className="px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-sm font-semibold text-red-700">
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Modal>
  )
}

function PhotoCaptureModal({ lot, task, onClose, onSave, source }) {
  const [category, setCategory] = useState(task ? 'progress' : 'daily')
  const [taskId, setTaskId] = useState(task?.id ?? '')
  const [location, setLocation] = useState('')
  const [caption, setCaption] = useState('')
  const getReq = (taskName) => {
    if (!taskName) return null
    const directKey = Object.keys(PHOTO_REQUIREMENTS ?? {}).find((k) => String(taskName).includes(k))
    if (directKey) return { key: directKey, ...PHOTO_REQUIREMENTS[directKey] }
    if (taskName === 'Final Clean' && PHOTO_REQUIREMENTS['Final Inspection']) {
      return { key: 'Final Inspection', ...PHOTO_REQUIREMENTS['Final Inspection'] }
    }
    return null
  }
  const selectedTask = taskId ? (lot.tasks ?? []).find((t) => t.id === taskId) ?? null : null
  const requirement = getReq(selectedTask?.name)
  const [angle, setAngle] = useState(() => requirement?.angles?.[0] ?? '')
  const [file, setFile] = useState(null)
  const cameraInputRef = useRef(null)
  const libraryInputRef = useRef(null)
  const [previewUrl, setPreviewUrl] = useState(null)

  useEffect(() => {
    if (!source) return
    const input = source === 'camera' ? cameraInputRef.current : libraryInputRef.current
    const timer = setTimeout(() => input?.click?.(), 80)
    return () => clearTimeout(timer)
  }, [source])

  useEffect(() => {
    let url = null
    if (file && typeof URL !== 'undefined') {
      url = URL.createObjectURL(file)
      setPreviewUrl(url)
    } else {
      setPreviewUrl(null)
    }
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [file])

  const modalTitle = source === 'library' ? '📁 Upload Photo' : '📷 Take Photo'

  return (
    <Modal
      title={modalTitle}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() =>
            onSave({
              lotId: lot.id,
              taskId: taskId || null,
              category,
              location,
              caption,
              tags: angle ? [angle] : [],
              file,
            })
          }
            className="flex-1"
            disabled={!file}
          >
            Save Photo
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">{lotCode(lot)}</p>
          <p className="text-xs text-gray-600 mt-1">Photos are cached locally (offline-friendly).</p>
        </Card>

        <label className="block">
          <span className="text-sm font-semibold">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 w-full px-3 py-3 border rounded-xl">
            {PHOTO_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Task</span>
          <select
            value={taskId}
            onChange={(e) => {
              const nextTaskId = e.target.value
              setTaskId(nextTaskId)
              const nextTask = nextTaskId ? (lot.tasks ?? []).find((t) => t.id === nextTaskId) ?? null : null
              const nextReq = getReq(nextTask?.name)
              if (!nextReq) return setAngle('')
              if (nextReq.angles?.length && !nextReq.angles.includes(angle)) setAngle(nextReq.angles[0])
            }}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
          >
            <option value="">(None)</option>
            {(lot.tasks ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        {requirement ? (
          <Card className="bg-gray-50">
            <p className="text-sm font-semibold">Recommended Photos</p>
            <p className="text-xs text-gray-600 mt-1">
              {requirement.key}: minimum {requirement.min} photo(s)
            </p>
            {Array.isArray(requirement.angles) && requirement.angles.length > 0 ? (
              <label className="block mt-2">
                <span className="text-sm font-semibold">Angle</span>
                <select
                  value={angle}
                  onChange={(e) => setAngle(e.target.value)}
                  className="mt-1 w-full px-3 py-3 border rounded-xl"
                >
                  {requirement.angles.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <p className="text-xs text-gray-500 mt-2">This is a guideline for documentation; you can still complete the task without photos.</p>
          </Card>
        ) : null}

        <label className="block">
          <span className="text-sm font-semibold">Location</span>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            placeholder="Great room, west wall"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Caption</span>
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            placeholder="Optional"
          />
        </label>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Photo</p>
            {file ? (
              <button
                type="button"
                onClick={() => {
                  setFile(null)
                  if (cameraInputRef.current) cameraInputRef.current.value = ''
                  if (libraryInputRef.current) libraryInputRef.current.value = ''
                }}
                className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
              >
                Remove
              </button>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => libraryInputRef.current?.click?.()}
            className={`w-full rounded-xl border p-4 text-left ${
              file ? 'bg-white border-gray-200' : 'bg-gray-50 border-dashed border-gray-300 hover:bg-gray-100'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${file ? 'bg-blue-50 text-blue-700' : 'bg-white text-gray-700'}`}>
                <Upload className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-gray-900">{file ? 'Change photo' : 'Choose / Take a photo'}</p>
                <p className="text-xs text-gray-600">
                  {file ? `${file.name} • ${Math.round(file.size / 1024)} KB` : 'Tap here to open your camera or photo library.'}
                </p>
              </div>
            </div>
          </button>

          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              e.target.value = ''
            }}
            className="hidden"
          />
          <input
            ref={libraryInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              e.target.value = ''
            }}
            className="hidden"
          />

          {previewUrl ? (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-700 mb-2">Preview</p>
              <img src={previewUrl} alt="Selected upload preview" className="w-full max-h-[40vh] object-contain rounded-xl bg-white border border-gray-200" />
            </div>
          ) : (
            <p className="text-xs text-gray-500">Save is enabled after you pick a photo.</p>
          )}
        </div>
      </div>
    </Modal>
  )
}

function PhotoSourceModal({ lot, task, onClose, onSelect }) {
  return (
    <Modal
      title="Add Photo"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">{lotCode(lot)}</p>
          {task ? <p className="text-xs text-gray-500 mt-1">Task: {task.name}</p> : null}
          <p className="text-xs text-gray-500 mt-2">Choose how you want to add a photo.</p>
        </Card>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onSelect('camera')}
            className="py-3 rounded-xl border border-blue-200 bg-blue-50 text-blue-700 font-semibold"
          >
            📷 Take Photo
          </button>
          <button
            type="button"
            onClick={() => onSelect('library')}
            className="py-3 rounded-xl border border-gray-200 bg-white text-gray-700 font-semibold"
          >
            📁 Upload Photo
          </button>
        </div>
      </div>
    </Modal>
  )
}


function PhotoViewerModal({ blobId, title, photos, startIndex = 0, onClose }) {
  const [url, setUrl] = useState(null)
  const [photoUrls, setPhotoUrls] = useState({})
  const [currentIndex, setCurrentIndex] = useState(startIndex)
  const [zoomedIndex, setZoomedIndex] = useState(null)
  const trackRef = useRef(null)

  useEffect(() => {
    if (Array.isArray(photos) && photos.length > 0) {
      setCurrentIndex(startIndex)
      return
    }
    let mounted = true
    let nextUrl = null
    const load = async () => {
      if (!blobId) return
      try {
        const blob = await getBlob(blobId)
        if (!mounted || !blob) return
        nextUrl = URL.createObjectURL(blob)
        setUrl(nextUrl)
      } catch (err) {
        console.error(err)
      }
    }
    load()
    return () => {
      mounted = false
      if (nextUrl) URL.revokeObjectURL(nextUrl)
    }
  }, [blobId, photos, startIndex])

  useEffect(() => {
    if (!Array.isArray(photos) || photos.length == 0) return
    let mounted = true
    const urls = {}
    const loadAll = async () => {
      for (const photo of photos) {
        if (!photo?.blob_id) continue
        try {
          const blob = await getBlob(photo.blob_id)
          if (!mounted || !blob) continue
          urls[photo.blob_id] = URL.createObjectURL(blob)
        } catch (err) {
          console.error(err)
        }
      }
      if (mounted) setPhotoUrls(urls)
    }
    loadAll()
    return () => {
      mounted = false
      Object.values(urls).forEach((entry) => URL.revokeObjectURL(entry))
    }
  }, [photos])

  useEffect(() => {
    if (!trackRef.current || !Array.isArray(photos) || photos.length == 0) return
    const width = trackRef.current.clientWidth
    trackRef.current.scrollTo({ left: width * startIndex, behavior: 'instant' })
  }, [photos, startIndex])

  const handleScroll = () => {
    if (!trackRef.current || !Array.isArray(photos) || photos.length == 0) return
    const width = trackRef.current.clientWidth
    if (!width) return
    const index = Math.round(trackRef.current.scrollLeft / width)
    setCurrentIndex(Math.min(Math.max(index, 0), photos.length - 1))
  }

  const activePhoto = Array.isArray(photos) && photos.length > 0 ? photos[currentIndex] : null
  const activeBlobId = activePhoto?.blob_id ?? blobId

  return (
    <Modal
      title={title || activePhoto?.caption || 'Photo'}
      onClose={onClose}
      zIndex="z-[90]"
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Close
          </SecondaryButton>
          <SecondaryButton onClick={() => openBlobInNewTab(activeBlobId)} className="flex-1">
            Open Fullscreen
          </SecondaryButton>
        </div>
      }
    >
      {Array.isArray(photos) && photos.length > 0 ? (
        <div className="space-y-2">
          <div
            ref={trackRef}
            onScroll={handleScroll}
            className="flex overflow-x-auto snap-x snap-mandatory gap-2"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            {photos.map((photo, index) => {
              const preview = photoUrls[photo.blob_id]
              const zoomed = zoomedIndex === index
              return (
                <div key={photo.id ?? photo.blob_id ?? index} className="min-w-full snap-center">
                  <div
                    className="max-h-[70vh] overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-2"
                    style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x pan-y pinch-zoom' }}
                    onClick={() => setZoomedIndex((prev) => (prev === index ? null : index))}
                  >
                    {preview ? (
                      <img
                        src={preview}
                        alt={photo.caption || 'Photo'}
                        className="rounded-xl bg-white"
                        style={{ width: zoomed ? '180%' : '100%', height: 'auto' }}
                      />
                    ) : (
                      <div className="bg-gray-100 rounded-xl p-6 text-center text-gray-600">Loading preview...</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>Swipe left/right to view more photos.</span>
            <span>
              {currentIndex + 1} / {photos.length}
            </span>
          </div>
        </div>
      ) : url ? (
        <div className="max-h-[70vh] overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-2" style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x pan-y pinch-zoom' }}>
          <img src={url} alt={title || 'Photo'} className="w-full h-auto rounded-xl bg-white" />
        </div>
      ) : (
        <div className="bg-gray-100 rounded-xl p-6 text-center text-gray-600">Loading preview...</div>
      )}
      <p className="text-xs text-gray-500 mt-2">Tap a photo to zoom in/out. Open Fullscreen for native zoom.</p>
    </Modal>
  )
}

function PhotoThumb({ blobId, alt }) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    let mounted = true
    let nextUrl = null
    const load = async () => {
      try {
        if (!blobId) return
        let blob = await getBlob(blobId)
        if (!blob) {
          const remote = decodeRemoteBlobId(blobId)
          if (remote) {
            const { data, error } = await supabase.storage.from(remote.bucket).download(remote.path)
            if (error) throw error
            blob = data ?? null
            if (blob) {
              // Cache for offline viewing on this device.
              try {
                await putBlob(blobId, blob)
              } catch {
                // ignore cache failures
              }
            }
          }
        }
        if (!mounted || !blob) return
        nextUrl = URL.createObjectURL(blob)
        setUrl(nextUrl)
      } catch (err) {
        console.error(err)
      }
    }
    load()
    return () => {
      mounted = false
      if (nextUrl) URL.revokeObjectURL(nextUrl)
    }
  }, [blobId])

  if (!url) {
    return (
      <div className="w-full aspect-square bg-gray-100 rounded-xl flex items-center justify-center">
        <Image className="w-6 h-6 text-gray-400" />
      </div>
    )
  }

  return <img src={url} alt={alt} className="w-full aspect-square object-cover rounded-xl" />
}

function PhotoTimelineModal({ lot, onClose, onTakePhoto, onDeletePhoto }) {
  const [category, setCategory] = useState('all')

  const filtered = useMemo(() => {
    if (category === 'all') return lot.photos ?? []
    return (lot.photos ?? []).filter((p) => p.category === category)
  }, [lot.photos, category])

  const byDate = useMemo(() => {
    const groups = new Map()
    for (const p of filtered) {
      const day = String(p.taken_at ?? '').slice(0, 10) || 'Unknown'
      if (!groups.has(day)) groups.set(day, [])
      groups.get(day).push(p)
    }
    return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  }, [filtered])

  return (
    <Modal
      title="📷 Photos"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Close
          </SecondaryButton>
          <PrimaryButton onClick={onTakePhoto} className="flex-1">
            + Take Photo
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm font-semibold">Filter</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 w-full px-3 py-3 border rounded-xl">
            <option value="all">All Categories</option>
            {PHOTO_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        {byDate.length === 0 ? (
          <p className="text-sm text-gray-600">No photos yet.</p>
        ) : (
          byDate.map(([day, photos]) => (
            <div key={day}>
              <p className="text-sm font-semibold text-gray-800 mb-2">{formatLongDate(day)}</p>
              <div className="grid grid-cols-3 gap-2">
                {photos.map((p) => (
                  <div key={p.id} className="bg-gray-50 border border-gray-200 rounded-xl p-2 text-center">
                    <button type="button" onClick={() => openBlobInNewTab(p.blob_id)} className="w-full">
                      <PhotoThumb blobId={p.blob_id} alt={p.caption || 'Photo'} />
                    </button>
                    <p className="text-[10px] text-gray-700 mt-1 truncate">
                      {p.caption || p.location || 'Photo'}
                    </p>
                    <p className="text-[10px] text-gray-500 truncate">
                      {PHOTO_CATEGORIES.find((c) => c.id === p.category)?.label ?? p.category}
                    </p>
                    <div className="mt-1 flex justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => openBlobInNewTab(p.blob_id)}
                        className="text-[10px] text-blue-600"
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeletePhoto?.(p.id)}
                        className="text-[10px] text-red-600"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}

function HybridScheduleView({ lot, subcontractors, org, scale = 'week', onSelectTask, onRescheduleTask }) {
  const tasks = (lot.tasks ?? []).slice().sort((a, b) => String(a.scheduled_start).localeCompare(String(b.scheduled_start)))

  const [isCompact, setIsCompact] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 640 : false))
  const [draggingTaskId, setDraggingTaskId] = useState(null)
  const [dragTargetIso, setDragTargetIso] = useState(null)
  const [dragStatus, setDragStatus] = useState(null)
  const dragStateRef = useRef({
    active: false,
    pointerId: null,
    timer: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    taskId: null,
    rowRect: null,
    pointerType: '',
    lastFlipAt: 0,
  })
  const suppressClickRef = useRef(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => setIsCompact(window.innerWidth < 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    return () => {
      if (dragStateRef.current.timer) {
        clearTimeout(dragStateRef.current.timer)
      }
    }
  }, [])

  const allDates = tasks.flatMap((t) => [t.scheduled_start, t.scheduled_end]).filter(Boolean).sort()
  const minDate = parseISODate(allDates[0]) ?? new Date()
  const maxDate = parseISODate(allDates[allDates.length - 1]) ?? addCalendarDays(new Date(), 60)
  const totalDays = Math.max(1, daysBetweenCalendar(maxDate, minDate) + 1)
  const useWorkWeek = scale === 'work_week'
  const taskColWidth = isCompact ? 140 : 192
  const dayColWidth = useWorkWeek ? (isCompact ? 64 : 90) : (isCompact ? 96 : 120)

  const weeks = []
  let cursor = new Date(minDate)
  while (cursor <= maxDate) {
    weeks.push(new Date(cursor))
    cursor = addCalendarDays(cursor, 7)
  }

  const { isWorkDay, getNextWorkDay, addWorkDays } = makeWorkdayHelpers(org)
  const getPrevWorkDay = (dateLike) => {
    const d = parseISODate(dateLike)
    if (!d) return null
    while (!isWorkDay(d)) d.setDate(d.getDate() - 1)
    return d
  }

  const getWeekStart = (dateLike) => {
    const d = parseISODate(dateLike)
    if (!d) return null
    const mondayOffset = (d.getDay() + 6) % 7
    const start = new Date(d)
    start.setDate(start.getDate() - mondayOffset)
    return start
  }

  const minWeekStart = getWeekStart(minDate) ?? new Date(minDate)
  const maxWeekStart = getWeekStart(maxDate) ?? new Date(maxDate)
  const [activeWeekStartIso, setActiveWeekStartIso] = useState(() => formatISODate(minWeekStart))

  useEffect(() => {
    if (!useWorkWeek) return
    const today = new Date()
    const base = today >= minDate && today <= maxDate ? today : minDate
    const start = getWeekStart(base) ?? minDate
    setActiveWeekStartIso((prev) => {
      const prevDate = parseISODate(prev)
      if (!prevDate) return formatISODate(start)
      if (prevDate < minWeekStart || prevDate > maxWeekStart) return formatISODate(start)
      return prev
    })
  }, [useWorkWeek, minDate, maxDate])

  const activeWeekStart = parseISODate(activeWeekStartIso) ?? minWeekStart
  const weekStart = activeWeekStart
  const weekEnd = addCalendarDays(weekStart, 4) ?? weekStart
  const weekDayIsos = useMemo(
    () => Array.from({ length: 5 }, (_, i) => formatISODate(addCalendarDays(weekStart, i))),
    [weekStart],
  )
  const weekDayIndexByIso = useMemo(() => new Map(weekDayIsos.map((iso, i) => [iso, i])), [weekDayIsos])
  const weekLabel = `${formatShortDate(weekStart)} – ${formatShortDate(weekEnd)}`
  const canGoPrev = weekStart > minWeekStart
  const canGoNext = weekStart < maxWeekStart
  const columnCount = useWorkWeek ? weekDayIsos.length : Math.max(1, weeks.length)
  const minGridWidth = Math.max(isCompact ? 520 : 800, columnCount * dayColWidth + taskColWidth)

  const STATUS_COLORS = {
    complete: '#22C55E',
    in_progress: '#3B82F6',
    delayed: '#EF4444',
    blocked: '#F97316',
    ready: '#8B5CF6',
    pending: '#D1D5DB',
  }

  const baseVisibleTasks = useWorkWeek
    ? tasks.filter((task) => {
        const startDate = parseISODate(task.scheduled_start)
        const endDate = parseISODate(task.scheduled_end)
        if (!startDate || !endDate) return false
        const startWork = isWorkDay(startDate) ? startDate : getNextWorkDay(startDate)
        const endWork = isWorkDay(endDate) ? endDate : getPrevWorkDay(endDate)
        if (!startWork || !endWork) return false
        return !(endWork < weekStart || startWork > weekEnd)
      })
    : tasks
  const pinnedDragTask = useWorkWeek && draggingTaskId ? tasks.find((t) => t.id === draggingTaskId) ?? null : null
  const showPinnedDrag = Boolean(pinnedDragTask && !baseVisibleTasks.some((t) => t.id === pinnedDragTask.id))
  const visibleTasks = showPinnedDrag ? [pinnedDragTask, ...baseVisibleTasks] : baseVisibleTasks

  const clearDragState = () => {
    const state = dragStateRef.current
    if (state.timer) clearTimeout(state.timer)
    state.active = false
    state.pointerId = null
    state.timer = null
    state.taskId = null
    state.rowRect = null
    state.pointerType = ''
    state.lastFlipAt = 0
    setDraggingTaskId(null)
    setDragTargetIso(null)
    setDragStatus(null)
  }

  const getIsoForWeek = (clientX, rowRect, baseWeekStart) => {
    if (!rowRect?.width || !baseWeekStart) return null
    const ratio = (clientX - rowRect.left) / rowRect.width
    const clamped = Math.max(0, Math.min(1, ratio))
    const index = Math.max(0, Math.min(weekDayIsos.length - 1, Math.floor(clamped * weekDayIsos.length)))
    const isoDate = addCalendarDays(baseWeekStart, index)
    return isoDate ? formatISODate(isoDate) : null
  }

  const updateDragTarget = (task, clientX, rowRect) => {
    if (!useWorkWeek || !rowRect?.width || weekDayIsos.length === 0) return
    const iso = getIsoForWeek(clientX, rowRect, weekStart)
    if (!iso) return
    if (dragTargetIso === iso && dragStatus?.taskId === task.id) return
    const preview = buildReschedulePreview({ lot, task, targetDateIso: iso, org })
    setDragTargetIso(iso)
    setDragStatus({ status: 'valid', preview, taskId: task.id })
  }

  const maybeFlipWeek = (task, clientX, rowRect) => {
    if (!useWorkWeek || !rowRect) return false
    const edge = 36
    const now = Date.now()
    const state = dragStateRef.current
    if (now - state.lastFlipAt < 380) return false

    if (clientX >= rowRect.right - edge && canGoNext) {
      const next = addCalendarDays(weekStart, 7)
      if (!next) return false
      state.lastFlipAt = now
      setActiveWeekStartIso(formatISODate(next))
      const iso = getIsoForWeek(clientX, rowRect, next)
      if (iso) {
        const preview = buildReschedulePreview({ lot, task, targetDateIso: iso, org })
        setDragTargetIso(iso)
        setDragStatus({ status: 'valid', preview, taskId: task.id })
      }
      return true
    }

    if (clientX <= rowRect.left + edge && canGoPrev) {
      const prev = addCalendarDays(weekStart, -7)
      if (!prev) return false
      state.lastFlipAt = now
      setActiveWeekStartIso(formatISODate(prev))
      const iso = getIsoForWeek(clientX, rowRect, prev)
      if (iso) {
        const preview = buildReschedulePreview({ lot, task, targetDateIso: iso, org })
        setDragTargetIso(iso)
        setDragStatus({ status: 'valid', preview, taskId: task.id })
      }
      return true
    }

    return false
  }

  const handleTaskClick = (taskId) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    onSelectTask?.(taskId)
  }

  const handleTaskPointerDown = (task, e) => {
    if (!useWorkWeek || !onRescheduleTask || task.status === 'complete') return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const rowRect = e.currentTarget.parentElement?.getBoundingClientRect()
    if (!rowRect) return

    const state = dragStateRef.current
    if (state.timer) clearTimeout(state.timer)
    state.active = false
    state.pointerId = e.pointerId
    state.startX = e.clientX
    state.startY = e.clientY
    state.lastX = e.clientX
    state.lastY = e.clientY
    state.taskId = task.id
    state.rowRect = rowRect
    state.pointerType = e.pointerType
    state.lastFlipAt = 0

    const targetEl = e.currentTarget
    const pointerId = e.pointerId
    const delay = e.pointerType === 'touch' ? 240 : 120
    state.timer = setTimeout(() => {
      state.timer = null
      state.active = true
      setDraggingTaskId(task.id)
      updateDragTarget(task, state.lastX, rowRect)
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(10)
      if (targetEl?.setPointerCapture) {
        try {
          targetEl.setPointerCapture(pointerId)
        } catch (_err) {
          void _err
          // ignore pointer capture failures
        }
      }
    }, delay)
  }

  const handleTaskPointerMove = (task, e) => {
    const state = dragStateRef.current
    if (state.taskId !== task.id) return
    state.lastX = e.clientX
    state.lastY = e.clientY
    const dx = Math.abs(state.lastX - state.startX)
    const dy = Math.abs(state.lastY - state.startY)

    if (!state.active) {
      if (state.pointerType !== 'touch' && (dx > 4 || dy > 4)) {
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
        state.active = true
        setDraggingTaskId(task.id)
        updateDragTarget(task, state.lastX, state.rowRect)
        if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(8)
        if (e.currentTarget?.setPointerCapture && state.pointerId !== null) {
          try {
            e.currentTarget.setPointerCapture(state.pointerId)
          } catch (_err) {
            void _err
            // ignore pointer capture failures
          }
        }
      } else if (state.pointerType === 'touch' && (dx > 8 || dy > 8)) {
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
      }
      return
    }

    e.preventDefault()
    const flipped = maybeFlipWeek(task, state.lastX, state.rowRect)
    if (!flipped) updateDragTarget(task, state.lastX, state.rowRect)
  }

  const handleTaskPointerUp = (task, e) => {
    const state = dragStateRef.current
    if (state.timer) clearTimeout(state.timer)
    state.timer = null

    if (!state.active) return
    state.active = false

    const dropIso = dragTargetIso
    const dropStatus = dragStatus?.taskId === task.id ? dragStatus : null
    const preview = dropStatus?.preview ?? (dropIso ? buildReschedulePreview({ lot, task, targetDateIso: dropIso, org }) : null)

    suppressClickRef.current = true
    setTimeout(() => {
      suppressClickRef.current = false
    }, 250)

    if (dropIso && preview) {
      onRescheduleTask?.({ task, targetDateIso: dropIso, preview })
    }

    if (state.pointerId !== null && e.currentTarget?.releasePointerCapture) {
      try {
        e.currentTarget.releasePointerCapture(state.pointerId)
      } catch (_err) {
        void _err
        // ignore pointer capture failures
      }
    }

    clearDragState()
  }

  const handleTaskPointerCancel = () => {
    clearDragState()
  }

  useEffect(() => {
    if (!useWorkWeek) clearDragState()
  }, [useWorkWeek])

  useEffect(() => {
    const state = dragStateRef.current
    if (!useWorkWeek || !state.active || !draggingTaskId || !state.rowRect) return
    const task = tasks.find((t) => t.id === draggingTaskId)
    if (!task) return
    updateDragTarget(task, state.lastX, state.rowRect)
  }, [activeWeekStartIso, useWorkWeek, tasks, draggingTaskId])

  return (
    <div className="overflow-auto border rounded-xl max-h-[70vh]">
      {useWorkWeek ? (
        <div className="flex items-center justify-between gap-3 border-b bg-white px-3 py-2">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Work Week</p>
            <p className="text-sm font-semibold">{weekLabel}</p>
            {onRescheduleTask ? <p className="text-[11px] text-gray-500">Long-press to drag. Pull to the edge to switch weeks.</p> : null}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                const prev = addCalendarDays(weekStart, -7)
                if (!prev) return
                setActiveWeekStartIso(formatISODate(prev))
              }}
              className="h-9 w-9 rounded-lg border border-gray-200 flex items-center justify-center disabled:opacity-40"
              disabled={!canGoPrev}
              title="Previous week"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                const next = addCalendarDays(weekStart, 7)
                if (!next) return
                setActiveWeekStartIso(formatISODate(next))
              }}
              className="h-9 w-9 rounded-lg border border-gray-200 flex items-center justify-center disabled:opacity-40"
              disabled={!canGoNext}
              title="Next week"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : null}
      <div style={{ minWidth: `${minGridWidth}px` }}>
        <div className="flex border-b bg-gray-50 sticky top-0 z-30">
          <div
            className="shrink-0 p-3 font-semibold border-r sticky left-0 z-40 bg-gray-50"
            style={{ width: taskColWidth, minWidth: taskColWidth }}
          >
            Task
          </div>
          <div className="flex-1 flex">
            {useWorkWeek
              ? weekDayIsos.map((iso) => (
                  <div key={iso} className="flex-1 p-2 text-center text-xs font-medium border-r last:border-r-0">
                    <div className="text-[10px] uppercase text-gray-500">{parseISODate(iso)?.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                    <div className="text-xs font-semibold">{formatShortDate(iso)}</div>
                  </div>
                ))
              : weeks.map((week, i) => (
                  <div key={i} className="flex-1 p-2 text-center text-xs font-medium border-r last:border-r-0">
                    {formatShortDate(week)}
                  </div>
                ))}
          </div>
        </div>

        {visibleTasks.length === 0 ? (
          <div className="p-4 text-sm text-gray-500">No tasks scheduled for this week.</div>
        ) : (
          visibleTasks.map((task) => {
          const sub = subcontractors.find((s) => s.id === task.sub_id) ?? null
          const status = deriveTaskStatus(task, lot.tasks, lot.inspections)
          const isDragging = draggingTaskId === task.id
          const isPinnedDragRow = showPinnedDrag && pinnedDragTask?.id === task.id
          const canDrag = useWorkWeek && Boolean(onRescheduleTask) && task.status !== 'complete'
          const dropIndex = dragTargetIso ? weekDayIndexByIso.get(dragTargetIso) : null
          const dropStatus = isDragging ? dragStatus : null
          const dropCls =
            dropStatus?.status === 'invalid'
              ? 'bg-red-100/70'
              : dropStatus?.status === 'valid'
                ? 'bg-green-100/70'
                : ''

          const startDate = parseISODate(task.scheduled_start)
          const endDate = parseISODate(task.scheduled_end)
          if (!startDate || !endDate) return null

          let leftPercent = 0
          let widthPercent = 0
          let duration = 0
          let startLabel = task.scheduled_start
          let endLabel = task.scheduled_end

          if (useWorkWeek) {
            let startWork = null
            let endWork = null
            if (isDragging && dragTargetIso) {
              startWork = getNextWorkDay(dragTargetIso) ?? parseISODate(dragTargetIso)
              const dragEnd = startWork ? addWorkDays(startWork, Math.max(0, Number(task.duration ?? 0) - 1)) : null
              endWork = dragEnd ?? startWork
            } else {
              startWork = isWorkDay(startDate) ? startDate : getNextWorkDay(startDate)
              endWork = isWorkDay(endDate) ? endDate : getPrevWorkDay(endDate)
            }
            if (!startWork || !endWork || endWork < startWork) return null
            const clampedStart = startWork < weekStart ? weekStart : startWork
            const clampedEnd = endWork > weekEnd ? weekEnd : endWork
            if (clampedEnd < clampedStart) return null
            const startIso = formatISODate(clampedStart)
            const endIso = formatISODate(clampedEnd)
            const startIndex = weekDayIndexByIso.get(startIso)
            const endIndex = weekDayIndexByIso.get(endIso)
            if (startIndex === undefined || endIndex === undefined) return null
            duration = Math.max(1, endIndex - startIndex + 1)
            leftPercent = (startIndex / Math.max(1, weekDayIsos.length)) * 100
            widthPercent = (duration / Math.max(1, weekDayIsos.length)) * 100
            startLabel = startIso
            endLabel = endIso
          } else {
            const startOffset = daysBetweenCalendar(startDate, minDate)
            duration = daysBetweenCalendar(endDate, startDate) + 1
            leftPercent = (startOffset / totalDays) * 100
            widthPercent = (duration / totalDays) * 100
          }

          return (
            <div key={task.id} className={`flex border-b hover:bg-gray-50 group ${isPinnedDragRow ? 'bg-blue-50/40' : ''}`}>
              <div
                className="shrink-0 p-2 border-r sticky left-0 z-20 bg-white group-hover:bg-gray-50"
                style={{ width: taskColWidth, minWidth: taskColWidth }}
              >
                <button
                  type="button"
                  onClick={() => onSelectTask?.(task.id)}
                  className="text-left w-full"
                >
                  <p className="text-sm font-medium leading-tight">{task.name}</p>
                  <p className="text-xs text-gray-500">{sub?.company_name ?? '—'}</p>
                </button>
              </div>
              <div className="flex-1 relative h-16">
                {(useWorkWeek ? weekDayIsos : weeks).map((_, i) => (
                  <div
                    key={i}
                    className="absolute top-0 bottom-0 border-r border-gray-100"
                    style={{ left: `${((i + 1) / columnCount) * 100}%` }}
                  />
                ))}
                {canDrag && isDragging && dropIndex !== null ? (
                  <div
                    className={`absolute top-0 bottom-0 ${dropCls} pointer-events-none`}
                    style={{ left: `${(dropIndex / columnCount) * 100}%`, width: `${100 / columnCount}%` }}
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => handleTaskClick(task.id)}
                  onPointerDown={canDrag ? (e) => handleTaskPointerDown(task, e) : undefined}
                  onPointerMove={canDrag ? (e) => handleTaskPointerMove(task, e) : undefined}
                  onPointerUp={canDrag ? (e) => handleTaskPointerUp(task, e) : undefined}
                  onPointerCancel={canDrag ? handleTaskPointerCancel : undefined}
                  className={`absolute top-2 h-10 rounded-lg flex items-center px-2 shadow-sm ${
                    canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
                  }`}
                  style={{
                    left: `${leftPercent}%`,
                    width: `${Math.max(widthPercent, 3)}%`,
                    backgroundColor: STATUS_COLORS[status] || STATUS_COLORS.pending,
                  }}
                  title={`${task.name}\n${formatShortDate(startLabel)} - ${formatShortDate(endLabel)}\n${duration} day${duration === 1 ? '' : 's'}`}
                >
                  <span className="text-xs text-white font-medium truncate">
                    {task.name} ({duration}d)
                  </span>
                </button>
              </div>
            </div>
          )
        }))}
      </div>
    </div>
  )
}

function InspectionsModal({ lot, community, onClose, onOpenInspection, onScheduleInspectionForTask }) {
  const inspections = lot.inspections ?? []
  const inspectionTasks = (lot.tasks ?? []).filter((t) => t.requires_inspection && t.status !== 'complete' && !t.inspection_id)

  return (
    <Modal title="🔍 Inspections" onClose={onClose}>
      <div className="space-y-4">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">
            {community?.name ?? 'Community'} • {lotCode(lot)}
          </p>
          <p className="text-xs text-gray-600 mt-1">Schedule inspections by type and track results here.</p>
        </Card>

        <div className="grid grid-cols-2 gap-2">
          <PrimaryButton
            onClick={() => {
              onScheduleInspectionForTask(null)
              onClose?.()
            }}
            className="w-full"
          >
            + New Inspection
          </PrimaryButton>
          <SecondaryButton onClick={onClose} className="w-full">
            Close
          </SecondaryButton>
        </div>

        {inspectionTasks.length > 0 ? (
          <Card className="border-orange-200 bg-orange-50">
            <p className="font-semibold text-orange-800 mb-2">Inspection Requirements</p>
            <p className="text-xs text-orange-700 mb-3">Schedule the required inspections for these tasks.</p>
            <div className="space-y-2">
              {inspectionTasks.slice(0, 6).map((t) => (
                <div
                  key={t.id}
                  className="w-full bg-white border border-orange-200 rounded-xl p-3 flex items-center justify-between gap-3"
                >
                  <div className="text-left">
                    <p className="font-semibold">{t.inspection_type ?? 'Inspection'} • {t.name}</p>
                    <p className="text-xs text-gray-600 mt-1">Needs scheduling before completion.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onScheduleInspectionForTask(t.id)
                      onClose?.()
                    }}
                    className="px-3 py-2 rounded-xl bg-white border border-orange-200 text-sm font-semibold text-orange-700"
                  >
                    Schedule
                  </button>
                </div>
              ))}
            </div>
          </Card>
        ) : null}

        <Card>
          <p className="font-semibold mb-2">Scheduled + Notes</p>
          {inspections.length === 0 ? (
            <p className="text-sm text-gray-600">No inspections yet. Schedule one above.</p>
          ) : (
            <div className="space-y-2">
              {inspections
                .slice()
                .sort((a, b) => String(b.scheduled_date).localeCompare(String(a.scheduled_date)))
                .map((i) => {
                  const label = INSPECTION_TYPES.find((t) => t.code === i.type)?.label ?? i.type
                  const isNote = i.type === 'NOTE'
                  const attachmentCount = (i.documents ?? []).length + (i.report_document ? 1 : 0)
                  const badge =
                    i.result === 'pass'
                      ? STATUS_BADGE.complete
                      : i.result === 'fail'
                        ? STATUS_BADGE.delayed
                        : i.result === 'partial'
                          ? STATUS_BADGE.blocked
                          : STATUS_BADGE.pending
                  return (
                    <button
                      key={i.id}
                      onClick={() => onOpenInspection(i.id)}
                      className="w-full bg-gray-50 rounded-xl border border-gray-200 p-3 text-left"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold">
                            {label} ({i.type})
                          </p>
                          <p className="text-xs text-gray-600 mt-1">
                            {formatShortDateWithWeekday(i.scheduled_date)} {i.scheduled_time ? `• ${i.scheduled_time}` : ''}
                            {attachmentCount ? ` • ${attachmentCount} file${attachmentCount === 1 ? '' : 's'}` : ''}
                          </p>
                        </div>
                        {isNote ? (
                          <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-lg border bg-indigo-50 text-indigo-700 border-indigo-200">
                            NOTE
                          </span>
                        ) : (
                          <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-lg border ${badge.cls}`}>
                            {i.result ? i.result.toUpperCase() : 'SCHEDULED'}
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
            </div>
          )}
        </Card>
      </div>
    </Modal>
  )
}

function CommunitySpecEditorModal({ community, spec, templateTasks, productTypes, plans, isOnline, onClose, onSave, onDelete }) {
  const [draft, setDraft] = useState(() => ({
    id: spec?.id ?? null,
    title: spec?.title ?? '',
    description: spec?.description ?? '',
    category: spec?.category ?? 'other',
    trade_trigger: spec?.trade_trigger ?? '',
    task_trigger: spec?.task_trigger ?? '',
    priority: spec?.priority ?? 'info',
    applies_to: spec?.applies_to ?? 'all',
    product_type_ids: spec?.product_type_ids ?? [],
    plan_ids: spec?.plan_ids ?? [],
    documents: spec?.documents ?? [],
    photos: spec?.photos ?? [],
  }))

  const hasApplicability =
    draft.applies_to === 'all' ||
    (draft.applies_to === 'product_type' && (draft.product_type_ids ?? []).length > 0) ||
    (draft.applies_to === 'plan' && (draft.plan_ids ?? []).length > 0)
  const canSave = draft.title.trim().length > 0 && hasApplicability
  const taskOptions = useMemo(() => {
    const tasks = Array.isArray(templateTasks) ? templateTasks : []
    const filtered = draft.trade_trigger ? tasks.filter((t) => t.trade === draft.trade_trigger) : tasks
    const byName = new Map()
    for (const t of filtered) {
      const name = String(t?.name ?? '').trim()
      if (!name) continue
      const prev = byName.get(name)
      const order = Number(t?.sort_order ?? 0) || 0
      if (!prev || order < prev.sort_order) byName.set(name, { name, sort_order: order })
    }
    return Array.from(byName.values()).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name))
  }, [templateTasks, draft.trade_trigger])

  const taskTriggerSelectValue =
    draft.task_trigger === '' || taskOptions.some((t) => t.name === draft.task_trigger) ? draft.task_trigger : '__custom__'

  const openAttachment = async (blobId) => {
    if (!blobId) return
    try {
      const blob = await getBlob(blobId)
      if (!blob) return
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      console.error(err)
      alert('Unable to open file.')
    }
  }

  const addAttachment = async (file) => {
    if (!file) return
    const max = 50 * 1024 * 1024
    if (file.size > max) return alert('File must be ≤ 50MB.')
    if (!isOnline) return alert('Uploading documents requires an internet connection.')

    const blobId = uuid()
    await putBlob(blobId, file)
    const doc = {
      id: uuid(),
      file_name: file.name,
      mime: file.type,
      file_size: file.size,
      blob_id: blobId,
      uploaded_at: new Date().toISOString(),
    }

    const isPhoto = String(file.type).startsWith('image/')
    setDraft((p) => ({
      ...p,
      ...(isPhoto
        ? { photos: [...(p.photos ?? []), doc] }
        : { documents: [...(p.documents ?? []), doc] }),
    }))
  }

  return (
    <Modal
      title={spec ? 'Edit Community Spec' : 'Add Community Spec'}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          {spec ? (
            <SecondaryButton
              onClick={() => onDelete?.(spec.id)}
              className="flex-1 border-red-200 text-red-700 bg-red-50"
            >
              Delete
            </SecondaryButton>
          ) : (
            <SecondaryButton onClick={onClose} className="flex-1">
              Cancel
            </SecondaryButton>
          )}
          <PrimaryButton
            onClick={() =>
              onSave?.({
                ...draft,
                title: draft.title.trim(),
                description: draft.description.trim(),
              })
            }
            className="flex-1"
            disabled={!canSave}
          >
            Save Spec
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">{community?.name ?? 'Community'}</p>
          {!isOnline ? <p className="text-xs text-orange-700 mt-1">Offline — attachments require connection.</p> : null}
        </Card>

        <label className="block">
          <span className="text-sm font-semibold">Title *</span>
          <input
            value={draft.title}
            onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            placeholder="Tankless Water Heaters Only"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Description</span>
          <textarea
            value={draft.description}
            onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            rows={4}
            placeholder="Rinnai RU199iN preferred. No tank heaters permitted..."
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-sm font-semibold">Category</span>
            <select
              value={draft.category}
              onChange={(e) => setDraft((p) => ({ ...p, category: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
            >
              {COMMUNITY_SPEC_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-semibold">Priority</span>
            <select
              value={draft.priority}
              onChange={(e) => setDraft((p) => ({ ...p, priority: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
            >
              <option value="required">Required</option>
              <option value="preferred">Preferred</option>
              <option value="info">Info</option>
            </select>
          </label>
        </div>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Applies To</p>
          <select
            value={draft.applies_to}
            onChange={(e) =>
              setDraft((p) => ({
                ...p,
                applies_to: e.target.value,
                product_type_ids: e.target.value === 'product_type' ? p.product_type_ids : [],
                plan_ids: e.target.value === 'plan' ? p.plan_ids : [],
              }))
            }
            className="w-full px-3 py-2 border rounded-xl text-sm"
          >
            <option value="all">All Lots</option>
            <option value="product_type">Product Type</option>
            <option value="plan">Specific Plan</option>
          </select>

          {draft.applies_to === 'product_type' ? (
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
              {(productTypes ?? []).map((pt) => (
                <label key={pt.id} className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={(draft.product_type_ids ?? []).includes(pt.id)}
                    onChange={(e) =>
                      setDraft((p) => {
                        const next = new Set(p.product_type_ids ?? [])
                        if (e.target.checked) next.add(pt.id)
                        else next.delete(pt.id)
                        return { ...p, product_type_ids: Array.from(next) }
                      })
                    }
                  />
                  {pt.name}
                </label>
              ))}
            </div>
          ) : null}

          {draft.applies_to === 'plan' ? (
            <div className="mt-2 space-y-1 text-sm">
              {(plans ?? []).map((plan) => {
                const pt = (productTypes ?? []).find((p) => p.id === plan.product_type_id)
                return (
                  <label key={plan.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={(draft.plan_ids ?? []).includes(plan.id)}
                      onChange={(e) =>
                        setDraft((p) => {
                          const next = new Set(p.plan_ids ?? [])
                          if (e.target.checked) next.add(plan.id)
                          else next.delete(plan.id)
                          return { ...p, plan_ids: Array.from(next) }
                        })
                      }
                    />
                    <span>
                      {plan.name} {pt ? `(${pt.name})` : ''}
                    </span>
                  </label>
                )
              })}
            </div>
          ) : null}

          {!hasApplicability ? <p className="text-xs text-red-600 mt-2">Select at least one option.</p> : null}
        </Card>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-sm font-semibold">Trade Trigger</span>
            <select
              value={draft.trade_trigger}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  trade_trigger: e.target.value,
                  // If the selected task isn't in the new filtered set, keep it as a custom trigger.
                }))
              }
              className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
            >
              <option value="">All Trades</option>
              {TRADES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-semibold">Task Trigger</span>
            <select
              value={taskTriggerSelectValue}
              onChange={(e) => {
                const v = e.target.value
                if (v === '__custom__') return setDraft((p) => ({ ...p, task_trigger: p.task_trigger || '' }))
                setDraft((p) => ({ ...p, task_trigger: v }))
              }}
              className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
            >
              <option value="">All Tasks</option>
              {taskOptions.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
              <option value="__custom__">Custom…</option>
            </select>
            {taskTriggerSelectValue === '__custom__' ? (
              <input
                value={draft.task_trigger}
                onChange={(e) => setDraft((p) => ({ ...p, task_trigger: e.target.value }))}
                className="mt-2 w-full px-3 py-3 border rounded-xl text-sm"
                placeholder="Type a task name substring (e.g., Rough Plumbing)"
              />
            ) : null}
          </label>
        </div>

        <Card>
          <div className="flex items-center justify-between mb-2">
            <p className="font-semibold">Attachments</p>
            <label className={`text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white ${!isOnline ? 'opacity-50' : 'cursor-pointer'}`}>
              + Add
              <input
                type="file"
                className="hidden"
                accept="application/pdf,image/*"
                disabled={!isOnline}
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  await addAttachment(file)
                  e.target.value = ''
                }}
              />
            </label>
          </div>

          {(draft.documents ?? []).length === 0 && (draft.photos ?? []).length === 0 ? (
            <p className="text-sm text-gray-600">No attachments.</p>
          ) : (
            <div className="space-y-2">
              {(draft.documents ?? []).map((d) => (
                <div key={d.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                  <p className="text-sm font-semibold">{d.file_name}</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => openAttachment(d.blob_id)}
                      className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                    >
                      Open
                    </button>
                    <button
                      onClick={async () => {
                        setDraft((p) => ({ ...p, documents: (p.documents ?? []).filter((x) => x.id !== d.id) }))
                        if (d.blob_id) await deleteBlob(d.blob_id)
                      }}
                      className="px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm font-semibold"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}

              {(draft.photos ?? []).map((p) => (
                <div key={p.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                  <p className="text-sm font-semibold">{p.file_name}</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => openAttachment(p.blob_id)}
                      className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                    >
                      Open
                    </button>
                    <button
                      onClick={async () => {
                        setDraft((d) => ({ ...d, photos: (d.photos ?? []).filter((x) => x.id !== p.id) }))
                        if (p.blob_id) await deleteBlob(p.blob_id)
                      }}
                      className="px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm font-semibold"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Modal>
  )
}

function CommunitySpecBulkModal({ community, productTypes, plans, onClose, onSave }) {
  const [titles, setTitles] = useState('')
  const [draft, setDraft] = useState(() => ({
    category: 'other',
    priority: 'info',
    trade_trigger: '',
    task_trigger: '',
    applies_to: 'all',
    product_type_ids: [],
    plan_ids: [],
  }))

  const hasApplicability =
    draft.applies_to === 'all' ||
    (draft.applies_to === 'product_type' && (draft.product_type_ids ?? []).length > 0) ||
    (draft.applies_to === 'plan' && (draft.plan_ids ?? []).length > 0)
  const titlesList = titles
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
  const canSave = titlesList.length > 0 && hasApplicability

  return (
    <Modal
      title="Bulk Add Specs"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() =>
              onSave?.(
                titlesList.map((title) => ({
                  id: uuid(),
                  title,
                  description: '',
                  category: draft.category,
                  trade_trigger: draft.trade_trigger,
                  task_trigger: draft.task_trigger,
                  priority: draft.priority,
                  applies_to: draft.applies_to,
                  product_type_ids: draft.product_type_ids ?? [],
                  plan_ids: draft.plan_ids ?? [],
                  documents: [],
                  photos: [],
                })),
              )
            }
            className="flex-1"
            disabled={!canSave}
          >
            Save Specs
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">{community?.name ?? 'Community'}</p>
        </Card>

        <label className="block">
          <span className="text-sm font-semibold">Spec Titles (one per line)</span>
          <textarea
            value={titles}
            onChange={(e) => setTitles(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            rows={6}
            placeholder="Tankless Water Heaters Only&#10;EV Charger Rough-In&#10;No carpet on main floor"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-sm font-semibold">Category</span>
            <select
              value={draft.category}
              onChange={(e) => setDraft((p) => ({ ...p, category: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
            >
              {COMMUNITY_SPEC_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-semibold">Priority</span>
            <select
              value={draft.priority}
              onChange={(e) => setDraft((p) => ({ ...p, priority: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
            >
              <option value="required">Required</option>
              <option value="preferred">Preferred</option>
              <option value="info">Info</option>
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-sm font-semibold">Trade Trigger</span>
            <select
              value={draft.trade_trigger}
              onChange={(e) => setDraft((p) => ({ ...p, trade_trigger: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
            >
              <option value="">All Trades</option>
              {TRADES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-semibold">Task Trigger</span>
            <input
              value={draft.task_trigger}
              onChange={(e) => setDraft((p) => ({ ...p, task_trigger: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
              placeholder="Optional task name"
            />
          </label>
        </div>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Applies To</p>
          <select
            value={draft.applies_to}
            onChange={(e) =>
              setDraft((p) => ({
                ...p,
                applies_to: e.target.value,
                product_type_ids: e.target.value === 'product_type' ? p.product_type_ids : [],
                plan_ids: e.target.value === 'plan' ? p.plan_ids : [],
              }))
            }
            className="w-full px-3 py-2 border rounded-xl text-sm"
          >
            <option value="all">All Lots</option>
            <option value="product_type">Product Type</option>
            <option value="plan">Specific Plan</option>
          </select>

          {draft.applies_to === 'product_type' ? (
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
              {(productTypes ?? []).map((pt) => (
                <label key={pt.id} className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={(draft.product_type_ids ?? []).includes(pt.id)}
                    onChange={(e) =>
                      setDraft((p) => {
                        const next = new Set(p.product_type_ids ?? [])
                        if (e.target.checked) next.add(pt.id)
                        else next.delete(pt.id)
                        return { ...p, product_type_ids: Array.from(next) }
                      })
                    }
                  />
                  {pt.name}
                </label>
              ))}
            </div>
          ) : null}

          {draft.applies_to === 'plan' ? (
            <div className="mt-2 space-y-1 text-sm">
              {(plans ?? []).map((plan) => {
                const pt = (productTypes ?? []).find((p) => p.id === plan.product_type_id)
                return (
                  <label key={plan.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={(draft.plan_ids ?? []).includes(plan.id)}
                      onChange={(e) =>
                        setDraft((p) => {
                          const next = new Set(p.plan_ids ?? [])
                          if (e.target.checked) next.add(plan.id)
                          else next.delete(plan.id)
                          return { ...p, plan_ids: Array.from(next) }
                        })
                      }
                    />
                    <span>
                      {plan.name} {pt ? `(${pt.name})` : ''}
                    </span>
                  </label>
                )
              })}
            </div>
          ) : null}

          {!hasApplicability ? <p className="text-xs text-red-600 mt-2">Select at least one option.</p> : null}
        </Card>
      </div>
    </Modal>
  )
}

function CommunityContactsModal({
  community,
  agencies,
  contactLibraryRealtors = [],
  contactLibraryBuilders = [],
  onClose,
  onSave,
}) {
  const lotCount = community?.lot_count ?? 0
  const [draft, setDraft] = useState(() => ({
    builders: (community.builders ?? []).map((b, idx) => ({
      id: b.id ?? uuid(),
      name: b.name ?? '',
      phone: b.phone ?? '',
      email: b.email ?? '',
      color: b.color ?? BUILDER_COLORS[idx % BUILDER_COLORS.length] ?? '#3B82F6',
      lot_ranges: toRangeString(b.assigned_lots ?? []),
    })),
    realtors: (community.realtors ?? []).map((r) => ({
      id: r.id ?? uuid(),
      name: r.name ?? '',
      phone: r.phone ?? '',
      email: r.email ?? '',
      company: r.company ?? '',
    })),
    inspectors: (community.inspectors ?? []).map((i) => ({
      id: i.id ?? uuid(),
      name: i.name ?? '',
      phone: i.phone ?? '',
      email: i.email ?? '',
      agency_id: i.agency_id ?? '',
    })),
  }))
  const [builderRangeDrafts, setBuilderRangeDrafts] = useState({})
  const [realtorPersonaId, setRealtorPersonaId] = useState('')
  const [builderPersonaId, setBuilderPersonaId] = useState('')

  const buildRangeNumbers = (startValue, endValue) => {
    const startNum = Number.parseInt(startValue, 10)
    const endNum = Number.parseInt(endValue || startValue, 10)
    if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) return []
    return normalizeRange(`${startNum}-${endNum}`, lotCount)
  }

  const rangesFromLots = (lots) => {
    const rangeString = toRangeString(lots)
    if (!rangeString) return []
    return rangeString.split(',').map((part) => part.trim()).filter(Boolean)
  }

  const isBlankRealtor = (realtor) =>
    !String(realtor?.name ?? '').trim() &&
    !String(realtor?.phone ?? '').trim() &&
    !String(realtor?.email ?? '').trim() &&
    !String(realtor?.company ?? '').trim()

  const isBlankBuilder = (builder) =>
    !String(builder?.name ?? '').trim() &&
    !String(builder?.phone ?? '').trim() &&
    !String(builder?.email ?? '').trim()

  const addRealtorFromLibrary = (personaId) => {
    const persona = contactLibraryRealtors.find((r) => r.id === personaId)
    if (!persona) return
    setDraft((d) => {
      const nextRealtors = [...(d.realtors ?? [])]
      const blankIndex = nextRealtors.findIndex((r) => isBlankRealtor(r))
      const payload = {
        name: persona.name ?? '',
        phone: persona.phone ?? '',
        email: persona.email ?? '',
        company: persona.company ?? '',
      }

      if (blankIndex >= 0) {
        const existing = nextRealtors[blankIndex]
        nextRealtors[blankIndex] = { ...existing, ...payload }
      } else {
        nextRealtors.push({ id: uuid(), ...payload })
      }

      return { ...d, realtors: nextRealtors }
    })
  }

  const addBuilderFromLibrary = (personaId) => {
    const persona = contactLibraryBuilders.find((b) => b.id === personaId)
    if (!persona) return
    setDraft((d) => {
      const nextBuilders = [...(d.builders ?? [])]
      const blankIndex = nextBuilders.findIndex((b) => isBlankBuilder(b))
      const targetIndex = blankIndex >= 0 ? blankIndex : nextBuilders.length
      const existing = blankIndex >= 0 ? nextBuilders[blankIndex] : { id: uuid(), lot_ranges: '' }
      const color =
        persona.color ||
        existing.color ||
        (BUILDER_COLORS[targetIndex % BUILDER_COLORS.length] ?? '#3B82F6')

      const payload = {
        name: persona.name ?? '',
        phone: persona.phone ?? '',
        email: persona.email ?? '',
        color,
      }

      if (blankIndex >= 0) {
        nextBuilders[blankIndex] = { ...existing, ...payload }
      } else {
        nextBuilders.push({ ...existing, ...payload })
      }

      return { ...d, builders: nextBuilders }
    })
  }

  const updateBuilderLots = (targetId, nextLots, removeFromOthers = true) => {
    setDraft((d) => {
      const nextBuilders = (d.builders ?? []).map((b) => ({
        ...b,
        assigned: normalizeRange(b.lot_ranges, lotCount),
      }))
      const nextSet = new Set(nextLots)
      if (removeFromOthers) {
        for (const builder of nextBuilders) {
          if (builder.id === targetId) continue
          builder.assigned = builder.assigned.filter((lotNum) => !nextSet.has(lotNum))
        }
      }
      for (const builder of nextBuilders) {
        if (builder.id !== targetId) continue
        builder.assigned = Array.from(nextSet).sort((a, b) => a - b)
      }
      return {
        ...d,
        builders: nextBuilders.map((b) => ({
          id: b.id,
          name: b.name,
          phone: b.phone,
          email: b.email,
          color: b.color,
          lot_ranges: toRangeString(b.assigned),
        })),
      }
    })
  }

  const activeBuilders = (draft.builders ?? []).filter((b) => {
    const hasContact = String(b.name || b.email || b.phone).trim()
    const hasLots = normalizeRange(b.lot_ranges, lotCount).length > 0
    return hasContact || hasLots
  })
  const builderAssignments = activeBuilders.map((b) => ({
    id: b.id,
    lots: normalizeRange(b.lot_ranges, lotCount),
  }))
  const builderValidation = validateAssignments({ assignments: builderAssignments, lotCount })
  const buildersValid =
    builderValidation.missing.length === 0 &&
    builderValidation.duplicates.length === 0 &&
    builderValidation.out_of_range.length === 0

  const handleSave = () => {
    const builders = activeBuilders.map((b) => ({
      id: b.id,
      name: b.name.trim(),
      phone: b.phone.trim(),
      email: b.email.trim(),
      color: b.color || '#3B82F6',
      assigned_lots: normalizeRange(b.lot_ranges, lotCount),
    }))
    const realtors = (draft.realtors ?? [])
      .filter((r) => String(r.name || r.email || r.phone).trim())
      .map((r) => ({ id: r.id, name: r.name.trim(), phone: r.phone.trim(), email: r.email.trim(), company: r.company.trim() }))
    const inspectors = (draft.inspectors ?? [])
      .filter((i) => String(i.name || i.email || i.phone).trim())
      .map((i) => ({ id: i.id, name: i.name.trim(), phone: i.phone.trim(), email: i.email.trim(), agency_id: i.agency_id || '' }))

    onSave?.({ builders, realtors, inspectors })
  }

  return (
    <Modal
      title="Edit Community Contacts"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton onClick={handleSave} className="flex-1" disabled={!buildersValid}>
            Save Contacts
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-4">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">{community?.name ?? 'Community'}</p>
        </Card>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="font-semibold">Builders</p>
            <div className="flex items-center gap-2">
              {contactLibraryBuilders.length > 0 ? (
                <select
                  value={builderPersonaId}
                  onChange={(e) => {
                    const nextId = e.target.value
                    if (!nextId) return
                    addBuilderFromLibrary(nextId)
                    setBuilderPersonaId('')
                  }}
                  className="text-sm px-2 py-1 rounded-xl border border-gray-200 bg-white"
                >
                  <option value="">Add from library...</option>
                  {contactLibraryBuilders.map((b) => (
                    <option key={b.id} value={b.id}>
                      {(b.name ?? 'Unnamed') + (b.email ? ` - ${b.email}` : '')}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    builders: [...(d.builders ?? []), { id: uuid(), name: '', phone: '', email: '', color: '#3B82F6', lot_ranges: '' }],
                  }))
                }
                className="text-sm font-semibold px-3 py-1 rounded-xl border border-gray-200 bg-white"
              >
                + Add
              </button>
            </div>
          </div>
          {contactLibraryBuilders.length === 0 ? (
            <p className="text-xs text-gray-500">No saved builders yet. Add them in Admin &gt; Contact Library.</p>
          ) : null}
          {(draft.builders ?? []).map((b) => (
            <div key={b.id} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
              {(() => {
                const assignedLots = normalizeRange(b.lot_ranges, lotCount)
                const rangeTokens = rangesFromLots(assignedLots)
                const draftRange = builderRangeDrafts[b.id] ?? { start: '', end: '' }
                return (
                  <>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={b.name}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      builders: (d.builders ?? []).map((x) => (x.id === b.id ? { ...x, name: e.target.value } : x)),
                    }))
                  }
                  className="w-full px-3 py-2 border rounded-xl"
                  placeholder="Name"
                />
                <input
                  type="color"
                  value={b.color || '#3B82F6'}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      builders: (d.builders ?? []).map((x) => (x.id === b.id ? { ...x, color: e.target.value } : x)),
                    }))
                  }
                  className="w-full h-10 border rounded-xl"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={b.phone}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      builders: (d.builders ?? []).map((x) => (x.id === b.id ? { ...x, phone: formatPhoneInput(e.target.value) } : x)),
                    }))
                  }
                  className="w-full px-3 py-2 border rounded-xl"
                  placeholder="Phone"
                />
                <input
                  value={b.email}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      builders: (d.builders ?? []).map((x) => (x.id === b.id ? { ...x, email: e.target.value } : x)),
                    }))
                  }
                  className="w-full px-3 py-2 border rounded-xl"
                  placeholder="Email"
                />
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-700">Assigned lots</p>
                  <span className="text-xs text-gray-500">{assignedLots.length} lots</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <input
                    type="number"
                    min="1"
                    max={lotCount}
                    value={draftRange.start}
                    onChange={(e) =>
                      setBuilderRangeDrafts((prev) => ({
                        ...prev,
                        [b.id]: { ...draftRange, start: e.target.value },
                      }))
                    }
                    className="px-3 py-2 border rounded-xl bg-white"
                    placeholder="Start"
                  />
                  <input
                    type="number"
                    min="1"
                    max={lotCount}
                    value={draftRange.end}
                    onChange={(e) =>
                      setBuilderRangeDrafts((prev) => ({
                        ...prev,
                        [b.id]: { ...draftRange, end: e.target.value },
                      }))
                    }
                    className="px-3 py-2 border rounded-xl bg-white"
                    placeholder="End"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const nextLots = buildRangeNumbers(draftRange.start, draftRange.end)
                      if (nextLots.length === 0) return
                      updateBuilderLots(b.id, [...assignedLots, ...nextLots])
                      setBuilderRangeDrafts((prev) => ({ ...prev, [b.id]: { start: '', end: '' } }))
                    }}
                    className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                  >
                    + Add Range
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {rangeTokens.length === 0 ? (
                    <span className="text-xs text-gray-500">No lots assigned yet.</span>
                  ) : (
                    rangeTokens.map((token) => (
                      <button
                        key={token}
                        type="button"
                        onClick={() => {
                          const removeSet = new Set(normalizeRange(token, lotCount))
                          updateBuilderLots(
                            b.id,
                            assignedLots.filter((lotNum) => !removeSet.has(lotNum)),
                            false,
                          )
                        }}
                        className="text-xs px-2 py-1 rounded-full border border-gray-200 bg-white"
                        title="Remove range"
                      >
                        {token} ×
                      </button>
                    ))
                  )}
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      if (builderValidation.missing.length === 0) return
                      updateBuilderLots(b.id, [...assignedLots, ...builderValidation.missing])
                    }}
                    className="px-2 py-1 rounded-lg border border-gray-200 bg-white text-gray-700"
                  >
                    Assign remaining
                  </button>
                  <button
                    type="button"
                    onClick={() => updateBuilderLots(b.id, [], false)}
                    className="px-2 py-1 rounded-lg border border-gray-200 bg-white text-gray-500"
                  >
                    Clear
                  </button>
                  <span className="text-[11px] text-gray-500">Assigning here removes lots from other builders.</span>
                </div>
              </div>
              <button
                onClick={() => setDraft((d) => ({ ...d, builders: (d.builders ?? []).filter((x) => x.id !== b.id) }))}
                className="text-xs text-red-600"
              >
                Remove
              </button>
                  </>
                )
              })()}
            </div>
          ))}
          {!buildersValid ? (
            <p className="text-xs text-red-600">
              Assign all lots (missing: {builderValidation.missing.length}, duplicates: {builderValidation.duplicates.length})
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="font-semibold">Realtors</p>
            <div className="flex items-center gap-2">
              {contactLibraryRealtors.length > 0 ? (
                <select
                  value={realtorPersonaId}
                  onChange={(e) => {
                    const nextId = e.target.value
                    if (!nextId) return
                    addRealtorFromLibrary(nextId)
                    setRealtorPersonaId('')
                  }}
                  className="text-sm px-2 py-1 rounded-xl border border-gray-200 bg-white"
                >
                  <option value="">Add from library...</option>
                  {contactLibraryRealtors.map((r) => (
                    <option key={r.id} value={r.id}>
                      {(r.name ?? 'Unnamed') + (r.company ? ` - ${r.company}` : '')}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    realtors: [...(d.realtors ?? []), { id: uuid(), name: '', phone: '', email: '', company: '' }],
                  }))
                }
                className="text-sm font-semibold px-3 py-1 rounded-xl border border-gray-200 bg-white"
              >
                + Add
              </button>
            </div>
          </div>
          {contactLibraryRealtors.length === 0 ? (
            <p className="text-xs text-gray-500">No saved realtors yet. Add them in Admin &gt; Contact Library.</p>
          ) : null}
          {(draft.realtors ?? []).map((r) => (
            <div key={r.id} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
              <input
                value={r.name}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    realtors: (d.realtors ?? []).map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)),
                  }))
                }
                className="w-full px-3 py-2 border rounded-xl"
                placeholder="Name"
              />
              <input
                value={r.company}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    realtors: (d.realtors ?? []).map((x) => (x.id === r.id ? { ...x, company: e.target.value } : x)),
                  }))
                }
                className="w-full px-3 py-2 border rounded-xl"
                placeholder="Company"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={r.phone}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      realtors: (d.realtors ?? []).map((x) => (x.id === r.id ? { ...x, phone: formatPhoneInput(e.target.value) } : x)),
                    }))
                  }
                  className="w-full px-3 py-2 border rounded-xl"
                  placeholder="Phone"
                />
                <input
                  value={r.email}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      realtors: (d.realtors ?? []).map((x) => (x.id === r.id ? { ...x, email: e.target.value } : x)),
                    }))
                  }
                  className="w-full px-3 py-2 border rounded-xl"
                  placeholder="Email"
                />
              </div>
              <button
                onClick={() => setDraft((d) => ({ ...d, realtors: (d.realtors ?? []).filter((x) => x.id !== r.id) }))}
                className="text-xs text-red-600"
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="font-semibold">Inspectors</p>
            <button
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  inspectors: [...(d.inspectors ?? []), { id: uuid(), name: '', phone: '', email: '', agency_id: '' }],
                }))
              }
              className="text-sm font-semibold px-3 py-1 rounded-xl border border-gray-200 bg-white"
            >
              + Add
            </button>
          </div>
          {(draft.inspectors ?? []).map((i) => (
            <div key={i.id} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
              <input
                value={i.name}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    inspectors: (d.inspectors ?? []).map((x) => (x.id === i.id ? { ...x, name: e.target.value } : x)),
                  }))
                }
                className="w-full px-3 py-2 border rounded-xl"
                placeholder="Name"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={i.phone}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      inspectors: (d.inspectors ?? []).map((x) => (x.id === i.id ? { ...x, phone: formatPhoneInput(e.target.value) } : x)),
                    }))
                  }
                  className="w-full px-3 py-2 border rounded-xl"
                  placeholder="Phone"
                />
                <input
                  value={i.email}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      inspectors: (d.inspectors ?? []).map((x) => (x.id === i.id ? { ...x, email: e.target.value } : x)),
                    }))
                  }
                  className="w-full px-3 py-2 border rounded-xl"
                  placeholder="Email"
                />
              </div>
              <select
                value={i.agency_id}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    inspectors: (d.inspectors ?? []).map((x) => (x.id === i.id ? { ...x, agency_id: e.target.value } : x)),
                  }))
                }
                className="w-full px-3 py-2 border rounded-xl text-sm"
              >
                <option value="">Select agency...</option>
                {agencies.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setDraft((d) => ({ ...d, inspectors: (d.inspectors ?? []).filter((x) => x.id !== i.id) }))}
                className="text-xs text-red-600"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

function MessageModal({ lot, community, task, org, isOnline, subcontractors, initialSubId, onClose, onSend }) {
  const [subId, setSubId] = useState(initialSubId ?? '')
  const [sms, setSms] = useState(true)
  const [email, setEmail] = useState(false)
  const [appChannel, setAppChannel] = useState(false)
  const [templateKey, setTemplateKey] = useState(() => (task && lot && community ? 'schedule_change' : 'custom'))

  const applyTemplate = (template, vars) =>
    String(template ?? '').replaceAll(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => (vars?.[key] ?? `{${key}}`))

  const buildVars = (sub) => {
    const builder_name = org?.builder_name ?? org?.name ?? ''
    const super_phone = org?.super_phone ?? ''
    const communityName = community?.name ?? ''
    const block = lot?.block ?? ''
    const lotNum = lot?.lot_number ?? ''
    const lot_address = lot?.address ?? ''
    const task_name = task?.name ?? ''
    const start_date = task?.scheduled_start ? formatShortDate(task.scheduled_start) : ''
    const end_date = task?.scheduled_end ? formatShortDate(task.scheduled_end) : ''
    return {
      builder_name,
      super_phone,
      community: communityName,
      block,
      lot: lotNum,
      lot_address,
      sub_name: sub?.company_name ?? '',
      task_name,
      start_date,
      end_date,
      old_start_date: start_date,
      new_start_date: start_date,
      change_reason: '',
      inspection_type: '',
      failure_items_list: '',
      target_date: '',
    }
  }

  const renderFromTemplate = ({ key, subId: subIdOverride }) => {
    if (key === 'custom') return ''
    const template = MESSAGE_TEMPLATES?.[key]
    if (!template) return ''
    const sub = subcontractors.find((s) => s.id === subIdOverride) ?? null
    return applyTemplate(template, buildVars(sub))
  }

  const [body, setBody] = useState(() => renderFromTemplate({ key: templateKey, subId: initialSubId ?? '' }))

  return (
    <Modal
      title="Message Sub"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() => onSend({ sub_id: subId, body, channels: { sms, email, app: appChannel } })}
            className="flex-1"
            disabled={!subId || !body.trim()}
          >
            Send Message
          </PrimaryButton>
        </div>
      }
    >
		      <div className="space-y-3">
		        <Card className="bg-gray-50">
		          {lot && community ? (
		            <>
		              <p className="text-sm text-gray-600">
		                {community.name} • {lotCode(lot)}
		              </p>
		              {task ? <p className="text-xs text-gray-600 mt-1">Task: {task.name}</p> : null}
		            </>
		          ) : (
		            <p className="text-sm text-gray-600">{org?.builder_name ?? org?.name ?? 'BuildFlow'}</p>
		          )}
		          {!isOnline ? <p className="text-xs text-orange-700 mt-1">Offline — message will queue.</p> : null}
		        </Card>

            <label className="block">
              <span className="text-sm font-semibold">Template</span>
              <select
                value={templateKey}
                onChange={(e) => {
                  const next = e.target.value
                  setTemplateKey(next)
                  const nextBody = renderFromTemplate({ key: next, subId })
                  if (nextBody) setBody(nextBody)
                  else if (next === 'custom') setBody('')
                }}
                className="mt-1 w-full px-3 py-3 border rounded-xl"
              >
                <option value="custom">Custom (blank)</option>
                <option value="schedule_notification">📅 New Schedule</option>
                <option value="schedule_change">📅 Schedule Update</option>
                <option value="day_before_reminder">⏰ Day-Before Reminder</option>
                <option value="inspection_failed">⚠️ Inspection Failed</option>
              </select>
            </label>
	
		        <label className="block">
		          <span className="text-sm font-semibold">To</span>
		          <select
		            value={subId}
		            onChange={(e) => {
		              const nextSubId = e.target.value
		              setSubId(nextSubId)
		              if (!body.trim() && templateKey !== 'custom') {
		                const nextBody = renderFromTemplate({ key: templateKey, subId: nextSubId })
		                if (nextBody) setBody(nextBody)
		              }
		            }}
		            className="mt-1 w-full px-3 py-3 border rounded-xl"
		          >
		            <option value="">Select subcontractor…</option>
	            {subcontractors.map((s) => (
	              <option key={s.id} value={s.id}>
	                {s.company_name}
	              </option>
	            ))}
	          </select>
	        </label>

        <div>
          <p className="text-sm font-semibold mb-2">Send via</p>
          <div className="flex gap-3 text-sm">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} />
              SMS
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
              Email
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={appChannel} onChange={(e) => setAppChannel(e.target.checked)} />
              App
            </label>
          </div>
        </div>

        <label className="block">
          <span className="text-sm font-semibold">Message</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="mt-1 w-full px-3 py-3 border rounded-xl"
            rows={8}
          />
        </label>
      </div>
    </Modal>
  )
}

function SubContactModal({ sub, onClose }) {
  const contact = sub?.primary_contact ?? {}
  const email = contact.email ?? ''
  const phone = contact.phone ?? ''
  const mailto = buildMailtoLink(email)
  const outlook = buildOutlookWebLink(email)
  const sms = buildSmsLink(phone)

  return (
    <Modal
      title="Contact Sub"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Close
          </SecondaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="font-semibold">{sub?.company_name ?? 'Subcontractor'}</p>
          {contact.name ? <p className="text-xs text-gray-600 mt-1">Contact: {contact.name}</p> : null}
          <p className="text-xs text-gray-600 mt-1">Phone: {phone || '—'}</p>
          <p className="text-xs text-gray-600 mt-1">Email: {email || '—'}</p>
        </Card>

        <div className="grid gap-2">
          <button
            type="button"
            onClick={() => openExternalLink(mailto, onClose)}
            disabled={!mailto}
            className={`h-12 px-4 rounded-xl border font-semibold ${mailto ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'}`}
          >
            Email
          </button>
          <button
            type="button"
            onClick={() => openExternalLink(outlook, onClose)}
            disabled={!outlook}
            className={`h-12 px-4 rounded-xl border font-semibold ${outlook ? 'bg-white text-gray-900 border-gray-200' : 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'}`}
          >
            Outlook Web
          </button>
          <button
            type="button"
            onClick={() => openExternalLink(sms, onClose)}
            disabled={!sms}
            className={`h-12 px-4 rounded-xl border font-semibold ${sms ? 'bg-white text-gray-900 border-gray-200' : 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'}`}
          >
            Text (SMS)
          </button>
        </div>
        <p className="text-xs text-gray-500">Tip: set Outlook as your default mail app to launch it from Email.</p>
      </div>
    </Modal>
  )
}

function SubEditModal({ sub, tradeOptions, onClose, onSave }) {
  const [draft, setDraft] = useState(() => ({
    company_name: sub?.company_name ?? '',
    contact_name: sub?.primary_contact?.name ?? '',
    contact_phone: sub?.primary_contact?.phone ?? sub?.office_phone ?? '',
    contact_email: sub?.primary_contact?.email ?? sub?.email ?? '',
    trade: sub?.trade ?? 'other',
    additional_contacts: Array.isArray(sub?.additional_contacts) ? sub.additional_contacts : [],
  }))

  return (
    <Modal
      title="Edit Sub Contact"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() =>
              onSave({
                ...sub,
                company_name: draft.company_name.trim() || sub?.company_name || '',
                trade: draft.trade || sub?.trade || 'other',
                primary_contact: {
                  ...(sub?.primary_contact ?? {}),
                  name: draft.contact_name.trim(),
                  phone: draft.contact_phone.trim(),
                  email: draft.contact_email.trim(),
                },
                additional_contacts: (draft.additional_contacts ?? [])
                  .map((c) => ({
                    ...c,
                    name: String(c.name ?? '').trim(),
                    phone: String(c.phone ?? '').trim(),
                    email: String(c.email ?? '').trim(),
                  }))
                  .filter((c) => c.name || c.phone || c.email),
              })
            }
            className="flex-1"
          >
            Save
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="text-xs text-gray-500">Company</span>
          <input
            value={draft.company_name}
            onChange={(e) => setDraft((prev) => ({ ...prev, company_name: e.target.value }))}
            className="mt-1 w-full px-3 py-2 border rounded-xl"
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Contact Name</span>
          <input
            value={draft.contact_name}
            onChange={(e) => setDraft((prev) => ({ ...prev, contact_name: e.target.value }))}
            className="mt-1 w-full px-3 py-2 border rounded-xl"
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Trade</span>
          <select
            value={draft.trade}
            onChange={(e) => setDraft((prev) => ({ ...prev, trade: e.target.value }))}
            className="mt-1 w-full px-3 py-2 border rounded-xl"
          >
            {(tradeOptions ?? TRADES).map((trade) => (
              <option key={trade.id} value={trade.id}>
                {trade.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Phone</span>
          <input
            value={draft.contact_phone}
            onChange={(e) => setDraft((prev) => ({ ...prev, contact_phone: formatPhoneInput(e.target.value) }))}
            className="mt-1 w-full px-3 py-2 border rounded-xl"
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Email</span>
          <input
            type="email"
            value={draft.contact_email}
            onChange={(e) => setDraft((prev) => ({ ...prev, contact_email: e.target.value }))}
            className="mt-1 w-full px-3 py-2 border rounded-xl"
          />
        </label>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">Additional Contacts</span>
            <button
              type="button"
              onClick={() =>
                setDraft((prev) => ({
                  ...prev,
                  additional_contacts: [
                    ...(prev.additional_contacts ?? []),
                    { id: uuid(), name: '', phone: '', email: '' },
                  ],
                }))
              }
              className="text-xs font-semibold text-blue-600"
            >
              + Add Contact
            </button>
          </div>
          {(draft.additional_contacts ?? []).length === 0 ? (
            <p className="text-xs text-gray-500">No additional contacts yet.</p>
          ) : null}
          <div className="space-y-2">
            {(draft.additional_contacts ?? []).map((contact) => (
              <div key={contact.id} className="border border-gray-200 rounded-xl p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Contact</span>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        additional_contacts: (prev.additional_contacts ?? []).filter((c) => c.id !== contact.id),
                      }))
                    }
                    className="text-xs text-red-600"
                  >
                    Remove
                  </button>
                </div>
                <input
                  value={contact.name ?? ''}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      additional_contacts: (prev.additional_contacts ?? []).map((c) => (c.id === contact.id ? { ...c, name: e.target.value } : c)),
                    }))
                  }
                  className="w-full px-3 py-2 border rounded-xl text-sm"
                  placeholder="Name"
                />
                <input
                  value={contact.phone ?? ''}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      additional_contacts: (prev.additional_contacts ?? []).map((c) =>
                        c.id === contact.id ? { ...c, phone: formatPhoneInput(e.target.value) } : c,
                      ),
                    }))
                  }
                  className="w-full px-3 py-2 border rounded-xl text-sm"
                  placeholder="Phone"
                />
                <input
                  type="email"
                  value={contact.email ?? ''}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      additional_contacts: (prev.additional_contacts ?? []).map((c) => (c.id === contact.id ? { ...c, email: e.target.value } : c)),
                    }))
                  }
                  className="w-full px-3 py-2 border rounded-xl text-sm"
                  placeholder="Email"
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}


const PUNCH_CATEGORY_DEFS = [
  { id: 'foundation', label: 'Foundation' },
  { id: 'interior', label: 'Interior Task' },
  { id: 'exterior', label: 'Exterior Task' },
  { id: 'final', label: 'Final' },
  { id: 'misc', label: 'Misc' },
]
// Punch photo uploads are intentionally disabled for now (kept for future enablement).
const ENABLE_PUNCH_PHOTOS = false

const normalizeTaskCategoryId = (task) => {
  const raw = task?.category ?? task?.category_id ?? task?.track ?? task?.phase ?? ''
  const value = String(raw ?? '').toLowerCase()
  if (value === 'foundation') return 'foundation'
  if (value === 'interior') return 'interior'
  if (value === 'exterior') return 'exterior'
  if (value === 'final') return 'final'
  if (value === 'misc') return 'misc'
  if (value.includes('foundation')) return 'foundation'
  if (value.includes('interior')) return 'interior'
  if (value.includes('exterior')) return 'exterior'
  if (value.includes('final')) return 'final'
  if (value.includes('misc')) return 'misc'
  return null
}

const normalizePunchCategoryId = (value) => {
  const v = String(value ?? '').toLowerCase()
  if (v.includes('foundation')) return 'foundation'
  if (v.includes('interior')) return 'interior'
  if (v.includes('exterior')) return 'exterior'
  if (v.includes('final')) return 'final'
  if (v.includes('misc')) return 'misc'
  return 'misc'
}

const punchCategoryLabelForItem = (item) => {
  const raw = item?.category ?? ''
  const id = normalizePunchCategoryId(raw)
  return PUNCH_CATEGORY_DEFS.find((c) => c.id === id)?.label ?? 'Misc'
}

const punchTaskTypeForItem = (item) => {
  const raw = item?.task_type || item?.subcategory || item?.trade || ''
  const value = String(raw ?? '').trim()
  return value || 'Custom'
}

const buildPunchTaskTypeOptionsByCategory = (tasks) => {
  const map = Object.fromEntries(PUNCH_CATEGORY_DEFS.map((c) => [c.id, new Set()]))
  const addAll = (categoryId, items) => {
    if (!map[categoryId] || !Array.isArray(items)) return
    items.forEach((item) => map[categoryId].add(item))
  }
  const exteriorItems = PUNCH_CATEGORIES.find((c) => c.id === 'exterior')?.items ?? []
  const interiorItems = [
    ...(PUNCH_CATEGORIES.find((c) => c.id === 'interior')?.items ?? []),
    ...(PUNCH_CATEGORIES.find((c) => c.id === 'mechanical')?.items ?? []),
    ...(PUNCH_CATEGORIES.find((c) => c.id === 'doors_windows')?.items ?? []),
  ]
  const finalItems = PUNCH_CATEGORIES.find((c) => c.id === 'final')?.items ?? []
  addAll('exterior', exteriorItems)
  addAll('interior', interiorItems)
  addAll('final', finalItems)

  ;(tasks ?? []).forEach((task) => {
    const categoryId = normalizeTaskCategoryId(task)
    if (!categoryId || !task?.name) return
    if (!map[categoryId]) map[categoryId] = new Set()
    map[categoryId].add(task.name)
  })

  const result = {}
  for (const category of PUNCH_CATEGORY_DEFS) {
    const options = Array.from(map[category.id] ?? []).filter(Boolean)
    options.sort((a, b) => a.localeCompare(b))
    const customIndex = options.findIndex((opt) => String(opt).toLowerCase() === 'custom')
    if (customIndex >= 0) options.splice(customIndex, 1)
    options.push('Custom')
    result[category.id] = options
  }
  return result
}

const punchTaskTypeToTrade = (taskType) => {
  const value = String(taskType ?? '').toLowerCase()
  if (!value || value === 'custom') return null
  if (value.includes('concrete') || value.includes('flatwork')) return 'concrete'
  if (value.includes('drywall')) return 'drywall'
  if (value.includes('elect')) return 'electrical'
  if (value.includes('floor')) return 'flooring'
  if (value.includes('hvac')) return 'hvac'
  if (value.includes('paint') || value.includes('stain')) return 'paint'
  if (value.includes('plumb')) return 'plumbing'
  if (value.includes('roof') || value.includes('gutter')) return 'roofing'
  if (value.includes('siding') || value.includes('soffit')) return 'siding'
  if (value.includes('landscape')) return 'landscaping'
  if (value.includes('garage')) return 'garage_door'
  if (value.includes('window') || value.includes('door')) return 'windows'
  if (value.includes('counter')) return 'countertops'
  if (value.includes('cabinet')) return 'cabinets'
  if (value.includes('trim')) return 'trim'
  if (value.includes('insulation')) return 'insulation'
  if (value.includes('appliance')) return 'appliances'
  if (value.includes('clean')) return 'cleaning'
  return 'other'
}

function PunchListModal({ lot, community, subcontractors, onClose, onUpdate, onAddPunchPhoto, onNotifyAssignment, onPreviewPhoto }) {
  const punch = lot.punch_list ?? null
  const [draftPunchId] = useState(() => uuid())
  const [draftCreatedAt] = useState(() => new Date().toISOString())
  const basePunch = punch ?? { id: draftPunchId, created_at: draftCreatedAt, items: [] }

  const items = basePunch?.items ?? []
  const done = items.filter((i) => i.status === 'closed' || i.status === 'verified').length
  const total = items.length

  const [expandedCategories, setExpandedCategories] = useState(() => new Set(PUNCH_CATEGORY_DEFS.map((c) => c.id)))
  const [showAdd, setShowAdd] = useState(false)
  const [addCategoryId, setAddCategoryId] = useState(PUNCH_CATEGORY_DEFS[0]?.id ?? 'foundation')
  const [showSend, setShowSend] = useState(false)
  const [draftModal, setDraftModal] = useState(null)
  const [editingItem, setEditingItem] = useState(null)

  const subsOnLot = (() => {
    const ids = new Set((lot.tasks ?? []).map((t) => t.sub_id).filter(Boolean))
    return subcontractors.filter((s) => ids.has(s.id))
  })()
  const availableSubs = subsOnLot.length > 0 ? subsOnLot : subcontractors

  const taskTypeOptionsByCategory = useMemo(() => buildPunchTaskTypeOptionsByCategory(lot.tasks), [lot.tasks])

  const toggleCategory = (categoryId) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  const updateItem = (itemId, patch) => {
    onUpdate({
      ...basePunch,
      items: items.map((x) => (x.id === itemId ? { ...x, ...patch, updated_at: new Date().toISOString() } : x)),
    })
  }

  const removeItem = (itemId) => {
    onUpdate({
      ...basePunch,
      items: items.filter((x) => x.id !== itemId),
    })
  }

  const openPunchPhoto = (photoOrId, photosForItem = null) => {
    if (!photoOrId && (!photosForItem || photosForItem.length === 0)) return
    const photo =
      typeof photoOrId === 'string'
        ? (lot.photos ?? []).find((p) => p.id === photoOrId)
        : photoOrId
    if (!photo?.blob_id) {
      alert('Photo not found yet. Please try again in a moment.')
      return
    }
    if (onPreviewPhoto) {
      if (Array.isArray(photosForItem) && photosForItem.length > 0) {
        const startIndex = Math.max(0, photosForItem.findIndex((p) => p.id === photo.id))
        onPreviewPhoto({ photos: photosForItem, startIndex, title: photo.caption || photo.location || 'Photos' })
      } else {
        onPreviewPhoto(photo)
      }
      return
    }
    openBlobInNewTab(photo.blob_id)
  }

  const getItemPhotoIds = (item) => {
    const ids = []
    if (Array.isArray(item.photo_ids)) ids.push(...item.photo_ids)
    if (item.photo_id) ids.push(item.photo_id)
    return Array.from(new Set(ids.filter(Boolean)))
  }

  const getItemPhotos = (item) => {
    const ids = getItemPhotoIds(item)
    return ids.map((id) => (lot.photos ?? []).find((p) => p.id === id)).filter(Boolean)
  }

  const handlePunchPhotoUpload = async (itemId, file, caption) => {
    if (!file || !itemId || !onAddPunchPhoto) return null
    const photoId = await onAddPunchPhoto({
      punchItemId: itemId,
      file,
      caption,
    })
    if (photoId) {
      const item = items.find((x) => x.id === itemId)
      const existing = item ? getItemPhotoIds(item) : []
      updateItem(itemId, { photo_id: photoId, photo_ids: Array.from(new Set([...existing, photoId])) })
    }
    return photoId
  }

  const handleCreateItem = async ({ categoryId, taskType, subId, description, photoFiles, keepOpen }) => {
    if (!description?.trim()) return
    const now = new Date().toISOString()
    const categoryLabel = PUNCH_CATEGORY_DEFS.find((c) => c.id === categoryId)?.label ?? 'Misc'
    const trade = punchTaskTypeToTrade(taskType) ?? 'other'
    const newItem = {
      id: uuid(),
      category: categoryLabel,
      task_type: taskType,
      subcategory: taskType,
      description: description.trim(),
      photo_id: null,
      photo_ids: [],
      trade,
      sub_id: subId || null,
      status: 'open',
      created_at: now,
      updated_at: now,
      completed_at: null,
      source: 'super',
    }
    const nextItems = [...items, newItem]
    onUpdate({ ...basePunch, items: nextItems })
    if (newItem.sub_id) onNotifyAssignment?.(newItem)

    if (ENABLE_PUNCH_PHOTOS && Array.isArray(photoFiles) && photoFiles.length > 0) {
      for (const file of photoFiles) {
        await handlePunchPhotoUpload(newItem.id, file, newItem.description || newItem.task_type || 'Punch item')
      }
    }

    if (!keepOpen) setShowAdd(false)
  }

  const handleEditItem = async ({ itemId, categoryId, taskType, subId, description, photoFiles, photoIds }) => {
    if (!description?.trim()) return
    const categoryLabel = PUNCH_CATEGORY_DEFS.find((c) => c.id === categoryId)?.label ?? 'Misc'
    const trade = punchTaskTypeToTrade(taskType) ?? 'other'
    updateItem(itemId, {
      category: categoryLabel,
      task_type: taskType,
      subcategory: taskType,
      description: description.trim(),
      trade,
      sub_id: subId || null,
      photo_ids: photoIds ?? getItemPhotoIds(items.find((x) => x.id === itemId) ?? {}),
    })
    if (ENABLE_PUNCH_PHOTOS && Array.isArray(photoFiles) && photoFiles.length > 0) {
      for (const file of photoFiles) {
        await handlePunchPhotoUpload(itemId, file, description.trim() || taskType || 'Punch item')
      }
    }
    setEditingItem(null)
  }

  const isComplete = (item) => item.status === 'closed' || item.status === 'verified'

  const toggleComplete = (item) => {
    const nextComplete = !isComplete(item)
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(10)
    updateItem(item.id, {
      status: nextComplete ? 'closed' : 'open',
      completed_at: nextComplete ? new Date().toISOString() : null,
    })
  }

  const buildDraft = (sub, groupItems) => {
    const communityName = community?.name ?? ''
    const lotLabel = lotCode(lot)
    const locationLabel = communityName ? `${communityName}, ${lotLabel}` : lotLabel
    const header = `Punch list - ${locationLabel}`
    const bullets = groupItems.map((item) => {
      const description = item.description ? item.description.trim() : ''
      const photoTag = ENABLE_PUNCH_PHOTOS && getItemPhotoIds(item).length > 0 ? ' (photo attached)' : ''
      return `- ${description || 'Punch item'}${photoTag}`
    })
    const body = `${header}\n\n${bullets.join('\n')}\n\nThanks!`
    return {
      subject: `Punch list - ${lotCode(lot)}`,
      body,
    }
  }

  const openDraftModal = (sub, groupItems, channel) => {
    setShowSend(false)
    setDraftModal({ sub, items: groupItems, channel })
  }

  const categoryItems = (categoryId) => {
    const label = PUNCH_CATEGORY_DEFS.find((c) => c.id === categoryId)?.label ?? 'Misc'
    const filtered = items.filter((i) => normalizePunchCategoryId(i.category) === categoryId || punchCategoryLabelForItem(i) === label)
    return filtered.slice().sort((a, b) => {
      const completeDiff = Number(isComplete(a)) - Number(isComplete(b))
      if (completeDiff !== 0) return completeDiff
      const aTime = new Date(a.created_at ?? 0).getTime()
      const bTime = new Date(b.created_at ?? 0).getTime()
      return aTime - bTime
    })
  }

  return (
    <>
      <Modal
        title="Punch List"
        onClose={onClose}
        footer={
          <div className="flex gap-2">
            <SecondaryButton onClick={onClose} className="flex-1">
              Close
            </SecondaryButton>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-gray-500">Lot</p>
              <p className="text-lg font-semibold">{lotCode(lot)}</p>
            </div>
            <button
              type="button"
              onClick={() => setShowSend(true)}
              className="h-11 px-4 rounded-xl bg-blue-600 text-white text-sm font-semibold flex items-center gap-2"
            >
              <MessageSquare className="w-4 h-4" />
              Send to Subs
            </button>
          </div>

          <Card className="bg-gray-50">
            <p className="text-sm font-semibold">
              Progress: {total ? `${done}/${total} (${Math.round((done / total) * 100)}%)` : '--'}
            </p>
            <div className="mt-2 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full bg-green-500" style={{ width: total ? `${(done / total) * 100}%` : '0%' }} />
            </div>
          </Card>

          <div className="space-y-2">
            {PUNCH_CATEGORY_DEFS.map((category) => {
              const expanded = expandedCategories.has(category.id)
              const list = categoryItems(category.id)
              const count = list.length
              const remaining = list.filter((item) => !isComplete(item)).length
              const allComplete = count > 0 && remaining === 0
              return (
                <div key={category.id} className="border border-gray-200 rounded-2xl overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between px-4 py-3 bg-white"
                    onClick={() => toggleCategory(category.id)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{category.label}</span>
                      <span className="text-xs text-gray-500">({count})</span>
                      {count === 0 ? null : allComplete ? (
                        <span className="text-[11px] font-semibold text-green-700 bg-green-100 border border-green-200 rounded-full px-2 py-0.5">
                          Completed
                        </span>
                      ) : (
                        <span className="text-[11px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
                          Incomplete Items ({remaining})
                        </span>
                      )}
                    </div>
                    <ChevronRight className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                  </button>

                  {expanded ? (
                    <div className="bg-gray-50 border-t border-gray-200 px-3 py-3 space-y-2">
                      {list.length === 0 ? (
                        <p className="text-sm text-gray-500 px-2">No punch items yet.</p>
                      ) : null}

                      {list.map((item) => {
                        const complete = isComplete(item)
                        const sub = subcontractors.find((s) => s.id === item.sub_id) ?? null
                        return (
                          <div
                            key={item.id}
                            className={`rounded-2xl border px-3 py-3 bg-white ${complete ? 'opacity-70' : ''}`}
                          >
                            <div className="flex items-start gap-3">
                              <button
                                type="button"
                                onClick={() => toggleComplete(item)}
                                className={`w-6 h-6 rounded-full border flex items-center justify-center mt-1 ${
                                  complete ? 'bg-green-600 border-green-600 text-white' : 'border-gray-300'
                                }`}
                                aria-label="Toggle complete"
                              >
                                {complete ? <Check className="w-4 h-4" /> : null}
                              </button>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="font-semibold text-sm truncate">{punchTaskTypeForItem(item)}</p>
                                  {ENABLE_PUNCH_PHOTOS && getItemPhotoIds(item).length > 0 ? (
                                    <button
                                      type="button"
                                      className="text-xs text-blue-600 font-semibold"
                                      onClick={() => {
                                        const photos = getItemPhotos(item)
                                        if (photos.length === 0) {
                                          alert('Photo not found yet. Please try again in a moment.')
                                          return
                                        }
                                        openPunchPhoto(photos[0], photos)
                                      }}
                                    >
                                      View photos ({getItemPhotoIds(item).length})
                                    </button>
                                  ) : null}
                                </div>
                                <p className="text-xs text-gray-600 truncate">{sub?.company_name ?? 'Unassigned'}</p>
                                <p className="text-sm text-gray-700 mt-1 truncate">{item.description}</p>
                                {ENABLE_PUNCH_PHOTOS && getItemPhotoIds(item).length > 0 ? (
                                  <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                                    {getItemPhotos(item).map((photo) => (
                                      <button
                                        key={photo.id}
                                        type="button"
                                        className="w-16 h-16 rounded-xl border overflow-hidden flex-shrink-0"
                                        onClick={() => openPunchPhoto(photo, getItemPhotos(item))}
                                      >
                                        <PhotoThumb blobId={photo.blob_id} alt={photo.caption ?? 'Punch photo'} />
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  className="text-xs text-blue-600 font-semibold"
                                  onClick={() => setEditingItem(item)}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="text-gray-400 hover:text-red-500"
                                  onClick={() => removeItem(item.id)}
                                  aria-label="Delete punch item"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </div>
                        )
                      })}

                      <button
                        type="button"
                        onClick={() => {
                          setAddCategoryId(category.id)
                          setShowAdd(true)
                        }}
                        className="w-full mt-1 h-11 rounded-xl border border-dashed border-gray-300 text-sm font-semibold text-gray-700"
                      >
                        + Add Punch Item
                      </button>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      </Modal>

      {showAdd ? (
        <AddPunchItemModal
          open={showAdd}
          categoryId={addCategoryId}
          categories={PUNCH_CATEGORY_DEFS}
          taskTypeOptionsByCategory={taskTypeOptionsByCategory}
          subcontractors={availableSubs}
          lotPhotos={lot.photos ?? []}
          onClose={() => setShowAdd(false)}
          onSave={handleCreateItem}
        />
      ) : null}

      {editingItem ? (
        <AddPunchItemModal
          mode="edit"
          open={Boolean(editingItem)}
          categoryId={normalizePunchCategoryId(editingItem.category)}
          categories={PUNCH_CATEGORY_DEFS}
          taskTypeOptionsByCategory={taskTypeOptionsByCategory}
          subcontractors={availableSubs}
          lotPhotos={lot.photos ?? []}
          initialItem={editingItem}
          onClose={() => setEditingItem(null)}
          onSave={handleEditItem}
        />
      ) : null}

      {showSend ? (
        <SendToSubsModal
          open={showSend}
          lot={lot}
          items={items}
          subcontractors={subcontractors}
          onClose={() => setShowSend(false)}
          onDraft={openDraftModal}
        />
      ) : null}

      {draftModal ? (
        <MessageDraftModal
          open={Boolean(draftModal)}
          lot={lot}
          draft={draftModal}
          onClose={() => setDraftModal(null)}
          buildDraft={buildDraft}
        />
      ) : null}
    </>
  )
}

function AddPunchItemModal({
  open,
  mode = 'create',
  categoryId,
  categories,
  taskTypeOptionsByCategory,
  subcontractors,
  lotPhotos,
  initialItem,
  onClose,
  onSave,
}) {
  const [selectedCategory, setSelectedCategory] = useState(categoryId)
  const [taskType, setTaskType] = useState('Custom')
  const [subId, setSubId] = useState('')
  const [description, setDescription] = useState('')
  const [photoFiles, setPhotoFiles] = useState([])
  const [photoPreviews, setPhotoPreviews] = useState([])
  const [existingPhotoIds, setExistingPhotoIds] = useState([])

  const taskTypeOptions = taskTypeOptionsByCategory[selectedCategory] ?? ['Custom']

  useEffect(() => {
    if (!open) return
    setSelectedCategory(categoryId)
    if (mode === 'edit' && initialItem) {
      const initialType = punchTaskTypeForItem(initialItem)
      const categoryFromItem = normalizePunchCategoryId(initialItem.category)
      setSelectedCategory(categoryFromItem || categoryId)
      setTaskType(initialType || 'Custom')
      setSubId(initialItem.sub_id ?? '')
      setDescription(initialItem.description ?? '')
      const ids = []
      if (Array.isArray(initialItem.photo_ids)) ids.push(...initialItem.photo_ids)
      if (initialItem.photo_id) ids.push(initialItem.photo_id)
      setExistingPhotoIds(Array.from(new Set(ids.filter(Boolean))))
      setPhotoFiles([])
      setPhotoPreviews([])
      return
    }
    const fallbackType = taskTypeOptionsByCategory[categoryId]?.[0] ?? 'Custom'
    setTaskType(fallbackType)
    setSubId('')
    setDescription('')
    setExistingPhotoIds([])
    setPhotoFiles([])
    setPhotoPreviews([])
  }, [open, categoryId, mode, initialItem, taskTypeOptionsByCategory])

  useEffect(() => {
    if (photoFiles.length === 0) {
      setPhotoPreviews([])
      return
    }
    const urls = photoFiles.map((file) => ({ file, url: URL.createObjectURL(file) }))
    setPhotoPreviews(urls)
    return () => {
      urls.forEach((entry) => URL.revokeObjectURL(entry.url))
    }
  }, [photoFiles])

  useEffect(() => {
    if (!taskTypeOptions.includes(taskType)) {
      setTaskType(taskTypeOptions[0] ?? 'Custom')
    }
  }, [taskTypeOptions, taskType])

  const availableSubs = (() => {
    const trade = punchTaskTypeToTrade(taskType)
    const normalized = String(taskType ?? '').toLowerCase()
    if (!trade || normalized === 'custom') return subcontractors
    const filtered = subcontractors.filter((s) => s.trade === trade || (s.secondary_trades ?? []).includes(trade))
    return filtered.length > 0 ? filtered : subcontractors
  })()

  const sortedSubs = availableSubs.slice().sort((a, b) => a.company_name.localeCompare(b.company_name))
  useEffect(() => {
    if (!subId) return
    if (!sortedSubs.some((s) => s.id === subId)) {
      setSubId('')
    }
  }, [subId, sortedSubs])

  const handleFile = (event) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length === 0) return
    setPhotoFiles((prev) => [...prev, ...files])
    event.target.value = ''
  }

  const removeNewPhoto = (index) => {
    setPhotoFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const removeExistingPhoto = (photoId) => {
    setExistingPhotoIds((prev) => prev.filter((id) => id !== photoId))
  }

  const existingPhotos = (lotPhotos ?? []).filter((p) => existingPhotoIds.includes(p.id))

  const handleSave = async ({ keepOpen }) => {
    if (!description.trim()) {
      alert('Please add a description before saving.')
      return
    }
    await onSave({
      itemId: initialItem?.id,
      categoryId: selectedCategory,
      taskType,
      subId,
      description,
      photoFiles,
      photoIds: existingPhotoIds,
      keepOpen,
    })
    if (keepOpen) {
      setTaskType(taskTypeOptions[0] ?? 'Custom')
      setDescription('')
      setSubId('')
      setExistingPhotoIds([])
      setPhotoFiles([])
    }
  }

  return (
    <Modal
      title={mode === 'edit' ? 'Edit Punch Item' : 'Add Punch Item'}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton onClick={() => handleSave({ keepOpen: false })} className="flex-1">
            {mode === 'edit' ? 'Save Changes' : 'Save Punch Item'}
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-2">
          <label className="text-xs text-gray-500">Category</label>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="px-3 py-3 border rounded-xl text-sm"
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <label className="text-xs text-gray-500">Task Type</label>
          <select value={taskType} onChange={(e) => setTaskType(e.target.value)} className="px-3 py-3 border rounded-xl text-sm">
            {taskTypeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <label className="text-xs text-gray-500">Subcontractor</label>
          <select value={subId} onChange={(e) => setSubId(e.target.value)} className="px-3 py-3 border rounded-xl text-sm">
            <option value="">Select sub...</option>
            {sortedSubs.map((sub) => (
              <option key={sub.id} value={sub.id}>
                {sub.company_name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <label className="text-xs text-gray-500">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="px-3 py-3 border rounded-xl text-sm min-h-[100px]"
            placeholder="Describe the issue to fix..."
          />
        </div>

        {ENABLE_PUNCH_PHOTOS ? (
          <div className="grid gap-2">
            <label className="text-xs text-gray-500">Photo</label>
            <div className="flex items-center gap-2">
              <label className="flex-1 h-11 border rounded-xl px-3 flex items-center justify-center gap-2 text-sm cursor-pointer">
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFile} />
                <Camera className="w-4 h-4" />
                Take photo
              </label>
              <label className="flex-1 h-11 border rounded-xl px-3 flex items-center justify-center gap-2 text-sm cursor-pointer">
                <input type="file" accept="image/*" multiple className="hidden" onChange={handleFile} />
                <Upload className="w-4 h-4" />
                Upload photo
              </label>
            </div>
            {existingPhotos.length > 0 ? (
              <div className="grid grid-cols-3 gap-2">
                {existingPhotos.map((photo) => (
                  <button
                    key={photo.id}
                    type="button"
                    className="relative border rounded-xl overflow-hidden"
                    onClick={() => openBlobInNewTab(photo.blob_id)}
                  >
                    <PhotoThumb blobId={photo.blob_id} alt={photo.caption ?? 'Punch photo'} />
                    <span
                      role="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        removeExistingPhoto(photo.id)
                      }}
                      className="absolute top-1 right-1 bg-white/90 text-gray-700 rounded-full w-5 h-5 text-xs flex items-center justify-center"
                    >
                      ×
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            {photoPreviews.length > 0 ? (
              <div className="grid grid-cols-3 gap-2">
                {photoPreviews.map((preview, index) => (
                  <div key={preview.url} className="relative border rounded-xl overflow-hidden">
                    <img src={preview.url} alt="Preview" className="w-full h-24 object-cover" />
                    <button
                      type="button"
                      onClick={() => removeNewPhoto(index)}
                      className="absolute top-1 right-1 bg-white/90 text-gray-700 rounded-full w-5 h-5 text-xs flex items-center justify-center"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {mode !== 'edit' ? (
          <button
            type="button"
            onClick={() => handleSave({ keepOpen: true })}
            className="w-full text-sm font-semibold text-blue-600"
          >
            Save & Add Another
          </button>
        ) : null}
      </div>
    </Modal>
  )
}

function SendToSubsModal({ open, lot, items, subcontractors, onClose, onDraft }) {
  if (!open) return null
  const groups = Array.from(
    (items ?? []).reduce((map, item) => {
      if (!item.sub_id) return map
      if (item.status === 'closed' || item.status === 'verified') return map
      if (!map.has(item.sub_id)) map.set(item.sub_id, [])
      map.get(item.sub_id).push(item)
      return map
    }, new Map()),
  ).map(([subId, subItems]) => ({
    id: subId,
    sub: subcontractors.find((s) => s.id === subId) ?? null,
    items: subItems,
  }))

  return (
    <Modal
      title="Send to Subs"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Close
          </SecondaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-gray-500">{lotCode(lot)} - {groups.length} sub(s)</p>
        {groups.length === 0 ? (
          <Card className="bg-gray-50">
            <p className="text-sm text-gray-600">No open punch items to send.</p>
          </Card>
        ) : null}
        {groups.map((group) => {
          const phone = getSubPhone(group.sub)
          const email = getSubEmail(group.sub)
          const contactName = group.sub?.primary_contact?.name ?? ''
          return (
            <Card key={group.id} className="space-y-2">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-semibold">{group.sub?.company_name ?? 'Subcontractor'}</p>
                  <p className="text-xs text-gray-500">{phone || 'No phone on file'}</p>
                  {contactName ? <p className="text-xs text-gray-500">Contact: {contactName}</p> : null}
                  <p className="text-xs text-gray-500">Email: {email || 'No email on file'}</p>
                </div>
                <span className="text-xs text-gray-500">{group.items.length} item(s)</span>
              </div>
              <ul className="text-sm text-gray-700 list-disc pl-5">
                {group.items.map((item) => (
                  <li key={item.id}>
                    {punchTaskTypeForItem(item)} - {item.description}
                    {(Array.isArray(item.photo_ids) && item.photo_ids.length > 0) || item.photo_id ? (
                      <span className="text-xs text-gray-400"> (photo attached)</span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onDraft(group.sub, group.items, 'sms')}
                  disabled={!phone}
                  className={`flex-1 h-10 rounded-xl border font-semibold ${phone ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'}`}
                >
                  Text
                </button>
                <button
                  type="button"
                  onClick={() => onDraft(group.sub, group.items, 'email')}
                  disabled={!email}
                  className={`flex-1 h-10 rounded-xl border font-semibold ${email ? 'bg-white text-gray-900 border-gray-200' : 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'}`}
                >
                  Email
                </button>
              </div>
            </Card>
          )
        })}
      </div>
    </Modal>
  )
}

function MessageDraftModal({ open, lot, draft, onClose, buildDraft }) {
  // Hooks must not be conditional; keep null render after hooks.
  const base = useMemo(() => {
    if (!open || !draft) return { subject: '', body: '' }
    const built = buildDraft?.(draft.sub, draft.items)
    return built && typeof built === 'object' ? built : { subject: '', body: '' }
  }, [open, draft, buildDraft])

  const [message, setMessage] = useState(base.body ?? '')

  useEffect(() => {
    setMessage(base.body ?? '')
  }, [base.body])

  if (!open || !draft) return null

  const { sub, items, channel } = draft
  const subject = base.subject ?? ''
  const contactName = sub?.primary_contact?.name ?? ''

  const photos = items
    .flatMap((item) => {
      const ids = []
      if (Array.isArray(item.photo_ids)) ids.push(...item.photo_ids)
      if (item.photo_id) ids.push(item.photo_id)
      return ids
    })
    .filter(Boolean)
    .filter((id, index, all) => all.indexOf(id) === index)
    .map((id) => (lot.photos ?? []).find((p) => p.id === id))
    .filter(Boolean)

  const handleSend = () => {
    if (channel === 'sms') {
      const baseLink = buildSmsLink(getSubPhone(sub))
      if (!baseLink) {
        alert('No phone number on file for this sub.')
        return
      }
      const href = `${baseLink}${baseLink.includes('?') ? '&' : '?'}body=${encodeURIComponent(message)}`
      openExternalLink(href)
      return
    }
    const baseLink = buildMailtoLink(getSubEmail(sub))
    if (!baseLink) {
      alert('No email address on file for this sub.')
      return
    }
    const href = `${baseLink}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`
    openExternalLink(href)
  }

  return (
    <Modal
      title="Message Draft"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Close
          </SecondaryButton>
          <PrimaryButton onClick={handleSend} className="flex-1">
            {channel === 'sms' ? 'Preview in iMessage' : 'Preview in Email'}
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm font-semibold">{sub?.company_name ?? 'Subcontractor'}</p>
          <p className="text-xs text-gray-500">{channel === 'sms' ? getSubPhone(sub) || 'No phone on file' : getSubEmail(sub) || 'No email on file'}</p>
          {contactName ? <p className="text-xs text-gray-500">Contact: {contactName}</p> : null}
          <p className="text-xs text-gray-500">Email: {getSubEmail(sub) || 'No email on file'}</p>
        </Card>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full min-h-[180px] px-3 py-3 border rounded-xl text-sm"
        />
        {photos.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {photos.map((photo) => (
              <button
                key={photo.id}
                type="button"
                className="border rounded-xl overflow-hidden"
                onClick={() => openBlobInNewTab(photo.blob_id)}
              >
                <PhotoThumb blobId={photo.blob_id} alt={photo.caption ?? 'Punch photo'} />
              </button>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-gray-500">Attachments open in your native app. Add photos there before sending.</p>
      </div>
    </Modal>
  )
}

function DailyLogModal({ lot, community, todayIso, subcontractors, isOnline, onClose, onSave, onAddDailyPhoto }) {
  const existing = (lot.daily_logs ?? []).find((l) => l.log_date === todayIso) ?? null

  const suggestedSubsOnSite = useMemo(() => {
    const subsForToday = new Map()
    const date = parseISODate(todayIso)
    if (!date) return []
    for (const task of lot.tasks ?? []) {
      if (!task.scheduled_start || !task.scheduled_end) continue
      const s = parseISODate(task.scheduled_start)
      const e = parseISODate(task.scheduled_end)
      if (!s || !e) continue
      if (date < s || date > e) continue
      if (!task.sub_id) continue
      subsForToday.set(task.sub_id, true)
    }

    return Array.from(subsForToday.keys()).map((subId) => {
      const sub = subcontractors.find((s) => s.id === subId)
      return {
        sub_id: subId,
        sub_name: sub?.company_name ?? 'Sub',
        crew_count: 0,
        time_in: '',
        time_out: '',
        work_performed: '',
        check_in_confirmed: false,
        no_show: false,
      }
    })
  }, [lot.tasks, subcontractors, todayIso])

  const suggestedTasksWorked = useMemo(() => {
    const date = parseISODate(todayIso)
    if (!date) return []
    const items = []
    for (const task of lot.tasks ?? []) {
      if (!task.scheduled_start || !task.scheduled_end) continue
      const s = parseISODate(task.scheduled_start)
      const e = parseISODate(task.scheduled_end)
      if (!s || !e) continue
      if (date < s || date > e) continue
      const before = task.status === 'complete' ? 100 : task.status === 'in_progress' ? 50 : 0
      items.push({
        task_id: task.id,
        task_name: task.name,
        percent_before: before,
        percent_after: before,
        notes: '',
      })
    }
    return items
  }, [lot.tasks, todayIso])

  const defaults = useMemo(
    () => ({
      id: uuid(),
      lot_id: lot.id,
      log_date: todayIso,
      superintendent_id: '',
      time_arrived: '7:00 AM',
      time_departed: '4:30 PM',
      weather: {
        conditions: [],
        temp_high: '',
        temp_low: '',
        precipitation: false,
        precipitation_amount: '',
        weather_impact: '',
      },
      subs_on_site: suggestedSubsOnSite,
      visitors: [],
      work_summary: '',
      tasks: suggestedTasksWorked,
      deliveries: [],
      issues: [],
      safety_observations: '',
      safety_incidents: [],
      photo_ids: [],
      notes: '',
      signature: '',
      signature_name: '',
      signed_at: null,
    }),
    [lot.id, todayIso, suggestedSubsOnSite, suggestedTasksWorked],
  )

  const [log, setLog] = useState(() => {
    if (!existing) return defaults
    return {
      ...defaults,
      ...existing,
      weather: { ...defaults.weather, ...(existing.weather ?? {}) },
      subs_on_site: (existing.subs_on_site ?? defaults.subs_on_site).map((s) => ({ ...s, no_show: Boolean(s.no_show) })),
      visitors: existing.visitors ?? [],
      tasks: existing.tasks ?? defaults.tasks,
      deliveries: existing.deliveries ?? [],
      issues: existing.issues ?? [],
      safety_observations: existing.safety_observations ?? '',
      safety_incidents: existing.safety_incidents ?? [],
      photo_ids: existing.photo_ids ?? [],
      signature_name: existing.signature_name ?? '',
    }
  })

  const signatureCanvasRef = useRef(null)
  const signatureDrawingRef = useRef({ drawing: false, lastX: 0, lastY: 0 })

  useEffect(() => {
    const canvas = signatureCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#111827'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    if (log.signature) {
      const img = new window.Image()
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      }
      img.src = log.signature
    }
  }, [log.signature])

  const clearSignature = () => {
    const canvas = signatureCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    setLog((p) => ({ ...p, signature: '' }))
  }

  const saveSignatureFromCanvas = () => {
    const canvas = signatureCanvasRef.current
    if (!canvas) return
    const url = canvas.toDataURL('image/png')
    setLog((p) => ({ ...p, signature: url }))
  }

  const renderTypedSignature = () => {
    const canvas = signatureCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#111827'
    ctx.font = '24px Inter, system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText(log.signature_name || 'Superintendent', 16, canvas.height / 2)
    saveSignatureFromCanvas()
  }

  const getCanvasPoint = (e) => {
    const canvas = signatureCanvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * (canvas.width / rect.width))),
      y: Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * (canvas.height / rect.height))),
    }
  }

  const onSignatureDown = (e) => {
    const canvas = signatureCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const pt = getCanvasPoint(e)
    if (!pt) return
    signatureDrawingRef.current = { drawing: true, lastX: pt.x, lastY: pt.y }
    ctx.beginPath()
    ctx.moveTo(pt.x, pt.y)
    e.preventDefault()
  }

  const onSignatureMove = (e) => {
    const canvas = signatureCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const state = signatureDrawingRef.current
    if (!state.drawing) return
    const pt = getCanvasPoint(e)
    if (!pt) return
    ctx.lineTo(pt.x, pt.y)
    ctx.stroke()
    state.lastX = pt.x
    state.lastY = pt.y
    e.preventDefault()
  }

  const onSignatureUp = (e) => {
    const state = signatureDrawingRef.current
    if (!state.drawing) return
    signatureDrawingRef.current.drawing = false
    saveSignatureFromCanvas()
    e.preventDefault()
  }

  const toggleWeather = (id) => {
    setLog((prev) => {
      const set = new Set(prev.weather.conditions ?? [])
      if (set.has(id)) set.delete(id)
      else set.add(id)
      return { ...prev, weather: { ...prev.weather, conditions: Array.from(set) } }
    })
  }

  const save = () => {
    onSave({
      ...log,
      signed_at: log.signature ? new Date().toISOString() : log.signed_at,
    })
    onClose()
  }

  const [addingSubId, setAddingSubId] = useState('')
  const availableSubs = subcontractors.slice().sort((a, b) => String(a.company_name).localeCompare(String(b.company_name)))
  const existingSubIds = new Set((log.subs_on_site ?? []).map((s) => s.sub_id))

  return (
    <Modal
      title="Daily Log"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton onClick={save} className="flex-1">
            Save Daily Log
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-4">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">
            {community?.name ?? 'Community'} • {lotCode(lot)}
          </p>
          <p className="text-sm font-semibold">{formatLongDate(log.log_date)}</p>
          {!isOnline ? <p className="text-xs text-orange-700 mt-1">Offline — daily log saves locally.</p> : null}
        </Card>

        <div>
          <p className="text-sm font-semibold mb-2">⏱️ Time On Site</p>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={log.time_arrived}
              onChange={(e) => setLog((p) => ({ ...p, time_arrived: e.target.value }))}
              className="px-3 py-3 border rounded-xl"
              placeholder="7:00 AM"
            />
            <input
              value={log.time_departed}
              onChange={(e) => setLog((p) => ({ ...p, time_departed: e.target.value }))}
              className="px-3 py-3 border rounded-xl"
              placeholder="4:30 PM"
            />
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-semibold">🌤️ Weather</p>
          <div className="flex gap-2">
            {[
              { id: 'sunny', label: '☀️' },
              { id: 'partly', label: '⛅' },
              { id: 'cloudy', label: '☁️' },
              { id: 'rain', label: '🌧️' },
              { id: 'snow', label: '❄️' },
              { id: 'windy', label: '💨' },
            ].map((w) => (
              <button
                key={w.id}
                onClick={() => toggleWeather(w.id)}
                className={`w-12 h-12 rounded-xl border text-lg ${log.weather.conditions.includes(w.id) ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'}`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={log.weather.temp_high}
              onChange={(e) => setLog((p) => ({ ...p, weather: { ...p.weather, temp_high: e.target.value } }))}
              className="px-3 py-3 border rounded-xl"
              placeholder="High (°F)"
            />
            <input
              value={log.weather.temp_low}
              onChange={(e) => setLog((p) => ({ ...p, weather: { ...p.weather, temp_low: e.target.value } }))}
              className="px-3 py-3 border rounded-xl"
              placeholder="Low (°F)"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(log.weather.precipitation)}
              onChange={(e) => setLog((p) => ({ ...p, weather: { ...p.weather, precipitation: e.target.checked } }))}
            />
            Precipitation
          </label>
          {log.weather.precipitation ? (
            <input
              value={log.weather.precipitation_amount}
              onChange={(e) => setLog((p) => ({ ...p, weather: { ...p.weather, precipitation_amount: e.target.value } }))}
              className="px-3 py-3 border rounded-xl"
              placeholder="Precipitation amount (e.g., 0.5 in)"
            />
          ) : null}
          <input
            value={log.weather.weather_impact}
            onChange={(e) => setLog((p) => ({ ...p, weather: { ...p.weather, weather_impact: e.target.value } }))}
            className="px-3 py-3 border rounded-xl"
            placeholder="Weather impact (optional)"
          />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-semibold">👷 Subs On Site</p>
          {log.subs_on_site.length === 0 ? (
            <p className="text-sm text-gray-600">No scheduled subs today.</p>
          ) : (
            <div className="space-y-2">
              {log.subs_on_site.map((s) => (
                <div key={s.sub_id} className={`border rounded-xl p-3 ${s.no_show ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
                  <div className="flex items-center justify-between">
                    <p className="font-semibold">{s.sub_name}</p>
                    <div className="flex items-center gap-3 text-sm">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={Boolean(s.check_in_confirmed)}
                          onChange={(e) =>
                            setLog((p) => ({
                              ...p,
                              subs_on_site: p.subs_on_site.map((x) =>
                                x.sub_id !== s.sub_id ? x : { ...x, check_in_confirmed: e.target.checked, no_show: e.target.checked ? false : x.no_show },
                              ),
                            }))
                          }
                        />
                        On site
                      </label>
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={Boolean(s.no_show)}
                          onChange={(e) =>
                            setLog((p) => ({
                              ...p,
                              subs_on_site: p.subs_on_site.map((x) =>
                                x.sub_id !== s.sub_id ? x : { ...x, no_show: e.target.checked, check_in_confirmed: e.target.checked ? false : x.check_in_confirmed },
                              ),
                            }))
                          }
                        />
                        No show
                      </label>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 mt-2">
                    <input
                      value={s.crew_count}
                      onChange={(e) =>
                        setLog((p) => ({
                          ...p,
                          subs_on_site: p.subs_on_site.map((x) =>
                            x.sub_id !== s.sub_id ? x : { ...x, crew_count: Number(e.target.value) || 0 },
                          ),
                        }))
                      }
                      className="px-3 py-2 border rounded-xl text-sm"
                      placeholder="Crew"
                      type="number"
                    />
                    <input
                      value={s.time_in}
                      onChange={(e) =>
                        setLog((p) => ({
                          ...p,
                          subs_on_site: p.subs_on_site.map((x) => (x.sub_id !== s.sub_id ? x : { ...x, time_in: e.target.value })),
                        }))
                      }
                      className="px-3 py-2 border rounded-xl text-sm"
                      placeholder="In"
                    />
                    <input
                      value={s.time_out}
                      onChange={(e) =>
                        setLog((p) => ({
                          ...p,
                          subs_on_site: p.subs_on_site.map((x) => (x.sub_id !== s.sub_id ? x : { ...x, time_out: e.target.value })),
                        }))
                      }
                      className="px-3 py-2 border rounded-xl text-sm"
                      placeholder="Out"
                    />
                  </div>
                  <textarea
                    value={s.work_performed}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        subs_on_site: p.subs_on_site.map((x) => (x.sub_id !== s.sub_id ? x : { ...x, work_performed: e.target.value })),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm mt-2"
                    rows={2}
                    placeholder={s.no_show ? 'No-show details (optional)' : 'Work performed'}
                  />
                </div>
              ))}
            </div>
          )}

          <Card className="bg-white">
            <p className="text-sm font-semibold mb-2">+ Add Sub Not on Schedule</p>
            <div className="flex gap-2">
              <select
                value={addingSubId}
                onChange={(e) => setAddingSubId(e.target.value)}
                className="flex-1 px-3 py-3 border rounded-xl text-sm"
              >
                <option value="">Select subcontractor…</option>
                {availableSubs.map((s) => (
                  <option key={s.id} value={s.id} disabled={existingSubIds.has(s.id)}>
                    {s.company_name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  if (!addingSubId) return
                  const sub = subcontractors.find((s) => s.id === addingSubId)
                  if (!sub) return
                  setLog((p) => ({
                    ...p,
                    subs_on_site: [
                      ...(p.subs_on_site ?? []),
                      {
                        sub_id: sub.id,
                        sub_name: sub.company_name,
                        crew_count: 0,
                        time_in: '',
                        time_out: '',
                        work_performed: '',
                        check_in_confirmed: false,
                        no_show: false,
                      },
                    ],
                  }))
                  setAddingSubId('')
                }}
                className="px-3 py-3 rounded-xl bg-blue-600 text-white font-semibold"
                disabled={!addingSubId}
              >
                Add
              </button>
            </div>
          </Card>
        </div>

        <Card>
          <div className="flex items-center justify-between mb-2">
            <p className="font-semibold">Visitors</p>
            <button
              onClick={() =>
                setLog((p) => ({
                  ...p,
                  visitors: [
                    ...(p.visitors ?? []),
                    { id: uuid(), name: '', company: '', purpose: '', time_in: '', time_out: '' },
                  ],
                }))
              }
              className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
            >
              + Add
            </button>
          </div>
          {(log.visitors ?? []).length === 0 ? (
            <p className="text-sm text-gray-600">No visitors logged.</p>
          ) : (
            <div className="space-y-2">
              {(log.visitors ?? []).map((v) => (
                <div key={v.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={v.name}
                      onChange={(e) =>
                        setLog((p) => ({
                          ...p,
                          visitors: (p.visitors ?? []).map((x) => (x.id === v.id ? { ...x, name: e.target.value } : x)),
                        }))
                      }
                      className="w-full px-3 py-2 border rounded-xl text-sm"
                      placeholder="Name"
                    />
                    <input
                      value={v.company}
                      onChange={(e) =>
                        setLog((p) => ({
                          ...p,
                          visitors: (p.visitors ?? []).map((x) => (x.id === v.id ? { ...x, company: e.target.value } : x)),
                        }))
                      }
                      className="w-full px-3 py-2 border rounded-xl text-sm"
                      placeholder="Company"
                    />
                  </div>
                  <input
                    value={v.purpose}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        visitors: (p.visitors ?? []).map((x) => (x.id === v.id ? { ...x, purpose: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                    placeholder="Purpose"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={v.time_in}
                      onChange={(e) =>
                        setLog((p) => ({
                          ...p,
                          visitors: (p.visitors ?? []).map((x) => (x.id === v.id ? { ...x, time_in: e.target.value } : x)),
                        }))
                      }
                      className="w-full px-3 py-2 border rounded-xl text-sm"
                      placeholder="Time in"
                    />
                    <input
                      value={v.time_out}
                      onChange={(e) =>
                        setLog((p) => ({
                          ...p,
                          visitors: (p.visitors ?? []).map((x) => (x.id === v.id ? { ...x, time_out: e.target.value } : x)),
                        }))
                      }
                      className="w-full px-3 py-2 border rounded-xl text-sm"
                      placeholder="Time out"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div>
          <p className="text-sm font-semibold mb-2">📝 Work Summary</p>
          <textarea
            value={log.work_summary}
            onChange={(e) => setLog((p) => ({ ...p, work_summary: e.target.value }))}
            className="w-full px-3 py-3 border rounded-xl"
            rows={4}
            placeholder="What happened today?"
          />
        </div>

        <Card>
          <div className="flex items-center justify-between mb-2">
            <p className="font-semibold">Tasks Worked</p>
          </div>
          {(log.tasks ?? []).length === 0 ? (
            <p className="text-sm text-gray-600">No tasks selected for today.</p>
          ) : (
            <div className="space-y-2">
              {(log.tasks ?? []).map((t) => (
                <div key={t.task_id} className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                  <p className="font-semibold text-gray-900">{t.task_name}</p>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={t.percent_before}
                      onChange={(e) =>
                        setLog((p) => ({
                          ...p,
                          tasks: (p.tasks ?? []).map((x) => (x.task_id === t.task_id ? { ...x, percent_before: Number(e.target.value) || 0 } : x)),
                        }))
                      }
                      className="px-3 py-2 border rounded-xl text-sm"
                      placeholder="Before %"
                    />
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={t.percent_after}
                      onChange={(e) =>
                        setLog((p) => ({
                          ...p,
                          tasks: (p.tasks ?? []).map((x) => (x.task_id === t.task_id ? { ...x, percent_after: Number(e.target.value) || 0 } : x)),
                        }))
                      }
                      className="px-3 py-2 border rounded-xl text-sm"
                      placeholder="After %"
                    />
                  </div>
                  <textarea
                    value={t.notes}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        tasks: (p.tasks ?? []).map((x) => (x.task_id === t.task_id ? { ...x, notes: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm mt-2"
                    rows={2}
                    placeholder="Notes"
                  />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-2">
            <p className="font-semibold">Deliveries</p>
            <button
              onClick={() =>
                setLog((p) => ({
                  ...p,
                  deliveries: [
                    ...(p.deliveries ?? []),
                    { id: uuid(), vendor: '', items: '', received_by: '', condition: 'good', notes: '', photo_id: null },
                  ],
                }))
              }
              className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
            >
              + Add
            </button>
          </div>
          {(log.deliveries ?? []).length === 0 ? (
            <p className="text-sm text-gray-600">No deliveries logged.</p>
          ) : (
            <div className="space-y-2">
              {(log.deliveries ?? []).map((d) => (
                <div key={d.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2">
                  <input
                    value={d.vendor}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        deliveries: (p.deliveries ?? []).map((x) => (x.id === d.id ? { ...x, vendor: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                    placeholder="Vendor"
                  />
                  <input
                    value={d.items}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        deliveries: (p.deliveries ?? []).map((x) => (x.id === d.id ? { ...x, items: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                    placeholder="Items"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={d.received_by}
                      onChange={(e) =>
                        setLog((p) => ({
                          ...p,
                          deliveries: (p.deliveries ?? []).map((x) => (x.id === d.id ? { ...x, received_by: e.target.value } : x)),
                        }))
                      }
                      className="w-full px-3 py-2 border rounded-xl text-sm"
                      placeholder="Received by"
                    />
                    <select
                      value={d.condition}
                      onChange={(e) =>
                        setLog((p) => ({
                          ...p,
                          deliveries: (p.deliveries ?? []).map((x) => (x.id === d.id ? { ...x, condition: e.target.value } : x)),
                        }))
                      }
                      className="w-full px-3 py-2 border rounded-xl text-sm"
                    >
                      <option value="good">Good</option>
                      <option value="damaged">Damaged</option>
                      <option value="partial">Partial</option>
                      <option value="wrong">Wrong</option>
                    </select>
                  </div>
                  <textarea
                    value={d.notes}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        deliveries: (p.deliveries ?? []).map((x) => (x.id === d.id ? { ...x, notes: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                    rows={2}
                    placeholder="Notes"
                  />

                  <label className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer inline-flex items-center justify-center">
                    {d.photo_id ? 'Replace Photo' : 'Add Photo'}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        const photoId = await onAddDailyPhoto({
                          dailyLogId: log.id,
                          file,
                          caption: `Delivery: ${d.vendor || 'Vendor'}`,
                          category: 'delivery',
                        })
                        if (!photoId) {
                          e.target.value = ''
                          return
                        }
                        setLog((p) => ({
                          ...p,
                          deliveries: (p.deliveries ?? []).map((x) => (x.id === d.id ? { ...x, photo_id: photoId } : x)),
                          photo_ids: [...(p.photo_ids ?? []), photoId],
                        }))
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-2">
            <p className="font-semibold">Issues</p>
            <button
              onClick={() =>
                setLog((p) => ({
                  ...p,
                  issues: [
                    ...(p.issues ?? []),
                    { id: uuid(), description: '', severity: 'low', action_taken: '', resolved: false, notify_manager: false, photo_id: null },
                  ],
                }))
              }
              className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
            >
              + Add Issue
            </button>
          </div>
          {(log.issues ?? []).length === 0 ? (
            <p className="text-sm text-gray-600">No issues logged.</p>
          ) : (
            <div className="space-y-2">
              {(log.issues ?? []).map((issue) => (
                <div key={issue.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2">
                  <textarea
                    value={issue.description}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        issues: (p.issues ?? []).map((x) => (x.id === issue.id ? { ...x, description: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                    rows={2}
                    placeholder="Description"
                  />
                  <select
                    value={issue.severity}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        issues: (p.issues ?? []).map((x) => (x.id === issue.id ? { ...x, severity: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                  <textarea
                    value={issue.action_taken}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        issues: (p.issues ?? []).map((x) => (x.id === issue.id ? { ...x, action_taken: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                    rows={2}
                    placeholder="Action taken"
                  />
                  <div className="flex items-center gap-4 text-sm">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={Boolean(issue.resolved)}
                        onChange={(e) =>
                          setLog((p) => ({
                            ...p,
                            issues: (p.issues ?? []).map((x) => (x.id === issue.id ? { ...x, resolved: e.target.checked } : x)),
                          }))
                        }
                      />
                      Resolved
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={Boolean(issue.notify_manager)}
                        onChange={(e) =>
                          setLog((p) => ({
                            ...p,
                            issues: (p.issues ?? []).map((x) => (x.id === issue.id ? { ...x, notify_manager: e.target.checked } : x)),
                          }))
                        }
                      />
                      Notify manager
                    </label>
                  </div>

                  <label className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer inline-flex items-center justify-center">
                    {issue.photo_id ? 'Replace Photo' : 'Add Photo'}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        const photoId = await onAddDailyPhoto({
                          dailyLogId: log.id,
                          file,
                          caption: `Issue: ${issue.description?.slice?.(0, 32) ?? 'Issue'}`,
                          category: 'issue',
                        })
                        if (!photoId) {
                          e.target.value = ''
                          return
                        }
                        setLog((p) => ({
                          ...p,
                          issues: (p.issues ?? []).map((x) => (x.id === issue.id ? { ...x, photo_id: photoId } : x)),
                          photo_ids: [...(p.photo_ids ?? []), photoId],
                        }))
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div>
          <p className="text-sm font-semibold mb-2">📷 Photos</p>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">{(log.photo_ids ?? []).length} attached</p>
            <label className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer">
              + Add
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const photoId = await onAddDailyPhoto({ dailyLogId: log.id, file, caption: 'Daily log', category: 'daily' })
                  if (!photoId) {
                    e.target.value = ''
                    return
                  }
                  setLog((p) => ({ ...p, photo_ids: [...(p.photo_ids ?? []), photoId] }))
                  e.target.value = ''
                }}
              />
            </label>
          </div>
        </div>

        <Card>
          <p className="font-semibold mb-2">Safety</p>
          <textarea
            value={log.safety_observations}
            onChange={(e) => setLog((p) => ({ ...p, safety_observations: e.target.value }))}
            className="w-full px-3 py-3 border rounded-xl"
            rows={3}
            placeholder="Safety observations"
          />
          <div className="mt-3 flex items-center justify-between">
            <p className="text-sm font-semibold">Incidents</p>
            <button
              onClick={() =>
                setLog((p) => ({
                  ...p,
                  safety_incidents: [
                    ...(p.safety_incidents ?? []),
                    { id: uuid(), description: '', persons_involved: '', action_taken: '', reported_to: '', photo_id: null },
                  ],
                }))
              }
              className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
            >
              + Add
            </button>
          </div>
          {(log.safety_incidents ?? []).length === 0 ? (
            <p className="text-sm text-gray-600 mt-2">No incidents.</p>
          ) : (
            <div className="space-y-2 mt-2">
              {(log.safety_incidents ?? []).map((inc) => (
                <div key={inc.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2">
                  <textarea
                    value={inc.description}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        safety_incidents: (p.safety_incidents ?? []).map((x) => (x.id === inc.id ? { ...x, description: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                    rows={2}
                    placeholder="Description"
                  />
                  <input
                    value={inc.persons_involved}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        safety_incidents: (p.safety_incidents ?? []).map((x) => (x.id === inc.id ? { ...x, persons_involved: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                    placeholder="Persons involved"
                  />
                  <textarea
                    value={inc.action_taken}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        safety_incidents: (p.safety_incidents ?? []).map((x) => (x.id === inc.id ? { ...x, action_taken: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                    rows={2}
                    placeholder="Action taken"
                  />
                  <input
                    value={inc.reported_to}
                    onChange={(e) =>
                      setLog((p) => ({
                        ...p,
                        safety_incidents: (p.safety_incidents ?? []).map((x) => (x.id === inc.id ? { ...x, reported_to: e.target.value } : x)),
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                    placeholder="Reported to"
                  />
                  <label className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer inline-flex items-center justify-center">
                    {inc.photo_id ? 'Replace Photo' : 'Add Photo'}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        const photoId = await onAddDailyPhoto({
                          dailyLogId: log.id,
                          file,
                          caption: `Safety: ${inc.description?.slice?.(0, 32) ?? 'Incident'}`,
                          category: 'safety',
                        })
                        if (!photoId) {
                          e.target.value = ''
                          return
                        }
                        setLog((p) => ({
                          ...p,
                          safety_incidents: (p.safety_incidents ?? []).map((x) => (x.id === inc.id ? { ...x, photo_id: photoId } : x)),
                          photo_ids: [...(p.photo_ids ?? []), photoId],
                        }))
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div>
          <p className="text-sm font-semibold mb-2">Notes</p>
          <textarea
            value={log.notes}
            onChange={(e) => setLog((p) => ({ ...p, notes: e.target.value }))}
            className="w-full px-3 py-3 border rounded-xl"
            rows={3}
            placeholder="Additional notes"
          />
        </div>

        <Card>
          <p className="font-semibold mb-2">✍️ Signature</p>
          <div className="grid grid-cols-1 gap-2">
            <input
              value={log.signature_name}
              onChange={(e) => setLog((p) => ({ ...p, signature_name: e.target.value }))}
              className="w-full px-3 py-3 border rounded-xl"
              placeholder="Type name (optional)"
            />
            <div className="flex gap-2">
              <button onClick={clearSignature} className="flex-1 h-11 rounded-xl border border-gray-200 bg-white text-sm font-semibold">
                Clear
              </button>
              <button
                onClick={renderTypedSignature}
                className="flex-1 h-11 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                disabled={!log.signature_name.trim()}
              >
                Use Typed
              </button>
            </div>
            <canvas
              ref={signatureCanvasRef}
              width={600}
              height={180}
              className="w-full border border-gray-200 rounded-xl bg-white touch-none"
              onPointerDown={onSignatureDown}
              onPointerMove={onSignatureMove}
              onPointerUp={onSignatureUp}
              onPointerLeave={onSignatureUp}
            />
            <p className="text-xs text-gray-600">Draw your signature above.</p>
          </div>
        </Card>
      </div>
    </Modal>
  )
}

const materialCategoryForTask = (task) => {
  const name = String(task?.name ?? '').toLowerCase()
  const trade = String(task?.trade ?? '').toLowerCase()

  if (name.includes('window')) return 'windows'
  if (name.includes('cabinet')) return 'cabinets'
  if (name.includes('countertop')) return 'countertops'
  if (name.includes('appliance')) return 'appliances'
  if (name.includes('truss')) return 'trusses'
  if (name.includes('garage door')) return 'garage_door'
  if (name.includes('fireplace')) return 'fireplace'
  if (name.includes('roof')) return 'roofing'
  if (name.includes('siding')) return 'siding'
  if (name.includes('door')) return name.includes('interior') ? 'doors_interior' : 'doors_exterior'

  if (trade === 'windows') return 'windows'
  if (trade === 'roofing') return 'roofing'
  if (trade === 'siding') return 'siding'
  if (trade === 'cabinet') return 'cabinets'
  if (trade === 'countertops') return 'countertops'
  if (trade === 'hvac') return 'hvac_equipment'

  return 'other'
}

const materialStatusLabel = (status) =>
  String(status ?? '')
    .split('_')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ''))
    .join(' ')

const computeMaterialAlert = ({ order, neededByIso, todayIso }) => {
  const status = String(order?.status ?? 'not_ordered')
  const lead = Math.max(0, Number(order?.lead_time_days ?? 0) || 0)
  const buffer = Math.max(0, Number(order?.buffer_days ?? 0) || 0)
  const shouldOrderBy = neededByIso ? formatISODate(addCalendarDays(neededByIso, -(lead + buffer + 7))) : null

  const eta = order?.estimated_delivery ?? null
  const etaDate = eta ? parseISODate(eta) : null
  const neededDate = neededByIso ? parseISODate(neededByIso) : null
  const daysUntilNeeded = neededByIso ? daysBetweenCalendar(neededByIso, todayIso) : null

  if (status === 'backordered') {
    return {
      type: 'material_backordered',
      severity: 'critical',
      title: `Material Backordered - ${order?.item_name || 'Material'}`,
      body: 'Status is BACKORDERED. Contact vendor for an update.',
    }
  }

  if (status === 'not_ordered' && shouldOrderBy && todayIso >= shouldOrderBy) {
    const urgent = daysUntilNeeded != null && daysUntilNeeded < 14
    return {
      type: 'material_not_ordered',
      severity: urgent ? 'critical' : 'warning',
      title: `Material Not Ordered - ${order?.item_name || 'Material'}`,
      body: `Lead time: ${lead} days.\nNeeded by: ${neededByIso ? formatShortDate(neededByIso) : '—'}`,
    }
  }

  if (neededDate && etaDate && etaDate > neededDate && status !== 'delivered' && status !== 'installed' && status !== 'cancelled') {
    return {
      type: 'material_at_risk',
      severity: 'critical',
      title: `Material At Risk - ${order?.item_name || 'Material'}`,
      body: `ETA: ${formatShortDate(eta)}\nNeeded: ${formatShortDate(neededByIso)}`,
    }
  }

  return null
}

function MaterialOrderEditorModal({ lot, tasks, initial, onClose, onSave, onAddDeliveryPhoto }) {
  const [draft, setDraft] = useState(() => {
    const now = new Date().toISOString()
    return {
      id: initial?.id ?? uuid(),
      lot_id: lot.id,
      item_category: initial?.item_category ?? 'other',
      item_name: initial?.item_name ?? '',
      item_description: initial?.item_description ?? '',
      manufacturer: initial?.manufacturer ?? '',
      model_number: initial?.model_number ?? '',
      color_finish: initial?.color_finish ?? '',
      quantity: initial?.quantity ?? 1,
      unit: initial?.unit ?? 'ea',
      vendor_name: initial?.vendor_name ?? '',
      vendor_contact: initial?.vendor_contact ?? '',
      vendor_phone: initial?.vendor_phone ?? '',
      vendor_email: initial?.vendor_email ?? '',
      po_number: initial?.po_number ?? '',
      order_date: initial?.order_date ?? '',
      order_confirmation: initial?.order_confirmation ?? null,
      unit_price: initial?.unit_price ?? 0,
      total_price: initial?.total_price ?? 0,
      tax: initial?.tax ?? 0,
      shipping: initial?.shipping ?? 0,
      grand_total: initial?.grand_total ?? 0,
      lead_time_days: initial?.lead_time_days ?? 0,
      estimated_ship_date: initial?.estimated_ship_date ?? '',
      estimated_delivery: initial?.estimated_delivery ?? '',
      actual_ship_date: initial?.actual_ship_date ?? null,
      actual_delivery: initial?.actual_delivery ?? null,
      task_id: initial?.task_id ?? '',
      needed_by_date: initial?.needed_by_date ?? '',
      buffer_days: initial?.buffer_days ?? 7,
      status: initial?.status ?? 'not_ordered',
      tracking_numbers: Array.isArray(initial?.tracking_numbers) ? initial.tracking_numbers : [],
      delivery_location: initial?.delivery_location ?? 'job_site',
      delivery_instructions: initial?.delivery_instructions ?? '',
      received_by: initial?.received_by ?? '',
      received_date: initial?.received_date ?? null,
      delivery_condition: initial?.delivery_condition ?? 'good',
      delivery_notes: initial?.delivery_notes ?? '',
      delivery_photo_ids: Array.isArray(initial?.delivery_photo_ids) ? initial.delivery_photo_ids : [],
      issues: Array.isArray(initial?.issues) ? initial.issues : [],
      created_at: initial?.created_at ?? now,
      updated_at: now,
      created_by: initial?.created_by ?? '',
    }
  })

  const computedNeededBy = useMemo(() => {
    if (draft.needed_by_date) return draft.needed_by_date
    const t = tasks.find((x) => x.id === draft.task_id)
    return t?.scheduled_start ?? ''
  }, [draft.needed_by_date, draft.task_id, tasks])

  const recomputeTotals = () => {
    const unit = Number(draft.unit_price ?? 0) || 0
    const qty = Number(draft.quantity ?? 0) || 0
    const total = unit * qty
    const tax = Number(draft.tax ?? 0) || 0
    const ship = Number(draft.shipping ?? 0) || 0
    setDraft((p) => ({ ...p, total_price: total, grand_total: total + tax + ship }))
  }

  useEffect(() => {
    recomputeTotals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.unit_price, draft.quantity, draft.tax, draft.shipping])

  const addTracking = () => {
    setDraft((p) => ({
      ...p,
      tracking_numbers: [...(p.tracking_numbers ?? []), { carrier: '', tracking: '', url: '' }],
    }))
  }

  const addIssue = () => {
    setDraft((p) => ({
      ...p,
      issues: [
        ...(p.issues ?? []),
        { id: uuid(), type: 'backorder', description: '', reported_date: formatISODate(new Date()), resolution: '', resolved_date: null },
      ],
    }))
  }

  const removeDoc = async () => {
    const doc = draft.order_confirmation
    setDraft((p) => ({ ...p, order_confirmation: null }))
    if (doc?.blob_id) await deleteBlob(doc.blob_id)
  }

  const attachDoc = async (file) => {
    const max = 25 * 1024 * 1024
    const okType = file.type === 'application/pdf' || String(file.type).startsWith('image/')
    if (!okType) {
      alert('Order confirmation must be a PDF or image.')
      return
    }
    if (file.size > max) {
      alert('Order confirmation must be ≤ 25MB.')
      return
    }
    const blobId = uuid()
    await putBlob(blobId, file)
    const doc = {
      id: uuid(),
      type: 'order_confirmation',
      file_name: file.name,
      mime: file.type,
      file_size: file.size,
      blob_id: blobId,
      uploaded_at: new Date().toISOString(),
    }
    setDraft((p) => ({ ...p, order_confirmation: doc }))
  }

  return (
    <Modal
      title={initial ? 'Edit Material Order' : 'Add Material Order'}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() => {
              onSave({ ...draft, needed_by_date: computedNeededBy })
            }}
            className="flex-1"
            disabled={!draft.item_name.trim()}
          >
            Save
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3">
          <label className="block">
            <span className="text-sm font-semibold">Category</span>
            <select
              value={draft.item_category}
              onChange={(e) => setDraft((p) => ({ ...p, item_category: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl"
            >
              {MATERIAL_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-semibold">Item Name</span>
            <input
              value={draft.item_name}
              onChange={(e) => setDraft((p) => ({ ...p, item_name: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl"
              placeholder="Kitchen Cabinets"
            />
          </label>

          <label className="block">
            <span className="text-sm font-semibold">Description</span>
            <textarea
              value={draft.item_description}
              onChange={(e) => setDraft((p) => ({ ...p, item_description: e.target.value }))}
              className="mt-1 w-full px-3 py-3 border rounded-xl"
              rows={3}
              placeholder="Shaker style, white, per plan"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-sm font-semibold">Qty</span>
              <input
                type="number"
                value={draft.quantity}
                onChange={(e) => setDraft((p) => ({ ...p, quantity: Number(e.target.value) }))}
                className="mt-1 w-full px-3 py-3 border rounded-xl"
              />
            </label>
            <label className="block">
              <span className="text-sm font-semibold">Unit</span>
              <input value={draft.unit} onChange={(e) => setDraft((p) => ({ ...p, unit: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl" />
            </label>
          </div>

          <Card className="bg-gray-50">
            <p className="text-sm font-semibold mb-2">Vendor</p>
            <div className="grid grid-cols-1 gap-2">
              <input
                value={draft.vendor_name}
                onChange={(e) => setDraft((p) => ({ ...p, vendor_name: e.target.value }))}
                className="w-full px-3 py-3 border rounded-xl"
                placeholder="Vendor name"
              />
              <input
                value={draft.vendor_contact}
                onChange={(e) => setDraft((p) => ({ ...p, vendor_contact: e.target.value }))}
                className="w-full px-3 py-3 border rounded-xl"
                placeholder="Contact"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={draft.vendor_phone}
                  onChange={(e) => setDraft((p) => ({ ...p, vendor_phone: formatPhoneInput(e.target.value) }))}
                  className="w-full px-3 py-3 border rounded-xl"
                  placeholder="Phone"
                />
                <input
                  value={draft.vendor_email}
                  onChange={(e) => setDraft((p) => ({ ...p, vendor_email: e.target.value }))}
                  className="w-full px-3 py-3 border rounded-xl"
                  placeholder="Email"
                />
              </div>
              <div className="flex gap-2">
                {draft.vendor_phone ? (
                  <a href={`tel:${draft.vendor_phone}`} className="flex-1 h-11 rounded-xl border border-gray-200 bg-white text-sm font-semibold inline-flex items-center justify-center gap-2">
                    <Phone className="w-4 h-4" />
                    Call
                  </a>
                ) : null}
                {draft.vendor_email ? (
                  <a href={`mailto:${draft.vendor_email}`} className="flex-1 h-11 rounded-xl border border-gray-200 bg-white text-sm font-semibold inline-flex items-center justify-center gap-2">
                    ✉️ Email
                  </a>
                ) : null}
              </div>
            </div>
          </Card>

          <Card className="bg-gray-50">
            <p className="text-sm font-semibold mb-2">Order & Timing</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-xs font-semibold text-gray-700">Status</span>
                <select value={draft.status} onChange={(e) => setDraft((p) => ({ ...p, status: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm">
                  {MATERIAL_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {materialStatusLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-gray-700">PO #</span>
                <input value={draft.po_number} onChange={(e) => setDraft((p) => ({ ...p, po_number: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm" />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-gray-700">Lead Time (days)</span>
                <input type="number" value={draft.lead_time_days} onChange={(e) => setDraft((p) => ({ ...p, lead_time_days: Number(e.target.value) }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm" />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-gray-700">Buffer Days</span>
                <input type="number" value={draft.buffer_days} onChange={(e) => setDraft((p) => ({ ...p, buffer_days: Number(e.target.value) }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm" />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-gray-700">Order Date</span>
                <input type="date" value={draft.order_date} onChange={(e) => setDraft((p) => ({ ...p, order_date: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm" />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-gray-700">ETA Delivery</span>
                <input type="date" value={draft.estimated_delivery} onChange={(e) => setDraft((p) => ({ ...p, estimated_delivery: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm" />
              </label>
            </div>

            <div className="mt-2">
              <p className="text-xs text-gray-600">
                Needed by: <span className="font-semibold">{computedNeededBy ? formatShortDate(computedNeededBy) : '—'}</span>
              </p>
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">Order Confirmation</p>
              {draft.order_confirmation ? (
                <button onClick={removeDoc} className="text-sm font-semibold px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700">
                  Remove
                </button>
              ) : (
                <label className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer">
                  Upload
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      await attachDoc(file)
                      e.target.value = ''
                    }}
                  />
                </label>
              )}
            </div>
            {draft.order_confirmation ? (
              <p className="text-xs text-gray-700 mt-1">{draft.order_confirmation.file_name}</p>
            ) : (
              <p className="text-xs text-gray-500 mt-1">Optional PDF/image attachment.</p>
            )}
          </Card>

          <Card className="bg-gray-50">
            <p className="text-sm font-semibold mb-2">Schedule Association</p>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Task</span>
              <select value={draft.task_id} onChange={(e) => setDraft((p) => ({ ...p, task_id: e.target.value, needed_by_date: '' }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm">
                <option value="">Select a task…</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({formatShortDate(t.scheduled_start)}-{formatShortDate(t.scheduled_end)})
                  </option>
                ))}
              </select>
            </label>
            <label className="block mt-2">
              <span className="text-xs font-semibold text-gray-700">Needed By Date (override)</span>
              <input type="date" value={draft.needed_by_date} onChange={(e) => setDraft((p) => ({ ...p, needed_by_date: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm" />
            </label>
          </Card>

          <Card className="bg-gray-50">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Tracking</p>
              <button onClick={addTracking} className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white">
                + Add
              </button>
            </div>
            {(draft.tracking_numbers ?? []).length === 0 ? (
              <p className="text-xs text-gray-500 mt-2">No tracking numbers.</p>
            ) : (
              <div className="space-y-2 mt-2">
                {(draft.tracking_numbers ?? []).map((t, idx) => (
                  <div key={idx} className="bg-white border border-gray-200 rounded-xl p-3">
                    <div className="grid grid-cols-1 gap-2">
                      <input
                        value={t.carrier ?? ''}
                        onChange={(e) => setDraft((p) => ({ ...p, tracking_numbers: p.tracking_numbers.map((x, i) => (i === idx ? { ...x, carrier: e.target.value } : x)) }))}
                        className="w-full px-3 py-2 border rounded-xl text-sm"
                        placeholder="Carrier"
                      />
                      <input
                        value={t.tracking ?? ''}
                        onChange={(e) => setDraft((p) => ({ ...p, tracking_numbers: p.tracking_numbers.map((x, i) => (i === idx ? { ...x, tracking: e.target.value } : x)) }))}
                        className="w-full px-3 py-2 border rounded-xl text-sm"
                        placeholder="Tracking #"
                      />
                      <input
                        value={t.url ?? ''}
                        onChange={(e) => setDraft((p) => ({ ...p, tracking_numbers: p.tracking_numbers.map((x, i) => (i === idx ? { ...x, url: e.target.value } : x)) }))}
                        className="w-full px-3 py-2 border rounded-xl text-sm"
                        placeholder="Tracking URL (optional)"
                      />
                      <button
                        onClick={() => setDraft((p) => ({ ...p, tracking_numbers: p.tracking_numbers.filter((_, i) => i !== idx) }))}
                        className="h-10 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm font-semibold"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="bg-gray-50">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Delivery Photos</p>
              <label className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer inline-flex items-center gap-2">
                <Image className="w-4 h-4" />
                Add
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    await onAddDeliveryPhoto?.({ orderId: draft.id, file, caption: draft.item_name })
                    e.target.value = ''
                  }}
                />
              </label>
            </div>
            {(draft.delivery_photo_ids ?? []).length === 0 ? (
              <p className="text-xs text-gray-500 mt-2">No delivery photos yet.</p>
            ) : (
              <p className="text-xs text-gray-700 mt-2">{draft.delivery_photo_ids.length} photo(s) attached.</p>
            )}
          </Card>

          <Card className="bg-gray-50">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Issues</p>
              <button onClick={addIssue} className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white">
                + Add
              </button>
            </div>
            {(draft.issues ?? []).length === 0 ? (
              <p className="text-xs text-gray-500 mt-2">No issues logged.</p>
            ) : (
              <div className="space-y-2 mt-2">
                {(draft.issues ?? []).map((iss) => (
                  <div key={iss.id} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                    <select
                      value={iss.type}
                      onChange={(e) => setDraft((p) => ({ ...p, issues: p.issues.map((x) => (x.id === iss.id ? { ...x, type: e.target.value } : x)) }))}
                      className="w-full px-3 py-2 border rounded-xl text-sm"
                    >
                      {['backorder', 'damaged', 'wrong_item', 'short', 'quality'].map((t) => (
                        <option key={t} value={t}>
                          {materialStatusLabel(t)}
                        </option>
                      ))}
                    </select>
                    <input
                      value={iss.description}
                      onChange={(e) => setDraft((p) => ({ ...p, issues: p.issues.map((x) => (x.id === iss.id ? { ...x, description: e.target.value } : x)) }))}
                      className="w-full px-3 py-2 border rounded-xl text-sm"
                      placeholder="Description"
                    />
                    <input
                      value={iss.resolution}
                      onChange={(e) => setDraft((p) => ({ ...p, issues: p.issues.map((x) => (x.id === iss.id ? { ...x, resolution: e.target.value } : x)) }))}
                      className="w-full px-3 py-2 border rounded-xl text-sm"
                      placeholder="Resolution"
                    />
                    <button
                      onClick={() => setDraft((p) => ({ ...p, issues: p.issues.filter((x) => x.id !== iss.id) }))}
                      className="h-10 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm font-semibold"
                    >
                      Remove Issue
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </Modal>
  )
}

function MaterialsModal({ lot, community, onClose, onUpdate, onNotify, onAddDeliveryPhoto }) {
  const todayIso = formatISODate(new Date())

  const tasks = useMemo(
    () => (lot.tasks ?? []).slice().sort((a, b) => String(a.scheduled_start).localeCompare(String(b.scheduled_start)) || String(a.name).localeCompare(String(b.name))),
    [lot.tasks],
  )

  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  const orders = Array.isArray(lot.material_orders) ? lot.material_orders : []
  const enriched = useMemo(() => {
    return orders
      .map((order) => {
        const task = order?.task_id ? tasksById.get(order.task_id) : null
        const neededByIso = order?.needed_by_date || task?.scheduled_start || null
        const alert = neededByIso ? computeMaterialAlert({ order, neededByIso, todayIso }) : null
        const eta = order?.estimated_delivery ?? null
        const isAtRisk =
          Boolean(alert?.type === 'material_at_risk') ||
          (neededByIso && eta && parseISODate(eta) && parseISODate(neededByIso) && parseISODate(eta) > parseISODate(neededByIso))

        return { order, task, neededByIso, alert, isAtRisk }
      })
      .sort((a, b) => {
        const aRank = a.alert?.severity === 'critical' ? 0 : a.alert?.severity === 'warning' ? 1 : a.isAtRisk ? 2 : 3
        const bRank = b.alert?.severity === 'critical' ? 0 : b.alert?.severity === 'warning' ? 1 : b.isAtRisk ? 2 : 3
        return aRank - bRank || String(a.neededByIso ?? '').localeCompare(String(b.neededByIso ?? '')) || String(a.order?.item_name ?? '').localeCompare(String(b.order?.item_name ?? ''))
      })
  }, [orders, tasksById, todayIso])

  const needsAttention = enriched.filter((x) => x.alert || x.isAtRisk || x.order?.status === 'backordered')
  const onTrack = enriched.filter((x) => !needsAttention.includes(x))

  const [editor, setEditor] = useState(null) // { mode: 'new'|'edit', order: MaterialOrder|null }

  const runAlerts = () => {
    for (const row of enriched) {
      const alert = row.alert
      if (!alert) continue
      onNotify?.({
        entity_id: row.order?.id ?? '',
        title: `${alert.title} - ${community?.name ?? ''} ${lotCode(lot)}`,
        body: alert.body,
        priority: alert.severity === 'critical' ? 'urgent' : 'high',
      })
    }
    if (enriched.every((r) => !r.alert)) {
      alert('No material alerts right now.')
    }
  }

  const suggestFromSchedule = () => {
    const existingTaskIds = new Set((orders ?? []).map((o) => o.task_id).filter(Boolean))
    const candidates = (lot.tasks ?? []).filter((t) => Number(t.lead_time_days ?? 0) > 0 && !existingTaskIds.has(t.id))
    if (candidates.length === 0) {
      alert('No suggested material orders found for this schedule.')
      return
    }
    const now = new Date().toISOString()
    const suggestions = candidates.slice(0, 12).map((t) => {
      const categoryId = materialCategoryForTask(t)
      const cat = MATERIAL_CATEGORIES.find((c) => c.id === categoryId)
      const lead = Math.max(Number(t.lead_time_days ?? 0) || 0, Number(cat?.typical_lead_days ?? 0) || 0)
      return {
        id: uuid(),
        lot_id: lot.id,
        item_category: categoryId,
        item_name: cat?.label ? `${cat.label}` : t.name,
        item_description: '',
        manufacturer: '',
        model_number: '',
        color_finish: '',
        quantity: 1,
        unit: 'ea',
        vendor_name: '',
        vendor_contact: '',
        vendor_phone: '',
        vendor_email: '',
        po_number: '',
        order_date: '',
        order_confirmation: null,
        unit_price: 0,
        total_price: 0,
        tax: 0,
        shipping: 0,
        grand_total: 0,
        lead_time_days: lead,
        estimated_ship_date: '',
        estimated_delivery: '',
        actual_ship_date: null,
        actual_delivery: null,
        task_id: t.id,
        needed_by_date: t.scheduled_start,
        buffer_days: 7,
        status: 'not_ordered',
        tracking_numbers: [],
        delivery_location: 'job_site',
        delivery_instructions: '',
        received_by: '',
        received_date: null,
        delivery_condition: 'good',
        delivery_notes: '',
        delivery_photo_ids: [],
        issues: [],
        created_at: now,
        updated_at: now,
        created_by: '',
      }
    })

    if (!confirm(`Add ${suggestions.length} suggested material order(s) from the schedule?`)) return
    onUpdate([...(orders ?? []), ...suggestions])
  }

  return (
    <>
      <Modal
        title={`📦 Materials - ${community?.name ?? ''} ${lotCode(lot)}`}
        onClose={onClose}
        footer={
          <div className="flex gap-2">
            <SecondaryButton onClick={onClose} className="flex-1">
              Close
            </SecondaryButton>
            <PrimaryButton onClick={() => setEditor({ mode: 'new', order: null })} className="flex-1">
              + Add
            </PrimaryButton>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="flex gap-2">
            <button onClick={suggestFromSchedule} className="flex-1 h-12 rounded-xl border border-gray-200 bg-white text-sm font-semibold">
              Suggest From Schedule
            </button>
            <button onClick={runAlerts} className="flex-1 h-12 rounded-xl bg-orange-600 text-white text-sm font-semibold">
              Run Alert Check
            </button>
          </div>

          <Card className="bg-gray-50">
            <p className="text-sm font-semibold">Needs Attention ({needsAttention.length})</p>
            {needsAttention.length === 0 ? (
              <p className="text-sm text-gray-600 mt-2">No at-risk materials right now.</p>
            ) : (
              <div className="space-y-2 mt-2">
                {needsAttention.map(({ order, task, neededByIso, alert }) => (
                  <button
                    key={order.id}
                    onClick={() => setEditor({ mode: 'edit', order })}
                    className="w-full text-left bg-white border border-gray-200 rounded-xl p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate">
                          {alert?.severity === 'critical' ? '🔴' : '🟡'} {order.item_name || 'Material'}
                        </p>
                        <p className="text-xs text-gray-600 mt-1">
                          Status: {materialStatusLabel(order.status)} • Needed: {neededByIso ? formatShortDate(neededByIso) : '—'}
                        </p>
                        {task ? <p className="text-xs text-gray-600 mt-1">Task: {task.name}</p> : null}
                        {alert ? <p className="text-xs text-orange-800 mt-2 whitespace-pre-line">{alert.body}</p> : null}
                      </div>
                      <span className="text-xs font-semibold px-2 py-1 rounded-lg border border-orange-200 bg-orange-50 text-orange-800">
                        {alert?.type === 'material_at_risk' ? 'AT RISK' : alert?.type === 'material_not_ordered' ? 'ORDER NOW' : 'ALERT'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card className="bg-gray-50">
            <p className="text-sm font-semibold">On Track ({onTrack.length})</p>
            {onTrack.length === 0 ? (
              <p className="text-sm text-gray-600 mt-2">No on-track material orders.</p>
            ) : (
              <div className="space-y-2 mt-2">
                {onTrack.map(({ order, task, neededByIso }) => (
                  <button
                    key={order.id}
                    onClick={() => setEditor({ mode: 'edit', order })}
                    className="w-full text-left bg-white border border-gray-200 rounded-xl p-3"
                  >
                    <p className="font-semibold text-gray-900">{order.item_name || 'Material'}</p>
                    <p className="text-xs text-gray-600 mt-1">
                      Status: {materialStatusLabel(order.status)} • Needed: {neededByIso ? formatShortDate(neededByIso) : '—'}
                    </p>
                    {task ? <p className="text-xs text-gray-600 mt-1">Task: {task.name}</p> : null}
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      </Modal>

      {editor && (
        <MaterialOrderEditorModal
          lot={lot}
          tasks={tasks}
          initial={editor.mode === 'edit' ? editor.order : null}
          onClose={() => setEditor(null)}
          onAddDeliveryPhoto={onAddDeliveryPhoto}
          onSave={(next) => {
            const now = new Date().toISOString()
            const nextOrders = [...orders.filter((o) => o.id !== next.id), { ...next, updated_at: now }]
            onUpdate(nextOrders)
            setEditor(null)
          }}
        />
      )}
    </>
  )
}

const changeOrderStatusLabel = (status) =>
  String(status ?? '')
    .split('_')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ''))
    .join(' ')

const formatMoney = (amount) => {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '$0'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function SignatureCapture({ label, value, onChange }) {
  const canvasRef = useRef(null)
  const drawingRef = useRef(false)
  const lastRef = useRef(null)

  const clear = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext?.('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    onChange?.(null)
  }

  const save = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      const dataUrl = canvas.toDataURL('image/png')
      onChange?.(dataUrl)
    } catch (err) {
      console.error(err)
    }
  }

  useEffect(() => {
    if (!value) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext?.('2d')
    if (!canvas || !ctx) return
    const img = new window.Image()
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    }
    img.src = value
  }, [value])

  const onDown = (e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    drawingRef.current = true
    canvas.setPointerCapture?.(e.pointerId)
    const rect = canvas.getBoundingClientRect()
    lastRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onMove = (e) => {
    if (!drawingRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext?.('2d')
    if (!canvas || !ctx) return
    const rect = canvas.getBoundingClientRect()
    const next = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const last = lastRef.current
    if (!last) {
      lastRef.current = next
      return
    }
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#111827'
    ctx.beginPath()
    ctx.moveTo(last.x, last.y)
    ctx.lineTo(next.x, next.y)
    ctx.stroke()
    lastRef.current = next
  }

  const onUp = () => {
    drawingRef.current = false
    lastRef.current = null
    save()
  }

  return (
    <Card className="bg-gray-50">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{label}</p>
        <button onClick={clear} className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white">
          Clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        width={600}
        height={180}
        className="mt-2 w-full border border-gray-200 rounded-xl bg-white touch-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      />
      <p className="text-xs text-gray-600 mt-2">{value ? 'Signature saved.' : 'Draw signature above.'}</p>
    </Card>
  )
}

function ChangeOrderEditorModal({
  lot,
  community,
  org,
  tasks,
  subcontractors,
  initial,
  isOnline,
  onClose,
  onSave,
  onAllocateNumber,
  onApplyScheduleImpact,
  onAddPhoto,
  onNotify,
}) {
  const [draft, setDraft] = useState(() => {
    const now = new Date().toISOString()
    const reqDate = initial?.request_date ?? formatISODate(new Date())
    const coNumber = initial?.co_number ?? ''
    return {
      id: initial?.id ?? uuid(),
      lot_id: lot.id,
      co_number: coNumber,
      title: initial?.title ?? '',
      description: initial?.description ?? '',
      category: initial?.category ?? 'other',
      requested_by: initial?.requested_by ?? 'buyer',
      requestor_name: initial?.requestor_name ?? '',
      requestor_email: initial?.requestor_email ?? '',
      request_date: reqDate,
      cost_impact: initial?.cost_impact ?? {
        labor: 0,
        materials: 0,
        permits: 0,
        other: 0,
        total: 0,
        margin: 20,
        buyer_price: 0,
      },
      schedule_impact: initial?.schedule_impact ?? {
        days_added: 0,
        tasks_affected: [],
        critical_path_impact: false,
        new_completion_date: null,
      },
      anchor_task_id: initial?.anchor_task_id ?? '',
      quotes: Array.isArray(initial?.quotes) ? initial.quotes : [],
      status: initial?.status ?? 'draft',
      approved_by: initial?.approved_by ?? null,
      approved_date: initial?.approved_date ?? null,
      approval_signature: initial?.approval_signature ?? null,
      decline_reason: initial?.decline_reason ?? null,
      buyer_signature: initial?.buyer_signature ?? null,
      buyer_signed_date: initial?.buyer_signed_date ?? null,
      work_started: initial?.work_started ?? null,
      work_completed: initial?.work_completed ?? null,
      final_cost: initial?.final_cost ?? null,
      documents: Array.isArray(initial?.documents) ? initial.documents : [],
      photos_before_ids: Array.isArray(initial?.photos_before_ids) ? initial.photos_before_ids : [],
      photos_after_ids: Array.isArray(initial?.photos_after_ids) ? initial.photos_after_ids : [],
      internal_notes: initial?.internal_notes ?? '',
      buyer_visible_notes: initial?.buyer_visible_notes ?? '',
      created_at: initial?.created_at ?? now,
      updated_at: now,
      created_by: initial?.created_by ?? '',
    }
  })

  const cost = draft.cost_impact ?? {}
  const subtotal = (Number(cost.labor ?? 0) || 0) + (Number(cost.materials ?? 0) || 0) + (Number(cost.permits ?? 0) || 0) + (Number(cost.other ?? 0) || 0)
  const marginPct = Math.max(0, Number(cost.margin ?? 0) || 0)
  const buyerPrice = subtotal + subtotal * (marginPct / 100)

  useEffect(() => {
    setDraft((p) => ({
      ...p,
      cost_impact: {
        ...p.cost_impact,
        total: subtotal,
        buyer_price: buyerPrice,
      },
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cost.labor, cost.materials, cost.permits, cost.other, cost.margin])

  const schedulePreview = useMemo(() => {
    const days = Math.max(0, Number(draft.schedule_impact?.days_added ?? 0) || 0)
    const taskId = draft.anchor_task_id
    if (!taskId || days <= 0) return null
    try {
      return previewDelayImpact(lot, taskId, days, org)
    } catch (err) {
      console.error(err)
      return null
    }
  }, [draft.anchor_task_id, draft.schedule_impact?.days_added, lot, org])

  const criticalImpact = useMemo(() => {
    if (!schedulePreview?.affected) return false
    const impacted = new Set((schedulePreview.affected ?? []).map((a) => a.task_id))
    return (lot.tasks ?? []).some((t) => impacted.has(t.id) && t.is_critical_path)
  }, [lot.tasks, schedulePreview])

  const addDocument = async (file) => {
    const max = 25 * 1024 * 1024
    const okType = file.type === 'application/pdf' || String(file.type).startsWith('image/')
    if (!okType) {
      alert('Attachment must be a PDF or image.')
      return
    }
    if (file.size > max) {
      alert('Attachment must be ≤ 25MB.')
      return
    }
    const blobId = uuid()
    await putBlob(blobId, file)
    const doc = {
      id: uuid(),
      type: 'change_order',
      file_name: file.name,
      mime: file.type,
      file_size: file.size,
      blob_id: blobId,
      uploaded_at: new Date().toISOString(),
    }
    setDraft((p) => ({ ...p, documents: [...(p.documents ?? []), doc] }))
  }

  const removeDocument = async (docId) => {
    const doc = (draft.documents ?? []).find((d) => d.id === docId)
    setDraft((p) => ({ ...p, documents: (p.documents ?? []).filter((d) => d.id !== docId) }))
    if (doc?.blob_id) await deleteBlob(doc.blob_id)
  }

  const addQuote = () => {
    setDraft((p) => ({
      ...p,
      quotes: [
        ...(p.quotes ?? []),
        {
          id: uuid(),
          sub_id: '',
          sub_name: '',
          trade: '',
          amount: 0,
          quote_date: formatISODate(new Date()),
          quote_document: null,
          notes: '',
        },
      ],
    }))
  }

  const updateQuote = (id, patch) => setDraft((p) => ({ ...p, quotes: (p.quotes ?? []).map((q) => (q.id === id ? { ...q, ...patch } : q)) }))

  const attachQuoteDoc = async (quoteId, file) => {
    const max = 25 * 1024 * 1024
    const okType = file.type === 'application/pdf' || String(file.type).startsWith('image/')
    if (!okType) {
      alert('Quote must be a PDF or image.')
      return
    }
    if (file.size > max) {
      alert('Quote must be ≤ 25MB.')
      return
    }
    const blobId = uuid()
    await putBlob(blobId, file)
    const doc = { id: uuid(), type: 'quote', file_name: file.name, mime: file.type, file_size: file.size, blob_id: blobId, uploaded_at: new Date().toISOString() }
    updateQuote(quoteId, { quote_document: doc })
  }

  const removeQuoteDoc = async (quoteId) => {
    const q = (draft.quotes ?? []).find((x) => x.id === quoteId)
    const doc = q?.quote_document
    updateQuote(quoteId, { quote_document: null })
    if (doc?.blob_id) await deleteBlob(doc.blob_id)
  }

  const saveWithStatus = (nextStatus) => {
    const now = new Date().toISOString()
    const todayIso = formatISODate(new Date())
    const coNumber = draft.co_number || (onAllocateNumber ? onAllocateNumber() : '')
    const daysAdded = Math.max(0, Number(draft.schedule_impact?.days_added ?? 0) || 0)
    const taskId = draft.anchor_task_id || null
    const scheduleImpact = schedulePreview
      ? {
          days_added: daysAdded,
          tasks_affected: (schedulePreview.affected ?? []).map((a) => a.task_id),
          critical_path_impact: criticalImpact,
          new_completion_date: schedulePreview.newCompletion ?? null,
        }
      : { ...(draft.schedule_impact ?? {}), days_added: daysAdded, critical_path_impact: criticalImpact }

    const next = {
      ...draft,
      co_number: coNumber,
      status: nextStatus ?? draft.status,
      work_started:
        (nextStatus ?? draft.status) === 'in_progress' && !draft.work_started ? todayIso : draft.work_started ?? null,
      work_completed:
        (nextStatus ?? draft.status) === 'complete' && !draft.work_completed ? todayIso : draft.work_completed ?? null,
      updated_at: now,
      cost_impact: { ...draft.cost_impact, total: subtotal, buyer_price: buyerPrice },
      schedule_impact: scheduleImpact,
    }

    if (next.status === 'declined' && !String(next.decline_reason ?? '').trim()) {
      alert('Decline reason is required.')
      return
    }
    if (next.status === 'approved' && !next.approval_signature) {
      alert('Approval signature is required to mark Approved.')
      return
    }
    if (next.status === 'approved' && next.requested_by === 'buyer' && !next.buyer_signature) {
      alert('Buyer signature is required for buyer-initiated change orders.')
      return
    }

    onSave(next)

    if (nextStatus && nextStatus !== initial?.status) {
      onNotify?.({
        entity_id: next.id,
        title: `Change Order ${next.co_number || ''} - ${changeOrderStatusLabel(nextStatus)}`.trim(),
        body: `${community?.name ?? ''} ${lotCode(lot)}\n${next.title}`.trim(),
        priority: nextStatus === 'declined' ? 'high' : 'normal',
      })
    }

    // Optional schedule apply shortcut
    if (nextStatus === 'in_progress' && taskId && daysAdded > 0) {
      if (confirm('Apply schedule impact now?')) {
        onApplyScheduleImpact?.({ taskId, daysAdded, reason: `Change order ${next.co_number || ''}: ${next.title}`.trim() })
      }
    }
  }

  const StatusPill = ({ value }) => (
    <span className="inline-flex items-center px-2 py-1 rounded-lg border text-xs font-semibold bg-gray-50 border-gray-200 text-gray-700">
      {changeOrderStatusLabel(value)}
    </span>
  )

  return (
    <Modal
      title={`${initial ? 'Edit' : 'New'} Change Order`}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          {draft.status === 'draft' ? (
            <>
              <SecondaryButton onClick={() => saveWithStatus('draft')} className="flex-1">
                Save Draft
              </SecondaryButton>
              <PrimaryButton onClick={() => saveWithStatus('submitted')} className="flex-1" disabled={!draft.title.trim()}>
                Submit
              </PrimaryButton>
            </>
          ) : (
            <PrimaryButton onClick={() => saveWithStatus(draft.status)} className="flex-1" disabled={!draft.title.trim()}>
              Save
            </PrimaryButton>
          )}
        </div>
      }
    >
      <div className="space-y-3">
        {!isOnline ? (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-sm text-orange-800">
            Offline — change orders still save locally; sends/exports queue until online.
          </div>
        ) : null}

        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">
            {community?.name ?? 'Community'} • {lotCode(lot)}
          </p>
          <p className="text-sm font-semibold mt-1">
            {draft.co_number ? `${draft.co_number}` : 'CO'} <StatusPill value={draft.status} />
          </p>
        </Card>

        <label className="block">
          <span className="text-sm font-semibold">Title</span>
          <input value={draft.title} onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl" placeholder="Add covered patio 12x16" />
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Category</span>
          <select value={draft.category} onChange={(e) => setDraft((p) => ({ ...p, category: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl">
            {CHANGE_ORDER_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Description</span>
          <textarea value={draft.description} onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl" rows={4} placeholder="Full description of change" />
        </label>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Requested By</p>
          <div className="flex flex-wrap gap-2">
            {[
              { id: 'buyer', label: 'Buyer' },
              { id: 'builder', label: 'Builder' },
              { id: 'architect', label: 'Architect' },
              { id: 'field', label: 'Field Issue' },
            ].map((o) => (
              <button
                key={o.id}
                onClick={() => setDraft((p) => ({ ...p, requested_by: o.id }))}
                className={`px-3 py-2 rounded-xl border text-sm font-semibold ${draft.requested_by === o.id ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-200 text-gray-900'}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2 mt-3">
            <input value={draft.requestor_name} onChange={(e) => setDraft((p) => ({ ...p, requestor_name: e.target.value }))} className="w-full px-3 py-3 border rounded-xl" placeholder="Requestor name" />
            <input value={draft.requestor_email} onChange={(e) => setDraft((p) => ({ ...p, requestor_email: e.target.value }))} className="w-full px-3 py-3 border rounded-xl" placeholder="Requestor email" />
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Request Date</span>
              <input type="date" value={draft.request_date} onChange={(e) => setDraft((p) => ({ ...p, request_date: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm" />
            </label>
          </div>
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Cost Estimate</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              ['labor', 'Labor'],
              ['materials', 'Materials'],
              ['permits', 'Permits'],
              ['other', 'Other'],
            ].map(([key, label]) => (
              <label key={key} className="block">
                <span className="text-xs font-semibold text-gray-700">{label}</span>
                <input
                  type="number"
                  value={cost[key] ?? 0}
                  onChange={(e) => setDraft((p) => ({ ...p, cost_impact: { ...(p.cost_impact ?? {}), [key]: Number(e.target.value) } }))}
                  className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
                />
              </label>
            ))}
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Margin %</span>
              <input type="number" value={marginPct} onChange={(e) => setDraft((p) => ({ ...p, cost_impact: { ...(p.cost_impact ?? {}), margin: Number(e.target.value) } }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm" />
            </label>
          </div>
          <div className="mt-3 text-sm text-gray-800 space-y-1">
            <p>
              Subtotal: <span className="font-semibold">{formatMoney(subtotal)}</span>
            </p>
            <p>
              Buyer Price: <span className="font-semibold">{formatMoney(buyerPrice)}</span>
            </p>
          </div>
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Schedule Impact</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Days Added</span>
              <input
                type="number"
                value={draft.schedule_impact?.days_added ?? 0}
                onChange={(e) => setDraft((p) => ({ ...p, schedule_impact: { ...(p.schedule_impact ?? {}), days_added: Number(e.target.value) } }))}
                className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Anchor Task</span>
              <select value={draft.anchor_task_id} onChange={(e) => setDraft((p) => ({ ...p, anchor_task_id: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm">
                <option value="">Select…</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({formatShortDate(t.scheduled_start)})
                  </option>
                ))}
              </select>
            </label>
          </div>

          {schedulePreview ? (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-gray-700">
                New completion: <span className="font-semibold">{schedulePreview.newCompletion ? formatShortDate(schedulePreview.newCompletion) : '—'}</span>{' '}
                {criticalImpact ? <span className="text-red-700 font-semibold">• Impacts critical path</span> : null}
              </p>
              <div className="space-y-1">
                {(schedulePreview.affected ?? []).slice(0, 6).map((a) => (
                  <p key={a.task_id} className="text-xs text-gray-700">
                    • {a.task_name}: {formatShortDate(a.old_start)} → <span className="font-semibold">{formatShortDate(a.new_start)}</span>
                  </p>
                ))}
                {(schedulePreview.affected ?? []).length > 6 ? (
                  <p className="text-xs text-gray-500">…and {(schedulePreview.affected ?? []).length - 6} more</p>
                ) : null}
              </div>
              <button
                onClick={() => {
                  const days = Math.max(0, Number(draft.schedule_impact?.days_added ?? 0) || 0)
                  if (!draft.anchor_task_id || days <= 0) return
                  onApplyScheduleImpact?.({ taskId: draft.anchor_task_id, daysAdded: days, reason: `Change order ${draft.co_number || ''}: ${draft.title}`.trim() })
                  onNotify?.({
                    entity_id: draft.id,
                    title: `Schedule Updated - ${draft.co_number || 'Change Order'}`,
                    body: `${community?.name ?? ''} ${lotCode(lot)}\n${draft.title}\n+${days} day(s)`,
                    priority: 'normal',
                  })
                }}
                className="w-full h-12 rounded-xl bg-blue-600 text-white font-semibold"
                disabled={!draft.anchor_task_id || Math.max(0, Number(draft.schedule_impact?.days_added ?? 0) || 0) === 0}
              >
                Apply Schedule Impact
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-500 mt-2">Enter days + anchor task to preview impact.</p>
          )}
        </Card>

        <Card className="bg-gray-50">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Attachments</p>
            <label className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer">
              + Add
              <input
                type="file"
                accept="application/pdf,image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  await addDocument(file)
                  e.target.value = ''
                }}
              />
            </label>
          </div>
          {(draft.documents ?? []).length === 0 ? (
            <p className="text-xs text-gray-500 mt-2">No attachments.</p>
          ) : (
            <div className="space-y-2 mt-2">
              {(draft.documents ?? []).slice(0, 6).map((d) => (
                <div key={d.id} className="bg-white border border-gray-200 rounded-xl p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{d.file_name}</p>
                    <p className="text-xs text-gray-500">{d.uploaded_at ? new Date(d.uploaded_at).toLocaleString() : ''}</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => openBlobInNewTab(d.blob_id)} className="p-2 rounded-xl border border-gray-200 bg-white" title="Open">
                      <Download className="w-4 h-4" />
                    </button>
                    <button onClick={() => removeDocument(d.id)} className="p-2 rounded-xl border border-red-200 bg-red-50 text-red-700" title="Remove">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Quotes</p>
          <button onClick={addQuote} className="w-full h-12 rounded-xl border border-gray-200 bg-white text-sm font-semibold">
            + Add Quote
          </button>
          {(draft.quotes ?? []).length > 0 ? (
            <div className="space-y-2 mt-2">
              {(draft.quotes ?? []).map((q) => (
                <div key={q.id} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                  <select
                    value={q.sub_id ?? ''}
                    onChange={(e) => {
                      const sub = subcontractors.find((s) => s.id === e.target.value) ?? null
                      updateQuote(q.id, { sub_id: e.target.value, sub_name: sub?.company_name ?? q.sub_name, trade: sub?.trade ?? q.trade })
                    }}
                    className="w-full px-3 py-2 border rounded-xl text-sm"
                  >
                    <option value="">Select sub…</option>
                    {subcontractors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.company_name}
                      </option>
                    ))}
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={q.trade ?? ''} onChange={(e) => updateQuote(q.id, { trade: e.target.value })} className="w-full px-3 py-2 border rounded-xl text-sm" placeholder="Trade" />
                    <input type="number" value={q.amount ?? 0} onChange={(e) => updateQuote(q.id, { amount: Number(e.target.value) })} className="w-full px-3 py-2 border rounded-xl text-sm" placeholder="Amount" />
                  </div>
                  <input type="date" value={q.quote_date ?? ''} onChange={(e) => updateQuote(q.id, { quote_date: e.target.value })} className="w-full px-3 py-2 border rounded-xl text-sm" />

                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-gray-700">Quote Doc</p>
                    {q.quote_document ? (
                      <button onClick={() => removeQuoteDoc(q.id)} className="text-xs font-semibold px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700">
                        Remove
                      </button>
                    ) : (
                      <label className="text-xs font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer">
                        Upload
                        <input
                          type="file"
                          accept="application/pdf,image/*"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            await attachQuoteDoc(q.id, file)
                            e.target.value = ''
                          }}
                        />
                      </label>
                    )}
                  </div>
                  {q.quote_document ? (
                    <button onClick={() => openBlobInNewTab(q.quote_document?.blob_id)} className="w-full h-10 rounded-xl border border-gray-200 bg-white text-sm font-semibold">
                      Open Quote Doc
                    </button>
                  ) : null}

                  <textarea value={q.notes ?? ''} onChange={(e) => updateQuote(q.id, { notes: e.target.value })} className="w-full px-3 py-2 border rounded-xl text-sm" rows={2} placeholder="Notes" />
                  <button
                    onClick={() => setDraft((p) => ({ ...p, quotes: (p.quotes ?? []).filter((x) => x.id !== q.id) }))}
                    className="w-full h-10 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm font-semibold"
                  >
                    Remove Quote
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Photos</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="h-12 rounded-xl border border-gray-200 bg-white text-sm font-semibold inline-flex items-center justify-center cursor-pointer">
              + Before Photo
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const photoId = await onAddPhoto?.({ changeOrderId: draft.id, stage: 'before', file })
                  if (photoId) setDraft((p) => ({ ...p, photos_before_ids: [...(p.photos_before_ids ?? []), photoId] }))
                  e.target.value = ''
                }}
              />
            </label>
            <label className="h-12 rounded-xl border border-gray-200 bg-white text-sm font-semibold inline-flex items-center justify-center cursor-pointer">
              + After Photo
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const photoId = await onAddPhoto?.({ changeOrderId: draft.id, stage: 'after', file })
                  if (photoId) setDraft((p) => ({ ...p, photos_after_ids: [...(p.photos_after_ids ?? []), photoId] }))
                  e.target.value = ''
                }}
              />
            </label>
          </div>
          <p className="text-xs text-gray-600 mt-2">
            Before: {draft.photos_before_ids.length} • After: {draft.photos_after_ids.length}
          </p>
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Status</p>
          <select
            value={draft.status}
            onChange={(e) => {
              const next = e.target.value
              setDraft((p) => ({ ...p, status: next }))
              if (next === 'approved') {
                setDraft((p) => ({ ...p, approved_date: p.approved_date ?? new Date().toISOString() }))
              }
            }}
            className="w-full px-3 py-3 border rounded-xl text-sm"
          >
            {CHANGE_ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {changeOrderStatusLabel(s)}
              </option>
            ))}
          </select>
          {draft.status === 'declined' ? (
            <textarea
              value={draft.decline_reason ?? ''}
              onChange={(e) => setDraft((p) => ({ ...p, decline_reason: e.target.value }))}
              className="mt-2 w-full px-3 py-3 border rounded-xl text-sm"
              rows={2}
              placeholder="Decline reason"
            />
          ) : null}
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Execution</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Work Started</span>
              <input
                type="date"
                value={draft.work_started ?? ''}
                onChange={(e) => setDraft((p) => ({ ...p, work_started: e.target.value || null }))}
                className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Work Completed</span>
              <input
                type="date"
                value={draft.work_completed ?? ''}
                onChange={(e) => setDraft((p) => ({ ...p, work_completed: e.target.value || null }))}
                className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
              />
            </label>
            <label className="block col-span-2">
              <span className="text-xs font-semibold text-gray-700">Final Cost</span>
              <input
                type="number"
                value={draft.final_cost ?? ''}
                onChange={(e) => setDraft((p) => ({ ...p, final_cost: e.target.value === '' ? null : Number(e.target.value) }))}
                className="mt-1 w-full px-3 py-3 border rounded-xl text-sm"
              />
            </label>
          </div>
        </Card>

        {draft.requested_by === 'buyer' ? (
          <SignatureCapture
            label="Buyer Signature"
            value={draft.buyer_signature}
            onChange={(sig) => setDraft((p) => ({ ...p, buyer_signature: sig, buyer_signed_date: sig ? new Date().toISOString() : null }))}
          />
        ) : null}

        <SignatureCapture
          label="Approval Signature (Manager)"
          value={draft.approval_signature}
          onChange={(sig) =>
            setDraft((p) => ({
              ...p,
              approval_signature: sig,
              approved_date: sig ? p.approved_date ?? new Date().toISOString() : p.approved_date,
            }))
          }
        />

        <div className="grid grid-cols-1 gap-3">
          <label className="block">
            <span className="text-sm font-semibold">Internal Notes</span>
            <textarea value={draft.internal_notes} onChange={(e) => setDraft((p) => ({ ...p, internal_notes: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl" rows={3} />
          </label>
          <label className="block">
            <span className="text-sm font-semibold">Buyer Visible Notes</span>
            <textarea value={draft.buyer_visible_notes} onChange={(e) => setDraft((p) => ({ ...p, buyer_visible_notes: e.target.value }))} className="mt-1 w-full px-3 py-3 border rounded-xl" rows={3} />
          </label>
        </div>
      </div>
    </Modal>
  )
}

function ChangeOrdersModal({ lot, community, org, subcontractors, isOnline, onClose, onUpdate, onAllocateNumber, onApplyScheduleImpact, onAddPhoto, onNotify }) {
  const orders = Array.isArray(lot.change_orders) ? lot.change_orders : []
  const tasks = useMemo(
    () => (lot.tasks ?? []).slice().sort((a, b) => String(a.scheduled_start).localeCompare(String(b.scheduled_start)) || String(a.name).localeCompare(String(b.name))),
    [lot.tasks],
  )

  const [editor, setEditor] = useState(null) // { mode: 'new'|'edit', order }

  const sorted = useMemo(() => {
    return orders
      .slice()
      .sort((a, b) => String(b.request_date ?? b.created_at ?? '').localeCompare(String(a.request_date ?? a.created_at ?? '')) || String(b.co_number ?? '').localeCompare(String(a.co_number ?? '')))
  }, [orders])

  const statusColor = (s) => {
    if (s === 'approved' || s === 'complete') return 'bg-green-50 border-green-200 text-green-800'
    if (s === 'declined' || s === 'cancelled') return 'bg-red-50 border-red-200 text-red-700'
    if (s === 'submitted' || s === 'under_review' || s === 'pending_buyer_approval') return 'bg-yellow-50 border-yellow-200 text-yellow-800'
    if (s === 'in_progress') return 'bg-blue-50 border-blue-200 text-blue-700'
    return 'bg-gray-50 border-gray-200 text-gray-700'
  }

  return (
    <>
      <Modal
        title={`✏️ Change Orders - ${community?.name ?? ''} ${lotCode(lot)}`}
        onClose={onClose}
        footer={
          <div className="flex gap-2">
            <SecondaryButton onClick={onClose} className="flex-1">
              Close
            </SecondaryButton>
            <PrimaryButton onClick={() => setEditor({ mode: 'new', order: null })} className="flex-1">
              + New
            </PrimaryButton>
          </div>
        }
      >
        <div className="space-y-3">
          {sorted.length === 0 ? (
            <p className="text-sm text-gray-600">No change orders yet.</p>
          ) : (
            <div className="space-y-2">
              {sorted.map((co) => (
                <button key={co.id} onClick={() => setEditor({ mode: 'edit', order: co })} className="w-full text-left bg-gray-50 rounded-xl border border-gray-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 truncate">
                        {co.co_number || 'CO'} • {co.title || 'Untitled'}
                      </p>
                      <p className="text-xs text-gray-600 mt-1">
                        {co.request_date ? formatShortDate(co.request_date) : ''} • {CHANGE_ORDER_CATEGORIES.find((c) => c.id === co.category)?.label ?? 'Other'}
                      </p>
                    </div>
                    <span className={`text-xs font-semibold px-2 py-1 rounded-lg border ${statusColor(co.status)}`}>{changeOrderStatusLabel(co.status)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {editor && (
        <ChangeOrderEditorModal
          lot={lot}
          community={community}
          org={org}
          tasks={tasks}
          subcontractors={subcontractors ?? []}
          initial={editor.mode === 'edit' ? editor.order : null}
          isOnline={isOnline}
          onClose={() => setEditor(null)}
          onAllocateNumber={onAllocateNumber}
          onApplyScheduleImpact={onApplyScheduleImpact}
          onAddPhoto={onAddPhoto}
          onNotify={onNotify}
          onSave={(next) => {
            const nextOrders = [...orders.filter((o) => o.id !== next.id), next]
            onUpdate(nextOrders)
            setEditor(null)
          }}
        />
      )}
    </>
  )
}

function GenerateReportModal({ communities, isOnline, onClose, onGenerate }) {
  const todayIso = formatISODate(new Date())

  const weekStartIso = useMemo(() => {
    const base = parseISODate(todayIso)
    if (!base) return todayIso
    const mondayOffset = (base.getDay() + 6) % 7
    const start = new Date(base)
    start.setDate(start.getDate() - mondayOffset)
    return formatISODate(start)
  }, [todayIso])

  const [reportType, setReportType] = useState('progress')
  const [preset, setPreset] = useState('this_week')
  const [fromIso, setFromIso] = useState(weekStartIso)
  const [toIso, setToIso] = useState(() => formatISODate(addCalendarDays(weekStartIso, 6)))
  const [selectedCommunityIds, setSelectedCommunityIds] = useState(() => new Set(['all']))
  const [format, setFormat] = useState('excel')
  const [includePhotos, setIncludePhotos] = useState(true)
  const [includeCharts, setIncludeCharts] = useState(true)
  const [includeComments, setIncludeComments] = useState(false)

  const applyPreset = (nextPreset) => {
    setPreset(nextPreset)
    if (nextPreset === 'custom') return
    const base = parseISODate(todayIso)
    if (!base) return
    if (nextPreset === 'this_week') {
      setFromIso(weekStartIso)
      setToIso(formatISODate(addCalendarDays(weekStartIso, 6)))
      return
    }
    if (nextPreset === 'last_week') {
      const start = formatISODate(addCalendarDays(weekStartIso, -7))
      setFromIso(start)
      setToIso(formatISODate(addCalendarDays(weekStartIso, -1)))
      return
    }
    if (nextPreset === 'this_month') {
      setFromIso(formatISODate(new Date(base.getFullYear(), base.getMonth(), 1)))
      setToIso(formatISODate(new Date(base.getFullYear(), base.getMonth() + 1, 0)))
      return
    }
    if (nextPreset === 'last_month') {
      setFromIso(formatISODate(new Date(base.getFullYear(), base.getMonth() - 1, 1)))
      setToIso(formatISODate(new Date(base.getFullYear(), base.getMonth(), 0)))
    }
  }

  const selectedIds = useMemo(() => {
    if (selectedCommunityIds.has('all')) return (communities ?? []).map((c) => c.id)
    return Array.from(selectedCommunityIds)
  }, [communities, selectedCommunityIds])

  return (
    <Modal
      title="Generate Report"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() =>
              onGenerate?.({
                reportType,
                fromIso,
                toIso,
                communityIds: selectedIds,
                format,
                includePhotos,
                includeCharts,
                includeComments,
              })
            }
            className="flex-1"
            disabled={!isOnline || !fromIso || !toIso}
            title={!isOnline ? 'Export requires connection' : ''}
          >
            Generate
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        {!isOnline ? (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-sm text-orange-800">
            Offline — report exports are disabled.
          </div>
        ) : null}

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Report Type</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'progress', label: 'Progress Report' },
              { id: 'community_summary', label: 'Community Summary' },
              { id: 'delay_analysis', label: 'Delay Analysis' },
              { id: 'sub_performance', label: 'Sub Performance' },
              { id: 'schedule_forecast', label: 'Schedule Forecast' },
            ].map((rt) => (
              <button
                key={rt.id}
                onClick={() => setReportType(rt.id)}
                className={`p-3 rounded-xl border text-sm font-semibold ${reportType === rt.id ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-200 text-gray-900'}`}
              >
                {rt.label}
              </button>
            ))}
          </div>
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Date Range</p>
          <select value={preset} onChange={(e) => applyPreset(e.target.value)} className="w-full px-3 py-3 border rounded-xl text-sm">
            <option value="this_week">This Week</option>
            <option value="last_week">Last Week</option>
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="custom">Custom</option>
          </select>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <input type="date" value={fromIso} onChange={(e) => setFromIso(e.target.value)} className="px-3 py-3 border rounded-xl text-sm" />
            <input type="date" value={toIso} onChange={(e) => setToIso(e.target.value)} className="px-3 py-3 border rounded-xl text-sm" />
          </div>
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Communities</p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selectedCommunityIds.has('all')}
              onChange={(e) => setSelectedCommunityIds(new Set(e.target.checked ? ['all'] : []))}
            />
            All
          </label>
          <div className="mt-2 space-y-1">
            {(communities ?? []).map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={selectedCommunityIds.has('all')}
                  checked={selectedCommunityIds.has(c.id)}
                  onChange={(e) =>
                    setSelectedCommunityIds((prev) => {
                      const next = new Set(prev)
                      next.delete('all')
                      if (e.target.checked) next.add(c.id)
                      else next.delete(c.id)
                      if (next.size === 0) next.add('all')
                      return next
                    })
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Format</p>
          <div className="grid grid-cols-3 gap-2">
            {[
              ['excel', 'Excel'],
              ['pdf', 'PDF'],
              ['csv', 'CSV'],
            ].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setFormat(id)}
                className={`h-11 rounded-xl border text-sm font-semibold ${format === id ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-200 text-gray-900'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Include</p>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeCharts} onChange={(e) => setIncludeCharts(e.target.checked)} />
              Charts
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includePhotos} onChange={(e) => setIncludePhotos(e.target.checked)} />
              Photos
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeComments} onChange={(e) => setIncludeComments(e.target.checked)} />
              Comments
            </label>
            <p className="text-xs text-gray-500">Charts/comments are simplified in this demo; photos include counts in exports.</p>
          </div>
        </Card>
      </div>
    </Modal>
  )
}

function ScheduledReportsModal({ reports, communities, onClose, onUpdate }) {
  const list = useMemo(() => (Array.isArray(reports) ? reports : []), [reports])
  const [showAdd, setShowAdd] = useState(false)
  const [draft, setDraft] = useState(() => ({
    report_type: 'progress',
    frequency: 'weekly',
    day_of_week: 1,
    time: '07:00',
    recipients: '',
    communities: 'all',
    format: 'excel',
    include_photos: true,
    is_active: true,
  }))

  const add = () => {
    const recips = String(draft.recipients ?? '')
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    const entry = {
      id: uuid(),
      report_type: draft.report_type,
      frequency: draft.frequency,
      day_of_week: Number(draft.day_of_week) || 1,
      time: draft.time,
      recipients: recips,
      communities: draft.communities,
      format: draft.format,
      include_photos: Boolean(draft.include_photos),
      is_active: Boolean(draft.is_active),
    }
    onUpdate([...(list ?? []), entry])
    setShowAdd(false)
    setDraft((p) => ({ ...p, recipients: '' }))
  }

  const updateEntry = (id, patch) => onUpdate(list.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  return (
    <Modal
      title="Scheduled Reports"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Close
          </SecondaryButton>
          <PrimaryButton onClick={() => setShowAdd((v) => !v)} className="flex-1">
            {showAdd ? 'Hide' : 'Add New'}
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        {showAdd ? (
          <Card className="bg-gray-50">
            <p className="text-sm font-semibold mb-2">New Scheduled Report</p>
            <div className="grid grid-cols-1 gap-2">
              <select value={draft.report_type} onChange={(e) => setDraft((p) => ({ ...p, report_type: e.target.value }))} className="w-full px-3 py-3 border rounded-xl text-sm">
                <option value="progress">Progress</option>
                <option value="community_summary">Community Summary</option>
                <option value="delay_analysis">Delay Analysis</option>
                <option value="sub_performance">Sub Performance</option>
                <option value="schedule_forecast">Schedule Forecast</option>
              </select>
              <div className="grid grid-cols-2 gap-2">
                <select value={draft.frequency} onChange={(e) => setDraft((p) => ({ ...p, frequency: e.target.value }))} className="w-full px-3 py-3 border rounded-xl text-sm">
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
                <input value={draft.time} onChange={(e) => setDraft((p) => ({ ...p, time: e.target.value }))} className="w-full px-3 py-3 border rounded-xl text-sm" placeholder="07:00" />
              </div>
              {draft.frequency === 'weekly' ? (
                <select value={draft.day_of_week} onChange={(e) => setDraft((p) => ({ ...p, day_of_week: Number(e.target.value) }))} className="w-full px-3 py-3 border rounded-xl text-sm">
                  <option value={1}>Monday</option>
                  <option value={2}>Tuesday</option>
                  <option value={3}>Wednesday</option>
                  <option value={4}>Thursday</option>
                  <option value={5}>Friday</option>
                  <option value={6}>Saturday</option>
                  <option value={7}>Sunday</option>
                </select>
              ) : null}
              <input value={draft.recipients} onChange={(e) => setDraft((p) => ({ ...p, recipients: e.target.value }))} className="w-full px-3 py-3 border rounded-xl text-sm" placeholder="Emails (comma-separated)" />

              <div className="grid grid-cols-2 gap-2">
                <select value={draft.format} onChange={(e) => setDraft((p) => ({ ...p, format: e.target.value }))} className="w-full px-3 py-3 border rounded-xl text-sm">
                  <option value="excel">Excel</option>
                  <option value="pdf">PDF</option>
                </select>
                <label className="flex items-center gap-2 text-sm px-3 py-3 border rounded-xl bg-white">
                  <input type="checkbox" checked={draft.include_photos} onChange={(e) => setDraft((p) => ({ ...p, include_photos: e.target.checked }))} />
                  Include photos
                </label>
              </div>

              <label className="flex items-center gap-2 text-sm px-3 py-3 border rounded-xl bg-white">
                <input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft((p) => ({ ...p, is_active: e.target.checked }))} />
                Active
              </label>

              <label className="flex items-center gap-2 text-sm px-3 py-3 border rounded-xl bg-white">
                <input
                  type="checkbox"
                  checked={draft.communities === 'all'}
                  onChange={(e) => setDraft((p) => ({ ...p, communities: e.target.checked ? 'all' : [] }))}
                />
                All communities
              </label>
              {draft.communities !== 'all' ? (
                <div className="space-y-1">
                  {(communities ?? []).map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={(draft.communities ?? []).includes(c.id)}
                        onChange={(e) =>
                          setDraft((p) => {
                            const next = Array.isArray(p.communities) ? [...p.communities] : []
                            if (e.target.checked) next.push(c.id)
                            else {
                              const idx = next.indexOf(c.id)
                              if (idx >= 0) next.splice(idx, 1)
                            }
                            return { ...p, communities: next }
                          })
                        }
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              ) : null}

              <PrimaryButton onClick={add} disabled={!draft.report_type || !draft.format} className="w-full">
                Save Scheduled Report
              </PrimaryButton>
            </div>
          </Card>
        ) : null}

        {list.length === 0 ? (
          <p className="text-sm text-gray-600">No scheduled reports yet.</p>
        ) : (
          <div className="space-y-2">
            {list.map((r) => (
              <div key={r.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900">
                      {String(r.report_type).replaceAll('_', ' ')} • {String(r.frequency)}
                    </p>
                    <p className="text-xs text-gray-600 mt-1">
                      {r.frequency === 'weekly' ? `DOW ${r.day_of_week} • ` : ''}{r.time} • {String(r.format).toUpperCase()} • Recipients: {(r.recipients ?? []).length}
                    </p>
                    <p className="text-xs text-gray-600 mt-1">Communities: {r.communities === 'all' ? 'All' : (r.communities ?? []).length}</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => updateEntry(r.id, { is_active: !r.is_active })}
                      className={`px-3 py-2 rounded-xl border text-sm font-semibold ${r.is_active ? 'bg-green-50 border-green-200 text-green-800' : 'bg-white border-gray-200 text-gray-700'}`}
                    >
                      {r.is_active ? 'Active' : 'Paused'}
                    </button>
                    <button onClick={() => onUpdate(list.filter((x) => x.id !== r.id))} className="px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm font-semibold">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

function NotificationPreferencesModal({ prefs, onClose, onSave }) {
  const [draft, setDraft] = useState(() => {
    return {
      user_id: prefs?.user_id ?? '',
      quiet_hours: prefs?.quiet_hours ?? { enabled: false, start: '22:00', end: '07:00', timezone: 'America/Chicago' },
      preferences: prefs?.preferences ?? {},
      always_notify_urgent: prefs?.always_notify_urgent ?? true,
    }
  })

  const types = useMemo(() => Object.keys(draft.preferences ?? {}).sort(), [draft.preferences])

  const setType = (type, patch) =>
    setDraft((p) => ({
      ...p,
      preferences: {
        ...(p.preferences ?? {}),
        [type]: { ...(p.preferences?.[type] ?? {}), ...patch },
      },
    }))

  return (
    <Modal
      title="Notification Preferences"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton onClick={() => onSave(draft)} className="flex-1">
            Save
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Quiet Hours</p>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Enabled</span>
            <input type="checkbox" checked={Boolean(draft.quiet_hours?.enabled)} onChange={(e) => setDraft((p) => ({ ...p, quiet_hours: { ...(p.quiet_hours ?? {}), enabled: e.target.checked } }))} />
          </label>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Start</span>
              <input value={draft.quiet_hours?.start ?? ''} onChange={(e) => setDraft((p) => ({ ...p, quiet_hours: { ...(p.quiet_hours ?? {}), start: e.target.value } }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm" placeholder="22:00" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">End</span>
              <input value={draft.quiet_hours?.end ?? ''} onChange={(e) => setDraft((p) => ({ ...p, quiet_hours: { ...(p.quiet_hours ?? {}), end: e.target.value } }))} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm" placeholder="07:00" />
            </label>
          </div>
          <p className="text-xs text-gray-500 mt-2">In-app notifications still appear; quiet hours primarily affect push/SMS/email in the full system.</p>
        </Card>

        <Card className="bg-gray-50">
          <label className="flex items-center justify-between gap-3 text-sm font-semibold">
            <span>Always notify urgent</span>
            <input type="checkbox" checked={Boolean(draft.always_notify_urgent)} onChange={(e) => setDraft((p) => ({ ...p, always_notify_urgent: e.target.checked }))} />
          </label>
        </Card>

        <Card className="bg-gray-50">
          <p className="text-sm font-semibold mb-2">Per-Type Settings</p>
          <div className="space-y-2">
            {types.map((t) => {
              const entry = draft.preferences?.[t] ?? {}
              const channels = entry.channels ?? {}
              return (
                <div key={t} className="bg-white border border-gray-200 rounded-xl p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-gray-900">{t.replaceAll('_', ' ')}</p>
                      <p className="text-xs text-gray-500">Frequency</p>
                    </div>
                    <label className="text-sm font-semibold flex items-center gap-2">
                      <input type="checkbox" checked={entry.enabled !== false} onChange={(e) => setType(t, { enabled: e.target.checked })} />
                      Enabled
                    </label>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    {['push', 'sms', 'email', 'in_app'].map((ch) => (
                      <label key={ch} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={channels?.[ch] !== false}
                          onChange={(e) => setType(t, { channels: { ...(channels ?? {}), [ch]: e.target.checked } })}
                        />
                        {ch.replaceAll('_', ' ')}
                      </label>
                    ))}
                  </div>

                  <select
                    value={entry.frequency ?? 'immediate'}
                    onChange={(e) => setType(t, { frequency: e.target.value })}
                    className="mt-2 w-full px-3 py-3 border rounded-xl text-sm"
                  >
                    <option value="immediate">Immediate</option>
                    <option value="hourly_digest">Hourly digest</option>
                    <option value="daily_digest">Daily digest</option>
                  </select>

                  {t === 'system_announcement' ? (
                    <p className="text-xs text-gray-500 mt-2">In this demo, only in-app delivery is simulated.</p>
                  ) : null}
                </div>
              )
            })}
          </div>
        </Card>
      </div>
    </Modal>
  )
}

function CommunityDocumentsModal({ community, isOnline, onClose, onUpload, onDelete }) {
  const platMaps = (community.documents ?? [])
    .filter((d) => d.type === 'plat_map')
    .slice()
    .sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)))

  const latest = platMaps[0] ?? null
  const latestBlobId = latest?.blob_id ?? null

  const [previewUrl, setPreviewUrl] = useState(null)

  useEffect(() => {
    let mounted = true
    let url = null
    const load = async () => {
      if (!latestBlobId) return
      try {
        const blob = await getBlob(latestBlobId)
        if (!blob || !mounted) return
        url = URL.createObjectURL(blob)
        setPreviewUrl(url)
      } catch (err) {
        console.error(err)
      }
    }
    load()
    return () => {
      mounted = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [latestBlobId])

  return (
    <Modal
      title={`Community Documents - ${community.name}`}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Close
          </SecondaryButton>
          <label
            className={`flex-1 h-12 inline-flex items-center justify-center rounded-xl text-white font-semibold cursor-pointer ${
              isOnline ? 'bg-blue-600' : 'bg-gray-400 cursor-not-allowed'
            }`}
            title={!isOnline ? 'Upload requires connection' : ''}
          >
            Upload Plat Map
            <input
              type="file"
              accept="application/pdf,image/*"
              className="hidden"
              disabled={!isOnline}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                await onUpload(file)
                e.target.value = ''
              }}
            />
          </label>
        </div>
      }
    >
      <div className="space-y-3">
        {!isOnline ? (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-sm text-orange-800">
            Offline — document upload is disabled. You can still view cached documents.
          </div>
        ) : null}

        {!latest ? (
          <p className="text-sm text-gray-600">No plat map uploaded yet.</p>
        ) : (
          <>
            <Card className="bg-gray-50">
              <p className="text-sm font-semibold">{latest.file_name}</p>
              <p className="text-xs text-gray-600 mt-1">
                Uploaded: {latest.uploaded_at ? new Date(latest.uploaded_at).toLocaleString() : '—'}
              </p>
              <div className="mt-2 flex gap-2">
                {previewUrl ? (
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                  >
                    Open
                  </a>
                ) : null}
                {previewUrl ? (
                  <a
                    href={previewUrl}
                    download={latest.file_name ?? 'plat-map'}
                    className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                  >
                    Download
                  </a>
                ) : null}
                <button
                  onClick={() => onDelete(latest)}
                  className="px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm font-semibold"
                >
                  Delete
                </button>
              </div>
            </Card>

            {previewUrl ? (
              latest.mime?.includes('pdf') ? (
                <iframe title="Plat map" src={previewUrl} className="w-full h-[60vh] rounded-xl border border-gray-200" />
              ) : (
                <img src={previewUrl} alt="Plat map" className="w-full rounded-xl border border-gray-200" />
              )
            ) : (
              <div className="bg-gray-100 rounded-xl p-6 text-center text-gray-600">Loading preview…</div>
            )}

            {platMaps.length > 1 ? (
              <Card>
                <p className="font-semibold mb-2">Version History</p>
                <div className="space-y-2">
                  {platMaps.slice(1, 6).map((d) => (
                    <div key={d.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                      <p className="text-sm font-semibold">{d.file_name}</p>
                      <p className="text-xs text-gray-600 mt-1">{new Date(d.uploaded_at).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  )
}

function SitePlanModal({ lot, isOnline, onClose, onUpload, onDelete }) {
  const sitePlans = (lot.documents ?? []).filter((d) => d.type === 'site_plan').slice().sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)))
  const latest = sitePlans[0] ?? null
  const latestBlobId = latest?.blob_id ?? null

  const [previewUrl, setPreviewUrl] = useState(null)
  const [uploadFile, setUploadFile] = useState(null)
  const [uploadName, setUploadName] = useState('')

  useEffect(() => {
    let mounted = true
    let url = null
    const load = async () => {
      if (!latestBlobId) return
      try {
        const blob = await getBlob(latestBlobId)
        if (!blob || !mounted) return
        url = URL.createObjectURL(blob)
        setPreviewUrl(url)
      } catch (err) {
        console.error(err)
      }
    }
    load()
    return () => {
      mounted = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [latestBlobId])

  return (
    <Modal
      title={`Site Plan - ${lotCode(lot)}`}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Close
          </SecondaryButton>
          <PrimaryButton
            onClick={async () => {
              if (!uploadFile || !isOnline) return
              await onUpload(uploadFile, uploadName)
              setUploadFile(null)
              setUploadName('')
            }}
            className="flex-1"
            disabled={!isOnline || !uploadFile}
            title={!isOnline ? 'Upload requires connection' : ''}
          >
            Upload New
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        {!isOnline ? (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-sm text-orange-800">
            Offline — document upload is disabled. You can still view cached documents.
          </div>
        ) : null}
        <Card className="bg-gray-50">
          <p className="font-semibold">Upload New</p>
          <div className="mt-2 space-y-2">
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">File</span>
              <label className={`mt-1 w-full h-11 inline-flex items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold ${!isOnline ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                <span className="truncate">{uploadFile ? uploadFile.name : 'Choose file'}</span>
                <span className="text-xs text-gray-500">Browse</span>
                <input
                  type="file"
                  accept="application/pdf,image/*"
                  className="hidden"
                  disabled={!isOnline}
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null
                    setUploadFile(file)
                    setUploadName(file?.name ?? '')
                    e.target.value = ''
                  }}
                />
              </label>
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">File name</span>
              <input
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                className="mt-1 w-full px-3 py-2 border rounded-lg text-sm"
                placeholder={uploadFile?.name ?? 'Site plan name'}
              />
            </label>
            <p className="text-[11px] text-gray-500">PDF or image • Max 50MB.</p>
          </div>
        </Card>
        {!latest ? (
          <p className="text-sm text-gray-600">No site plan uploaded yet.</p>
        ) : (
          <>
            <Card className="bg-gray-50">
              <p className="text-sm font-semibold">{latest.file_name}</p>
              <p className="text-xs text-gray-600 mt-1">
                Uploaded: {latest.uploaded_at ? new Date(latest.uploaded_at).toLocaleString() : '—'}
              </p>
              <div className="mt-2 flex gap-2">
                {previewUrl ? (
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                  >
                    Open
                  </a>
                ) : null}
                {previewUrl ? (
                  <a
                    href={previewUrl}
                    download={latest.file_name ?? 'site-plan'}
                    className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                  >
                    Download
                  </a>
                ) : null}
                <button
                  onClick={() => onDelete(latest)}
                  className="px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm font-semibold"
                >
                  Delete
                </button>
              </div>
            </Card>

            {previewUrl ? (
              latest.mime?.includes('pdf') ? (
                <iframe title="Site plan" src={previewUrl} className="w-full h-[60vh] rounded-xl border border-gray-200" />
              ) : (
                <img src={previewUrl} alt="Site plan" className="w-full rounded-xl border border-gray-200" />
              )
            ) : (
              <div className="bg-gray-100 rounded-xl p-6 text-center text-gray-600">Loading preview…</div>
            )}

            {sitePlans.length > 1 ? (
              <Card>
                <p className="font-semibold mb-2">Version History</p>
                <div className="space-y-2">
                  {sitePlans.slice(1, 6).map((d) => (
                    <div key={d.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                      <p className="text-sm font-semibold">{d.file_name}</p>
                      <p className="text-xs text-gray-600 mt-1">{new Date(d.uploaded_at).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  )
}

function LotFilesModal({ lot, isOnline, onClose, onAddFile, onRemoveFile }) {
  const files = (lot.documents ?? [])
    .filter((d) => d.type === 'lot_file')
    .slice()
    .sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)))

  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState(null)

  const canAdd = Boolean(file && label.trim())

  return (
    <Modal
      title={`Files - ${lotCode(lot)}`}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Close
          </SecondaryButton>
          <PrimaryButton
            onClick={async () => {
              if (!canAdd) return
              const added = await onAddFile?.({ label, description, file })
              if (added) {
                setLabel('')
                setDescription('')
                setFile(null)
              }
            }}
            className="flex-1"
            disabled={!canAdd}
          >
            Add File
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
        {!isOnline ? (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-sm text-orange-800">
            Offline — files save locally and sync when back online.
          </div>
        ) : null}

        <Card className="bg-gray-50">
          <p className="font-semibold">Upload New</p>
          <div className="mt-2 space-y-2">
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Label *</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="mt-1 w-full px-3 py-2 border rounded-lg text-sm"
                placeholder="Survey, permit, scope, warranty..."
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">Description</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1 w-full px-3 py-2 border rounded-lg text-sm"
                placeholder="Optional context"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">File</span>
              <label className="mt-1 w-full h-11 inline-flex items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold cursor-pointer">
                <span className="truncate">{file ? file.name : 'Choose file'}</span>
                <span className="text-xs text-gray-500">Browse</span>
                <input
                  type="file"
                  accept={FILE_ACCEPT}
                  onChange={(e) => {
                    const nextFile = e.target.files?.[0] ?? null
                    setFile(nextFile)
                    if (nextFile && !label.trim()) setLabel(nextFile.name ?? '')
                    e.target.value = ''
                  }}
                  className="hidden"
                />
              </label>
              <p className="text-[11px] text-gray-500 mt-1">CSV, Excel, Word, PDF, or images • Max 50MB.</p>
            </label>
          </div>
        </Card>

        <div>
          <p className="text-sm font-semibold mb-2">Attached Files</p>
          {files.length === 0 ? (
            <p className="text-sm text-gray-500">No files uploaded yet.</p>
          ) : (
            <div className="space-y-2">
              {files.map((doc) => (
                <div key={doc.id} className="bg-white border border-gray-200 rounded-xl p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 truncate">{doc.label || doc.file_name || 'File'}</p>
                      {doc.description ? <p className="text-xs text-gray-600 mt-1">{doc.description}</p> : null}
                      <p className="text-[11px] text-gray-500 mt-1">{doc.file_name}</p>
                    </div>
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() => openBlobInNewTab(doc.blob_id)}
                        className="px-2 py-1 rounded-lg border border-gray-200 bg-white text-xs font-semibold"
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveFile?.(doc.id)}
                        className="px-2 py-1 rounded-lg border border-red-200 bg-red-50 text-xs font-semibold text-red-700"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
