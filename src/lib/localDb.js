// Local entity + outbox storage for BuildFlow (IndexedDB).
//
// This module is intentionally standalone and additive. The current app still uses
// localStorage for the full app graph; sync v2 work will progressively migrate
// reads/writes to this store behind feature flags.

const DB_NAME = 'buildflow_local'
const DB_VERSION = 1

export const STORES = {
  META: 'meta',
  OUTBOX: 'outbox',
  COMMUNITIES: 'communities',
  LOTS: 'lots',
  TASKS: 'tasks',
  SUBCONTRACTORS: 'subcontractors',
  PRODUCT_TYPES: 'product_types',
  PLANS: 'plans',
  AGENCIES: 'agencies',
}

let dbPromise = null

export const openLocalDb = () => {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(STORES.META)) {
        db.createObjectStore(STORES.META, { keyPath: 'key' })
      }

      if (!db.objectStoreNames.contains(STORES.OUTBOX)) {
        const store = db.createObjectStore(STORES.OUTBOX, { keyPath: 'id' })
        store.createIndex('created_at', 'created_at', { unique: false })
        store.createIndex('next_retry_at', 'next_retry_at', { unique: false })
      }

      const ensureEntityStore = (name, indexDefs) => {
        if (db.objectStoreNames.contains(name)) return
        const store = db.createObjectStore(name, { keyPath: 'id' })
        for (const def of indexDefs ?? []) {
          store.createIndex(def.name, def.keyPath, { unique: Boolean(def.unique) })
        }
      }

      ensureEntityStore(STORES.COMMUNITIES, [
        { name: 'org_id', keyPath: 'org_id' },
        { name: 'updated_at', keyPath: 'updated_at' },
      ])

      ensureEntityStore(STORES.LOTS, [
        { name: 'org_id', keyPath: 'org_id' },
        { name: 'community_id', keyPath: 'community_id' },
        { name: 'updated_at', keyPath: 'updated_at' },
      ])

      ensureEntityStore(STORES.TASKS, [
        { name: 'org_id', keyPath: 'org_id' },
        { name: 'lot_id', keyPath: 'lot_id' },
        { name: 'updated_at', keyPath: 'updated_at' },
      ])

      ensureEntityStore(STORES.SUBCONTRACTORS, [
        { name: 'org_id', keyPath: 'org_id' },
        { name: 'trade', keyPath: 'trade' },
        { name: 'updated_at', keyPath: 'updated_at' },
      ])

      ensureEntityStore(STORES.PRODUCT_TYPES, [
        { name: 'org_id', keyPath: 'org_id' },
        { name: 'updated_at', keyPath: 'updated_at' },
      ])

      ensureEntityStore(STORES.PLANS, [
        { name: 'org_id', keyPath: 'org_id' },
        { name: 'product_type_id', keyPath: 'product_type_id' },
        { name: 'updated_at', keyPath: 'updated_at' },
      ])

      ensureEntityStore(STORES.AGENCIES, [
        { name: 'org_id', keyPath: 'org_id' },
        { name: 'updated_at', keyPath: 'updated_at' },
      ])
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'))
  })

  return dbPromise
}

const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
  })

const requestValue = (request, fallback = null) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? fallback)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })

export const metaGet = async (key) => {
  const db = await openLocalDb()
  const tx = db.transaction(STORES.META, 'readonly')
  const row = await requestValue(tx.objectStore(STORES.META).get(key), null)
  await txDone(tx)
  return row?.value ?? null
}

export const metaSet = async (key, value) => {
  const db = await openLocalDb()
  const tx = db.transaction(STORES.META, 'readwrite')
  tx.objectStore(STORES.META).put({ key, value, updated_at: new Date().toISOString() })
  await txDone(tx)
}

export const upsertMany = async (storeName, rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return
  const db = await openLocalDb()
  const tx = db.transaction(storeName, 'readwrite')
  const store = tx.objectStore(storeName)
  for (const row of rows) {
    if (!row?.id) continue
    store.put(row)
  }
  await txDone(tx)
}

export const getById = async (storeName, id) => {
  if (!id) return null
  const db = await openLocalDb()
  const tx = db.transaction(storeName, 'readonly')
  const value = await requestValue(tx.objectStore(storeName).get(id), null)
  await txDone(tx)
  return value ?? null
}

export const getAll = async (storeName) => {
  const db = await openLocalDb()
  const tx = db.transaction(storeName, 'readonly')
  const value = await requestValue(tx.objectStore(storeName).getAll(), [])
  await txDone(tx)
  return Array.isArray(value) ? value : []
}

export const getAllByIndex = async (storeName, indexName, key) => {
  const db = await openLocalDb()
  const tx = db.transaction(storeName, 'readonly')
  const store = tx.objectStore(storeName)
  const index = store.index(indexName)
  const value = await requestValue(index.getAll(key), [])
  await txDone(tx)
  return Array.isArray(value) ? value : []
}

export const outboxEnqueue = async (op) => {
  if (!op?.id) throw new Error('Outbox op missing id')
  const db = await openLocalDb()
  const tx = db.transaction(STORES.OUTBOX, 'readwrite')
  tx.objectStore(STORES.OUTBOX).put(op)
  await txDone(tx)
  return op.id
}

