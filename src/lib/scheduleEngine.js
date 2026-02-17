import { INSPECTION_TYPES, MILESTONES } from '../data/constants.js'
import { makeWorkdayHelpers, formatISODate, parseISODate } from './date.js'
import { uuid } from './uuid.js'

const bySortOrder = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name).localeCompare(String(b.name))

const isBufferTask = (task) => {
  if (!task) return false
  if (task.is_buffer) return true
  if (String(task.kind ?? '').toLowerCase() === 'buffer') return true
  if (String(task.trade ?? '').toLowerCase() === 'buffer') return true
  if (String(task.name ?? '').trim().toLowerCase() === 'buffer') return true
  return false
}

const shiftByWorkdays = (iso, delta, helpers) => {
  if (!iso || !delta) return iso
  if (delta > 0) return formatISODate(helpers.addWorkDays(iso, delta))
  return formatISODate(helpers.subtractWorkDays(iso, Math.abs(delta)))
}

const workdayDiff = (fromIso, toIso, helpers) => {
  const from = parseISODate(fromIso)
  const to = parseISODate(toIso)
  if (!from || !to) return 0
  if (to.getTime() === from.getTime()) return 0

  let cursor = fromIso
  let delta = 0
  const limit = 4000

  if (to > from) {
    while (cursor !== toIso && delta < limit) {
      cursor = formatISODate(helpers.addWorkDays(cursor, 1))
      delta += 1
    }
    return delta
  }

  while (cursor !== toIso && delta > -limit) {
    cursor = formatISODate(helpers.subtractWorkDays(cursor, 1))
    delta -= 1
  }
  return delta
}

export const buildReschedulePreview = ({ lot, task, targetDateIso, org }) => {
  const out = { affected: [], oldCompletion: null, newCompletion: null, dependency_violation: false, earliest_start: null, normalized_date: '' }
  if (!targetDateIso || !task?.scheduled_start) return out
  const helpers = makeWorkdayHelpers(org)
  const { getNextWorkDay } = helpers

  const normalizedDate = (() => {
    const next = getNextWorkDay(targetDateIso) ?? parseISODate(targetDateIso)
    return next ? formatISODate(next) : targetDateIso
  })()
  out.normalized_date = normalizedDate

  const shiftDays = workdayDiff(task.scheduled_start, normalizedDate, helpers)
  const tasks = (lot.tasks ?? []).slice().sort(bySortOrder)

  const oldCompletion = maxDateLike(tasks.map((t) => t.scheduled_end).filter(Boolean))
  out.oldCompletion = oldCompletion ? formatISODate(oldCompletion) : null

  if (shiftDays === 0) {
    out.newCompletion = out.oldCompletion
    return out
  }

  const movedTrack = task.track
  const movedSort = task.sort_order ?? 0
  const byId = new Map()
  const affected = []

  for (const t of tasks) {
    if (!t?.scheduled_start || !t?.scheduled_end) continue
    if (t.status === 'complete') continue
    const isAfter = (t.sort_order ?? 0) > movedSort
    const shouldShift = t.id === task.id || (t.track === movedTrack && isAfter)

    if (!shouldShift) continue

    const newStart = shiftByWorkdays(t.scheduled_start, shiftDays, helpers)
    const newEnd = shiftByWorkdays(t.scheduled_end, shiftDays, helpers)
    byId.set(t.id, { start: newStart, end: newEnd })
    affected.push({
      task_id: t.id,
      task_name: t.name,
      old_start: t.scheduled_start,
      new_start: newStart,
      old_end: t.scheduled_end,
      new_end: newEnd,
      track: t.track,
    })
  }

  out.affected = affected.slice().sort((a, b) => (a.task_id === task.id ? -1 : 0) || String(a.old_start).localeCompare(String(b.old_start)))

  const completion = maxDateLike(
    tasks.map((t) => {
      const hit = byId.get(t.id)
      return hit?.end ?? t.scheduled_end
    }),
  )
  out.newCompletion = completion ? formatISODate(completion) : null

  return out
}

const maxDateLike = (dateLikes) => {
  let max = null
  for (const like of dateLikes) {
    const d = parseISODate(like)
    if (!d) continue
    if (!max || d > max) max = d
  }
  return max
}

const minDateLike = (dateLikes) => {
  let min = null
  for (const like of dateLikes) {
    const d = parseISODate(like)
    if (!d) continue
    if (!min || d < min) min = d
  }
  return min
}

export const getTradeLabel = (tradeId) => {
  if (!tradeId) return ''
  return String(tradeId)
    .split('_')
    .map((x) => (x ? x[0].toUpperCase() + x.slice(1) : x))
    .join(' ')
}

const scheduleSequential = (tasks, startDateLike, orgSettings, scheduledDatesById) => {
  const { getNextWorkDay, addWorkDays } = makeWorkdayHelpers(orgSettings)
  let cursor = getNextWorkDay(startDateLike)
  if (!cursor) return

  for (const task of tasks.sort(bySortOrder)) {
    const start = cursor
    const end = addWorkDays(start, Math.max(0, (task.duration ?? 0) - 1))
    scheduledDatesById.set(task.id, { start, end })
    cursor = addWorkDays(end, 1)
  }
}

const getDriedInDate = (allTasks, scheduledDatesById) => {
  const windowsTask = allTasks.find((t) => String(t.name).toLowerCase().includes('window'))
  const roofTask = allTasks.find((t) => String(t.name).toLowerCase().includes('roof'))
  const windowsDates = windowsTask ? scheduledDatesById.get(windowsTask.id) : null
  if (windowsDates) return windowsDates.end
  const roofDates = roofTask ? scheduledDatesById.get(roofTask.id) : null
  return roofDates?.end ?? null
}

