import sharp from 'sharp'
import { isDefaultCoverUrl } from '../constants/default-cover'
import { storageService } from '../services/storage.service'
import { COVER_THUMB_WIDTH, encodeImageThumb, thumbKey } from './image-encoding'
import { log } from './logger'

/**
 * The small copy of a template cover, stored beside it and shown on a list
 * card. A full cover is up to 2048 px and ~300 KB; four onboarding cards would
 * otherwise pull ~1.3 MB over a phone connection.
 *
 * Nothing here ever fails a save: a cover without a small copy is a card that
 * falls back to the full image, which is what every world had before this.
 */
const FETCH_TIMEOUT_MS = 8_000
const MAX_COVER_BYTES = 15 * 1024 * 1024
/** The pixels one cover may decode to; a decompression bomb is refused. */
const MAX_INPUT_PIXELS = 40_000_000

export interface CoverThumbDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  encode?: (image: sharp.Sharp, width: number) => Promise<Buffer>
  upload?: (data: Buffer, contentType: string, opts: { key: string }) => Promise<{ url: string; key: string }>
}

type CoverThumbPlan = { key: string } | { reason: string }

/** Where the small copy of this cover lives, or why there cannot be one. */
function coverThumbPlan(coverUrl: string | undefined | null): CoverThumbPlan {
  const url = (coverUrl || '').trim()
  if (!url) return { reason: 'no cover url' }
  // The shared fallback picture belongs to every world without a cover, so it
  // is never copied.
  if (isDefaultCoverUrl(url)) return { reason: 'the shared default cover' }
  const key = storageService.keyFromUrl(url)
  if (!key) return { reason: 'outside our storage' }
  const small = thumbKey(key, COVER_THUMB_WIDTH)
  if (!small) return { reason: 'not a WebP cover' }
  return { key: small }
}

/** The storage key a cover's 540 px copy is stored under, or null when the url
 *  is not one a small copy can be made from. Never throws, like its caller. */
export function coverThumbKey(coverUrl: string | undefined | null): string | null {
  try {
    const plan = coverThumbPlan(coverUrl)
    return 'key' in plan ? plan.key : null
  } catch {
    return null
  }
}

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}

/**
 * Read at most `maxBytes` of a response body, so a wrong object behind a cover
 * url cannot fill memory. Null when the body is larger than that.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') || '')
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length > maxBytes ? null : bytes
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * Make the 540 px WebP of a saved cover and return its CDN url. Null — never a
 * throw — when there is nothing to copy (an empty url, the shared default, a url
 * off our storage, a cover that is not WebP) or when fetching, encoding or
 * uploading fails, so a save still lands without it.
 */
export async function makeCoverThumb(
  coverUrl: string | undefined | null,
  deps: CoverThumbDeps = {},
): Promise<string | null> {
  const url = (coverUrl || '').trim()
  const doFetch = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const encode = deps.encode ?? encodeImageThumb
  const upload = deps.upload ?? ((data: Buffer, contentType: string, opts: { key: string }) =>
    storageService.upload(data, contentType, opts))
  let stage = 'plan'
  try {
    const plan = coverThumbPlan(url)
    if (!('key' in plan)) {
      log.warn('cover_thumb.skipped', { reason: plan.reason })
      return null
    }
    stage = 'fetch'
    const response = await doFetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`the CDN answered ${response.status}`)
    const bytes = await readBounded(response, MAX_COVER_BYTES)
    if (!bytes) throw new Error(`the cover is larger than ${MAX_COVER_BYTES} bytes`)
    stage = 'encode'
    const small = await encode(
      sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).rotate(),
      COVER_THUMB_WIDTH,
    )
    stage = 'upload'
    const stored = await upload(small, 'image/webp', { key: plan.key })
    return stored.url
  } catch (error) {
    // A storage helper that reads the environment can fail before the plan is
    // even made; every step is inside this guard so a save never sees it.
    log.warn('cover_thumb.failed', { stage, error: shortError(error) })
    return null
  }
}

export interface CoverWrite {
  /** The `$set` fields of this save: the cover, and its small copy beside it. */
  set: { image_url: string; image_thumb_url?: string }
  /** Present only when no small copy could be made, so the old one is removed. */
  unset: { image_thumb_url?: '' }
}

/**
 * The cover fields one save writes. The small copy always describes the cover
 * being saved, so without one the key is removed — never written as null or "",
 * both of which a client would render as a broken image.
 */
export function coverWrite(imageUrl: string, thumbUrl: string | null): CoverWrite {
  return thumbUrl
    ? { set: { image_url: imageUrl, image_thumb_url: thumbUrl }, unset: {} }
    : { set: { image_url: imageUrl }, unset: { image_thumb_url: '' } }
}

export interface CoverCleanupDeps {
  keyFromUrl?: (url: string) => string | null
  delete?: (key: string) => Promise<void> | void
}

/**
 * Best-effort removal of the small copy a new cover replaced, beside the old
 * cover's own removal. The object this save just wrote is never deleted —
 * re-picking a preview can resolve to the same cover key — and neither is the
 * shared default.
 */
export function deleteReplacedThumb(
  previousThumbUrl: string | undefined | null,
  nextThumbUrl: string | undefined | null,
  deps: CoverCleanupDeps = {},
): void {
  if (!previousThumbUrl) return
  const keyFromUrl = deps.keyFromUrl ?? ((url: string) => storageService.keyFromUrl(url))
  const remove = deps.delete ?? ((key: string) => storageService.delete(key))
  let previous: string | null
  try {
    if (isDefaultCoverUrl(previousThumbUrl)) return
    previous = keyFromUrl(previousThumbUrl)
  } catch {
    // The environment is unreadable; a stale object is not worth failing a save.
    return
  }
  if (!previous) return
  const next = nextThumbUrl ? keyFromUrl(nextThumbUrl) : null
  if (previous === next) return
  void remove(previous)
}
