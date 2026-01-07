import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Building2,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudRain,
  DollarSign,
  Download,
  Image,
  LayoutGrid,
  Lock,
  MapPin,
  MessageSquare,
  Phone,
  Play,
  Plus,
  Sun,
  Upload,
  Users,
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
import { addCalendarDays, daysBetweenCalendar, formatISODate, formatLongDate, formatShortDate, makeWorkdayHelpers, parseISODate } from './lib/date.js'
import { fillTemplate } from './lib/templating.js'
import { clearAppState, loadAppState, saveAppState } from './lib/storage.js'
import { normalizeRange, toRangeString, validateAssignments } from './lib/utils.js'
import {
  applyDelayCascade,
  calculateLotProgress,
  calculateTargetCompletionDate,
  deriveTaskStatus,
  getCurrentMilestone,
  getPredictedCompletionDate,
  previewDelayImpact,
  startLotFromTemplate,
} from './lib/scheduleEngine.js'
import { deleteBlob, getBlob, putBlob } from './lib/idb.js'
import { uuid } from './lib/uuid.js'

const DALLAS = {
  name: 'Dallas, TX',
  latitude: 32.7767,
  longitude: -96.797,
  timezone: 'America/Chicago',
}

const EXTERIOR_TASK_LIBRARY = [
  { id: 'siding', name: 'Siding', trade: 'siding', duration: 5 },
  { id: 'brick', name: 'Exterior Brick/Stone', trade: 'siding', duration: 4 },
  { id: 'paint', name: 'Exterior Paint', trade: 'paint', duration: 3 },
  { id: 'gutters', name: 'Gutters', trade: 'gutters', duration: 1 },
  { id: 'flatwork', name: 'Concrete Flatwork', trade: 'concrete', duration: 3 },
  { id: 'landscaping', name: 'Landscaping', trade: 'landscaping', duration: 3 },
  { id: 'garage_door', name: 'Garage Door', trade: 'garage_door', duration: 1 },
  { id: 'custom', name: 'Custom', trade: 'other', duration: 1 },
]

const bySortOrder = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name ?? '').localeCompare(String(b.name ?? ''))

const buildReschedulePreview = ({ lot, task, targetDateIso, org }) => {
  const out = { affected: [], oldCompletion: null, newCompletion: null, dependency_violation: false, earliest_start: null, normalized_date: '' }
  if (!targetDateIso || !task?.scheduled_start) return out
  const { getNextWorkDay, addWorkDays, subtractWorkDays } = makeWorkdayHelpers(org)

  const normalizedDate = (() => {
    const next = getNextWorkDay(targetDateIso) ?? parseISODate(targetDateIso)
    return next ? formatISODate(next) : targetDateIso
  })()
  out.normalized_date = normalizedDate

  const durationMinus1 = Math.max(0, Number(task.duration ?? 0) - 1)
  let earliest = getNextWorkDay(task.scheduled_start) ?? parseISODate(task.scheduled_start)

  for (const dep of task.dependencies ?? []) {
    const pred = (lot.tasks ?? []).find((t) => t.id === dep.depends_on_task_id)
    if (!pred?.scheduled_start || !pred?.scheduled_end) continue
    const lag = Math.max(0, Number(dep.lag_days ?? 0) || 0)

    if (dep.type === 'FS') {
      const d = addWorkDays(pred.scheduled_end, 1 + lag)
      if (d && (!earliest || d > earliest)) earliest = d
    } else if (dep.type === 'SS') {
      const d = addWorkDays(pred.scheduled_start, lag)
      if (d && (!earliest || d > earliest)) earliest = d
    } else if (dep.type === 'FF') {
      const requiredEnd = addWorkDays(pred.scheduled_end, lag)
      const d = requiredEnd ? subtractWorkDays(requiredEnd, durationMinus1) : null
      if (d && (!earliest || d > earliest)) earliest = d
    } else if (dep.type === 'SF') {
      const requiredEnd = addWorkDays(pred.scheduled_start, lag)
      const d = requiredEnd ? subtractWorkDays(requiredEnd, durationMinus1) : null
      if (d && (!earliest || d > earliest)) earliest = d
    }
  }

  const earliestStart = earliest ? formatISODate(getNextWorkDay(earliest) ?? earliest) : null
  out.earliest_start = earliestStart
  if (earliestStart && parseISODate(normalizedDate) && parseISODate(earliestStart) && parseISODate(normalizedDate) < parseISODate(earliestStart)) {
    out.dependency_violation = true
    return out
  }

  const workdayDiff = (fromIso, toIso) => {
    const from = parseISODate(fromIso)
    const to = parseISODate(toIso)
    if (!from || !to) return 0
    if (to.getTime() === from.getTime()) return 0

    let cursor = fromIso
    let delta = 0
    const limit = 4000

    if (to > from) {
      while (cursor !== toIso && delta < limit) {
        cursor = formatISODate(addWorkDays(cursor, 1))
        delta += 1
      }
      return delta
    }

    while (cursor !== toIso && delta > -limit) {
      cursor = formatISODate(subtractWorkDays(cursor, 1))
      delta -= 1
    }
    return delta
  }

  const shiftDays = workdayDiff(task.scheduled_start, normalizedDate)
  const tasks = (lot.tasks ?? []).slice().sort(bySortOrder)

  const oldCompletion = (() => {
    let max = null
    for (const t of tasks) {
      const d = parseISODate(t.scheduled_end)
      if (!d) continue
      if (!max || d > max) max = d
    }
    return max ? formatISODate(max) : null
  })()
  out.oldCompletion = oldCompletion

  if (shiftDays === 0) {
    out.newCompletion = oldCompletion
    return out
  }

  const shiftIso = (iso, delta) => {
    if (!iso || !delta) return iso
    if (delta > 0) return formatISODate(addWorkDays(iso, delta))
    return formatISODate(subtractWorkDays(iso, Math.abs(delta)))
  }

  const movedTrack = task.track
  const movedSort = task.sort_order ?? 0
  const byId = new Map()
  const affected = []

  for (const t of tasks) {
    if (!t?.scheduled_start || !t?.scheduled_end) continue
    if (t.status === 'complete') continue
    const isAfter = (t.sort_order ?? 0) > movedSort
    const shouldShift =
      t.id === task.id ||
      (t.track === movedTrack && isAfter) ||
      (t.dependencies ?? []).some((d) => d.depends_on_task_id === task.id)

    if (!shouldShift) continue

    const newStart = shiftIso(t.scheduled_start, shiftDays)
    const newEnd = shiftIso(t.scheduled_end, shiftDays)
    byId.set(t.id, { start: newStart, end: newEnd })
    affected.push({
      task_id: t.id,
      task_name: t.name,
      old_start: t.scheduled_start,
      new_start: newStart,
      old_end: t.scheduled_end,
      new_end: newEnd,
      track: t.track,
    })
  }

  const maxEndFor = (filterFn) => {
    let max = null
    for (const t of tasks) {
      if (!filterFn(t)) continue
      const endIso = byId.get(t.id)?.end ?? t.scheduled_end
      if (!endIso) continue
      const d = parseISODate(endIso)
      if (!d) continue
      if (!max || d > max) max = d
    }
    return max
  }

  const blockingEnd = maxEndFor((t) => t.track !== 'final' && t.blocks_final !== false)
  const finalStart = blockingEnd ? addWorkDays(formatISODate(blockingEnd), 1) : null

  if (finalStart) {
    let cursor = finalStart
    const finalTasks = tasks.filter((t) => t.track === 'final').sort(bySortOrder)
    for (const ft of finalTasks) {
      if (ft.status === 'complete') {
        const end = parseISODate(ft.scheduled_end)
        if (end && cursor && end >= cursor) cursor = addWorkDays(end, 1)
        continue
      }
      const startIso = formatISODate(cursor)
      const endDate = addWorkDays(cursor, Math.max(0, Number(ft.duration ?? 0) - 1))
      const endIso = endDate ? formatISODate(endDate) : ft.scheduled_end

      const prevStart = byId.get(ft.id)?.start ?? ft.scheduled_start
      const prevEnd = byId.get(ft.id)?.end ?? ft.scheduled_end
      byId.set(ft.id, { start: startIso, end: endIso })

      if (prevStart !== startIso || prevEnd !== endIso) {
        const existing = affected.find((a) => a.task_id === ft.id)
        if (existing) {
          existing.new_start = startIso
          existing.new_end = endIso
        } else {
          affected.push({
            task_id: ft.id,
            task_name: ft.name,
            old_start: ft.scheduled_start,
            new_start: startIso,
            old_end: ft.scheduled_end,
            new_end: endIso,
            track: ft.track,
          })
        }
      }

      cursor = endDate ? addWorkDays(endDate, 1) : cursor
    }
  }

  out.affected = affected.slice().sort((a, b) => (a.task_id === task.id ? -1 : 0) || String(a.old_start).localeCompare(String(b.old_start)))

  const newCompletion = (() => {
    let max = null
    for (const t of tasks) {
      const endIso = byId.get(t.id)?.end ?? t.scheduled_end
      const d = parseISODate(endIso)
      if (!d) continue
      if (!max || d > max) max = d
    }
    return max ? formatISODate(max) : null
  })()
  out.newCompletion = newCompletion

  return out
}

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

