import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase env vars: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY')
}

const readCookie = (name) => {
  if (typeof document === 'undefined') return null
  const encodedName = `${encodeURIComponent(name)}=`
  const parts = String(document.cookie ?? '').split(';')
  for (const part of parts) {
    const value = part.trim()
    if (!value.startsWith(encodedName)) continue
    try {
      return decodeURIComponent(value.slice(encodedName.length))
    } catch {
      return value.slice(encodedName.length)
    }
  }
  return null
}

const writeCookie = (name, value, maxAgeSeconds = 60 * 60 * 24 * 30) => {
  if (typeof document === 'undefined') return
  const secure = typeof window !== 'undefined' && window.location?.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Number(maxAgeSeconds) || 0)}; SameSite=Lax${secure}`
}

const cookieByteLength = (value) => {
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(value ?? '')).length
  } catch {
    // ignore
  }
  return String(value ?? '').length
}

const MAX_COOKIE_VALUE_BYTES = 3500

const removeCookie = (name) => {
  if (typeof document === 'undefined') return
  const secure = typeof window !== 'undefined' && window.location?.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${encodeURIComponent(name)}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
}

const createResilientStorage = () => ({
  getItem(key) {
    let localValue = null
    try {
      if (typeof localStorage !== 'undefined') {
        localValue = localStorage.getItem(key)
      }
    } catch {
      localValue = null
    }
    if (localValue != null) return localValue

    const cookieValue = readCookie(key)
    if (cookieValue != null) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, cookieValue)
      } catch {
        // ignore
      }
      return cookieValue
    }
    return null
  },
  setItem(key, value) {
    const next = String(value ?? '')
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, next)
      }
    } catch {
      // ignore
    }
    try {
      if (cookieByteLength(next) <= MAX_COOKIE_VALUE_BYTES) {
        writeCookie(key, next)
      } else {
        removeCookie(key)
      }
    } catch {
      // ignore
    }
  },
  removeItem(key) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key)
      }
    } catch {
      // ignore
    }
    try {
      removeCookie(key)
    } catch {
      // ignore
    }
  },
})

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: createResilientStorage(),
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
