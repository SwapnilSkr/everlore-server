import { env } from '../config/env'

/**
 * Talking and scene video via OpenRouter (`POST /api/v1/videos`,
 * `GET /videos/{id}`, `GET /videos/{id}/content`) — the shapes the probes
 * established. HeyGen takes the portrait and the audio as `input_references`
 * and rejects `first_frame`; scene models take a `first_frame` still.
 * The audio URL must be a reachable HTTPS URL (our CDN URL serves).
 */

export interface VideoSubmitOpts {
  model?: string
  prompt: string
  /** First-frame still for image-to-video scene shots. Never a portrait. */
  firstFrameUrl?: string
  /** Portrait + voice clip for the HeyGen line shot. */
  inputReferences?: Array<{ type: 'image_url' | 'audio_url'; url: string }>
  duration?: number
  resolution?: string
  aspectRatio?: string
  generateAudio?: boolean
  signal?: AbortSignal
}

export interface VideoStatus {
  jobId: string
  status: string
  generationId: string | null
  costUsd?: number
}

const headers = () => ({
  Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://everloreapp.com',
  'X-Title': 'Everlore',
})

export async function submitVideo(opts: VideoSubmitOpts): Promise<{ jobId: string; status: string }> {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured')
  const body: Record<string, unknown> = {
    model: opts.model || process.env.MEDIA_VIDEO_MODEL || 'heygen/avatar-iv',
    prompt: opts.prompt,
  }
  if (opts.duration !== undefined) body.duration = opts.duration
  if (opts.resolution !== undefined) body.resolution = opts.resolution
  if (opts.aspectRatio !== undefined) body.aspect_ratio = opts.aspectRatio
  if (opts.generateAudio !== undefined) body.generate_audio = opts.generateAudio
  // HeyGen rejects frame images; scene shots require one. Exactly one path.
  if (opts.firstFrameUrl) {
    body.frame_images = [{ type: 'image_url', image_url: { url: opts.firstFrameUrl }, frame_type: 'first_frame' }]
  }
  if (opts.inputReferences?.length) {
    body.input_references = opts.inputReferences.map((ref) => ref.type === 'image_url'
      ? { type: 'image_url', image_url: { url: ref.url } }
      : { type: 'audio_url', audio_url: { url: ref.url } })
  }
  const res = await fetch('https://openrouter.ai/api/v1/videos', {
    method: 'POST', headers: headers(), body: JSON.stringify(body), signal: opts.signal,
  })
  const json = await res.json().catch(() => ({})) as { id?: string; status?: string; error?: { message?: string } }
  if (!res.ok) throw new Error(`Video submit failed (${res.status}): ${(json.error?.message || res.statusText).slice(0, 300)}`)
  if (typeof json.id !== 'string') throw new Error('Video submit returned no job id')
  return { jobId: json.id, status: typeof json.status === 'string' ? json.status : 'pending' }
}

export async function pollVideo(jobId: string, opts: { signal?: AbortSignal } = {}): Promise<VideoStatus> {
  const res = await fetch(`https://openrouter.ai/api/v1/videos/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://everloreapp.com', 'X-Title': 'Everlore' },
    signal: opts.signal,
  })
  const json = await res.json().catch(() => ({})) as {
    status?: string; generation_id?: string; usage?: { cost?: number }; error?: unknown
  }
  if (!res.ok) throw new Error(`Video poll failed (${res.status})`)
  const status = typeof json.status === 'string' ? json.status : 'unknown'
  const cost = json.usage && typeof json.usage.cost === 'number' && json.usage.cost >= 0 ? json.usage.cost : undefined
  return {
    jobId,
    status,
    generationId: typeof json.generation_id === 'string' ? json.generation_id : null,
    ...(cost !== undefined ? { costUsd: cost } : {}),
  }
}

/** Wait for completion; throws on failed/cancelled/expired or on deadline. */
export async function awaitVideo(
  jobId: string,
  opts: { pollMs?: number; attempts?: number; signal?: AbortSignal } = {},
): Promise<VideoStatus> {
  const pollMs = opts.pollMs ?? 15000
  const attempts = opts.attempts ?? 40
  let last: VideoStatus = { jobId, status: 'pending', generationId: null }
  for (let i = 0; i < attempts; i++) {
    last = await pollVideo(jobId, opts)
    if (last.status === 'completed') return last
    if (['failed', 'cancelled', 'expired'].includes(last.status)) {
      throw new Error(`Video ${last.status}`)
    }
    await Bun.sleep(pollMs)
  }
  throw new Error('Video polling deadline; job left running, never resubmitted')
}

export async function downloadVideo(jobId: string, opts: { index?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
  const res = await fetch(
    `https://openrouter.ai/api/v1/videos/${encodeURIComponent(jobId)}/content?index=${opts.index ?? 0}`,
    { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://everloreapp.com', 'X-Title': 'Everlore' }, signal: opts.signal },
  )
  if (!res.ok) throw new Error(`Video download failed (${res.status})`)
  const data = Buffer.from(await res.arrayBuffer())
  if (!data.length) throw new Error('Video download returned empty bytes')
  return data
}