export const outboxEnqueueMany = async (ops) => {
  if (!Array.isArray(ops) || ops.length === 0) return
  const db = await openLocalDb()
  const tx = db.transaction(STORES.OUTBOX, 'readwrite')
  const store = tx.objectStore(STORES.OUTBOX)
  for (const op of ops) {
    if (!op?.id) continue
    store.put(op)
  }
  await txDone(tx)
}

export const outboxList = async () => {
  const db = await openLocalDb()
  const tx = db.transaction(STORES.OUTBOX, 'readonly')
  const index = tx.objectStore(STORES.OUTBOX).index('created_at')
  const value = await requestValue(index.getAll(), [])
  await txDone(tx)
  return Array.isArray(value) ? value : []
}

export const outboxUpdate = async (id, patch) => {
  if (!id) return
  const db = await openLocalDb()
  const tx = db.transaction(STORES.OUTBOX, 'readwrite')
  const store = tx.objectStore(STORES.OUTBOX)
  const existing = await requestValue(store.get(id), null)
  if (!existing) {
    await txDone(tx)
    return
  }
  store.put({ ...existing, ...(patch ?? {}), id })
  await txDone(tx)
}

export const outboxDelete = async (id) => {
  if (!id) return
  const db = await openLocalDb()
  const tx = db.transaction(STORES.OUTBOX, 'readwrite')
  tx.objectStore(STORES.OUTBOX).delete(id)
  await txDone(tx)
}

export const clearLocalDb = async () => {
  const db = await openLocalDb()
  const tx = db.transaction(Object.values(STORES), 'readwrite')
  for (const name of Object.values(STORES)) {
    tx.objectStore(name).clear()
  }
  await txDone(tx)
}

const IMPORT_META_KEY = 'import:snapshot_v1'

const withOrgId = (row, orgId) => {
  if (!row || typeof row !== 'object') return row
  if (!orgId) return row
  return row.org_id ? row : { ...row, org_id: orgId }
}

export const getImportStatus = async () => {
  const value = await metaGet(IMPORT_META_KEY)
  return value && typeof value === 'object' ? value : null
}

// One-time import: convert the existing localStorage "app graph" snapshot into normalized entity stores.
// This does not change the app behavior yet; it just creates a durable foundation for sync v2.
export const importSnapshotV1 = async (state, options = {}) => {
  const orgId =
    options.org_id ?? options.orgId ?? state?.org?.id ?? null

  const now = new Date().toISOString()

  const communities = Array.isArray(state?.communities) ? state.communities : []
  const lots = Array.isArray(state?.lots) ? state.lots : []
  const subcontractors = Array.isArray(state?.subcontractors) ? state.subcontractors : []
  const productTypes = Array.isArray(state?.product_types) ? state.product_types : []
  const plans = Array.isArray(state?.plans) ? state.plans : []
  const agencies = Array.isArray(state?.agencies) ? state.agencies : []

  const tasks = []
  const lotsWithoutTasks = []
  for (const lot of lots) {
    const lotTasks = Array.isArray(lot?.tasks) ? lot.tasks : []
    for (const t of lotTasks) {
      if (!t?.id) continue
      tasks.push(withOrgId({ ...t, lot_id: lot.id }, orgId))
    }
    const { tasks: _tasks, ...rest } = lot ?? {}
    lotsWithoutTasks.push(withOrgId(rest, orgId))
  }

  const pending = Array.isArray(state?.sync?.pending) ? state.sync.pending : []
  const outboxOps = pending
    .filter((op) => op?.id)
    .map((op) => withOrgId({ ...op, next_retry_at: op.next_retry_at ?? null }, orgId))

  await Promise.all([
    upsertMany(STORES.COMMUNITIES, communities.map((c) => withOrgId(c, orgId))),
    upsertMany(STORES.LOTS, lotsWithoutTasks),
    upsertMany(STORES.TASKS, tasks),
    upsertMany(STORES.SUBCONTRACTORS, subcontractors.map((s) => withOrgId(s, orgId))),
    upsertMany(STORES.PRODUCT_TYPES, productTypes.map((pt) => withOrgId(pt, orgId))),
    upsertMany(STORES.PLANS, plans.map((p) => withOrgId(p, orgId))),
    upsertMany(STORES.AGENCIES, agencies.map((a) => withOrgId(a, orgId))),
    outboxEnqueueMany(outboxOps),
  ])

  const summary = {
    imported_at: now,
    org_id: orgId,
    counts: {
      communities: communities.length,
      lots: lotsWithoutTasks.length,
      tasks: tasks.length,
      subcontractors: subcontractors.length,
      product_types: productTypes.length,
      plans: plans.length,
      agencies: agencies.length,
      outbox: outboxOps.length,
    },
  }

  await metaSet(IMPORT_META_KEY, summary)
  return summary
}

export const ensureImportedFromSnapshotV1 = async (state, options = {}) => {
  const existing = await getImportStatus()
  if (existing) return { status: 'skipped', ...existing }
  const imported = await importSnapshotV1(state, options)
  return { status: 'imported', ...imported }
}
