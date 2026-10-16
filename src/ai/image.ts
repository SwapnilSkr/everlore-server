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
 * and scene stills use generateMediaImage below: a different model on a
 * different endpoint. The two must never share a function again.
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
  /** PNG/JPEG bytes for an identity or wardrobe reference (sent as a data URL). */
  data: Buffer
  contentType: string
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

/**
 * Generate a media image (portrait, picture, scene still) via OpenRouter's
 * dedicated image API (`POST /api/v1/images`), the shape the media probe
 * established: `prompt`, `aspect_ratio`, `n`, `input_references`. References
 * are generated/authored portraits only — never uploads, never covers —
 * enforced by the caller (safety.ts), not by this transport.
 */
export async function generateMediaImage(
  prompt: string,
  opts: {
    model?: string
    aspectRatio?: string
    reference?: MediaImageReference
    signal?: AbortSignal
  } = {},
): Promise<MediaImageResult> {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured')
  }
  const model = opts.model || process.env.MEDIA_IMAGE_MODEL || 'black-forest-labs/flux.2-klein-4b'
  const body: Record<string, unknown> = {
    model,
    prompt,
    aspect_ratio: opts.aspectRatio || '9:16',
    n: 1,
  }
  if (opts.reference) {
    const mime = opts.reference.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    body.input_references = [{
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${opts.reference.data.toString('base64')}` },
    }]
  }
  const res = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://everloreapp.com',
      'X-Title': 'Everlore',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  const generationId = res.headers.get('X-Generation-Id')
  const json = await res.json().catch(() => ({})) as {
    data?: Array<{ b64_json?: string; url?: string }>
    usage?: { cost?: number }
    error?: { message?: string; code?: unknown }
  }
  if (!res.ok) {
    const refusal = providerRefusal(res.status, json)
    if (refusal !== null) throw new ProviderRefusalError(res.status, refusal, `Image generation refused (${res.status}:${refusal})`)
    throw new Error(`Image generation failed (${res.status}): ${(json.error?.message || res.statusText).slice(0, 300)}`)
  }
  const item = json.data?.[0]
  const bytes = item?.b64_json
  if (!bytes || typeof bytes !== 'string') {
    throw new Error('Image model returned no inline bytes')
  }
  const data = Buffer.from(bytes, 'base64')
  if (!data.length) throw new Error('Image model returned empty bytes')
  const cost = typeof json.usage?.cost === 'number' && json.usage.cost >= 0 ? json.usage.cost : undefined
  return { data, contentType: 'image/png', generationId, ...(cost !== undefined ? { costUsd: cost } : {}) }
}
