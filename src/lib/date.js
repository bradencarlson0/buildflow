const pad2 = (n) => String(n).padStart(2, '0')

export const formatISODate = (dateLike) => {
  const d = parseISODate(dateLike)
  if (!d) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export const formatISODateInTimeZone = (dateLike, timeZone) => {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike)
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return ''
  const tz = String(timeZone || '').trim() || 'America/Chicago'

  // Use formatToParts so we are not dependent on locale output formatting.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)

  const year = parts.find((p) => p.type === 'year')?.value ?? ''
  const month = parts.find((p) => p.type === 'month')?.value ?? ''
  const day = parts.find((p) => p.type === 'day')?.value ?? ''
  if (!year || !month || !day) return ''
  return `${year}-${month}-${day}`
}

export const parseISODate = (iso) => {
  if (iso instanceof Date) return new Date(iso.getFullYear(), iso.getMonth(), iso.getDate())
  if (typeof iso !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  return new Date(year, month - 1, day)
}

export const formatShortDate = (dateLike) => {
  const d = parseISODate(dateLike)
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
}

export const formatShortDateWithWeekday = (dateLike) => {
  const d = parseISODate(dateLike)
  if (!d) return ''
  const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' })
  return `${datePart} (${weekday})`
}

export const formatLongDate = (dateLike) => {
  const d = parseISODate(dateLike)
  return d
    ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : ''
}

export const addCalendarDays = (dateLike, days) => {
  const d = parseISODate(dateLike)
  if (!d) return null
  d.setDate(d.getDate() + Number(days))
  return d
}

export const daysBetweenCalendar = (aLike, bLike) => {
  const a = parseISODate(aLike)
  const b = parseISODate(bLike)
  if (!a || !b) return 0
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((utcA - utcB) / 86400000)
}

export const makeWorkdayHelpers = (orgSettings) => {
  const workDays = Array.isArray(orgSettings?.work_days) ? orgSettings.work_days : [1, 2, 3, 4, 5]
  const holidays = Array.isArray(orgSettings?.holidays) ? orgSettings.holidays : []
  const workDaySet = new Set(workDays.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))
  const holidaySet = new Set(holidays.map((h) => String(h?.date ?? '').trim()).filter(Boolean))

  const isWorkDay = (dateLike) => {
    const d = parseISODate(dateLike)
    if (!d) return false
    const weekday = d.getDay()
    if (!workDaySet.has(weekday)) return false
    return !holidaySet.has(formatISODate(d))
  }

  const getNextWorkDay = (dateLike) => {
    const d = parseISODate(dateLike)
    if (!d) return null
    while (!isWorkDay(d)) d.setDate(d.getDate() + 1)
    return d
  }

  // Like the spec pseudocode:
  // addWorkDays(date, 0) === date, and counts forward only on workdays.
  const addWorkDays = (dateLike, workDaysToAdd) => {
    const d = parseISODate(dateLike)
    if (!d) return null
    const total = Math.max(0, Number(workDaysToAdd) || 0)
    let added = 0
    while (added < total) {
      d.setDate(d.getDate() + 1)
      if (isWorkDay(d)) added++
    }
    return d
  }

  const subtractWorkDays = (dateLike, workDaysToSubtract) => {
    const d = parseISODate(dateLike)
    if (!d) return null
    const total = Math.max(0, Number(workDaysToSubtract) || 0)
    let removed = 0
    while (removed < total) {
      d.setDate(d.getDate() - 1)
      if (isWorkDay(d)) removed++
    }
    return d
  }

  const businessDaysBetweenInclusive = (startLike, endLike) => {
    const start = parseISODate(startLike)
    const end = parseISODate(endLike)
    if (!start || !end) return 0
    if (end < start) return 0
    let count = 0
    const d = new Date(start)
    while (d <= end) {
      if (isWorkDay(d)) count++
      d.setDate(d.getDate() + 1)
    }
    return Math.max(1, count)
  }

  return { isWorkDay, getNextWorkDay, addWorkDays, subtractWorkDays, businessDaysBetweenInclusive }
}