const applyTemplateTrackScheduling = (tasks, lotStartDate, orgSettings) => {
  const scheduledDatesById = new Map()

  const foundationTasks = tasks.filter((t) => t.track === 'foundation')
  const structureTasks = tasks.filter((t) => t.track === 'structure')
  const interiorTasks = tasks.filter((t) => t.track === 'interior')
  const exteriorTasks = tasks.filter((t) => t.track === 'exterior')
  const finalTasks = tasks.filter((t) => t.track === 'final')

  scheduleSequential(foundationTasks, lotStartDate ?? new Date(), orgSettings, scheduledDatesById)

  const { addWorkDays } = makeWorkdayHelpers(orgSettings)
  const lastFoundationEnd = maxDateLike(foundationTasks.map((t) => scheduledDatesById.get(t.id)?.end).filter(Boolean))
  const structureStart = lastFoundationEnd ? addWorkDays(lastFoundationEnd, 1) : lotStartDate ?? new Date()
  scheduleSequential(structureTasks, structureStart, orgSettings, scheduledDatesById)

  const driedInDate = getDriedInDate(tasks, scheduledDatesById)
  const trackStart = driedInDate ? addWorkDays(driedInDate, 1) : null

  if (trackStart) {
    scheduleSequential(interiorTasks, trackStart, orgSettings, scheduledDatesById)
    scheduleSequential(exteriorTasks, trackStart, orgSettings, scheduledDatesById)
  }

  const blockingTasks = tasks.filter((t) => t.track !== 'final' && t.blocks_final !== false)
  const blockingEnd = maxDateLike(blockingTasks.map((t) => scheduledDatesById.get(t.id)?.end).filter(Boolean))
  const finalStartBase = blockingEnd
  const finalStart = finalStartBase ? addWorkDays(finalStartBase, 1) : null
  if (finalStart) scheduleSequential(finalTasks, finalStart, orgSettings, scheduledDatesById)

  for (const task of tasks) {
    const dates = scheduledDatesById.get(task.id)
    task.scheduled_start = dates ? formatISODate(dates.start) : null
    task.scheduled_end = dates ? formatISODate(dates.end) : null
  }

  const blockingInteriorEnd = maxDateLike(interiorTasks.filter((t) => t.blocks_final !== false).map((t) => scheduledDatesById.get(t.id)?.end).filter(Boolean))
  const blockingExteriorEnd = maxDateLike(exteriorTasks.filter((t) => t.blocks_final !== false).map((t) => scheduledDatesById.get(t.id)?.end).filter(Boolean))
  const bottleneckTrack =
    !blockingExteriorEnd || (blockingInteriorEnd && blockingInteriorEnd >= blockingExteriorEnd) ? 'interior' : 'exterior'
  for (const task of tasks) {
    task.is_critical_path =
      task.track === 'foundation' || task.track === 'structure' || task.track === 'final' || task.track === bottleneckTrack
  }
}

const scaleTemplateTaskDurationsToTarget = (tasks, targetBuildDays, orgSettings) => {
  const target = Math.max(1, Number(targetBuildDays) || 1)
  const starts = tasks.map((t) => t.scheduled_start).filter(Boolean)
  const ends = tasks.map((t) => t.scheduled_end).filter(Boolean)
  const earliest = minDateLike(starts)
  const latest = maxDateLike(ends)
  if (!earliest || !latest) return

  const { businessDaysBetweenInclusive } = makeWorkdayHelpers(orgSettings)
  const current = Math.max(1, Number(businessDaysBetweenInclusive(formatISODate(earliest), formatISODate(latest)) || 1))
  if (current === target) return

  const ratio = target / current
  for (const task of tasks) {
    if (isBufferTask(task)) continue
    const duration = Math.max(1, Number(task.duration ?? 1) || 1)
    task.duration = Math.max(1, Math.round(duration * ratio))
  }
}

export const buildLotTasksFromTemplate = (lotId, lotStartDate, template, orgSettings) => {
  const templateTasks = (template?.tasks ?? []).slice()

  const created = templateTasks.map((tt) => {
    const id = uuid()
    return {
      id,
      lot_id: lotId,
      name: tt.name,
      description: null,
      trade: tt.trade,
      phase: tt.phase,
      track: tt.track,
      sub_id: null,
      duration: tt.duration,
      scheduled_start: null,
      scheduled_end: null,
      actual_start: null,
      actual_end: null,
      status: 'pending',
      delay_days: 0,
      delay_reason: null,
      delay_notes: null,
      delay_logged_at: null,
      delay_logged_by: null,
      requires_inspection: Boolean(tt.requires_inspection),
      inspection_type: tt.inspection_type ?? null,
      inspection_id: null,
      is_outdoor: Boolean(tt.is_outdoor),
      is_critical_path: false,
      blocks_final: tt.blocks_final !== false,
      lead_time_days: tt.lead_time_days ?? 0,
      photos: [],
      documents: [],
      notes: [],
      sort_order: tt.sort_order ?? 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
  })

  applyTemplateTrackScheduling(created, lotStartDate, orgSettings)

  // Ensure the first actionable task reads as ready
  const sortedAll = created.slice().sort(bySortOrder)
  if (sortedAll.length > 0) sortedAll[0].status = 'ready'

  return created
}

export const assignSubsToTasks = (tasks, subs) => {
  const activeSubs = (subs ?? []).filter((s) => s.status === 'active')

  const isBlackout = (sub, dateIso) => {
    const d = parseISODate(dateIso)
    if (!d) return false
    return (sub.blackout_dates ?? []).some((range) => {
      const start = parseISODate(range.start)
      const end = parseISODate(range.end)
      if (!start || !end) return false
      return d >= start && d <= end
    })
  }

  const isAvailable = (sub, dateIso) => {
    if (isBlackout(sub, dateIso)) return false
    return true
  }

  const pickSubForTrade = (tradeId, dateIso) => {
    const tradeSubs = activeSubs.filter((s) => s.trade === tradeId || (s.secondary_trades ?? []).includes(tradeId))
    if (tradeSubs.length === 0) return null

    const preferred = tradeSubs.find((s) => s.is_preferred)
    if (preferred && isAvailable(preferred, dateIso)) return preferred

    const backup = tradeSubs.find((s) => s.is_backup)
    if (backup && isAvailable(backup, dateIso)) return backup

    const available = tradeSubs
      .filter((s) => isAvailable(s, dateIso))
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))

    return available[0] ?? null
  }

  const next = tasks.map((t) => ({ ...t }))
  for (const task of next.sort((a, b) => {
    const aStart = parseISODate(a.scheduled_start)?.getTime() ?? 0
    const bStart = parseISODate(b.scheduled_start)?.getTime() ?? 0
    return aStart - bStart || bySortOrder(a, b)
  })) {
    if (!task.scheduled_start) continue
    const chosen = pickSubForTrade(task.trade, task.scheduled_start)
    task.sub_id = chosen?.id ?? null
  }

  return next
}

