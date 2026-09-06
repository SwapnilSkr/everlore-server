import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'
import { env } from '../config/env'

/**
 * Object storage for generated media (avatars / chat backgrounds).
 *
 * The S3 bucket is PRIVATE (all public access blocked); objects are served only
 * through CloudFront (Origin Access Control). So we upload to S3 and return the
 * CDN URL — never an s3:// or direct bucket URL. AWS credentials + region come
 * from the standard env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY picked
 * up by the SDK automatically; AWS_REGION / S3_BUCKET / CDN_BASE_URL explicit).
 */

let _client: S3Client | null = null
function client(): S3Client {
  if (!_client) _client = new S3Client({ region: env.AWS_REGION })
  return _client
}

export function isStorageConfigured(): boolean {
  return Boolean(env.S3_BUCKET && env.CDN_BASE_URL)
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export const storageService = {
  /** Resolve a manifest key through CloudFront; never return a bucket URL. */
  urlForKey(key: string): string | null {
    if (!isStorageConfigured() || !key) return null
    return `${env.CDN_BASE_URL.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`
  },
  /** Checks a durable key before an authoring upload. */
  async exists(key: string): Promise<boolean> {
    if (!isStorageConfigured() || !key) return false
    try {
      await client().send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
      return true
    } catch (error: any) {
      const status = error?.$metadata?.httpStatusCode
      // S3 returns 403 rather than 404 for an absent exact key when this role
      // lacks ListBucket. A present key still returns success, so this keeps
      // revisioned authoring uploads possible without granting bucket listing.
      if (status === 403 || status === 404 || error?.name === 'NotFound') return false
      throw error
    }
  },
  /**
   * Upload bytes under a key prefix and return the public CDN URL.
   * `previews/` objects auto-expire via the bucket lifecycle rule; promote a
   * chosen one to a durable prefix with {@link promotePreview} on save.
   */
  async upload(
    data: Buffer,
    contentType: string,
    opts: { prefix?: string; key?: string } = {},
  ): Promise<{ url: string; key: string }> {
    if (!isStorageConfigured()) {
      throw new Error('Storage not configured (S3_BUCKET / CDN_BASE_URL missing)')
    }
    const ext = EXT[contentType] || 'png'
    const prefix = (opts.prefix || 'previews').replace(/^\/+|\/+$/g, '')
    const key = opts.key || `${prefix}/${randomUUID()}.${ext}`

    await client().send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: data,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    )
    return { url: `${env.CDN_BASE_URL.replace(/\/+$/, '')}/${key}`, key }
  },

  async delete(key: string): Promise<void> {
    if (!isStorageConfigured() || !key) return
    try {
      await client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
    } catch {
      // best-effort
    }
  },

  /**
   * Promote a chosen `previews/` image to the durable `media/` prefix so the
   * lifecycle rule won't expire it. Idempotent: returns the URL unchanged if it
   * isn't one of our preview URLs (already durable, or external). Best-effort
   * deletes the old preview object afterward.
   */
  async promote(url: string): Promise<string> {
    if (!isStorageConfigured()) return url
    const key = this.keyFromUrl(url)
    if (!key || !key.startsWith('previews/')) return url
    const destKey = key.replace(/^previews\//, 'media/')
    try {
      await client().send(
        new CopyObjectCommand({
          Bucket: env.S3_BUCKET,
          CopySource: `${env.S3_BUCKET}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
          Key: destKey,
          MetadataDirective: 'COPY',
        }),
      )
    } catch (e) {
      // If the copy fails, keep the original URL rather than losing the image.
      return url
    }
    void this.delete(key)
    return `${env.CDN_BASE_URL.replace(/\/+$/, '')}/${destKey}`
  },

  /** Map a CDN URL back to its S3 object key (or null if it isn't ours). */
  keyFromUrl(url: string): string | null {
    if (!url || !env.CDN_BASE_URL) return null
    const base = env.CDN_BASE_URL.replace(/\/+$/, '')
    return url.startsWith(base + '/') ? url.slice(base.length + 1) : null
  },
}
