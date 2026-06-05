import { env } from '../config/env'
import { storageService } from '../services/storage.service'

/** Fixed S3 key for the universal fallback cover (worlds + characters). */
export const DEFAULT_COVER_KEY = 'media/defaults/everlore-cover.webp'

/** CDN URL for the default cover, or '' when storage is not configured. */
export function defaultCoverUrl(): string {
  if (!env.CDN_BASE_URL) return ''
  return `${env.CDN_BASE_URL.replace(/\/+$/, '')}/${DEFAULT_COVER_KEY}`
}

export function isDefaultCoverUrl(url: string | undefined | null): boolean {
  if (!url) return false
  return storageService.keyFromUrl(url) === DEFAULT_COVER_KEY
}

/**
 * Promote a preview URL when present; otherwise return the static default cover.
 * Skipped image generation in Forge / Create Character flows land here.
 */
export async function resolveTemplateImageUrl(
  raw: string | undefined | null,
): Promise<string> {
  const trimmed = (raw || '').trim()
  if (trimmed) {
    const promoted = await storageService.promote(trimmed)
    if (promoted) return promoted
  }
  return defaultCoverUrl()
}
