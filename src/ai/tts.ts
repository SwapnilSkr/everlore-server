import { env } from '../config/env'

export type TtsResponseFormat = 'mp3' | 'pcm'

export interface TtsRequest {
  model: string
  input: string
  voice: string
  responseFormat?: TtsResponseFormat
  speed?: number
  signal?: AbortSignal
  /** OpenRouter provider passthrough (e.g. OpenAI `instructions`, Azure `style`). */
  provider?: Record<string, unknown>
}

export interface TtsResult {
  data: Buffer
  contentType: string
  generationId: string | null
}

const FORMAT_MIME: Record<TtsResponseFormat, string> = {
  mp3: 'audio/mpeg',
  pcm: 'audio/pcm',
}

/**
 * Synthesize speech via OpenRouter's `/api/v1/audio/speech` endpoint (OpenAI-compatible).
 * Returns raw audio bytes — not JSON. See everlore-docs/server/TTS_MODELS.md.
 */
export async function synthesizeSpeech(req: TtsRequest): Promise<TtsResult> {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured')
  }

  const responseFormat = req.responseFormat ?? 'mp3'
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.input,
    voice: req.voice,
    response_format: responseFormat,
  }
  if (req.speed != null) body.speed = req.speed
  if (req.provider) body.provider = req.provider

  const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://everlore.app',
      'X-Title': 'Everlore',
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })

  const generationId = res.headers.get('X-Generation-Id')

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    let detail = errText.slice(0, 400)
    try {
      const parsed = JSON.parse(errText) as { error?: { message?: string } }
      if (parsed.error?.message) detail = parsed.error.message
    } catch {
      /* raw text */
    }
    throw new Error(`TTS failed (${res.status}): ${detail}`)
  }

  const contentType = res.headers.get('Content-Type') || FORMAT_MIME[responseFormat]
  const data = Buffer.from(await res.arrayBuffer())
  if (data.length === 0) {
    throw new Error('TTS returned empty audio body')
  }

  return { data, contentType, generationId }
}
