import { env } from '../config/env'
import { AI_MODELS } from './models'

/**
 * Generate an image via OpenRouter (default Seedream 4.5 — see AI_MODELS.image).
 *
 * Image-capable models use the chat-completions endpoint with
 * `modalities: ["image"]` and return the bytes as a base64 data URL in
 * `choices[0].message.images[].image_url.url`. (`["image"]` is the universal
 * form — image-only models like Seedream reject `["image","text"]`.) The OpenAI
 * SDK doesn't type these fields, so we call the REST endpoint directly. Returns
 * decoded bytes + mime.
 *
 * This is the world-cover path (image.service.ts). Media portraits, pictures
 * and scene stills use generateMediaImage in services/media/image.ts: a
 * different model on a different endpoint. The two must never share a function again.
 */
export async function generateImage(
  prompt: string,
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<{ data: Buffer; contentType: string }> {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured')
  }
  const model = opts.model || AI_MODELS.image

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://everloreapp.com',
      'X-Title': 'Everlore',
    },
    body: JSON.stringify({
      model,
      modalities: ['image'],
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: opts.signal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Image generation failed (${res.status}): ${body.slice(0, 300)}`)
  }

  const json: any = await res.json()
  const url: string | undefined = json?.choices?.[0]?.message?.images?.[0]?.image_url?.url
  if (!url || typeof url !== 'string') {
    throw new Error('Image model returned no image (it may not support image output)')
  }

  // Expected: data:image/png;base64,<...>
  const match = /^data:(?<mime>[^;]+);base64,(?<b64>.+)$/s.exec(url)
  if (!match?.groups) {
    throw new Error('Unexpected image data URL format from model')
  }
  return {
    data: Buffer.from(match.groups.b64, 'base64'),
    contentType: match.groups.mime || 'image/png',
  }
}

export interface MediaImageReference {
  /** JPEG/PNG/WebP bytes for an identity or wardrobe reference (sent as a data URL). */
  data: Buffer
  contentType: string
}

/**
 * The image type sniffed from the magic bytes — never a guess from a model
 * id, a URL or a caller label. Flux 3 Klein returns JPEG (ff d8 ff); older
 * kept portraits are PNG; WebP stays supported. Anything else throws.
 */
export type SniffedImageContentType = 'image/jpeg' | 'image/png' | 'image/webp'

export function sniffImageContentType(data: Buffer): SniffedImageContentType {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    data.length >= 12
    && data.toString('ascii', 0, 4) === 'RIFF'
    && data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  throw new Error('Image bytes are of an unknown type')
}

/** The storage/upload extension matching a sniffed image type. */
export function imageExtensionFor(contentType: string): '.jpg' | '.png' | '.webp' {
  if (contentType === 'image/jpeg') return '.jpg'
  if (contentType === 'image/png') return '.png'
  if (contentType === 'image/webp') return '.webp'
  throw new Error(`Unknown image content type: ${contentType}`)
}

/** Downloaded bytes (an older PNG portrait, a new JPEG one) as a reference. */
export function asMediaImageReference(data: Buffer): MediaImageReference {
  return { data, contentType: sniffImageContentType(data) }
}

/**
 * A provider content refusal, detected structurally: an HTTP client error
 * carrying the provider's error envelope. Never matched on message words —
 * the message text is provider-specific ("Black Forest Labs blocked this
 * request…", "flagged for graphic violence") while the envelope shape is
 * stable. Recorded shape (OpenRouter `/api/v1/images`, Oct 16 2026 live run):
 * HTTP 400 with a JSON body of `{"error": {"message": "…", "code": 400}}`.
 * The `code` field mirrors the status when present; classification rests on
 * status plus envelope presence, never on any word in the message. A 4xx
 * without that envelope (malformed body, unknown shape) stays a plain
 * failure so a transport bug cannot hide as a refusal.
 */
export class ProviderRefusalError extends Error {
  readonly status: number
  readonly code: string | null
  /** message is the provider's own message (stored sanitised by the caller),
   * falling back to a status:code label when the envelope carries none. */
  constructor(status: number, code: unknown, message: string) {
    super(message)
    this.name = 'ProviderRefusalError'
    this.status = status
    this.code = typeof code === 'string' || typeof code === 'number' ? String(code) : null
  }
}

/**
 * Structural refusal test shared by the image and video transports: a 400 or
 * 422 carrying the provider's error object is a refusal of the request. Every
 * other status (5xx, 429, timeouts) is a failure, never a refusal.
 */
export function providerRefusal(status: number, body: unknown): string | null {
  if ((status === 400 || status === 422) && body && typeof body === 'object'
    && 'error' in body && body.error && typeof body.error === 'object') {
    const code = (body.error as { code?: unknown }).code
    return typeof code === 'string' || typeof code === 'number' ? String(code) : `http_${status}`
  }
  return null
}

export interface MediaImageResult {
  data: Buffer
  contentType: string
  width?: number
  height?: number
  generationId: string | null
  /** Billed cost from the response usage, when the provider returns one. */
  costUsd?: number
}
