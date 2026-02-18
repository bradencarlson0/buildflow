export const STORAGE_KEY = 'buildflow:state:v1'

// iOS Safari can evict/clear localStorage under memory pressure; IndexedDB is
// typically more durable. We mirror the snapshot into IndexedDB (best-effort,
// throttled) and can rehydrate from it if localStorage is missing/corrupt.
export const IDB_SNAPSHOT_META_KEY = 'snapshot:state:v1'
const IDB_MIRROR_MIN_INTERVAL_MS = 2000

let idbMirrorTimer = null
let idbMirrorQueuedState = null
let idbMirrorLastSavedAtMs = 0
let idbMirrorInFlight = false

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

const REQUIRED_ORG_CUSTOM_FIELDS = [
  { id: 'cf-elevation', label: 'Elevation' },
  { id: 'cf-lot-cost', label: 'Lot Cost' },
  { id: 'cf-construction-cost', label: 'Construction Cost' },
  { id: 'cf-purchase-price', label: 'Purchase Price' },
  { id: 'cf-sqft-heated', label: 'Sq Ft Heated (Override)' },
  { id: 'cf-sqft-total', label: 'Sq Ft Total (Override)' },
]

const LOT_TYPE_VALUES = new Set(['vacant', 'spec', 'model', 'sold'])

const normalizeLotType = (value) => {
  const next = String(value ?? '').trim().toLowerCase()
  if (LOT_TYPE_VALUES.has(next)) return next
  return 'vacant'
}

const ensureOrgCustomFields = (fields) => {
  const out = Array.isArray(fields) ? fields.map((x) => ({ ...x })) : []
  const existingIds = new Set(out.map((f) => String(f?.id ?? '').trim()).filter(Boolean))
  for (const required of REQUIRED_ORG_CUSTOM_FIELDS) {
    if (existingIds.has(required.id)) continue
    out.push({ ...required })
  }
  return out
}

export const loadStoredAppStateRaw = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

const migrateAppState = (state) => {
  if (!state || typeof state !== 'object') return state
  const productTypes = state.product_types ?? []
  const defaultProductTypeId = productTypes[0]?.id ?? null

  const communities = (state.communities ?? []).map((community) => {
    const lotsForCommunity = (state.lots ?? []).filter((l) => l.community_id === community.id)
    const lotCount =
      community.lot_count ??
      (community.blocks ?? []).reduce((acc, b) => acc + (Number(b.lot_count) || 0), 0) ??
      lotsForCommunity.length

    const lotNumbers = lotsForCommunity
      .map((l, idx) => Number.parseInt(l.lot_number, 10) || idx + 1)
      .filter((n) => Number.isFinite(n))

    const lotsByProductType =
      community.lots_by_product_type ??
      (defaultProductTypeId ? { [defaultProductTypeId]: lotNumbers } : {})

    return {
      ...community,
      product_type_ids: community.product_type_ids ?? (defaultProductTypeId ? [defaultProductTypeId] : []),
      lot_count: lotCount,
      lots_by_product_type: lotsByProductType,
      builders: community.builders ?? [],
      realtors: community.realtors ?? [],
      inspectors: community.inspectors ?? [],
      agencies: community.agencies ?? [],
      agency_ids: community.agency_ids ?? [],
    }
  })

  const lots = (state.lots ?? []).map((lot) => {
    const productTypeId = lot.product_type_id ?? defaultProductTypeId
    const buildDays =
      lot.build_days ??
      productTypes.find((pt) => pt.id === productTypeId)?.build_days ??
      state.org?.default_build_days ??
      135
    const customFields = isPlainObject(lot.custom_fields) ? { ...lot.custom_fields } : {}
    const lotType = normalizeLotType(lot.lot_type ?? customFields.inventory_type)
    customFields.inventory_type = lotType

    return {
      ...lot,
      block: lot.block ?? '',
      product_type_id: productTypeId,
      plan_id: lot.plan_id ?? null,
      builder_id: lot.builder_id ?? null,
      job_number: lot.job_number ?? '',
      sold_status: lot.sold_status ?? 'available',
      sold_date: lot.sold_date ?? null,
      build_days: buildDays,
      lot_type: lotType,
      custom_fields: customFields,
    }
  })

  const org = {
    ...(state.org ?? {}),
    custom_fields: ensureOrgCustomFields(state.org?.custom_fields),
    plan_sq_ft_total: isPlainObject(state.org?.plan_sq_ft_total) ? state.org.plan_sq_ft_total : {},
  }

  const contactLibrary = {
    builders: state.contact_library?.builders ?? [],
    realtors: state.contact_library?.realtors ?? [],
  }

  return { ...state, org, communities, lots, contact_library: contactLibrary }
}