export const getTrackEndDate = (tasks, track) =>
  maxDateLike((tasks ?? []).filter((t) => t.track === track).map((t) => t.scheduled_end).filter(Boolean))

const buildDurationShift = (lot, taskId, nextDuration, orgSettings) => {
  const helpers = makeWorkdayHelpers(orgSettings)
  const tasks = (lot?.tasks ?? []).slice()
  const target = tasks.find((t) => t.id === taskId)
  if (!target || !target.scheduled_start || !target.scheduled_end) {
    return { affected: [], nextDatesById: new Map(), oldCompletion: null, newCompletion: null, newEnd: null, duration: 0 }
  }

  const duration = Math.max(1, Number(nextDuration) || 1)
  const oldDuration = Math.max(
    1,
    helpers.businessDaysBetweenInclusive(target.scheduled_start, target.scheduled_end) || Number(target.duration ?? 1) || 1,
  )
  const delta = duration - oldDuration
  const newEnd = formatISODate(helpers.addWorkDays(target.scheduled_start, duration - 1))

  const sorted = tasks.slice().sort(bySortOrder)
  const nextDatesById = new Map()
  const affected = []

  const shouldShift = (t) => {
    if (t.id === target.id) return true
    if (t.status === 'complete') return false
    const isAfter = (t.sort_order ?? 0) > (target.sort_order ?? 0)
    return t.track === target.track && isAfter
  }

  for (const t of sorted) {
    if (!t?.scheduled_start || !t?.scheduled_end) continue
    if (!shouldShift(t)) continue
    if (t.id === target.id) {
      if (t.scheduled_end !== newEnd) {
        nextDatesById.set(t.id, { start: t.scheduled_start, end: newEnd })
        affected.push({
          task_id: t.id,
          task_name: t.name,
          old_start: t.scheduled_start,
          new_start: t.scheduled_start,
          old_end: t.scheduled_end,
          new_end: newEnd,
          track: t.track,
        })
      }
      continue
    }
    if (delta === 0) continue
    const newStart = shiftByWorkdays(t.scheduled_start, delta, helpers)
    const newTaskEnd = shiftByWorkdays(t.scheduled_end, delta, helpers)
    nextDatesById.set(t.id, { start: newStart, end: newTaskEnd })
    affected.push({
      task_id: t.id,
      task_name: t.name,
      old_start: t.scheduled_start,
      new_start: newStart,
      old_end: t.scheduled_end,
      new_end: newTaskEnd,
      track: t.track,
    })
  }

  const resolveStart = (t) => nextDatesById.get(t.id)?.start ?? t.scheduled_start
  const resolveEnd = (t) => nextDatesById.get(t.id)?.end ?? t.scheduled_end

  const oldCompletion = maxDateLike(sorted.map((t) => t.scheduled_end).filter(Boolean))

  const blockingEnd = maxDateLike(
    sorted
      .filter((t) => t.track !== 'final' && t.blocks_final !== false)
      .map((t) => resolveEnd(t))
      .filter(Boolean),
  )
  const newFinalStartBase = blockingEnd
  const newFinalStart = newFinalStartBase ? formatISODate(helpers.addWorkDays(newFinalStartBase, 1)) : null
  const finalTasks = sorted.filter((t) => t.track === 'final').sort(bySortOrder)
  if (newFinalStart && finalTasks.length) {
    const firstFinal = finalTasks[0]
    const currentFinalStart = resolveStart(firstFinal)
    if (currentFinalStart) {
      const shift = workdayDiff(currentFinalStart, newFinalStart, helpers)
      if (shift !== 0) {
        for (const ft of finalTasks) {
          const baseStart = resolveStart(ft)
          const baseEnd = resolveEnd(ft)
          if (!baseStart || !baseEnd) continue
          const bumpedStart = shiftByWorkdays(baseStart, shift, helpers)
          const bumpedEnd = shiftByWorkdays(baseEnd, shift, helpers)
          nextDatesById.set(ft.id, { start: bumpedStart, end: bumpedEnd })
          if (!affected.some((a) => a.task_id === ft.id)) {
            affected.push({
              task_id: ft.id,
              task_name: ft.name,
              old_start: ft.scheduled_start,
              new_start: bumpedStart,
              old_end: ft.scheduled_end,
              new_end: bumpedEnd,
              track: ft.track,
            })
          }
        }
      }
    }
  }

  const newCompletion = maxDateLike(sorted.map((t) => resolveEnd(t)).filter(Boolean))

  return {
    affected,
    nextDatesById,
    oldCompletion,
    newCompletion,
    newEnd,
    duration,
  }
}

export const previewDurationChange = (lot, taskId, nextDuration, orgSettings) => {
  const shift = buildDurationShift(lot, taskId, nextDuration, orgSettings)
  return {
    affected: shift.affected,
    oldCompletion: shift.oldCompletion,
    newCompletion: shift.newCompletion,
    newEnd: shift.newEnd,
  }
}

export const applyDurationChange = (lot, taskId, nextDuration, orgSettings) => {
  const shift = buildDurationShift(lot, taskId, nextDuration, orgSettings)
  const affectedById = shift.nextDatesById
  if (!lot) return lot

  const now = new Date().toISOString()
  const nextTasks = (lot.tasks ?? []).map((t) => {
    const hit = affectedById.get(t.id)
    const next = hit
      ? { ...t, scheduled_start: hit.start, scheduled_end: hit.end, updated_at: now }
      : { ...t }
    if (t.id === taskId) {
      next.duration = shift.duration
    }
    return next
  })

  return { ...lot, tasks: refreshReadyStatuses(nextTasks) }
}

export const applyManualStartDate = (lot, taskId, nextStartIso, orgSettings) => {
  if (!lot || !taskId || !nextStartIso) return lot
  const helpers = makeWorkdayHelpers(orgSettings)
  const { getNextWorkDay, addWorkDays } = helpers
  const normalized = (() => {
    const next = getNextWorkDay(nextStartIso) ?? parseISODate(nextStartIso)
    return next ? formatISODate(next) : ''
  })()
  if (!normalized) return lot

  const now = new Date().toISOString()
  const nextTasks = (lot.tasks ?? []).map((t) => {
    if (t.id !== taskId) return t
    const duration = Math.max(1, Number(t.duration ?? 1) || 1)
    const newEnd = formatISODate(addWorkDays(normalized, duration - 1))
    return {
      ...t,
      scheduled_start: normalized,
      scheduled_end: newEnd,
      updated_at: now,
    }
  })

  return { ...lot, tasks: refreshReadyStatuses(nextTasks) }
}

