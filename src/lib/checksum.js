const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

const sortDeep = (value) => {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (!isObject(value)) return value
  const out = {}
  for (const key of Object.keys(value).sort()) {
    out[key] = sortDeep(value[key])
  }
  return out
}

export const stableStringify = (value) => JSON.stringify(sortDeep(value))

const bytesToHex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')

export const sha256Hex = async (value) => {
  const text = typeof value === 'string' ? value : stableStringify(value)
  try {
    if (typeof crypto !== 'undefined' && crypto?.subtle) {
      const input = new TextEncoder().encode(text)
      const digest = await crypto.subtle.digest('SHA-256', input)
      return bytesToHex(new Uint8Array(digest))
    }
  } catch {
    // ignore and fall back
  }

  // Fallback hash for environments without Web Crypto support.
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv32:${(hash >>> 0).toString(16)}:${text.length}`
}
