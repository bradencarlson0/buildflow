const DB_NAME = 'buildflow'
const DB_VERSION = 1
const STORE_BLOBS = 'blobs'

let dbPromise = null

const openDb = () => {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS)
      }
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

export const putBlob = async (key, blob) => {
  const db = await openDb()
  const tx = db.transaction(STORE_BLOBS, 'readwrite')
  tx.objectStore(STORE_BLOBS).put(blob, key)
  await txDone(tx)
}

export const getBlob = async (key) => {
  const db = await openDb()
  const tx = db.transaction(STORE_BLOBS, 'readonly')
  const request = tx.objectStore(STORE_BLOBS).get(key)
  const value = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(request.error ?? new Error('Failed to read blob'))
  })
  await txDone(tx)
  return value
}

export const deleteBlob = async (key) => {
  const db = await openDb()
  const tx = db.transaction(STORE_BLOBS, 'readwrite')
  tx.objectStore(STORE_BLOBS).delete(key)
  await txDone(tx)
}

export const clearAllBlobs = async () => {
  const db = await openDb()
  const tx = db.transaction(STORE_BLOBS, 'readwrite')
  tx.objectStore(STORE_BLOBS).clear()
  await txDone(tx)
}