export const canParallelizeTasks = (lot, taskIds) => {
  void lot
  void taskIds
  return {
    ok: true,
    blocked: [],
    reason: '',
  }
}

export const buildParallelStartPlan = (lot, taskIds, orgSettings, options = {}) => {
  const selected = Array.from(new Set(taskIds ?? [])).filter(Boolean)
  if (!lot || selected.length === 0) {
    return { status: 'invalid', blockedDependencies: [], previewsById: {}, targetStartIso: '' }
  }

  const originalById = new Map((lot.tasks ?? []).map((t) => [t.id, t]))
  const workingLot = { ...lot, tasks: (lot.tasks ?? []).map((t) => ({ ...t })) }
  const selectedSet = new Set(selected)

  const blockedDependencies = canParallelizeTasks(workingLot, selected).blocked ?? []
  if (blockedDependencies.length > 0 && !options.overrideDependencies) {
    return { status: 'blocked', blockedDependencies, previewsById: {}, targetStartIso: '' }
  }

  const selectedTasks = workingLot.tasks.filter((t) => selectedSet.has(t.id))
  const targetDate = minDateLike(selectedTasks.map((t) => t.scheduled_start).filter(Boolean))
  const targetStartIso = targetDate ? formatISODate(targetDate) : ''
  if (!targetStartIso) {
    return { status: 'invalid', blockedDependencies, previewsById: {}, targetStartIso: '' }
  }

  const previewsById = {}
  const ordered = selectedTasks.slice().sort(bySortOrder)

  for (const task of ordered) {
    const preview = buildReschedulePreview({ lot: workingLot, task, targetDateIso: targetStartIso, org: orgSettings })
    previewsById[task.id] = preview
    if (preview.dependency_violation) {
      return { status: 'invalid', blockedDependencies, previewsById, targetStartIso, earliest: preview.earliest_start }
    }
    const byId = new Map((preview.affected ?? []).map((a) => [a.task_id, a]))
    workingLot.tasks = (workingLot.tasks ?? []).map((t) => {
      const hit = byId.get(t.id)
      if (!hit) return t
      return { ...t, scheduled_start: hit.new_start, scheduled_end: hit.new_end }
    })
  }

  const impacted = []
  for (const task of workingLot.tasks ?? []) {
    const original = originalById.get(task.id)
    if (!original) continue
    if (original.scheduled_start !== task.scheduled_start || original.scheduled_end !== task.scheduled_end) {
      impacted.push({
        task_id: task.id,
        task_name: task.name,
        old_start: original.scheduled_start,
        new_start: task.scheduled_start,
        old_end: original.scheduled_end,
        new_end: task.scheduled_end,
        track: task.track,
      })
    }
  }

  return {
    status: 'ok',
    blockedDependencies,
    previewsById,
    targetStartIso,
    nextLot: workingLot,
    impacted,
  }
}

export const applyListReorder = (lot, dragTaskId, dropTaskId, orgSettings) => {
  if (!lot || !dragTaskId || !dropTaskId || dragTaskId === dropTaskId) return lot
  const tasks = (lot.tasks ?? []).map((t) => ({ ...t }))
  const dragTask = tasks.find((t) => t.id === dragTaskId)
  const dropTask = tasks.find((t) => t.id === dropTaskId)
  if (!dragTask || !dropTask || dragTask.track !== dropTask.track) return lot
  if (!dragTask.scheduled_start || !dropTask.scheduled_start) return lot

  const { getNextWorkDay, addWorkDays } = makeWorkdayHelpers(orgSettings)
  const normalizeStart = (iso) => {
    const next = getNextWorkDay(iso) ?? parseISODate(iso)
    return next ? formatISODate(next) : iso
  }

  const dragStart = normalizeStart(dragTask.scheduled_start)
  const dropStart = normalizeStart(dropTask.scheduled_start)
  const dragDuration = Math.max(1, Number(dragTask.duration ?? 1) || 1)
  const dropDuration = Math.max(1, Number(dropTask.duration ?? 1) || 1)
  const dragEnd = formatISODate(addWorkDays(dropStart, dragDuration - 1))
  const dropEnd = formatISODate(addWorkDays(dragStart, dropDuration - 1))

  const trackTasks = tasks.filter((t) => t.track === dragTask.track).sort(bySortOrder)
  const orderById = new Map(trackTasks.map((t, idx) => [t.id, Number(t.sort_order ?? 0) || idx + 1]))
  const dragOrder = orderById.get(dragTaskId)
  const dropOrder = orderById.get(dropTaskId)

  const now = new Date().toISOString()
  const nextTasks = tasks.map((t) => {
    if (t.id === dragTask.id) {
      return {
        ...t,
        scheduled_start: dropStart,
        scheduled_end: dragEnd,
        sort_order: dropOrder ?? t.sort_order,
        updated_at: now,
      }
    }
    if (t.id === dropTask.id) {
      return {
        ...t,
        scheduled_start: dragStart,
        scheduled_end: dropEnd,
        sort_order: dragOrder ?? t.sort_order,
        updated_at: now,
      }
    }
    if (dragOrder !== undefined && dropOrder !== undefined && t.track === dragTask.track) {
      if (t.sort_order === dragOrder) return { ...t, sort_order: dropOrder }
      if (t.sort_order === dropOrder) return { ...t, sort_order: dragOrder }
    }
    return t
  })

  const trackTasksReflow = nextTasks.filter((t) => t.track === dragTask.track).sort(bySortOrder)
  const hasBuffer = trackTasksReflow.some((t) => isBufferTask(t))
  if (hasBuffer) {
    const earliest = minDateLike(trackTasksReflow.map((t) => t.scheduled_start).filter(Boolean))
    let cursor = normalizeStart(earliest ? formatISODate(earliest) : lot.start_date)
    const now = new Date().toISOString()
    if (cursor) {
      for (const task of trackTasksReflow) {
        const duration = Math.max(1, Number(task.duration ?? 1) || 1)
        task.scheduled_start = cursor
        task.scheduled_end = formatISODate(addWorkDays(cursor, duration - 1))
        task.updated_at = now
        cursor = formatISODate(addWorkDays(task.scheduled_end, 1))
      }
    }
  }

  return { ...lot, tasks: refreshReadyStatuses(nextTasks) }
}

