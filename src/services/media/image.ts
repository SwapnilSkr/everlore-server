import { env } from '../../config/env'
import { ProviderRefusalError, providerRefusal, sniffImageContentType, type MediaImageReference, type MediaImageResult } from '../../ai/image'
import { imageModel, imageSafetyTolerance } from './config'

/** Media-only transport: provider tolerance never changes the world-cover path. */
export async function generateMediaImage(
  prompt: string,
  opts: {
    model?: string
    aspectRatio?: string
    reference?: MediaImageReference
    signal?: AbortSignal
    /** null omits the parameter for a provider-default comparison. */
    safetyTolerance?: number | null
  } = {},
): Promise<MediaImageResult> {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured')
  }
  const model = opts.model || imageModel()
  const body: Record<string, unknown> = {
    model,
    prompt,
    aspect_ratio: opts.aspectRatio || '9:16',
    n: 1,
  }
  const tolerance = opts.safetyTolerance === undefined ? imageSafetyTolerance() : opts.safetyTolerance
  if (tolerance !== null) {
    if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > 5) throw new Error('Invalid media image safety tolerance')
    body.safety_tolerance = tolerance
  }
  if (opts.reference) {
    body.input_references = [{
      type: 'image_url',
      image_url: { url: `data:${opts.reference.contentType};base64,${opts.reference.data.toString('base64')}` },
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
    signal: opts.signal ?? AbortSignal.timeout(120000),
  })
  const generationId = res.headers.get('X-Generation-Id')
  const json = await res.json().catch(() => ({})) as {
    data?: Array<{ b64_json?: string; url?: string }>
    usage?: { cost?: number }
    error?: { message?: string; code?: unknown }
  }
  if (!res.ok) {
    const refusal = providerRefusal(res.status, json)
    // The classification stays structural (status + envelope), but the reason
    // is never dropped: the provider's message rides on the error so the
    // caller can store it sanitised on the unseen and rejection rows.
    if (refusal !== null) throw new ProviderRefusalError(res.status, refusal, json.error?.message || `Image generation refused (${res.status}:${refusal})`)
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
  // Flux 3 Klein returns JPEG (no output_format knob); older runs were PNG.
  // Sniff, never assume — unknown bytes are an error, never a guess.
  const contentType = sniffImageContentType(data)
  return { data, contentType, generationId, ...(cost !== undefined ? { costUsd: cost } : {}) }
}
