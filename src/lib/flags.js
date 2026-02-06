export const readFlag = (key, fallback = false) => {
  try {
    const v = localStorage.getItem(key)
    if (v === '1' || v === 'true') return true
    if (v === '0' || v === 'false') return false
    return Boolean(fallback)
  } catch {
    return Boolean(fallback)
  }
}

export const writeFlag = (key, value) => {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // ignore
  }
}

export const isSyncV2Enabled = () => {
  try {
    if (String(import.meta.env.VITE_SYNC_V2 ?? '') === '1') return true
  } catch {
    // ignore
  }
  return readFlag('bf:sync_v2', false)
}