export const previewDelayImpact = (lot, taskId, delayDays, orgSettings) => {
  const { addWorkDays } = makeWorkdayHelpers(orgSettings)
  const tasks = (lot?.tasks ?? []).slice().sort(bySortOrder)
  const delayed = tasks.find((t) => t.id === taskId)
  if (!delayed) return { affected: [], newCompletion: null }

  const delay = Math.max(1, Number(delayDays) || 1)
  const delayedTrack = delayed.track
  const delayedSort = delayed.sort_order ?? 0

  const oldCompletion = maxDateLike(tasks.map((t) => t.scheduled_end).filter(Boolean))

  const affected = []

  for (const task of tasks) {
    const oldStart = task.scheduled_start
    const oldEnd = task.scheduled_end
    if (!oldStart || !oldEnd) continue

    let shouldShift = false
    const isAfterDelayed = (task.sort_order ?? 0) > delayedSort
    if (task.id === delayed.id) shouldShift = true
    else if (task.track === delayedTrack && isAfterDelayed) shouldShift = true

    if (!shouldShift) continue

    const newStart = formatISODate(addWorkDays(oldStart, delay))
    const newEnd = formatISODate(addWorkDays(oldEnd, delay))
    affected.push({
      task_id: task.id,
      task_name: task.name,
      old_start: oldStart,
      new_start: newStart,
      old_end: oldEnd,
      new_end: newEnd,
      track: task.track,
    })
  }

  // Final phase may need additional shift if it is now waiting on bottleneck
  const shiftedTasks = tasks.map((t) => {
    const hit = affected.find((a) => a.task_id === t.id)
    if (!hit) return t
    return { ...t, scheduled_start: hit.new_start, scheduled_end: hit.new_end }
  })

  const newBlockingEnd = maxDateLike(
    shiftedTasks
      .filter((t) => t.track !== 'final' && t.blocks_final !== false)
      .map((t) => t.scheduled_end)
      .filter(Boolean),
  )
  const newFinalStartBase = newBlockingEnd
  const newFinalStart = newFinalStartBase ? addWorkDays(newFinalStartBase, 1) : null

  const finalTasks = shiftedTasks.filter((t) => t.track === 'final').sort(bySortOrder)
  if (newFinalStart && finalTasks.length) {
    const firstFinal = finalTasks[0]
    if (firstFinal.scheduled_start && parseISODate(newFinalStart) > parseISODate(firstFinal.scheduled_start)) {
      const shiftDays = Math.max(0, Math.abs(Number(delay)))
      for (const ft of finalTasks) {
        if (!ft.scheduled_start || !ft.scheduled_end) continue
        const oldStart = ft.scheduled_start
        const oldEnd = ft.scheduled_end
        const hit = affected.find((a) => a.task_id === ft.id)
        const baseStart = hit?.new_start ?? oldStart
        const baseEnd = hit?.new_end ?? oldEnd

        const bumpedStart = formatISODate(addWorkDays(baseStart, shiftDays))
        const bumpedEnd = formatISODate(addWorkDays(baseEnd, shiftDays))
        if (!affected.some((a) => a.task_id === ft.id)) {
          affected.push({
            task_id: ft.id,
            task_name: ft.name,
            old_start: oldStart,
            new_start: bumpedStart,
            old_end: oldEnd,
            new_end: bumpedEnd,
            track: ft.track,
          })
        }
      }
    }
  }

  const completion = maxDateLike(
    shiftedTasks.map((t) => {
      const hit = affected.find((a) => a.task_id === t.id)
      return hit?.new_end ?? t.scheduled_end
    }),
  )

  return { affected, oldCompletion, newCompletion: completion }
}

export const applyDelayCascade = (lot, taskId, delayDays, reason, notes, orgSettings) => {
  const { addWorkDays } = makeWorkdayHelpers(orgSettings)
  const delay = Math.max(1, Number(delayDays) || 1)
  const nextLot = { ...lot }
  const tasks = (lot?.tasks ?? []).map((t) => ({ ...t }))
  const sorted = tasks.slice().sort(bySortOrder)
  const delayed = tasks.find((t) => t.id === taskId)
  if (!delayed) return nextLot

  const delayedTrack = delayed.track
  const delayedSort = delayed.sort_order ?? 0

  const shiftTask = (t) => {
    if (!t.scheduled_start || !t.scheduled_end) return
    t.scheduled_start = formatISODate(addWorkDays(t.scheduled_start, delay))
    t.scheduled_end = formatISODate(addWorkDays(t.scheduled_end, delay))
  }

  // Update the delayed task
  delayed.delay_days = delay
  delayed.delay_reason = reason
  delayed.delay_notes = notes ?? null
  delayed.delay_logged_at = new Date().toISOString()
  delayed.status = 'delayed'
  shiftTask(delayed)

  // Cascade within track / dependents
  for (const task of sorted) {
    if (task.id === delayed.id) continue
    const isAfterDelayed = (task.sort_order ?? 0) > delayedSort
    const sameTrack = task.track === delayedTrack && isAfterDelayed
    if (sameTrack) shiftTask(task)
  }

  // Final track waits on bottleneck
  const finalStartBase = maxDateLike(
    sorted
      .filter((t) => t.track !== 'final' && t.blocks_final !== false)
      .map((t) => t.scheduled_end)
      .filter(Boolean),
  )
  const newFinalStart = finalStartBase ? addWorkDays(finalStartBase, 1) : null

  const finalTasks = sorted.filter((t) => t.track === 'final').sort(bySortOrder)
  if (newFinalStart && finalTasks.length) {
    const firstFinal = finalTasks[0]
    if (firstFinal.scheduled_start && parseISODate(newFinalStart) > parseISODate(firstFinal.scheduled_start)) {
      // shift all final tasks forward by delay workdays (simple)
      for (const ft of finalTasks) shiftTask(ft)
    }
  }

  nextLot.tasks = tasks
  return { ...nextLot, tasks: refreshReadyStatuses(tasks) }
}

