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
