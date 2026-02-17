import { IDB_SNAPSHOT_META_KEY, STORAGE_KEY } from './storage.js'
import { getSyncV2Cursor, metaGet, metaSet, outboxList } from './localDb.js'
import { sha256Hex } from './checksum.js'

export const BASELINE_SCHEMA_VERSION = 1
export const BASELINE_DEFAULT_ID = 'demo_baseline_v1'
export const BASELINE_ACTIVE_ARTIFACT_KEY = 'baseline:artifact:v1'
export const BASELINE_LAST_RESTORE_POINT_KEY = 'baseline:restore_point:last'
export const BASELINE_METADATA_KEY = 'baseline:metadata:v1'

const detectSourceDevice = () => {
  try {
    if (typeof navigator === 'undefined') return 'unknown-device'
    const platform = String(navigator.platform ?? '').trim()
    const ua = String(navigator.userAgent ?? '').trim()
    return [platform, ua].filter(Boolean).join(' | ').slice(0, 420) || 'unknown-device'
  } catch {
    return 'unknown-device'
  }
}

const buildBaselineProtection = (metadata) => ({
  enabled: true,
  baseline_id: metadata?.baseline_id ?? BASELINE_DEFAULT_ID,
  created_at: metadata?.created_at ?? null,
  checksum: metadata?.checksum ?? '',
  org_id: metadata?.org_id ?? null,
  restore_point: metadata?.restore_point ?? null,
  mode: 'protected',
})

const baselineChecksumState = (state) => {
  if (!state || typeof state !== 'object') return state
  const sync = state.sync && typeof state.sync === 'object' ? state.sync : null
  if (!sync) return state
  const { baseline_meta: _baselineMeta, baseline_protection: _baselineProtection, ...restSync } = sync
  return {
    ...state,
    sync: restSync,
  }
}

export const withBaselineMetadata = (state, metadata) => {
  if (!state || typeof state !== 'object') return state
  const prevSync = state.sync ?? {}
  return {
    ...state,
    sync: {
      ...prevSync,
      baseline_meta: metadata,
      baseline_protection: buildBaselineProtection(metadata),
    },
  }
}

export const verifyBaselineArtifact = async (artifact) => {
  const metadata = artifact?.metadata ?? null
  const state = artifact?.state ?? null
  if (!metadata || !state || typeof state !== 'object') {
    return { ok: false, expected: '', actual: '', reason: 'invalid_artifact' }
  }

  const expected = String(metadata.checksum ?? '').trim()
  const actual = await sha256Hex(baselineChecksumState(state))
  if (!expected) return { ok: false, expected: '', actual, reason: 'missing_checksum' }
  if (actual === expected) return { ok: true, expected, actual, reason: '' }

  // Backward compatibility for any previously exported artifact that hashed the full state object.
  const fallbackActual = await sha256Hex(state)
  if (fallbackActual === expected) return { ok: true, expected, actual: fallbackActual, reason: '' }

  return { ok: false, expected, actual, reason: 'checksum_mismatch' }
}

export const buildBaselineArtifact = async ({
  state,
  baselineId = BASELINE_DEFAULT_ID,
  orgId = null,
  sourceDevice = null,
  label = 'baseline_capture',
} = {}) => {
  if (!state || typeof state !== 'object') {
    throw new Error('Cannot capture baseline: missing app state.')
  }

  const createdAt = new Date().toISOString()
  const checksum = await sha256Hex(baselineChecksumState(state))
  const idbSnapshot = await metaGet(IDB_SNAPSHOT_META_KEY)
  const idbSnapshotChecksum = idbSnapshot?.state ? await sha256Hex(idbSnapshot.state) : ''
  const outbox = await outboxList()
  const syncCursor = await getSyncV2Cursor()

  const metadata = {
    baseline_id: String(baselineId || BASELINE_DEFAULT_ID),
    created_at: createdAt,
    checksum,
    source_device: sourceDevice || detectSourceDevice(),
    org_id: orgId ?? null,
    restore_point: {
      label: String(label || 'baseline_capture'),
      storage_key: STORAGE_KEY,
      idb_snapshot_key: IDB_SNAPSHOT_META_KEY,
      sync_v2_cursor: syncCursor ?? null,
      outbox_count: outbox.length,
    },
  }

  return {
    schema_version: BASELINE_SCHEMA_VERSION,
    metadata,
    state: withBaselineMetadata(state, metadata),
    idb_mirror: {
      saved_at: idbSnapshot?.saved_at ?? null,
      checksum: idbSnapshotChecksum || null,
    },
    idb_outbox: outbox,
    sync_v2_cursor: syncCursor ?? null,
  }
}

export const persistBaselineArtifact = async (artifact) => {
  if (!artifact || typeof artifact !== 'object') throw new Error('Invalid baseline artifact.')
  await metaSet(BASELINE_ACTIVE_ARTIFACT_KEY, artifact)
  if (artifact.metadata) {
    await metaSet(BASELINE_METADATA_KEY, artifact.metadata)
  }
}

export const loadBaselineArtifact = async () => {
  const artifact = await metaGet(BASELINE_ACTIVE_ARTIFACT_KEY)
  return artifact && typeof artifact === 'object' ? artifact : null
}

export const loadBaselineMetadata = async () => {
  const metadata = await metaGet(BASELINE_METADATA_KEY)
  return metadata && typeof metadata === 'object' ? metadata : null
}

export const persistRestorePoint = async (artifact) => {
  if (!artifact || typeof artifact !== 'object') return
  await metaSet(BASELINE_LAST_RESTORE_POINT_KEY, artifact)
}

export const loadRestorePoint = async () => {
  const artifact = await metaGet(BASELINE_LAST_RESTORE_POINT_KEY)
  return artifact && typeof artifact === 'object' ? artifact : null
}

export const baselineArtifactToJson = (artifact) => JSON.stringify(artifact, null, 2)