export const applyBufferAfterTask = (lot, taskId, bufferDays, orgSettings) => {
  if (!lot) return lot
  const days = Math.max(0, Number(bufferDays) || 0)
  if (days <= 0) return lot
  const helpers = makeWorkdayHelpers(orgSettings)
  const tasks = (lot.tasks ?? []).map((t) => ({ ...t }))
  const target = tasks.find((t) => t.id === taskId)
  if (!target) return lot

  const targetTrack = target.track
  const targetSort = target.sort_order ?? 0

  const shiftTask = (t, delta) => {
    if (!t.scheduled_start || !t.scheduled_end) return
    t.scheduled_start = shiftByWorkdays(t.scheduled_start, delta, helpers)
    t.scheduled_end = shiftByWorkdays(t.scheduled_end, delta, helpers)
  }

  for (const task of tasks) {
    const isAfter = (task.sort_order ?? 0) > targetSort
    if (task.track === targetTrack && isAfter) {
      shiftTask(task, days)
    }
  }

  // If this track blocks final, ensure final track doesn't start before new bottleneck
  const blockingEnd = maxDateLike(
    tasks
      .filter((t) => t.track !== 'final' && t.blocks_final !== false)
      .map((t) => t.scheduled_end)
      .filter(Boolean),
  )
  const finalTasks = tasks.filter((t) => t.track === 'final').sort(bySortOrder)
  if (blockingEnd && finalTasks.length > 0) {
    const desiredFinalStart = formatISODate(helpers.addWorkDays(blockingEnd, 1))
    const firstFinal = finalTasks[0]
    if (firstFinal?.scheduled_start) {
      const shift = workdayDiff(firstFinal.scheduled_start, desiredFinalStart, helpers)
      if (shift > 0) {
        for (const ft of finalTasks) shiftTask(ft, shift)
      }
    }
  }

  return { ...lot, tasks: refreshReadyStatuses(tasks) }
}

export const insertBufferTaskAfter = (lot, afterTaskId, bufferDays, orgSettings, options = {}) => {
  if (!lot) return lot
  const days = Math.max(1, Number(bufferDays) || 1)
  const helpers = makeWorkdayHelpers(orgSettings)
  const tasks = (lot.tasks ?? []).map((t) => ({ ...t }))
  const target = tasks.find((t) => t.id === afterTaskId)
  if (!target || !target.scheduled_end) return lot

  const track = target.track ?? 'misc'
  const targetSort = Number(target.sort_order ?? 0) || 0

  const bufferStart = formatISODate(helpers.addWorkDays(target.scheduled_end, 1))
  const bufferEnd = formatISODate(helpers.addWorkDays(bufferStart, days - 1))

  const now = new Date().toISOString()
  const bufferTask = {
    id: options.buffer_task_id ?? uuid(),
    lot_id: lot.id,
    name: 'Buffer',
    description: 'Schedule buffer',
    trade: 'buffer',
    phase: 'misc',
    track,
    sub_id: null,
    duration: days,
    scheduled_start: bufferStart,
    scheduled_end: bufferEnd,
    actual_start: null,
    actual_end: null,
    status: 'pending',
    delay_days: 0,
    delay_reason: null,
    delay_notes: null,
    delay_logged_at: null,
    delay_logged_by: null,
    requires_inspection: false,
    inspection_type: null,
    inspection_id: null,
    is_outdoor: false,
    is_critical_path: false,
    blocks_final: false,
    lead_time_days: 0,
    photos: [],
    documents: [],
    notes: [],
    sort_order: targetSort + 0.5,
    created_at: now,
    updated_at: now,
    is_buffer: true,
    kind: 'buffer',
  }

  // Shift later tasks in track forward by buffer days.
  for (const task of tasks) {
    const isAfter = (Number(task.sort_order ?? 0) || 0) > targetSort
    if (task.track === track && isAfter) {
      if (task.status === 'complete' || task.status === 'in_progress') continue
      if (!task.scheduled_start || !task.scheduled_end) continue
      task.scheduled_start = shiftByWorkdays(task.scheduled_start, days, helpers)
      task.scheduled_end = shiftByWorkdays(task.scheduled_end, days, helpers)
      task.updated_at = now
    }
  }

  tasks.push(bufferTask)

  // Normalize sort order for the track so we don't store fractional sort_order.
  const trackTasks = tasks.filter((t) => (t.track ?? 'misc') === track).sort(bySortOrder)
  for (let idx = 0; idx < trackTasks.length; idx++) {
    trackTasks[idx].sort_order = idx + 1
  }

  // If this track blocks final, ensure final track doesn't start before new bottleneck.
  const blockingEnd = maxDateLike(
    tasks
      .filter((t) => t.track !== 'final' && t.blocks_final !== false)
      .map((t) => t.scheduled_end)
      .filter(Boolean),
  )
  const finalTasks = tasks.filter((t) => t.track === 'final').sort(bySortOrder)
  if (blockingEnd && finalTasks.length > 0) {
    const desiredFinalStart = formatISODate(helpers.addWorkDays(blockingEnd, 1))
    const firstFinal = finalTasks[0]
    if (firstFinal?.scheduled_start) {
      const shift = workdayDiff(firstFinal.scheduled_start, desiredFinalStart, helpers)
      if (shift > 0) {
        for (const ft of finalTasks) {
          if (!ft.scheduled_start || !ft.scheduled_end) continue
          ft.scheduled_start = shiftByWorkdays(ft.scheduled_start, shift, helpers)
          ft.scheduled_end = shiftByWorkdays(ft.scheduled_end, shift, helpers)
          ft.updated_at = now
        }
      }
    }
  }

  return { ...lot, tasks: refreshReadyStatuses(tasks) }
}

