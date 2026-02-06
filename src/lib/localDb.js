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

