const isMissingRpcError = (error) => {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '').toLowerCase()
  return code === '42883' || (message.includes('function') && message.includes('does not exist'))
}

export const syncV2Push = async ({ supabase, ops }) => {
  if (!supabase) throw new Error('Missing supabase client')
  const list = Array.isArray(ops) ? ops : []
  if (list.length === 0) return { ok: true, applied: [], server_time: null }

  const payload = list.map((op) => op?.payload).filter(Boolean)
  if (payload.length === 0) return { ok: true, applied: [], server_time: null }

  const { data, error } = await supabase.rpc('sync_push', { p_ops: payload })
  if (error) {
    if (isMissingRpcError(error)) return { ok: false, missing: true, error }
    return { ok: false, missing: false, error }
  }

  const row = data && typeof data === 'object' ? data : {}
  return { ok: true, applied: row.applied ?? [], server_time: row.server_time ?? null }
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
    lots: Array.isArray(row.lots) ? row.lots : [],
    tasks: Array.isArray(row.tasks) ? row.tasks : [],
    lot_assignments: Array.isArray(row.lot_assignments) ? row.lot_assignments : [],
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
  }
}