const mergeWithFallback = (fallbackState, parsed) => {
  const merged = {
    ...fallbackState,
    ...parsed,
    org: { ...(fallbackState?.org ?? {}), ...(parsed?.org ?? {}) },
    template: parsed?.template ?? fallbackState?.template,
    templates: parsed?.templates ?? fallbackState?.templates ?? [],
    product_types: parsed?.product_types ?? fallbackState?.product_types ?? [],
    plans: parsed?.plans ?? fallbackState?.plans ?? [],
    agencies: parsed?.agencies ?? fallbackState?.agencies ?? [],
    inspection_checklists: parsed?.inspection_checklists ?? fallbackState?.inspection_checklists ?? {},
    sync: { ...(fallbackState?.sync ?? {}), ...(parsed?.sync ?? {}) },
    notification_preferences: {
      ...(fallbackState?.notification_preferences ?? {}),
      ...(parsed?.notification_preferences ?? {}),
    },
    scheduled_reports: parsed?.scheduled_reports ?? fallbackState?.scheduled_reports ?? [],
    counters: { ...(fallbackState?.counters ?? {}), ...(parsed?.counters ?? {}) },
    dedupe: { ...(fallbackState?.dedupe ?? {}), ...(parsed?.dedupe ?? {}) },
    derived: { ...(fallbackState?.derived ?? {}), ...(parsed?.derived ?? {}) },
  }
  return migrateAppState(merged)
}

export const loadAppState = (fallbackState) => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallbackState
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallbackState
    return mergeWithFallback(fallbackState, parsed)
  } catch {
    return fallbackState
  }
}

export const loadAppStateFromIdb = async (fallbackState) => {
  try {
    const { metaGet } = await import('./localDb.js')
    const snapshot = await metaGet(IDB_SNAPSHOT_META_KEY)
    if (!snapshot || typeof snapshot !== 'object') return null
    const state = snapshot.state
    if (!isPlainObject(state)) return null
    return mergeWithFallback(fallbackState, state)
  } catch {
    return null
  }
}

const scheduleIdbMirror = (state) => {
  try {
    if (!isPlainObject(state)) return
    idbMirrorQueuedState = state

    if (idbMirrorTimer) return

    const nowMs = Date.now()
    const wait = Math.max(350, IDB_MIRROR_MIN_INTERVAL_MS - (nowMs - idbMirrorLastSavedAtMs))

    idbMirrorTimer = setTimeout(async () => {
      idbMirrorTimer = null
      if (idbMirrorInFlight) {
        // If a previous put is still running, reschedule soon and coalesce.
        scheduleIdbMirror(idbMirrorQueuedState)
        return
      }

      const nextState = idbMirrorQueuedState
      if (!nextState) return

      idbMirrorInFlight = true
      try {
        const { metaSet } = await import('./localDb.js')
        const savedAt = new Date().toISOString()
        await metaSet(IDB_SNAPSHOT_META_KEY, { saved_at: savedAt, state: nextState })
        idbMirrorLastSavedAtMs = Date.now()
      } catch {
        // Best-effort: ignore; localStorage remains the primary persistence today.
      } finally {
        idbMirrorInFlight = false
      }
    }, wait)
  } catch {
    // ignore
  }
}

export const saveAppState = (state) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    scheduleIdbMirror(state)
  } catch (err) {
    console.error(err)
  }
}

export const clearAppState = () => {
  try {
    localStorage.removeItem(STORAGE_KEY)
    // Best-effort; avoid forcing IndexedDB for environments without it.
    void import('./localDb.js')
      .then(({ metaSet }) => metaSet(IDB_SNAPSHOT_META_KEY, null))
      .catch(() => {})
  } catch (err) {
    console.error(err)
  }
}