function Modal({ title, onClose, children, footer }) {
  useEffect(() => lockBodyScroll(), [])

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center">
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
  ready: { label: '▶ Ready', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  blocked: { label: '🔒 Blocked', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  pending: { label: '○ Pending', cls: 'bg-gray-50 text-gray-600 border-gray-200' },
}

const TASK_STATUS_COLORS = {
  complete: '#22C55E',
  in_progress: '#3B82F6',
  delayed: '#EF4444',
  blocked: '#F97316',
  ready: '#8B5CF6',
  pending: '#D1D5DB',
}

const TaskStatusBadge = ({ status }) => {
  const entry = STATUS_BADGE[status] ?? STATUS_BADGE.pending
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

const buildSmsLink = (phone) => {
  const normalized = normalizePhone(phone)
  return normalized ? `sms:${normalized}` : ''
}

const buildMailtoLink = (email) => {
  const address = String(email ?? '').trim()
  return address ? `mailto:${address}` : ''
}

const openExternalLink = (href, onClose) => {
  if (!href || typeof window === 'undefined') return
  if (onClose) onClose()
  window.location.href = href
}

const BottomNav = ({ value, onChange }) => {
  const items = [
    { id: 'dashboard', label: 'Home', icon: LayoutGrid },
    { id: 'calendar', label: 'Calendar', icon: Calendar },
    { id: 'communities', label: 'Communities', icon: MapPin },
    { id: 'sales', label: 'Sales', icon: DollarSign },
    { id: 'subs', label: 'Subs', icon: Users },
    { id: 'reports', label: 'Reports', icon: BarChart3 },
    { id: 'admin', label: 'Admin', icon: Lock },
  ]

  return (
    <div className="bottom-nav border-t flex justify-around py-2 safe-area-pb">
      {items.map((item) => {
        const Icon = item.icon
        const active = value === item.id
        return (
          <button
            key={item.id}
            onClick={() => onChange(item.id)}
            className={`flex flex-col items-center px-3 py-2 rounded-xl ${active ? 'text-blue-600' : 'text-gray-500'}`}
          >
            <Icon className="w-5 h-5" />
            <span className="text-xs mt-1">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export default function BuildFlow() {
  const [app, setApp] = useState(() => loadAppState(createSeedState()))
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
  const [delayModal, setDelayModal] = useState(null)
  const [rescheduleModal, setRescheduleModal] = useState(null)
  const [addExteriorTaskModal, setAddExteriorTaskModal] = useState(null)
  const [scheduleInspectionModal, setScheduleInspectionModal] = useState(null)
  const [inspectionResultModal, setInspectionResultModal] = useState(null)
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
  const [communityDocsCommunityId, setCommunityDocsCommunityId] = useState(null)
  const [communityContactsModalId, setCommunityContactsModalId] = useState(null)
  const [reportModal, setReportModal] = useState(false)
  const [scheduledReportModal, setScheduledReportModal] = useState(false)
  const [subContactModalId, setSubContactModalId] = useState(null)

  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true))
  const [weather, setWeather] = useState({ loading: true, forecast: [] })
  const [calendarView, setCalendarView] = useState('day')
  const [calendarDate, setCalendarDate] = useState(() => formatISODate(new Date()))
  const [draggingCalendarTask, setDraggingCalendarTask] = useState(null)
  const [calendarDropTarget, setCalendarDropTarget] = useState(null)
  const [calendarFilters, setCalendarFilters] = useState(() => ({
    communityId: 'all',
    trade: 'all',
    subId: 'all',
    showInspections: true,
    showDelayed: true,
    showMilestones: true,
  }))

  useEffect(() => {
    saveAppState(app)
  }, [app])

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

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const loadWeather = async () => {
      setWeather((prev) => ({ ...prev, loading: true }))
      try {
        const url = new URL('https://api.open-meteo.com/v1/forecast')
        url.searchParams.set('latitude', String(DALLAS.latitude))
        url.searchParams.set('longitude', String(DALLAS.longitude))
        url.searchParams.set('timezone', DALLAS.timezone)
        url.searchParams.set('temperature_unit', 'fahrenheit')
        url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode,wind_speed_10m_max')

        const res = await fetch(url.toString(), { signal: controller.signal })
        if (!res.ok) throw new Error(`Weather request failed: ${res.status}`)
        const json = await res.json()
        const forecast = build7DayForecast(json?.daily)
        if (!cancelled) setWeather({ loading: false, forecast })
      } catch (err) {
        if (!cancelled && err?.name !== 'AbortError') {
          console.error(err)
          setWeather((prev) => ({ ...prev, loading: false }))
        }
      }
    }

    if (isOnline) loadWeather()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [isOnline])

  const org = app.org
  const communities = app.communities ?? []
  const productTypes = app.product_types ?? []
  const plans = app.plans ?? []
  const agencies = app.agencies ?? []
  const templates = app.templates ?? []
  const { businessDaysBetweenInclusive, getNextWorkDay, addWorkDays, subtractWorkDays } = makeWorkdayHelpers(org)
  const todayIso = formatISODate(new Date())

  const communitiesById = useMemo(() => new Map(app.communities.map((c) => [c.id, c])), [app.communities])
  const lotsById = useMemo(() => new Map(app.lots.map((l) => [l.id, l])), [app.lots])
  const productTypesById = useMemo(() => new Map(productTypes.map((pt) => [pt.id, pt])), [productTypes])

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

  const pendingSyncOps = app.sync?.pending ?? []
  const pendingSyncCount = pendingSyncOps.length
  const lastSyncedAt = app.sync?.last_synced_at ?? null

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

    setApp((prev) => ({
      ...prev,
      sync: {
        ...(prev.sync ?? {}),
        pending: [...((prev.sync ?? {}).pending ?? []), op],
      },
    }))

    return op.id
  }

  const syncNow = () => {
    if (!isOnline) return
    setApp((prev) => {
      const now = new Date().toISOString()
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
          ...(prev.sync ?? {}),
          pending: [],
          last_synced_at: now,
        },
      }
    })
  }

  const resetDemo = () => {
    clearAppState()
    setApp(createSeedState())
    setTab('dashboard')
    setSelectedCommunityId(null)
    setSelectedLotId(null)
    setLotDetailTab('overview')
  }

  const navigateRoot = (nextTab) => {
    setTab(nextTab)
    setSelectedCommunityId(null)
    setSelectedLotId(null)
    setLotDetailTab('overview')
  }

  const updateLot = (lotId, updater) => {
    setApp((prev) => {
      const nextLots = prev.lots.map((l) => (l.id === lotId ? updater(l, prev) : l))
      return { ...prev, lots: nextLots }
    })
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
    updateLot(lotId, (lot) => {
      const now = new Date().toISOString()
      return {
        ...lot,
        tasks: (lot.tasks ?? []).map((t) => {
          if (t.id !== taskId) return t
          return {
            ...t,
            status: 'in_progress',
            actual_start: t.actual_start ?? todayIso,
            updated_at: now,
          }
        }),
      }
    })
    if (!isOnline) {
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
      const updatedTasks = (lotSnapshot.tasks ?? []).map((t) => {
        if (t.id !== taskId) return t
        return {
          ...t,
          status: 'complete',
          actual_start: t.actual_start ?? todayIso,
          actual_end: todayIso,
          updated_at: now,
        }
      })
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

    updateLot(lotId, (lot) => {
      const now = new Date().toISOString()
      const updatedTasks = (lot.tasks ?? []).map((t) => {
        if (t.id !== taskId) return t
        return {
          ...t,
          status: 'complete',
          actual_start: t.actual_start ?? todayIso,
          actual_end: todayIso,
          updated_at: now,
        }
      })

      const maybeCompleted = updatedTasks.find((t) => t.id === taskId)
      const nextPunch = !lot.punch_list && maybeCompleted?.name === 'Final Clean' ? createPunchListFromTemplate(now) : lot.punch_list
      const lotStatus = maybeCompleted?.name === 'Punch Complete' ? 'complete' : lot.status

      return {
        ...lot,
        status: lotStatus,
        actual_completion_date: lotStatus === 'complete' ? todayIso : lot.actual_completion_date ?? null,
        tasks: updatedTasks,
        punch_list: nextPunch,
      }
    })
    if (!isOnline) {
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
        return {
          ...t,
          status: 'blocked',
          inspection_id: inspectionId,
          actual_end: t.actual_end ?? todayIso,
          updated_at: now,
        }
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
    const lotSnapshot = lotsById.get(lotId) ?? null
    if (lotSnapshot && resultPayload?.result === 'pass') {
      const before = getCurrentMilestone(lotSnapshot)
      const now = new Date().toISOString()
      const inspections = (lotSnapshot.inspections ?? []).map((i) => {
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

      const inspection = inspections.find((i) => i.id === inspectionId)
      const tasks = (lotSnapshot.tasks ?? []).map((t) => {
        if (!inspection || t.id !== inspection.task_id) return t
        return { ...t, status: 'complete', updated_at: now }
      })

      const inspectedTask = inspection ? tasks.find((t) => t.id === inspection.task_id) ?? null : null
      const nextPunch =
        resultPayload.result === 'pass' && !lotSnapshot.punch_list && inspectedTask?.name === 'Final Clean'
          ? createPunchListFromTemplate(now)
          : lotSnapshot.punch_list
      const nextStatus = resultPayload.result === 'pass' && inspectedTask?.name === 'Punch Complete' ? 'complete' : lotSnapshot.status

      const nextLotSnapshot = {
        ...lotSnapshot,
        status: nextStatus,
        actual_completion_date: nextStatus === 'complete' ? todayIso : lotSnapshot.actual_completion_date ?? null,
        inspections,
        tasks,
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

      const inspection = inspections.find((i) => i.id === inspectionId)
      const tasks = (lot.tasks ?? []).map((t) => {
        if (!inspection || t.id !== inspection.task_id) return t
        if (resultPayload.result !== 'pass') {
          return { ...t, status: 'blocked', updated_at: now }
        }
        return { ...t, status: 'complete', updated_at: now }
      })

      const inspectedTask = inspection ? tasks.find((t) => t.id === inspection.task_id) ?? null : null
      const nextPunch =
        resultPayload.result === 'pass' && !lot.punch_list && inspectedTask?.name === 'Final Clean'
          ? createPunchListFromTemplate(now)
          : lot.punch_list
      const nextStatus = resultPayload.result === 'pass' && inspectedTask?.name === 'Punch Complete' ? 'complete' : lot.status

      return {
        ...lot,
        status: nextStatus,
        actual_completion_date: nextStatus === 'complete' ? todayIso : lot.actual_completion_date ?? null,
        inspections,
        tasks,
        punch_list: nextPunch,
      }
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
      synced: isOnline,
      sync_error: null,
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

    if (!isOnline) {
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

  const allocateChangeOrderNumber = () => {
    const year = new Date().getFullYear()
    const nextSeq = (app.counters?.change_orders ?? 0) + 1
    setApp((prev) => ({
      ...prev,
      counters: { ...(prev.counters ?? {}), change_orders: nextSeq },
    }))
    return `CO-${year}-${String(nextSeq).padStart(3, '0')}`
  }

  const openLot = (lotId) => {
    setSelectedLotId(lotId)
    setLotDetailTab('overview')
    setTab('communities')
  }

  const lotHasDelay = (lot) => (lot?.tasks ?? []).some((t) => t.status === 'delayed')

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
          predicted ?? '',
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
        ['Subcontractor', 'Trade', 'Rating', 'On-Time %', 'Delay Count', 'Total Jobs', 'Capacity', 'Insurance Expiration', 'Status'],
        ...app.subcontractors.map((s) => [
          s.company_name,
          TRADES.find((t) => t.id === s.trade)?.label ?? s.trade,
          s.rating ?? '',
          s.on_time_pct ?? '',
          s.delay_count ?? '',
          s.total_jobs ?? '',
          s.max_concurrent_lots ?? '',
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
            return [community?.name ?? '', lotCode(l), milestone?.label ?? '', pct, l.target_completion_date ?? '', predicted ?? '', delayed ? 'YES' : 'NO']
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
        const doc = new jsPDF({ unit: 'pt', format: 'letter' })
        const pageWidth = doc.internal.pageSize.getWidth()
        let y = 40
        doc.setFontSize(16)
        doc.text(title, 40, y)
        y += 18
        doc.setFontSize(10)
        doc.text(`Date range: ${fromIso} to ${toIso}`, 40, y)
        y += 14
        doc.text(`Generated: ${new Date().toLocaleString()}`, 40, y)
        y += 20

        doc.setFontSize(10)
        const sheet = sheets[0]
        doc.text(String(sheet.name ?? 'Report'), 40, y)
        y += 14

        const rows = sheet.rows ?? []
        const maxRows = Math.min(rows.length, 26)
        for (let i = 0; i < maxRows; i++) {
          const line = (rows[i] ?? []).map((c) => String(c ?? '')).join('  |  ')
          const wrapped = doc.splitTextToSize(line, pageWidth - 80)
          for (const w of wrapped) {
            if (y > 740) {
              doc.addPage()
              y = 40
            }
            doc.text(w, 40, y)
            y += 12
          }
        }

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

  const upcomingInspections = useMemo(() => {
    const list = []
    for (const lot of app.lots ?? []) {
      for (const inspection of lot.inspections ?? []) {
        if (!inspection?.scheduled_date) continue
        if (inspection.result) continue
        if (inspection.scheduled_date < todayIso) continue
        const community = communitiesById.get(lot.community_id) ?? null
        list.push({ lot, community, inspection })
      }
    }
    return list.sort((a, b) => String(a.inspection.scheduled_date).localeCompare(String(b.inspection.scheduled_date)))
  }, [app.lots, communitiesById, todayIso])

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

  const pendingInspections = useMemo(() => {
    let count = 0
    for (const lot of app.lots ?? []) {
      for (const inspection of lot.inspections ?? []) {
        if (!inspection?.result) count += 1
      }
    }
    return count
  }, [app.lots])

  const delayedLots = useMemo(() => activeLots.filter((l) => lotHasDelay(l)), [activeLots])

  const openPunchItems = useMemo(() => {
    let count = 0
    for (const lot of app.lots ?? []) {
      for (const item of lot.punch_list?.items ?? []) {
        if (item.status !== 'closed' && item.status !== 'verified') count += 1
      }
    }
    return count
  }, [app.lots])

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

  const subConflicts = useMemo(() => {
    const out = []
    const subsById = new Map((app.subcontractors ?? []).map((s) => [s.id, s]))
    const start = todayIso
    if (!start) return out

    const byKey = new Map()
    const dates = []
    for (let i = 0; i < 14; i++) {
      const d = addCalendarDays(start, i)
      if (!d) continue
      dates.push(formatISODate(d))
    }

    for (const dateIso of dates) {
      for (const lot of activeLots) {
        const community = communitiesById.get(lot.community_id) ?? null
        for (const task of lot.tasks ?? []) {
          if (!task.sub_id) continue
          if (task.status === 'complete') continue
          if (!taskInRange(task, dateIso)) continue
          const key = `${task.sub_id}::${dateIso}`
          const entry = byKey.get(key) ?? { sub_id: task.sub_id, date: dateIso, lots: new Map() }
          entry.lots.set(lot.id, { lot, community, task })
          byKey.set(key, entry)
        }
      }
    }

    for (const entry of byKey.values()) {
      const sub = subsById.get(entry.sub_id) ?? null
      const capacity = Math.max(1, Number(sub?.max_concurrent_lots ?? 1) || 1)
      const booked = entry.lots.size
      if (booked <= capacity) continue
      out.push({
        sub,
        date: entry.date,
        booked,
        capacity,
        jobs: Array.from(entry.lots.values()).slice(0, 6),
      })
    }

    return out.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || (b.booked - b.capacity) - (a.booked - a.capacity))
  }, [app.subcontractors, activeLots, communitiesById, todayIso, taskInRange])

  const matchesCalendarFilters = (lot, task, status) => {
    if (calendarFilters.communityId !== 'all' && lot.community_id !== calendarFilters.communityId) return false
    if (calendarFilters.trade !== 'all' && task.trade !== calendarFilters.trade) return false
    if (calendarFilters.subId !== 'all' && task.sub_id !== calendarFilters.subId) return false
    if (!calendarFilters.showDelayed && status === 'delayed') return false
    return true
  }

  const getEarliestStartIso = (lot, task) => {
    if (!task?.scheduled_start) return null
    const durationMinus1 = Math.max(0, Number(task.duration ?? 0) - 1)
    let earliest = getNextWorkDay(task.scheduled_start) ?? parseISODate(task.scheduled_start)

    for (const dep of task.dependencies ?? []) {
      const pred = (lot.tasks ?? []).find((t) => t.id === dep.depends_on_task_id)
      if (!pred?.scheduled_start || !pred?.scheduled_end) continue
      const lag = Math.max(0, Number(dep.lag_days ?? 0) || 0)

      if (dep.type === 'FS') {
        const d = addWorkDays(pred.scheduled_end, 1 + lag)
        if (d && (!earliest || d > earliest)) earliest = d
      } else if (dep.type === 'SS') {
        const d = addWorkDays(pred.scheduled_start, lag)
        if (d && (!earliest || d > earliest)) earliest = d
      } else if (dep.type === 'FF') {
        const requiredEnd = addWorkDays(pred.scheduled_end, lag)
        const d = requiredEnd ? subtractWorkDays(requiredEnd, durationMinus1) : null
        if (d && (!earliest || d > earliest)) earliest = d
      } else if (dep.type === 'SF') {
        const requiredEnd = addWorkDays(pred.scheduled_start, lag)
        const d = requiredEnd ? subtractWorkDays(requiredEnd, durationMinus1) : null
        if (d && (!earliest || d > earliest)) earliest = d
      }
    }

    const normalized = earliest ? formatISODate(getNextWorkDay(earliest) ?? earliest) : null
    return normalized
  }

  const getSubConflictPreview = ({ subId, dateIso, movingLotId }) => {
    if (!subId || !dateIso) return { conflict: false, booked: 0, capacity: 0 }
    const sub = (app.subcontractors ?? []).find((s) => s.id === subId) ?? null
    const capacity = Math.max(1, Number(sub?.max_concurrent_lots ?? 1) || 1)
    const lotIds = new Set()

    for (const lot of activeLots) {
      for (const t of lot.tasks ?? []) {
        if (t.status === 'complete') continue
        if (t.sub_id !== subId) continue
        if (!taskInRange(t, dateIso)) continue
        lotIds.add(lot.id)
      }
    }

    const bookedAfter = lotIds.size + (lotIds.has(movingLotId) ? 0 : 1)
    return { conflict: bookedAfter > capacity, booked: bookedAfter, capacity }
  }

  const getCalendarDropStatus = ({ lot, task, targetDateIso }) => {
    if (!lot || !task || !targetDateIso) return { status: 'invalid', normalized: '', earliest: null, conflict: null }
    const normalized = formatISODate(getNextWorkDay(targetDateIso) ?? parseISODate(targetDateIso)) || targetDateIso
    const earliest = getEarliestStartIso(lot, task)
    const violation = earliest && parseISODate(normalized) && parseISODate(earliest) && parseISODate(normalized) < parseISODate(earliest)
    if (violation) return { status: 'invalid', normalized, earliest, conflict: null }
    const conflict = task.sub_id ? getSubConflictPreview({ subId: task.sub_id, dateIso: normalized, movingLotId: lot.id }) : null
    if (conflict?.conflict) return { status: 'conflict', normalized, earliest, conflict }
    return { status: 'valid', normalized, earliest, conflict }
  }

  const applyReschedule = ({ lot, task, targetDateIso, reason, notifySubs, preview }) => {
    if (!lot || !task) return { status: 'invalid' }
    const computed = preview ?? buildReschedulePreview({ lot, task, targetDateIso, org })
    const normalizedDate = computed.normalized_date || ''
    if (!normalizedDate) return { status: 'invalid' }
    if (computed.dependency_violation) return { status: 'invalid', earliest: computed.earliest_start }

    const hasShift = (computed.affected ?? []).some((a) => a.old_start !== a.new_start || a.old_end !== a.new_end)
    if (!hasShift) return { status: 'noop', newStartDate: normalizedDate, preview: computed }

    const affectedById = new Map((computed.affected ?? []).map((a) => [a.task_id, a]))
    const community = communitiesById.get(lot.community_id) ?? null
    const impacted = (computed.affected ?? []).filter((a) => a.old_start !== a.new_start)

    updateLot(lot.id, (current) => {
      const now = new Date().toISOString()
      const nextTasks = (current.tasks ?? []).map((t) => {
        const hit = affectedById.get(t.id)
        if (!hit) return t
        return { ...t, scheduled_start: hit.new_start, scheduled_end: hit.new_end, updated_at: now }
      })
      const currentTask = (current.tasks ?? []).find((t) => t.id === task.id) ?? task
      return {
        ...current,
        tasks: nextTasks,
        schedule_changes: [
          ...(current.schedule_changes ?? []),
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
    })

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

  const calendarInspectionsForDate = (dateIso) => {
    if (!calendarFilters.showInspections) return []
    const out = []
    for (const lot of activeLots) {
      for (const inspection of lot.inspections ?? []) {
        if (!inspection?.scheduled_date) continue
        if (inspection.scheduled_date !== dateIso) continue
        const task = lot.tasks?.find((t) => t.id === inspection.task_id) ?? null
        const community = communitiesById.get(lot.community_id) ?? null
        out.push({ lot, community, inspection, task })
      }
    }
    return out
  }

  const headerTitle = selectedLot
    ? `${selectedCommunity ? selectedCommunity.name : 'Lot'} ${lotCode(selectedLot)}`
    : selectedCommunity
      ? selectedCommunity.name
      : 'BuildFlow'

  const adminSections = [
    { id: 'product_types', label: 'Product Types', description: 'Define categories, build days, and templates.', count: productTypes.length },
    { id: 'plans', label: 'Plans', description: 'Attach floor plans to product types.', count: plans.length },
    { id: 'agencies', label: 'Agencies', description: 'Configure inspection agencies and types.', count: agencies.length },
    { id: 'custom_fields', label: 'Custom Fields', description: 'Extra fields for lot start and reporting.', count: (org.custom_fields ?? []).length },
  ]

  const [communityWizardStep, setCommunityWizardStep] = useState(1)
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

  const closeStartLot = () => {
    setStartLotPrefill(null)
    setShowStartLot(false)
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
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
          {(!isOnline || pendingSyncCount > 0) && (
            <button
              onClick={() => setShowOfflineStatus(true)}
              className="px-2 py-1 rounded-lg bg-white/15 text-xs flex items-center gap-1"
              title={!isOnline ? 'Offline mode' : 'Pending sync items'}
            >
              <WifiOff className="w-4 h-4" />
              {!isOnline ? 'Offline' : 'Sync'}
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
            <div className="bg-gradient-to-r from-sky-400 to-blue-500 rounded-2xl p-4 text-white">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm opacity-90">7-Day Forecast</p>
                  <p className="text-2xl font-bold">
                    {weather.forecast?.[0]?.max ?? '--'}°F
                  </p>
                  <p className="text-xs opacity-75">{DALLAS.name}</p>
                </div>
                <Sun className="w-12 h-12 opacity-90" />
              </div>
              <div className="flex justify-between">
                {(weather.forecast ?? []).map((d) => (
                  <div key={d.date} className="text-center">
                    <p className="text-xs opacity-75">{d.label}</p>
                    <d.icon className={`w-5 h-5 mx-auto my-1 ${d.rainChance > 50 ? 'text-yellow-200' : ''}`} />
                    <p className="text-xs font-medium">{d.max ?? '--'}°</p>
                    {d.rainChance > 50 ? <p className="text-xs text-yellow-200">☔ {d.rainChance}%</p> : null}
                  </div>
                ))}
              </div>

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
              <div className="bg-white rounded-xl p-3 border text-center">
                <p className="text-xl font-bold text-blue-600">{activeLots.length}</p>
                <p className="text-xs text-gray-500">Active</p>
              </div>
              <div className="bg-white rounded-xl p-3 border text-center">
                <p className="text-xl font-bold text-green-600">
                  {activeLots.filter((l) => !lotHasDelay(l)).length}
                </p>
                <p className="text-xs text-gray-500">On Track</p>
              </div>
              <div className="bg-white rounded-xl p-3 border text-center">
                <p className="text-xl font-bold text-red-600">
                  {activeLots.filter((l) => lotHasDelay(l)).length}
                </p>
                <p className="text-xs text-gray-500">Delayed</p>
              </div>
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

            {subConflicts.length > 0 ? (
              <Card>
                <h3 className="font-semibold mb-3">⚠️ Sub Conflicts Detected</h3>
                <div className="space-y-2">
                  {subConflicts.slice(0, 2).map((c) => (
                    <div key={`${c.sub?.id ?? ''}-${c.date}`} className="bg-gray-50 rounded-xl border border-gray-200 p-3">
                      <p className="font-semibold text-gray-900">{c.sub?.company_name ?? 'Sub'}</p>
                      <p className="text-xs text-gray-600 mt-1">
                        {formatShortDate(c.date)} • Max capacity: {c.capacity} | Booked: {c.booked}
                      </p>
                      <div className="mt-2 space-y-1 text-xs text-gray-700">
                        {c.jobs.map((j) => (
                          <p key={j.lot.id}>
                            • {j.community?.name ?? ''} {lotCode(j.lot)} ({j.task.name})
                          </p>
                        ))}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => {
                            const first = c.jobs[0]
                            if (!first) return
                            setTab('calendar')
                            setCalendarView('day')
                            setCalendarDate(c.date)
                            setRescheduleModal({ lot_id: first.lot.id, task_id: first.task.id, initial_date: c.date })
                          }}
                          className="flex-1 h-10 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                        >
                          Resolve
                        </button>
                      </div>
                    </div>
                  ))}
                  {subConflicts.length > 2 ? <p className="text-xs text-gray-500">+ {subConflicts.length - 2} more conflicts</p> : null}
                </div>
              </Card>
            ) : null}

            <Card>
              <h3 className="font-semibold mb-3">On Site Today</h3>
              {todaysAssignments.length === 0 ? (
                <p className="text-sm text-gray-500">No active assignments today.</p>
              ) : (
                <div className="space-y-2">
                  {todaysAssignments.slice(0, 6).map(({ lot, task, status, sub }) => (
                    <button
                      key={`${lot.id}-${task.id}`}
                      onClick={() => openLot(lot.id)}
                      className="w-full bg-gray-50 rounded-xl p-3 text-left"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-gray-900">{sub?.company_name ?? 'Unassigned'}</p>
                          <p className="text-xs text-gray-600">
                            {lotCode(lot)} • {task.name}
                          </p>
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
              <h3 className="font-semibold mb-3">Upcoming Inspections</h3>
              {upcomingInspections.length === 0 ? (
                <p className="text-sm text-gray-500">No upcoming inspections.</p>
              ) : (
                <div className="space-y-2">
                  {upcomingInspections.slice(0, 5).map(({ lot, community, inspection }) => (
                    <button
                      key={inspection.id}
                      onClick={() => openLot(lot.id)}
                      className="w-full p-3 bg-gray-50 rounded-xl text-left"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          {INSPECTION_TYPES.find((t) => t.code === inspection.type)?.label ?? inspection.type}
                        </span>
                        <span className="text-xs text-gray-600">{formatShortDate(inspection.scheduled_date)}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">{community?.name ?? ''} • {lotCode(lot)}</p>
                    </button>
                  ))}
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
              <h3 className="font-semibold mb-3">At a Glance</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-4 bg-blue-50 rounded-xl text-center">
                  <p className="text-2xl font-bold text-blue-600">{todaysTasks.length}</p>
                  <p className="text-xs text-gray-600">Tasks Today</p>
                </div>
                <div className="p-4 bg-orange-50 rounded-xl text-center">
                  <p className="text-2xl font-bold text-orange-600">{pendingInspections}</p>
                  <p className="text-xs text-gray-600">Pending Inspections</p>
                </div>
                <div className="p-4 bg-red-50 rounded-xl text-center">
                  <p className="text-2xl font-bold text-red-600">{delayedLots.length}</p>
                  <p className="text-xs text-gray-600">Delayed Lots</p>
                </div>
                <div className="p-4 bg-purple-50 rounded-xl text-center">
                  <p className="text-2xl font-bold text-purple-600">{openPunchItems}</p>
                  <p className="text-xs text-gray-600">Open Punch Items</p>
                </div>
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
                  <p className="text-xs text-gray-500">{DALLAS.name}</p>
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

              <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={calendarFilters.showInspections}
                    onChange={(e) => setCalendarFilters((p) => ({ ...p, showInspections: e.target.checked }))}
                  />
                  Inspections
                </label>
                <label className="inline-flex items-center gap-2">
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
              const inspections = calendarInspectionsForDate(calendarDate)
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
                            onClick={() => setTaskModal({ lot_id: lot.id, task_id: task.id })}
                            className="w-full bg-gray-50 rounded-xl p-3 text-left"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="font-semibold">{sub?.company_name ?? 'Unassigned'}</p>
                                <p className="text-xs text-gray-600">
                                  {lotCode(lot)} • {task.name}
                                </p>
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
                  </Card>

                  {calendarFilters.showInspections ? (
                    <Card>
                      <h3 className="font-semibold mb-3">Inspections</h3>
                      {inspections.length === 0 ? (
                        <p className="text-sm text-gray-500">No inspections scheduled.</p>
                      ) : (
                        <div className="space-y-2">
                          {inspections.map(({ lot, community, inspection, task }) => (
                            <button
                              key={inspection.id}
                              onClick={() => setInspectionResultModal({ lot_id: lot.id, inspection_id: inspection.id })}
                              className="w-full bg-gray-50 rounded-xl border border-gray-200 p-3 text-left"
                            >
                              <p className="font-semibold">
                                {INSPECTION_TYPES.find((t) => t.code === inspection.type)?.label ?? inspection.type}{' '}
                                • {community?.name ?? ''} {lotCode(lot)}
                              </p>
                              <p className="text-xs text-gray-600 mt-1">
                                {inspection.scheduled_time ? `${inspection.scheduled_time} • ` : ''}
                                {task?.name ?? ''}
                              </p>
                            </button>
                          ))}
                        </div>
                      )}
                    </Card>
                  ) : null}
                </>
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
                            : drop?.status === 'conflict'
                              ? 'bg-yellow-100/70'
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
                                  alert(`Dependency violation. Earliest allowed start is ${formatShortDate(status.earliest)}.`)
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
                    const inspections = calendarInspectionsForDate(iso)
                    if (calendarView === 'sub' && calendarFilters.subId === 'all') return null
                    const drop = calendarDropTarget?.date === iso ? calendarDropTarget : null
                    const dropCls =
                      drop?.status === 'invalid'
                        ? 'bg-red-50 border-red-200'
                        : drop?.status === 'conflict'
                          ? 'bg-yellow-50 border-yellow-200'
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
                            alert(`Dependency violation. Earliest allowed start is ${formatShortDate(status.earliest)}.`)
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
                        {assignments.length === 0 && inspections.length === 0 ? (
                          <p className="text-sm text-gray-500">No scheduled work.</p>
                        ) : (
                          <div className="space-y-2">
                            {assignments.map(({ lot, community, task, sub, status }) => (
                              <button
                                key={`${lot.id}-${task.id}`}
                                onClick={() => setTaskModal({ lot_id: lot.id, task_id: task.id })}
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
                                    <p className="text-xs text-gray-600">
                                      {community?.name ?? ''} {lotCode(lot)} • {task.name}
                                    </p>
                                  </div>
                                  <TaskStatusBadge status={status} />
                                </div>
                              </button>
                            ))}
                            {calendarFilters.showInspections
                              ? inspections.map(({ lot, community, inspection }) => (
                                  <button
                                    key={inspection.id}
                                    onClick={() => setInspectionResultModal({ lot_id: lot.id, inspection_id: inspection.id })}
                                    className="w-full bg-white rounded-xl border border-gray-200 p-3 text-left"
                                  >
                                    <p className="font-semibold">
                                      🔍 {INSPECTION_TYPES.find((t) => t.code === inspection.type)?.label ?? inspection.type} •{' '}
                                      {community?.name ?? ''} {lotCode(lot)}
                                    </p>
                                    <p className="text-xs text-gray-600 mt-1">
                                      {inspection.scheduled_time ? `${inspection.scheduled_time}` : 'Scheduled'}
                                    </p>
                                  </button>
                                ))
                              : null}
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
                    const workCount = calendarAssignmentsForDate(iso).length
                    const inspCount = calendarInspectionsForDate(iso).length
                    return (
                      <button
                        key={iso}
                        onClick={() => {
                          setCalendarDate(iso)
                          setCalendarView('day')
                        }}
                        className={`aspect-square rounded-xl border text-left p-2 ${inMonth ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-100 text-gray-400'}`}
                        title={offset === 0 ? 'Month start' : ''}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold">{d ? d.getDate() : ''}</span>
                          {(workCount + inspCount) > 0 ? (
                            <span className="text-[10px] font-semibold text-blue-700">{workCount + inspCount}</span>
                          ) : null}
                        </div>
                        {(workCount + inspCount) > 0 ? (
                          <div className="mt-2 flex gap-1">
                            {workCount > 0 ? <span className="w-2 h-2 rounded-full bg-blue-500" /> : null}
                            {inspCount > 0 ? <span className="w-2 h-2 rounded-full bg-orange-500" /> : null}
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
                      const lots = app.lots.filter((l) => l.community_id === selectedCommunity.id && l.block === b.label)
                      return (
                        <div key={b.id}>
                          <p className="text-sm font-semibold text-gray-700 mb-2">Block {b.label}</p>
                          <div className="grid grid-cols-6 gap-2">
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
                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/80 text-gray-700 border border-white/60">
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
                    <div className="grid grid-cols-6 gap-2">
                      {app.lots
                        .filter((l) => l.community_id === selectedCommunity.id)
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
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/80 text-gray-700 border border-white/60">
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
                    .sort((a, b) => (a.block || '').localeCompare(b.block || '') || Number(a.lot_number) - Number(b.lot_number))
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
                    const lots = app.lots.filter((l) => l.community_id === selectedCommunity.id && l.status === col.key)
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
                </div>
                {selectedLot.status === 'not_started' ? (
                  <button
                    onClick={() => openStartLot(selectedLot.id)}
                    className="bg-green-600 text-white px-3 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                    disabled={!isOnline}
                    title={!isOnline ? 'Requires connection to generate schedules' : ''}
                  >
                    Start Lot
                  </button>
                ) : null}
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
                        { label: 'Add Photos', onClick: () => setPhotoTimelineLotId(selectedLot.id) },
                        { label: 'Daily Log', onClick: () => setDailyLogLotId(selectedLot.id) },
                        { label: 'Inspections', onClick: () => setInspectionsLotId(selectedLot.id) },
                        { label: 'Punch List', onClick: () => setPunchListLotId(selectedLot.id) },
                        { label: 'Site Plan', onClick: () => setSitePlanLotId(selectedLot.id) },
                        { label: 'Materials', onClick: () => setMaterialsLotId(selectedLot.id) },
                        { label: 'Change Orders', onClick: () => setChangeOrdersLotId(selectedLot.id) },
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
                                  {sub?.company_name ?? 'Unassigned'} • {formatShortDate(task.scheduled_start)} - {formatShortDate(task.scheduled_end)}
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
                        onClick={() => setPhotoCaptureModal({ lot_id: selectedLot.id, task_id: null, source: 'camera' })}
                        className="flex-1 py-3 bg-blue-50 text-blue-700 rounded-xl font-medium border border-blue-200"
                      >
                        📷 Take Photo
                      </button>
                      <button
                        onClick={() => setPhotoCaptureModal({ lot_id: selectedLot.id, task_id: null, source: 'library' })}
                        className="flex-1 py-3 bg-gray-50 text-gray-700 rounded-xl font-medium border border-gray-200"
                      >
                        📁 Upload
                      </button>
                    </div>

                    {(selectedLot.photos ?? []).length === 0 ? (
                      <p className="text-sm text-gray-500">No photos yet.</p>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        {(selectedLot.photos ?? []).map((p) => (
                          <div key={p.id} className="bg-gray-50 border border-gray-200 rounded-xl p-2">
                            <PhotoThumb blobId={p.blob_id} alt={p.caption || 'Photo'} />
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
                      <div className="flex gap-2">
                        <button
                          onClick={() => setAddExteriorTaskModal({ lot_id: selectedLot.id })}
                          className="px-3 py-2 rounded-xl bg-blue-50 border border-blue-200 text-sm font-semibold text-blue-700"
                        >
                          <Plus className="w-4 h-4 inline mr-1" />
                          Exterior Task
                        </button>
                        <button
                          onClick={() => exportLotScheduleCsv(selectedLot)}
                          className="px-3 py-2 rounded-xl bg-white border border-gray-200 text-sm font-semibold"
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
                          onRescheduleTask={({ task, targetDateIso, preview }) => {
                            if (!selectedLot || !task) return
                            const outcome = applyReschedule({ lot: selectedLot, task, targetDateIso, preview })
                            if (outcome.status === 'invalid') {
                              alert(`Dependency violation. Earliest allowed start is ${formatShortDate(outcome.earliest)}.`)
                            }
                          }}
                        />
                      </div>
                    ) : (
                      ['foundation', 'structure', 'interior', 'exterior', 'final'].map((track) => {
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
                                  : 'Final'
                        return (
                          <div key={track}>
                            <p className="text-sm font-semibold text-gray-800 mb-2">{title}</p>
                            <div className="space-y-2">
                              {tasks.map((task) => {
                                const status = deriveTaskStatus(task, selectedLot.tasks, selectedLot.inspections)
                                const sub = app.subcontractors.find((s) => s.id === task.sub_id) ?? null
                                return (
                                  <button
                                    key={task.id}
                                    onClick={() => setTaskModal({ lot_id: selectedLot.id, task_id: task.id })}
                                    className="w-full bg-gray-50 rounded-xl p-3 border border-gray-200 text-left"
                                  >
                                    <div className="flex items-center justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="font-semibold truncate">{task.name}</p>
                                        <p className="text-xs text-gray-600">
                                          {formatShortDate(task.scheduled_start)} - {formatShortDate(task.scheduled_end)} • {task.duration}d
                                        </p>
                                        <p className="text-xs text-gray-600">{sub?.company_name ?? 'Unassigned'}</p>
                                      </div>
                                      <TaskStatusBadge status={status} />
                                    </div>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })
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
              <h3 className="font-semibold mb-3">Subcontractors</h3>
              <div className="space-y-2">
                {app.subcontractors.map((sub) => (
                  <div key={sub.id} className="bg-gray-50 rounded-xl border border-gray-200 p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-semibold">{sub.company_name}</p>
                        <p className="text-xs text-gray-600 mt-1">
                          Trade: {TRADES.find((t) => t.id === sub.trade)?.label ?? sub.trade} • Capacity: {sub.max_concurrent_lots}
                        </p>
                      </div>
                      <div className="text-sm font-semibold bg-yellow-50 border border-yellow-200 text-yellow-800 px-2 py-1 rounded-lg">
                        ★ {sub.rating}
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <a
                        href={`tel:${sub.primary_contact.phone}`}
                        className="text-sm text-blue-600 inline-flex items-center gap-1"
                      >
                        <Phone className="w-4 h-4" />
                        {sub.primary_contact.phone}
                      </a>
                      <button
                        onClick={() => setSubContactModalId(sub.id)}
                        className="text-sm font-semibold px-3 py-2 rounded-xl border border-gray-200 bg-white"
                      >
                        Message
                      </button>
                    </div>
                  </div>
                ))}
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
                    Manage product types, plans, agencies, and custom fields used across BuildFlow.
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
                    <div className="flex items-start justify-between gap-3">
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
                        className="h-10"
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
                  <label className={`block ${!isOnline ? 'opacity-50' : ''}`}>
                    <span className="text-sm font-semibold">Upload Plat Map</span>
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
                      className="mt-1 w-full"
                    />
                  </label>

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
                  <button
                    onClick={() => setCommunityDraft((d) => ({ ...d, realtors: [...(d.realtors ?? []), createDraftRealtor()] }))}
                    className="text-sm font-semibold px-3 py-1 rounded-xl border border-gray-200 bg-white"
                  >
                    + Add
                  </button>
                </div>
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
                              realtors: (d.realtors ?? []).map((x) => (x.id === r.id ? { ...x, phone: e.target.value } : x)),
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
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold">City Inspectors</p>
                  <button
                    onClick={() => setCommunityDraft((d) => ({ ...d, inspectors: [...(d.inspectors ?? []), createDraftInspector()] }))}
                    className="text-sm font-semibold px-3 py-1 rounded-xl border border-gray-200 bg-white"
                  >
                    + Add
                  </button>
                </div>
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
                              inspectors: (d.inspectors ?? []).map((x) => (x.id === i.id ? { ...x, phone: e.target.value } : x)),
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
                <p className="font-semibold mb-2">Agencies</p>
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
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold">Builders / Superintendents</p>
                  <button
                    onClick={() =>
                      setCommunityDraft((d) => ({
                        ...d,
                        builders: [...(d.builders ?? []), createDraftBuilder((d.builders ?? []).length)],
                      }))
                    }
                    className="text-sm font-semibold px-3 py-1 rounded-xl border border-gray-200 bg-white"
                  >
                    + Add
                  </button>
                </div>
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
                                builders: (d.builders ?? []).map((x) => (x.id === b.id ? { ...x, phone: e.target.value } : x)),
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
          onStart={({ lotId, form }) => {
            setApp((prev) => {
              const existingLots = prev.lots
              let startedLot = null
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
                  existingLots,
                })
                startedLot = next
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
            setSelectedCommunityId(lotsById.get(lotId)?.community_id ?? null)
            setSelectedLotId(lotId)
            setLotDetailTab('schedule')
            setTab('communities')
            closeStartLot()
          }}
        />
      )}

      {taskModal && (() => {
        const lot = lotsById.get(taskModal.lot_id) ?? null
        const task = lot?.tasks?.find((t) => t.id === taskModal.task_id) ?? null
        if (!lot || !task) return null
        const community = communitiesById.get(lot.community_id) ?? null
        const status = deriveTaskStatus(task, lot.tasks, lot.inspections)
        const sub = app.subcontractors.find((s) => s.id === task.sub_id) ?? null
        return (
          <TaskModal
            lot={lot}
            community={community}
            task={task}
            status={status}
            sub={sub}
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
            onRequestComplete={() => {
              if (task.requires_inspection) {
                setScheduleInspectionModal({ lot_id: lot.id, task_id: task.id })
                return
              }
              completeTaskDirect(lot.id, task.id)
            }}
            onDelay={() => setDelayModal({ lot_id: lot.id, task_id: task.id })}
            onReschedule={() => setRescheduleModal({ lot_id: lot.id, task_id: task.id })}
            onAddPhoto={() => setPhotoCaptureModal({ lot_id: lot.id, task_id: task.id })}
            onOpenInspection={() => {
              const inspectionId = task.inspection_id
              if (inspectionId) setInspectionResultModal({ lot_id: lot.id, inspection_id: inspectionId })
              else setScheduleInspectionModal({ lot_id: lot.id, task_id: task.id })
            }}
            onMessage={() => setMessageModal({ lot_id: lot.id, task_id: task.id, sub_id: sub?.id ?? null })}
          />
        )
      })()}

      {addExteriorTaskModal && (() => {
        const lot = lotsById.get(addExteriorTaskModal.lot_id) ?? null
        if (!lot) return null
        return (
          <AddExteriorTaskModal
            lot={lot}
            org={org}
            subcontractors={app.subcontractors ?? []}
            onClose={() => setAddExteriorTaskModal(null)}
            onSave={(task) => {
              updateLot(lot.id, (current) => ({
                ...current,
                tasks: [...(current.tasks ?? []), task],
              }))
              setAddExteriorTaskModal(null)
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
              const preview = previewDelayImpact(lot, task.id, days, org)
              const affected = (preview.affected ?? []).filter((a) => a.old_start !== a.new_start)

              updateLot(lot.id, (current) => applyDelayCascade(current, task.id, days, reason, notes, org))
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
            onApply={({ newStartDate, reason, notifySubs, preview }) => {
              applyReschedule({ lot, task, targetDateIso: newStartDate, reason, notifySubs, preview })
              setRescheduleModal(null)
            }}
          />
        )
      })()}

      {scheduleInspectionModal && (() => {
        const lot = lotsById.get(scheduleInspectionModal.lot_id) ?? null
        const task = lot?.tasks?.find((t) => t.id === scheduleInspectionModal.task_id) ?? null
        if (!lot || !task) return null
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
              const inspectionId = scheduleInspectionForTask(lot.id, task.id, {
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
        if (!lot || !inspection || !task) return null
        const community = communitiesById.get(lot.community_id) ?? null
        return (
          <InspectionResultModal
            lot={lot}
            task={task}
            inspection={inspection}
            subcontractors={app.subcontractors}
            isOnline={isOnline}
            onClose={() => setInspectionResultModal(null)}
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

      {photoTimelineLotId && (() => {
        const lot = lotsById.get(photoTimelineLotId) ?? null
        if (!lot) return null
        return (
          <PhotoTimelineModal
            lot={lot}
            onClose={() => setPhotoTimelineLotId(null)}
            onTakePhoto={() => setPhotoCaptureModal({ lot_id: lot.id, task_id: null })}
          />
        )
      })()}

      {inspectionsLotId && (() => {
        const lot = lotsById.get(inspectionsLotId) ?? null
        const community = lot ? communitiesById.get(lot.community_id) ?? null : null
        if (!lot) return null
        return (
          <InspectionsModal
            lot={lot}
            community={community}
            onClose={() => setInspectionsLotId(null)}
            onOpenInspection={(inspectionId) => setInspectionResultModal({ lot_id: lot.id, inspection_id: inspectionId })}
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
            subcontractors={app.subcontractors}
            onClose={() => setPunchListLotId(null)}
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
            onMessageSub={(subId) => setMessageModal({ lot_id: lot.id, task_id: null, sub_id: subId })}
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
              updateLot(lot.id, (current) => {
                if (!taskId || !daysAdded) return current
                const preview = previewDelayImpact(current, taskId, Math.max(1, Number(daysAdded) || 1), org)
                const now = new Date().toISOString()
                const nextTasks = (current.tasks ?? []).map((t) => {
                  const hit = (preview.affected ?? []).find((a) => a.task_id === t.id)
                  if (!hit) return t
                  return { ...t, scheduled_start: hit.new_start, scheduled_end: hit.new_end, updated_at: now }
                })
                return {
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
            onUpload={async (file) => {
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
                file_name: file.name,
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

      {subContactModalId && (() => {
        const sub = (app.subcontractors ?? []).find((s) => s.id === subContactModalId) ?? null
        if (!sub) return null
        return <SubContactModal sub={sub} onClose={() => setSubContactModalId(null)} />
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

function OfflineStatusModal({ isOnline, pending, lastSyncedAt, onClose, onSyncNow }) {
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

  return (
    <Modal
      title={isOnline ? 'Sync Status' : '📴 You\u2019re Offline'}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Close
          </SecondaryButton>
          <PrimaryButton onClick={onSyncNow} className="flex-1" disabled={!isOnline || pendingCount === 0}>
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
          Last synced:{' '}
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

  const targetCompletion = form.start_date ? calculateTargetCompletionDate(form.start_date, buildDays, org) : null

  const canStart = Boolean(resolvedLotId && form.start_date)

  return (
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
            onClick={() => onStart({ lotId: resolvedLotId, form })}
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
            Target Completion:{' '}
            <span className="font-semibold">{targetCompletion ? formatShortDate(targetCompletion) : '—'}</span>
          </p>
          <p className="text-xs text-gray-600 mt-1">
            {template?.tasks?.length ?? 0} tasks • {INSPECTION_TYPES.length} inspections
          </p>
        </Card>
      </div>
    </Modal>
  )
}

function TaskModal({
  lot,
  community,
  task,
  status,
  sub,
  isOnline,
  specAcknowledgements,
  specDismissals,
  onToggleSpecAck,
  onDismissSpec,
  onClose,
  onStart,
  onRequestComplete,
  onDelay,
  onReschedule,
  onAddPhoto,
  onOpenInspection,
  onMessage,
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
                Scheduled: {formatShortDate(task.scheduled_start)} - {formatShortDate(task.scheduled_end)} • {task.duration}d
              </p>
              <p className="text-xs text-gray-600 mt-1">
                Sub: {sub?.company_name ?? 'Unassigned'}
              </p>
            </div>
            <TaskStatusBadge status={status} />
          </div>
        </Card>

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
          <button
            onClick={onOpenInspection}
            disabled={!task.requires_inspection && !task.inspection_id}
            className="h-12 rounded-xl bg-white border border-gray-200 text-gray-900 font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <Lock className="w-5 h-5" /> Inspection
          </button>
        </div>

        <div className="flex gap-2">
          {status === 'ready' ? (
            <PrimaryButton onClick={onStart} className="flex-1 bg-green-600">
              Start Task
            </PrimaryButton>
          ) : null}
          {status === 'in_progress' ? (
            <PrimaryButton onClick={onRequestComplete} className="flex-1" disabled={!canComplete}>
              {task.requires_inspection ? (
                <>
                  <Check className="w-4 h-4 inline mr-1" /> Complete & Schedule Inspection
                </>
              ) : (
                <>
                  <Check className="w-4 h-4 inline mr-1" /> Mark Complete
                </>
              )}
            </PrimaryButton>
          ) : null}
          {status === 'blocked' && task.inspection_id ? (
            <PrimaryButton onClick={onOpenInspection} className="flex-1 bg-orange-600">
              Enter Inspection Result
            </PrimaryButton>
          ) : null}
        </div>

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

function AddExteriorTaskModal({ lot, org, subcontractors, onClose, onSave }) {
  const presets = EXTERIOR_TASK_LIBRARY
  const defaultPreset = presets[0] ?? { id: 'custom', name: 'Custom', trade: 'other', duration: 1 }
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
      title="Add Exterior Task"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() => {
              if (!canSave) return
              const maxSort = Math.max(0, ...(lot.tasks ?? []).map((t) => Number(t.sort_order ?? 0) || 0))
              const now = new Date().toISOString()
              onSave?.({
                id: uuid(),
                lot_id: lot.id,
                name: draft.name.trim(),
                description: null,
                trade: draft.trade,
                phase: 'exterior',
                track: 'exterior',
                sub_id: effectiveSubId || null,
                duration: durationValue,
                scheduled_start: normalizedStart,
                scheduled_end: endDate,
                actual_start: null,
                actual_end: null,
                dependencies: [],
                status: 'pending',
                delay_days: 0,
                delay_reason: null,
                delay_notes: null,
                delay_logged_at: null,
                delay_logged_by: null,
                requires_inspection: false,
                inspection_type: null,
                inspection_id: null,
                is_outdoor: true,
                is_critical_path: false,
                blocks_final: false,
                lead_time_days: 0,
                photos: [],
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
            {lotCode(lot)} • Exterior work is scheduled ad hoc
          </p>
        </Card>

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
  const canApply = Boolean(normalizedDate) && !preview.dependency_violation && task.status !== 'complete'
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

        {preview.dependency_violation ? (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">
            Dependency violation — earliest allowed start is {formatShortDate(preview.earliest_start)}.
          </div>
        ) : null}

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
  const defaultType = initialType ?? task.inspection_type ?? 'RME'
  const [type, setType] = useState(defaultType)
  const [scheduledDate, setScheduledDate] = useState(task.scheduled_end ?? '')
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
          <p className="text-xs text-gray-600 mt-1">Triggered by: {task.name}</p>
        </Card>

        <label className="block">
          <span className="text-sm font-semibold">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 w-full px-3 py-3 border rounded-xl">
            {INSPECTION_TYPES.map((t) => (
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
            onChange={(e) => setInspector((prev) => ({ ...prev, phone: e.target.value }))}
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

function InspectionResultModal({ lot, task, inspection, subcontractors, isOnline, onClose, onSave, onAddInspectionPhoto }) {
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
            {lotCode(lot)} • {task.name}
          </p>
          <p className="text-xs text-gray-600 mt-1">
            Scheduled: {formatShortDate(inspection.scheduled_date)} {inspection.scheduled_time ? `• ${inspection.scheduled_time}` : ''}
          </p>
          {inspection.parent_inspection_id ? <p className="text-xs text-gray-600 mt-1">Re-inspection</p> : null}
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

  return (
    <Modal
      title="📷 Take Photo"
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

function PhotoThumb({ blobId, alt }) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    let mounted = true
    let nextUrl = null
    const load = async () => {
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

function PhotoTimelineModal({ lot, onClose, onTakePhoto }) {
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
              <div className="grid grid-cols-4 gap-2">
                {photos.map((p) => (
                  <div key={p.id} className="text-center">
                    <PhotoThumb blobId={p.blob_id} alt={p.caption || 'Photo'} />
                    <p className="text-[10px] text-gray-600 mt-1 truncate">
                      {PHOTO_CATEGORIES.find((c) => c.id === p.category)?.label ?? p.category}
                    </p>
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
  if (tasks.length === 0) {
    return <p className="text-sm text-gray-500">No scheduled tasks yet.</p>
  }

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

  const { isWorkDay, getNextWorkDay } = makeWorkdayHelpers(org)
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

  const visibleTasks = useWorkWeek
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

  const clearDragState = () => {
    const state = dragStateRef.current
    if (state.timer) clearTimeout(state.timer)
    state.active = false
    state.pointerId = null
    state.timer = null
    state.taskId = null
    state.rowRect = null
    state.pointerType = ''
    setDraggingTaskId(null)
    setDragTargetIso(null)
    setDragStatus(null)
  }

  const updateDragTarget = (task, clientX, rowRect) => {
    if (!useWorkWeek || !rowRect?.width || weekDayIsos.length === 0) return
    const ratio = (clientX - rowRect.left) / rowRect.width
    const clamped = Math.max(0, Math.min(1, ratio))
    const index = Math.max(0, Math.min(weekDayIsos.length - 1, Math.floor(clamped * weekDayIsos.length)))
    const iso = weekDayIsos[index]
    if (!iso) return
    if (dragTargetIso === iso && dragStatus?.taskId === task.id) return
    const preview = buildReschedulePreview({ lot, task, targetDateIso: iso, org })
    const status = preview.dependency_violation ? 'invalid' : 'valid'
    setDragTargetIso(iso)
    setDragStatus({ status, preview, taskId: task.id })
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

    const targetEl = e.currentTarget
    const pointerId = e.pointerId
    const delay = e.pointerType === 'touch' ? 240 : 120
    state.timer = setTimeout(() => {
      state.timer = null
      state.active = true
      setDraggingTaskId(task.id)
      updateDragTarget(task, state.lastX, rowRect)
      if (targetEl?.setPointerCapture) {
        try {
          targetEl.setPointerCapture(pointerId)
        } catch {}
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
        if (e.currentTarget?.setPointerCapture && state.pointerId !== null) {
          try {
            e.currentTarget.setPointerCapture(state.pointerId)
          } catch {}
        }
      } else if (state.pointerType === 'touch' && (dx > 8 || dy > 8)) {
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
      }
      return
    }

    e.preventDefault()
    updateDragTarget(task, state.lastX, state.rowRect)
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
      if (preview.dependency_violation) {
        alert(`Dependency violation. Earliest allowed start is ${formatShortDate(preview.earliest_start)}.`)
      } else {
        onRescheduleTask?.({ task, targetDateIso: dropIso, preview })
      }
    }

    if (state.pointerId !== null && e.currentTarget?.releasePointerCapture) {
      try {
        e.currentTarget.releasePointerCapture(state.pointerId)
      } catch {}
    }

    clearDragState()
  }

  const handleTaskPointerCancel = () => {
    clearDragState()
  }

  useEffect(() => {
    if (!useWorkWeek) clearDragState()
  }, [useWorkWeek])

  return (
    <div className="overflow-x-auto border rounded-xl">
      {useWorkWeek ? (
        <div className="flex items-center justify-between gap-3 border-b bg-white px-3 py-2">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Work Week</p>
            <p className="text-sm font-semibold">{weekLabel}</p>
            {onRescheduleTask ? <p className="text-[11px] text-gray-500">Long-press a task to drag.</p> : null}
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
        <div className="flex border-b bg-gray-50 sticky top-0">
          <div className="shrink-0 p-3 font-semibold border-r" style={{ width: taskColWidth, minWidth: taskColWidth }}>
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
            const startWork = isWorkDay(startDate) ? startDate : getNextWorkDay(startDate)
            const endWork = isWorkDay(endDate) ? endDate : getPrevWorkDay(endDate)
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
            <div key={task.id} className="flex border-b hover:bg-gray-50">
              <div className="shrink-0 p-2 border-r" style={{ width: taskColWidth, minWidth: taskColWidth }}>
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
  const blockedTasks = (lot.tasks ?? []).filter((t) => t.requires_inspection && t.status === 'blocked' && !t.inspection_id)

  return (
    <Modal title="🔍 Inspections" onClose={onClose}>
      <div className="space-y-4">
        <Card className="bg-gray-50">
          <p className="text-sm text-gray-600">
            {community?.name ?? 'Community'} • {lotCode(lot)}
          </p>
          <p className="text-xs text-gray-600 mt-1">Tap an inspection to enter results.</p>
        </Card>

        {blockedTasks.length > 0 ? (
          <Card className="border-orange-200 bg-orange-50">
            <p className="font-semibold text-orange-800 mb-2">Needs Scheduling</p>
            <div className="space-y-2">
              {blockedTasks.slice(0, 6).map((t) => (
                <button
                  key={t.id}
                  onClick={() => onScheduleInspectionForTask(t.id)}
                  className="w-full bg-white border border-orange-200 rounded-xl p-3 text-left"
                >
                  <p className="font-semibold">{t.inspection_type ?? 'Inspection'} • {t.name}</p>
                  <p className="text-xs text-gray-600 mt-1">Schedule inspection</p>
                </button>
              ))}
            </div>
          </Card>
        ) : null}

        <Card>
          <p className="font-semibold mb-2">All Inspections</p>
          {inspections.length === 0 ? (
            <p className="text-sm text-gray-600">No inspections yet.</p>
          ) : (
            <div className="space-y-2">
              {inspections
                .slice()
                .sort((a, b) => String(b.scheduled_date).localeCompare(String(a.scheduled_date)))
                .map((i) => {
                  const label = INSPECTION_TYPES.find((t) => t.code === i.type)?.label ?? i.type
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
                            {formatShortDate(i.scheduled_date)} {i.scheduled_time ? `• ${i.scheduled_time}` : ''}
                          </p>
                        </div>
                        <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-lg border ${badge.cls}`}>
                          {i.result ? i.result.toUpperCase() : 'SCHEDULED'}
                        </span>
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

function CommunityContactsModal({ community, agencies, onClose, onSave }) {
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
                      builders: (d.builders ?? []).map((x) => (x.id === b.id ? { ...x, phone: e.target.value } : x)),
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
                      realtors: (d.realtors ?? []).map((x) => (x.id === r.id ? { ...x, phone: e.target.value } : x)),
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
                      inspectors: (d.inspectors ?? []).map((x) => (x.id === i.id ? { ...x, phone: e.target.value } : x)),
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
            onClick={() => openExternalLink(sms, onClose)}
            disabled={!sms}
            className={`h-12 px-4 rounded-xl border font-semibold ${sms ? 'bg-white text-gray-900 border-gray-200' : 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'}`}
          >
            Text (SMS)
          </button>
        </div>
      </div>
    </Modal>
  )
}

function PunchListModal({ lot, subcontractors, onClose, onUpdate, onAddPunchPhoto, onMessageSub, onNotifyAssignment }) {
  const punch = lot.punch_list ?? null
  const [draftPunchId] = useState(() => uuid())
  const [draftCreatedAt] = useState(() => new Date().toISOString())
  const basePunch = punch ?? { id: draftPunchId, created_at: draftCreatedAt, items: [] }

  const items = basePunch?.items ?? []
  const done = items.filter((i) => i.status === 'closed' || i.status === 'verified').length
  const total = items.length

  const [filterCategory, setFilterCategory] = useState('all')
  const [filterTrade, setFilterTrade] = useState('all')
  const [expanded, setExpanded] = useState(() => new Set())
  const [adding, setAdding] = useState(false)

  const visible = items.filter((i) => {
    if (filterCategory !== 'all' && i.category !== filterCategory) return false
    if (filterTrade !== 'all' && i.trade !== filterTrade) return false
    return true
  })

  const categories = Array.from(new Set(visible.map((i) => i.category)))

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
            <PrimaryButton onClick={() => setAdding(true)} className="flex-1">
              + Add Punch Item
            </PrimaryButton>
          </div>
        }
      >
        <div className="space-y-3">
          {!punch ? (
            <Card className="border-orange-200 bg-orange-50">
              <p className="font-semibold text-orange-800">Punch list not generated yet</p>
              <p className="text-sm text-orange-800 mt-1">
                Per spec, it auto-generates when the lot reaches <span className="font-semibold">Final Clean</span>. You can also generate it now.
              </p>
              <div className="mt-3">
                <button
                  onClick={() => {
                    const now = new Date().toISOString()
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
                    onUpdate({
                      id: basePunch.id,
                      created_at: basePunch.created_at,
                      items: PUNCH_TEMPLATE.map((entry) => ({
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
                    })
                  }}
                  className="w-full h-11 rounded-xl bg-orange-600 text-white font-semibold"
                >
                  Generate From Template
                </button>
              </div>
            </Card>
          ) : null}

          <Card className="bg-gray-50">
            <p className="text-sm font-semibold">Progress: {total ? `${done}/${total} (${Math.round((done / total) * 100)}%)` : '—'}</p>
            <div className="mt-2 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full bg-green-500" style={{ width: total ? `${(done / total) * 100}%` : '0%' }} />
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-2">
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="px-3 py-3 border rounded-xl text-sm"
            >
              <option value="all">All Categories</option>
              {Array.from(new Set(items.map((i) => i.category))).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select value={filterTrade} onChange={(e) => setFilterTrade(e.target.value)} className="px-3 py-3 border rounded-xl text-sm">
              <option value="all">All Trades</option>
              {TRADES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {categories.length === 0 ? (
            <p className="text-sm text-gray-600">No punch items yet.</p>
          ) : (
            categories.map((cat) => {
              const remaining = visible.filter((i) => i.category === cat && i.status !== 'closed').length
              const isOpen = expanded.has(cat)
              return (
                <div key={cat} className="bg-white border border-gray-200 rounded-xl">
                  <button
                    onClick={() => {
                      setExpanded((prev) => {
                        const next = new Set(prev)
                        if (next.has(cat)) next.delete(cat)
                        else next.add(cat)
                        return next
                      })
                    }}
                    className="w-full p-3 flex items-center justify-between"
                  >
                    <p className="font-semibold text-gray-900">
                      {cat} <span className="text-gray-500 text-sm">({remaining} remaining)</span>
                    </p>
                    <span className="text-gray-500">{isOpen ? '▲' : '▼'}</span>
                  </button>
                  {isOpen ? (
                    <div className="px-3 pb-3 space-y-2">
                      {visible
                        .filter((i) => i.category === cat)
                        .map((item) => (
                          <div key={item.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                            <p className="font-semibold text-gray-900">{item.description}</p>
                            <p className="text-xs text-gray-600 mt-1">📍 {item.location || '—'}</p>
                            <p className="text-xs text-gray-600 mt-1">
                              👷 {TRADES.find((t) => t.id === item.trade)?.label ?? item.trade}{' '}
                              {item.sub_id ? `- ${(subcontractors.find((s) => s.id === item.sub_id)?.company_name ?? '')}` : ''}
                            </p>
                            <div className="mt-2 flex items-center justify-between">
                              <label className="inline-flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={item.status === 'closed' || item.status === 'verified'}
                                  onChange={(e) =>
                                    onUpdate({
                                      ...basePunch,
                                      items: items.map((x) =>
                                        x.id !== item.id ? x : { ...x, status: e.target.checked ? 'closed' : 'open', updated_at: new Date().toISOString() },
                                      ),
                                    })
                                  }
                                />
                                Completed
                              </label>
                              <button
                                onClick={() => onMessageSub?.(item.sub_id)}
                                disabled={!item.sub_id}
                                className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold"
                              >
                                Message
                              </button>
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      </Modal>

      {adding ? (
        <AddPunchItemModal
          lot={lot}
          subcontractors={subcontractors}
          onClose={() => setAdding(false)}
          onCreate={async (newItem, photoFile) => {
            let photoId = null
            if (photoFile) {
              photoId = await onAddPunchPhoto({ punchItemId: newItem.id, file: photoFile, caption: newItem.description })
            }

            const now = new Date().toISOString()
            const itemWithPhoto = { ...newItem, photo_id: photoId, created_at: now, updated_at: now }
            onUpdate({ ...basePunch, items: [...items, itemWithPhoto] })
            if (itemWithPhoto.sub_id) onNotifyAssignment?.(itemWithPhoto)
            setAdding(false)
          }}
        />
      ) : null}
    </>
  )
}

function AddPunchItemModal({ subcontractors, onClose, onCreate }) {
  const [category, setCategory] = useState('Interior')
  const [subcategory, setSubcategory] = useState('Drywall')
  const [location, setLocation] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('standard')
  const [trade, setTrade] = useState('drywall')
  const [subId, setSubId] = useState('')
  const [source, setSource] = useState('super')
  const [photoFile, setPhotoFile] = useState(null)
  const cameraInputRef = useRef(null)
  const fileInputRef = useRef(null)

  const categoryOptions = PUNCH_CATEGORIES.map((c) => c.label)
  const subcategoryOptions = PUNCH_CATEGORIES.find((c) => c.label === category)?.items ?? []
  const effectiveSubcategory = subcategoryOptions.includes(subcategory) ? subcategory : (subcategoryOptions[0] ?? '')
  const subsForTrade = subcontractors.filter((s) => s.trade === trade || (s.secondary_trades ?? []).includes(trade))
  const validSubIds = new Set(subsForTrade.map((s) => s.id))
  const effectiveSubId = validSubIds.has(subId) ? subId : ''

  const canCreate = description.trim().length > 0

  return (
    <Modal
      title="Add Punch Item"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={() =>
              onCreate(
                {
                  id: uuid(),
                  category,
                  subcategory: effectiveSubcategory,
                  location,
                  description: description.trim(),
                  priority,
                  trade,
                  sub_id: effectiveSubId || null,
                  source,
                  status: 'open',
                },
                photoFile,
              )
            }
            className="flex-1"
            disabled={!canCreate}
          >
            Add Item
          </PrimaryButton>
        </div>
      }
    >
      <div className="space-y-3">
	        <label className="block">
	          <span className="text-sm font-semibold">Category</span>
	          <select
	            value={category}
	            onChange={(e) => {
	              const nextCategory = e.target.value
	              setCategory(nextCategory)
	              const nextOptions = PUNCH_CATEGORIES.find((c) => c.label === nextCategory)?.items ?? []
	              if (nextOptions.length && !nextOptions.includes(subcategory)) setSubcategory(nextOptions[0])
	            }}
	            className="mt-1 w-full px-3 py-3 border rounded-xl"
	          >
	            {categoryOptions.map((c) => (
	              <option key={c} value={c}>
	                {c}
	              </option>
	            ))}
	          </select>
	        </label>
	        <label className="block">
	          <span className="text-sm font-semibold">Subcategory</span>
	          <select
	            value={effectiveSubcategory}
	            onChange={(e) => setSubcategory(e.target.value)}
	            className="mt-1 w-full px-3 py-3 border rounded-xl"
	          >
	            {subcategoryOptions.map((c) => (
	              <option key={c} value={c}>
	                {c}
	              </option>
	            ))}
	          </select>
	        </label>
        <label className="block">
          <span className="text-sm font-semibold">Location</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} className="mt-1 w-full px-3 py-3 border rounded-xl" placeholder="Master bedroom entry" />
        </label>
        <label className="block">
          <span className="text-sm font-semibold">Description</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 w-full px-3 py-3 border rounded-xl" rows={3} />
        </label>
        <div>
          <span className="text-sm font-semibold">Photo (Optional)</span>
          {photoFile ? (
            <div className="mt-2 flex items-center justify-between bg-gray-50 border border-gray-200 rounded-xl px-3 py-2">
              <span className="text-sm">{photoFile.name}</span>
              <button
                onClick={() => setPhotoFile(null)}
                className="text-xs text-red-600"
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => cameraInputRef.current?.click()}
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
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
        </div>
        <div>
          <p className="text-sm font-semibold mb-2">Priority</p>
          <div className="grid grid-cols-3 gap-2 text-sm">
            {[
              { id: 'critical', label: 'Critical' },
              { id: 'standard', label: 'Standard' },
              { id: 'cosmetic', label: 'Cosmetic' },
            ].map((p) => (
              <button
                key={p.id}
                onClick={() => setPriority(p.id)}
                className={`px-3 py-3 rounded-xl border font-semibold ${priority === p.id ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-gray-200 text-gray-700'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
	        <div className="grid grid-cols-2 gap-2">
	          <label className="block">
	            <span className="text-sm font-semibold">Trade</span>
	            <select
	              value={trade}
	              onChange={(e) => {
	                setTrade(e.target.value)
	                setSubId('')
	              }}
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
	            <span className="text-sm font-semibold">Sub</span>
	            <select value={effectiveSubId} onChange={(e) => setSubId(e.target.value)} className="mt-1 w-full px-3 py-3 border rounded-xl text-sm">
	              <option value="">Select…</option>
	              {subsForTrade.map((s) => (
	                  <option key={s.id} value={s.id}>
	                    {s.company_name}
	                  </option>
	                ))}
	            </select>
	          </label>
	        </div>
        <div>
          <p className="text-sm font-semibold mb-2">Source</p>
          <div className="grid grid-cols-3 gap-2 text-sm">
            {[
              { id: 'super', label: 'Super' },
              { id: 'manager', label: 'Manager' },
              { id: 'buyer', label: 'Buyer' },
            ].map((s) => (
              <button
                key={s.id}
                onClick={() => setSource(s.id)}
                className={`px-3 py-3 rounded-xl border font-semibold ${source === s.id ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-gray-200 text-gray-700'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
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
                  onChange={(e) => setDraft((p) => ({ ...p, vendor_phone: e.target.value }))}
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

const openBlobInNewTab = async (blobId) => {
  if (!blobId) return
  try {
    const blob = await getBlob(blobId)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank', 'noopener,noreferrer')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (err) {
    console.error(err)
    alert('Failed to open file.')
  }
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
          <label
            className={`flex-1 h-12 inline-flex items-center justify-center rounded-xl text-white font-semibold cursor-pointer ${
              isOnline ? 'bg-blue-600' : 'bg-gray-400 cursor-not-allowed'
            }`}
            title={!isOnline ? 'Upload requires connection' : ''}
          >
            Upload New
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
