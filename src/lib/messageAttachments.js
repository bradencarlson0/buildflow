import { getBlob, putBlob } from './idb.js'
import { supabase } from './supabaseClient.js'

const canvasToBlob = (canvas, type, quality) =>
  new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality)
  })

const decodeImageSource = async (blob) => {
  if (typeof createImageBitmap === 'function') {
    try {
      // Prefer honoring EXIF orientation when supported (especially on iOS).
      return await createImageBitmap(blob, { imageOrientation: 'from-image' })
    } catch {
      return await createImageBitmap(blob)
    }
  }

  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    if (img.decode) await img.decode()
    else {
      await new Promise((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Failed to decode image'))
      })
    }
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

export const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(blob)
  })

export const getPhotoBlob = async (photo) => {
  const blobId = String(photo?.blob_id ?? '').trim()
  if (!blobId) return null

  try {
    const cached = await getBlob(blobId)
    if (cached) return cached
  } catch {
    // ignore cache errors
  }

  const bucket = String(photo?.storage_bucket ?? '').trim()
  const path = String(photo?.storage_path ?? '').trim()
  if (!bucket || !path) return null

  try {
    const { data, error } = await supabase.storage.from(bucket).download(path)
    if (error) throw error
    if (!data) return null
    try {
      await putBlob(blobId, data)
    } catch {
      // ignore cache write failures
    }
    return data
  } catch {
    return null
  }
}

export const compressImageBlobForMessaging = async (
  blob,
  { maxDimPx = 1600, jpegQuality = 0.82 } = {},
) => {
  const source = await decodeImageSource(blob)
  const width = source?.width ?? source?.naturalWidth ?? 0
  const height = source?.height ?? source?.naturalHeight ?? 0
  if (!width || !height) throw new Error('Invalid image dimensions')

  const scale = Math.min(1, maxDimPx / Math.max(width, height))
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not available')
  ctx.drawImage(source, 0, 0, targetW, targetH)

  if (typeof source?.close === 'function') {
    try {
      source.close()
    } catch {
      // ignore
    }
  }

  const out = await canvasToBlob(canvas, 'image/jpeg', jpegQuality)
  if (!out) throw new Error('Failed to compress image')
  return { blob: out, mime: 'image/jpeg' }
}

export const buildPunchMessageAttachments = async ({
  lot,
  photos,
  maxAttachments = 6,
  maxDimPx = 1600,
  jpegQuality = 0.82,
  onProgress,
} = {}) => {
  const list = Array.isArray(photos) ? photos.filter((p) => p?.id) : []

  let failedCount = 0
  let omittedCount = 0

  const attachments = []
  for (let i = 0; i < list.length; i++) {
    if (attachments.length >= maxAttachments) {
      omittedCount = list.length - i
      break
    }

    const photo = list[i]
    onProgress?.({ current: i + 1, total: Math.min(list.length, maxAttachments), photoId: photo.id })

    const blob = await getPhotoBlob(photo)
    if (!blob) {
      failedCount += 1
      continue
    }

    let payloadBlob = blob
    let mime = String(photo?.mime ?? blob.type ?? '').trim() || 'application/octet-stream'

    try {
      const compressed = await compressImageBlobForMessaging(blob, { maxDimPx, jpegQuality })
      payloadBlob = compressed.blob
      mime = compressed.mime
    } catch {
      // If compression fails, fall back to the original blob.
    }

    try {
      const base64 = await blobToBase64(payloadBlob)
      const lotId = String(lot?.id ?? '').trim() || 'lot'
      attachments.push({
        base64,
        mime,
        fileName: `punch_${lotId}_${photo.id}.${mime === 'image/jpeg' ? 'jpg' : 'bin'}`,
      })
    } catch {
      failedCount += 1
    }
  }

  return { attachments, failedCount, omittedCount }
}