export const removeBufferTask = (lot, bufferTaskId, orgSettings) => {
  if (!lot) return lot
  const helpers = makeWorkdayHelpers(orgSettings)
  const tasks = (lot.tasks ?? []).map((t) => ({ ...t }))
  const buffer = tasks.find((t) => t.id === bufferTaskId)
  if (!buffer || !isBufferTask(buffer)) return lot

  const days = Math.max(1, Number(buffer.duration ?? 1) || 1)
  const track = buffer.track ?? 'misc'
  const sort = Number(buffer.sort_order ?? 0) || 0

  const nextTasks = tasks.filter((t) => t.id !== bufferTaskId)
  const now = new Date().toISOString()

  for (const task of nextTasks) {
    const isAfter = (Number(task.sort_order ?? 0) || 0) > sort
    if (task.track === track && isAfter) {
      if (task.status === 'complete' || task.status === 'in_progress') continue
      if (!task.scheduled_start || !task.scheduled_end) continue
      task.scheduled_start = shiftByWorkdays(task.scheduled_start, -days, helpers)
      task.scheduled_end = shiftByWorkdays(task.scheduled_end, -days, helpers)
      task.updated_at = now
    }
  }

  return { ...lot, tasks: refreshReadyStatuses(nextTasks) }
}

export const normalizeTrackSortOrderBySchedule = (lot, track) => {
  if (!lot) return lot
  const resolvedTrack = track ?? 'misc'
  const tasks = (lot.tasks ?? []).map((t) => ({ ...t }))
  const groupIds = new Set()

  const getStartMs = (t) => (t?.scheduled_start ? parseISODate(t.scheduled_start)?.getTime() ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY)
  const getEndMs = (t) => (t?.scheduled_end ? parseISODate(t.scheduled_end)?.getTime() ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY)

  const group = tasks
    .filter((t) => (t.track ?? 'misc') === resolvedTrack)
    .slice()
    .sort((a, b) => {
      const aStart = getStartMs(a)
      const bStart = getStartMs(b)
      if (aStart !== bStart) return aStart - bStart

      const aEnd = getEndMs(a)
      const bEnd = getEndMs(b)
      if (aEnd !== bEnd) return aEnd - bEnd

      // Preserve existing ordering when dates tie (important for parallelized tasks).
      const so = bySortOrder(a, b)
      if (so !== 0) return so

      const nameCmp = String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
      if (nameCmp !== 0) return nameCmp
      return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
    })

  for (let idx = 0; idx < group.length; idx++) {
    group[idx].sort_order = idx + 1
    groupIds.add(group[idx].id)
  }

  const normalizedById = new Map(group.map((t) => [t.id, t]))
  const nextTasks = tasks.map((t) => {
    if (!groupIds.has(t.id)) return t
    return normalizedById.get(t.id) ?? t
  })

  return { ...lot, tasks: refreshReadyStatuses(nextTasks) }
}

export const rebuildTrackSchedule = (lot, track, orgSettings, options = {}) => {
  if (!lot) return lot
  const helpers = makeWorkdayHelpers(orgSettings)
  const { getNextWorkDay, addWorkDays } = helpers

  const tasks = (lot.tasks ?? []).map((t) => ({ ...t }))
  const resolvedTrack = track ?? 'misc'

  const normalizeIso = (iso) => {
    if (!iso) return null
    const next = getNextWorkDay(iso) ?? parseISODate(iso)
    return next ? formatISODate(next) : iso
  }

  const scheduleGroup = (group, startIsoLike) => {
    let cursorIso = normalizeIso(startIsoLike)
    if (!cursorIso) return
    for (const task of group.sort(bySortOrder)) {
      const duration = Math.max(1, Number(task.duration ?? 1) || 1)
      task.scheduled_start = cursorIso
      task.scheduled_end = formatISODate(addWorkDays(cursorIso, duration - 1))
      cursorIso = formatISODate(addWorkDays(task.scheduled_end, 1))
    }
  }

  const group = tasks.filter((t) => (t.track ?? 'misc') === resolvedTrack)
  if (group.length > 0) {
    const providedStart = normalizeIso(options.start_date ?? options.startDateIso ?? '')
    const derivedStart =
      providedStart ??
      (() => {
        const earliest = minDateLike(group.map((t) => t.scheduled_start).filter(Boolean))
        if (earliest) return formatISODate(earliest)
        return normalizeIso(lot.start_date)
      })()
    scheduleGroup(group, derivedStart)
  }

  // Keep the final track anchored to the non-final bottleneck.
  const blockingEnd = maxDateLike(
    tasks
      .filter((t) => t.track !== 'final' && t.blocks_final !== false)
      .map((t) => t.scheduled_end)
      .filter(Boolean),
  )
  const finalTasks = tasks.filter((t) => t.track === 'final')
  if (blockingEnd && finalTasks.length > 0) {
    const desiredFinalStart = formatISODate(addWorkDays(blockingEnd, 1))
    scheduleGroup(finalTasks, desiredFinalStart)
  }

  return { ...lot, tasks: refreshReadyStatuses(tasks) }
}

export const canCompleteTask = (task, inspections, photoRequirements) => {
  void task
  void inspections
  void photoRequirements
  return true
}

export const getBlockedInspectionTypesForTask = (taskName) =>
  INSPECTION_TYPES.filter((t) => t.blocksNext === taskName).map((t) => t.code)

export const hasPassedInspection = (inspections, inspectionType) =>
  (inspections ?? []).some((i) => i.type === inspectionType && i.result === 'pass')

export const canStartTask = (task, schedule, inspections) => {
  void schedule
  void inspections
  return Boolean(task) && task.status !== 'complete'
}

export const deriveTaskStatus = (task, schedule, inspections) => {
  void schedule
  void inspections
  if (!task) return 'pending'
  const status = task.status ?? 'pending'
  if (status === 'complete') return 'complete'
  if (status === 'in_progress') return 'in_progress'
  if (status === 'delayed') return 'delayed'
  if (status === 'blocked') return 'blocked'
  if (status === 'ready') return 'ready'
  return 'pending'
}

export const refreshReadyStatuses = (tasks) => {
  const list = (tasks ?? []).map((t) => ({ ...t }))
  const byTrack = new Map()
  for (const task of list) {
    const track = task.track ?? 'misc'
    const group = byTrack.get(track) ?? []
    group.push(task)
    byTrack.set(track, group)
  }

  const isEligible = (task) => !isBufferTask(task) && !['complete', 'in_progress', 'delayed', 'blocked'].includes(task.status)

  for (const group of byTrack.values()) {
    const eligible = group.filter(isEligible)
    if (eligible.length === 0) continue
    eligible.sort((a, b) => {
      const aDate = a.scheduled_start ? parseISODate(a.scheduled_start)?.getTime() ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
      const bDate = b.scheduled_start ? parseISODate(b.scheduled_start)?.getTime() ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
      if (aDate !== bDate) return aDate - bDate
      return (Number(a.sort_order ?? 0) || 0) - (Number(b.sort_order ?? 0) || 0)
    })
    const nextReady = eligible[0]
    for (const task of eligible) {
      task.status = task.id === nextReady.id ? 'ready' : 'pending'
    }
  }

  return list
}

