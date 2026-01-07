const STORAGE_KEY = 'buildflow:state:v1'

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

    return {
      ...lot,
      block: lot.block ?? '',
      product_type_id: productTypeId,
      plan_id: lot.plan_id ?? null,
      builder_id: lot.builder_id ?? null,
      job_number: lot.job_number ?? '',
      sold_status: lot.sold_status ?? 'available',
      sold_date: lot.sold_date ?? null,
      custom_fields: lot.custom_fields ?? {},
      build_days: buildDays,
    }
  })

  const org = {
    ...(state.org ?? {}),
    custom_fields: state.org?.custom_fields ?? [],
  }

  return { ...state, org, communities, lots }
}

export const loadAppState = (fallbackState) => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallbackState
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallbackState
    const merged = {
      ...fallbackState,
      ...parsed,
      org: { ...(fallbackState?.org ?? {}), ...(parsed.org ?? {}) },
      template: parsed.template ?? fallbackState?.template,
      templates: parsed.templates ?? fallbackState?.templates ?? [],
      product_types: parsed.product_types ?? fallbackState?.product_types ?? [],
      plans: parsed.plans ?? fallbackState?.plans ?? [],
      agencies: parsed.agencies ?? fallbackState?.agencies ?? [],
      inspection_checklists: parsed.inspection_checklists ?? fallbackState?.inspection_checklists ?? {},
      sync: { ...(fallbackState?.sync ?? {}), ...(parsed.sync ?? {}) },
      notification_preferences: {
        ...(fallbackState?.notification_preferences ?? {}),
        ...(parsed.notification_preferences ?? {}),
      },
      scheduled_reports: parsed.scheduled_reports ?? fallbackState?.scheduled_reports ?? [],
      counters: { ...(fallbackState?.counters ?? {}), ...(parsed.counters ?? {}) },
      dedupe: { ...(fallbackState?.dedupe ?? {}), ...(parsed.dedupe ?? {}) },
      derived: { ...(fallbackState?.derived ?? {}), ...(parsed.derived ?? {}) },
    }
    return migrateAppState(merged)
  } catch {
    return fallbackState
  }
}

export const saveAppState = (state) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (err) {
    console.error(err)
  }
}

export const clearAppState = () => {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (err) {
    console.error(err)
  }
}
