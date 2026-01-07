export const parseRange = (rangeStr) => {
  if (!rangeStr) return []
  const values = new Set()
  const parts = String(rangeStr)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

  for (const part of parts) {
    if (part.includes('-')) {
      const [rawStart, rawEnd] = part.split('-').map((v) => v.trim())
      const start = Number.parseInt(rawStart, 10)
      const end = Number.parseInt(rawEnd, 10)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      const min = Math.min(start, end)
      const max = Math.max(start, end)
      for (let i = min; i <= max; i++) values.add(i)
    } else {
      const num = Number.parseInt(part, 10)
      if (Number.isFinite(num)) values.add(num)
    }
  }

  return Array.from(values).sort((a, b) => a - b)
}

export const toRangeString = (numbers) => {
  const sorted = Array.from(new Set((numbers ?? []).map((n) => Number(n)).filter(Number.isFinite))).sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  const ranges = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i]
    if (current === prev + 1) {
      prev = current
      continue
    }
    ranges.push(start === prev ? String(start) : `${start}-${prev}`)
    start = current
    prev = current
  }
  return ranges.join(', ')
}

export const normalizeRange = (rangeStr, max) => {
  const values = parseRange(rangeStr)
  return values.filter((n) => n >= 1 && (Number.isFinite(max) ? n <= max : true))
}

export const validateAssignments = ({ assignments, lotCount }) => {
  const assignedByLot = new Map()
  const duplicates = new Set()
  const outOfRange = new Set()

  for (const entry of assignments ?? []) {
    const lots = entry?.lots ?? []
    for (const lotNum of lots) {
      if (!Number.isFinite(lotNum)) continue
      if (Number.isFinite(lotCount) && (lotNum < 1 || lotNum > lotCount)) {
        outOfRange.add(lotNum)
        continue
      }
      if (assignedByLot.has(lotNum)) duplicates.add(lotNum)
      assignedByLot.set(lotNum, entry?.id ?? '')
    }
  }

  const missing = []
  for (let i = 1; i <= (lotCount ?? 0); i++) {
    if (!assignedByLot.has(i)) missing.push(i)
  }

  return {
    assignedCount: assignedByLot.size,
    duplicates: Array.from(duplicates).sort((a, b) => a - b),
    missing,
    out_of_range: Array.from(outOfRange).sort((a, b) => a - b),
  }
}