export const calculateLotProgress = (lot) => {
  const tasks = lot?.tasks ?? []
  const completed = tasks.filter((t) => t.status === 'complete')

  const manual = lot?.manual_milestones ?? {}

  const isAchieved = (m) => {
    if (!m) return false
    if (m.manual) return Boolean(manual?.[m.id])
    if (m.id === 'rough_complete') {
      const roughTasks = tasks.filter((t) => t.phase === 'mechanical' && String(t.name).startsWith('Rough '))
      if (roughTasks.length === 0) return false
      return roughTasks.every((t) => t.status === 'complete')
    }
    if (!m.trigger) return false
    const triggerTask = tasks.find((t) => t.name === m.trigger)
    return triggerTask?.status === 'complete'
  }

  const achievedPct = Math.max(0, ...MILESTONES.filter(isAchieved).map((m) => Number(m.pct) || 0))
  if (achievedPct > 0) return achievedPct

  const first = MILESTONES.slice().sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0)).find((m) => (m.pct ?? 0) > 0) ?? { pct: 8 }
  if (completed.length > 0 && tasks.length > 0) {
    return Math.round((completed.length / tasks.length) * Number(first.pct ?? 8))
  }
  return 0
}

export const getCurrentMilestone = (lot) => {
  const tasks = lot?.tasks ?? []
  const manual = lot?.manual_milestones ?? {}

  const isAchieved = (m) => {
    if (!m) return false
    if (m.manual) return Boolean(manual?.[m.id])
    if (m.id === 'rough_complete') {
      const roughTasks = tasks.filter((t) => t.phase === 'mechanical' && String(t.name).startsWith('Rough '))
      if (roughTasks.length === 0) return false
      return roughTasks.every((t) => t.status === 'complete')
    }
    if (!m.trigger) return false
    const triggerTask = tasks.find((t) => t.name === m.trigger)
    return triggerTask?.status === 'complete'
  }

  const achieved = MILESTONES.filter(isAchieved).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
  return achieved[0] ?? MILESTONES.slice().sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0))[0]
}

export const getPredictedCompletionDate = (lot) =>
  maxDateLike((lot?.tasks ?? []).map((t) => t.scheduled_end).filter(Boolean))

export const calculateTargetCompletionDate = (startDateIso, buildDays, orgSettings) => {
  const { getNextWorkDay, addWorkDays } = makeWorkdayHelpers(orgSettings)
  const start = getNextWorkDay(startDateIso)
  if (!start) return null
  const days = Math.max(1, Number(buildDays) || 1)
  return formatISODate(addWorkDays(start, days - 1))
}

export const startLotFromTemplate = ({
  lot,
  start_date,
  model_type,
  plan_id,
  job_number,
  custom_fields,
  address,
  permit_number,
  hard_deadline,
  template,
  orgSettings,
  subcontractors,
  draftTasks,
  draft_tasks,
  build_days_override,
}) => {
  const { getNextWorkDay } = makeWorkdayHelpers(orgSettings)
  const normalizedStart = start_date ? formatISODate(getNextWorkDay(start_date) ?? start_date) : null
  if (!normalizedStart) return lot

  const baseBuildDays = Math.max(1, Number(template?.build_days ?? lot.build_days ?? 1) || 1)
  const overrideBuildDaysRaw = Number(build_days_override)
  const hasBuildDaysOverride = Number.isFinite(overrideBuildDaysRaw) && overrideBuildDaysRaw > 0
  const overrideBuildDays = hasBuildDaysOverride ? Math.max(1, Math.round(overrideBuildDaysRaw)) : null

  const providedTasks = (draftTasks ?? draft_tasks ?? []).map((t) => ({ ...t }))
  const baseTasks =
    providedTasks.length > 0 ? providedTasks : buildLotTasksFromTemplate(lot.id, normalizedStart, template, orgSettings)
  const shouldRescaleTemplateTasks = providedTasks.length === 0 && overrideBuildDays !== null && overrideBuildDays !== baseBuildDays
  if (shouldRescaleTemplateTasks) {
    scaleTemplateTaskDurationsToTarget(baseTasks, overrideBuildDays, orgSettings)
    applyTemplateTrackScheduling(baseTasks, normalizedStart, orgSettings)
  }
  const tasksWithSubs = assignSubsToTasks(baseTasks, subcontractors)
  const nextTasks = refreshReadyStatuses(tasksWithSubs)

  const effectiveBuildDays = overrideBuildDays ?? baseBuildDays
  const target_completion_date = calculateTargetCompletionDate(normalizedStart, effectiveBuildDays, orgSettings)

  return {
    ...lot,
    status: 'in_progress',
    start_date: normalizedStart,
    model_type: model_type ?? lot.model_type ?? '',
    plan_id: plan_id ?? lot.plan_id ?? null,
    job_number: job_number ?? lot.job_number ?? '',
    address: address ?? lot.address ?? '',
    permit_number: permit_number ?? lot.permit_number ?? null,
    hard_deadline: hard_deadline ?? lot.hard_deadline ?? null,
    build_days: effectiveBuildDays ?? lot.build_days,
    target_completion_date,
    custom_fields: custom_fields ?? lot.custom_fields ?? {},
    tasks: nextTasks,
    inspections: [],
    punch_list: null,
    daily_logs: lot.daily_logs ?? [],
    change_orders: lot.change_orders ?? [],
    material_orders: lot.material_orders ?? [],
    documents: lot.documents ?? [],
    photos: lot.photos ?? [],
    manual_milestones: lot.manual_milestones ?? {},
    spec_acknowledgements: lot.spec_acknowledgements ?? {},
    spec_dismissals: lot.spec_dismissals ?? {},
    schedule_changes: lot.schedule_changes ?? [],
  }
}
