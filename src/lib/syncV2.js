const isMissingRpcError = (error) => {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '').toLowerCase()
  return code === '42883' || (message.includes('function') && message.includes('does not exist'))
}

const normalizePushResults = (row, fallbackOps = []) => {
  const explicit = Array.isArray(row?.results) ? row.results : null
  if (explicit && explicit.length > 0) {
    const normalized = []
    for (const item of explicit) {
      const status = String(item?.status ?? item?.result ?? '').toLowerCase()
      normalized.push({
        id: String(item?.id ?? item?.op_id ?? ''),
        status: status || 'unknown',
        conflict_code: item?.conflict_code ?? null,
        conflict_reason: item?.conflict_reason ?? item?.message ?? null,
        applied_at: item?.applied_at ?? row?.server_time ?? null,
      })
    }
    return normalized.filter((item) => item.id)
  }

  const appliedSet = new Set(
    Array.isArray(row?.applied)
      ? row.applied.map((item) => String(item?.id ?? item?.op_id ?? '')).filter(Boolean)
      : [],
  )
  return (Array.isArray(fallbackOps) ? fallbackOps : [])
    .map((op) => {
      const id = String(op?.id ?? op?.op_id ?? '')
      if (!id) return null
      return {
        id,
        status: appliedSet.has(id) ? 'applied' : 'unknown',
        conflict_code: null,
        conflict_reason: null,
        applied_at: row?.server_time ?? null,
      }
    })
    .filter(Boolean)
}

export const syncV2Push = async ({ supabase, ops }) => {
  if (!supabase) throw new Error('Missing supabase client')
  const list = Array.isArray(ops) ? ops : []
  if (list.length === 0) return { ok: true, applied: [], results: [], conflicts: [], server_time: null }

  const payload = list.map((op) => op?.payload).filter(Boolean)
  if (payload.length === 0) return { ok: true, applied: [], results: [], conflicts: [], server_time: null }

  const { data, error } = await supabase.rpc('sync_push', { p_ops: payload })
  if (error) {
    if (isMissingRpcError(error)) return { ok: false, missing: true, error }
    return { ok: false, missing: false, error }
  }

  const row = data && typeof data === 'object' ? data : {}
  const results = normalizePushResults(row, list)
  const conflicts = results.filter((item) => ['conflict', 'rejected', 'denied', 'unavailable'].includes(String(item.status ?? '')))
  return { ok: true, applied: row.applied ?? [], results, conflicts, server_time: row.server_time ?? null }
}

export const syncV2Pull = async ({ supabase, since }) => {
  if (!supabase) throw new Error('Missing supabase client')
  const { data, error } = await supabase.rpc('sync_pull', { p_since: since ?? null })
  if (error) {
    if (isMissingRpcError(error)) return { ok: false, missing: true, error }
    return { ok: false, missing: false, error }
  }
  const row = data && typeof data === 'object' ? data : {}
  return {
    ok: true,
    server_time: row.server_time ?? null,
    cursor: row.cursor ?? row.server_time ?? null,
    versions: row.versions ?? null,
    product_types: Array.isArray(row.product_types) ? row.product_types : [],
    plans: Array.isArray(row.plans) ? row.plans : [],
    agencies: Array.isArray(row.agencies) ? row.agencies : [],
    communities: Array.isArray(row.communities) ? row.communities : [],
    subcontractors: Array.isArray(row.subcontractors) ? row.subcontractors : [],
    lots: Array.isArray(row.lots) ? row.lots : [],
    tasks: Array.isArray(row.tasks) ? row.tasks : [],
    lot_assignments: Array.isArray(row.lot_assignments) ? row.lot_assignments : [],
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
  }
}

export const syncV2HealthCheck = async ({ supabase }) => {
  if (!supabase) throw new Error('Missing supabase client')

  const pull = await supabase.rpc('sync_pull', { p_since: null })
  if (pull.error) {
    if (isMissingRpcError(pull.error)) return { ok: false, missing: true, stage: 'sync_pull', error: pull.error }
    return { ok: false, missing: false, stage: 'sync_pull', error: pull.error }
  }

  // Empty push validates RPC contract without writing rows.
  const push = await supabase.rpc('sync_push', { p_ops: [] })
  if (push.error) {
    if (isMissingRpcError(push.error)) return { ok: false, missing: true, stage: 'sync_push', error: push.error }
    return { ok: false, missing: false, stage: 'sync_push', error: push.error }
  }

  const pullRow = pull.data && typeof pull.data === 'object' ? pull.data : {}
  const pushRow = push.data && typeof push.data === 'object' ? push.data : {}

  if (!Object.prototype.hasOwnProperty.call(pullRow, 'cursor')) {
    return {
      ok: false,
      missing: false,
      stage: 'sync_pull_contract',
      error: { message: 'sync_pull contract mismatch: missing cursor' },
    }
  }

  if (!Object.prototype.hasOwnProperty.call(pullRow, 'versions')) {
    return {
      ok: false,
      missing: false,
      stage: 'sync_pull_contract',
      error: { message: 'sync_pull contract mismatch: missing versions metadata' },
    }
  }

  if (!Array.isArray(pushRow?.results)) {
    return {
      ok: false,
      missing: false,
      stage: 'sync_push_contract',
      error: { message: 'sync_push contract mismatch: missing results[]' },
    }
  }

  return {
    ok: true,
    missing: false,
    stage: 'ready',
    server_time: pullRow.server_time ?? pushRow.server_time ?? null,
  }
}
