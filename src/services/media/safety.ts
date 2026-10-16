import { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import { env } from '../../config/env'
import { callLLM } from '../../ai/client'
import { AI_MODELS } from '../../ai/models'
import type { MediaAssetDoc, MediaKind } from '../../models/media.model'
import { ffmpegPath, ffprobePath, moderationModel, visionModel } from './config'

/**
 * Safety (§7). These are gates, not prompts: a moderation check on the visual
 * description BEFORE generation, and a vision check AFTER generation on the
 * image — or on the first, middle and last frames of every shot of a video.
 * A rejection deletes the file, releases the slot, sends `media_unseen`, and
 * logs a count to `media_rejections`. Never charged when unseen.
 *
 * Model choice (owner review; live catalogue Oct 16 2026):
 * - moderation `openai/gpt-4o-mini` ($0.15/M in): OpenRouter has no dedicated
 *   moderation endpoint, and a structured verdict gives reason codes, not just
 *   flags. ≈ $0.0001 per gate.
 * - vision `google/gemini-2.5-flash-lite` ($0.10/M text, images billed per
 *   token): native image input, cheapest vision-capable model in the
 *   catalogue. ≈ $0.0002 per image, ≈ $0.0006 for a 3-frame video check.
 */

export type GateVerdict = { verdict: 'allow' | 'reject'; reason_code: string }

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason_code'],
  properties: {
    verdict: { type: 'string', enum: ['allow', 'reject'] },
    reason_code: { type: 'string' },
  },
} as const

const MODERATION_SYSTEM = [
  'You are the safety gate for illustrated story art. Every picture we show must be safe for everyone.',
  'Decide on the DESCRIPTION, which is what the painter will paint.',
  'Reject sexual content, nudity, minors in romantic or sexual situations, real people, or graphic gore.',
  'An intimate moment described as implied, clothed and non-explicit is ALLOWED: the rule moves it off-screen, it does not ban the scene.',
  'Return only JSON matching the schema.',
].join(' ')

const VISION_SYSTEM = [
  'You are the safety gate for illustrated story art. Look at the image and decide what it SHOWS.',
  'Reject nudity, sexual acts or sexualized posing, minors in romantic or sexual situations, graphic gore, or readable text anywhere in the frame.',
  'A fictional illustrated face is ALLOWED even when the painting is semi-photographic. Reject for real people only when the image is clearly a photograph of an actual public figure.',
  'A fully clothed embrace, hands, a closed door, a candle, rain on glass, or distant silhouettes are ALLOWED.',
  'Also report what you see: how many people are visible, whether any face fills a large share of the frame, whether any text is visible.',
  'Return only JSON: { verdict, reason_code, people_count, face_close_up, text_visible }.',
].join(' ')

const VISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason_code', 'people_count', 'face_close_up', 'text_visible'],
  properties: {
    verdict: { type: 'string', enum: ['allow', 'reject'] },
    reason_code: { type: 'string' },
    people_count: { type: 'number' },
    face_close_up: { type: 'boolean' },
    text_visible: { type: 'boolean' },
    wardrobe_match: { type: 'boolean' },
  },
} as const

export interface FrameCheck {
  verdict: 'allow' | 'reject'
  reason_code: string
  people_count: number
  face_close_up: boolean
  text_visible: boolean
  /** Same clothes and hair as the still reference, when one was supplied. */
  wardrobe_match?: boolean
}

export const safetyEffects = {
  call: callLLM,
  judge: judgeFrame,
  /** First/middle/last PNG frames of a video, via temp files (seekable, no pipe fragility). */
  frames: async (video: Buffer): Promise<Buffer[]> => {
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'everlore-frames-'))
    try {
      const src = join(dir, 'shot.mp4')
      await writeFile(src, video)
      const probe = Bun.spawnSync([ffprobePath(), '-v', 'error', '-show_entries',
        'format=duration', '-of', 'csv=p=0', src], { stdout: 'pipe', stderr: 'pipe' })
      const duration = Number(probe.stdout.toString().trim()) || 4
      const frames: Buffer[] = []
      for (const at of [0.2, duration / 2, Math.max(0.2, duration - 0.2)]) {
        const out = join(dir, `f-${at.toFixed(2)}.png`)
        const child = Bun.spawnSync([ffmpegPath(), '-v', 'error', '-ss', String(at),
          '-i', src, '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', out],
          { stdout: 'pipe', stderr: 'pipe' })
        if (child.exitCode !== 0) throw new Error(`Frame extraction failed at ${at}s`)
        frames.push(Buffer.from(await readFile(out)))
      }
      return frames
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  },
}

/**
 * The gates fail closed: a missing, misspelt or malformed verdict is never an
 * allow. Only `verdict === 'allow'` on a well-formed report passes; anything
 * else is a rejection (unseen) or a thrown error (failed). Never shown.
 */
function parseGateVerdict(raw: string): GateVerdict {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Gate returned no verdict')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Gate returned no verdict')
  const report = parsed as Record<string, unknown>
  if (report.verdict !== 'allow' && report.verdict !== 'reject') throw new Error('Gate returned no verdict')
  if (typeof report.reason_code !== 'string' || !report.reason_code) throw new Error('Gate returned no reason')
  return { verdict: report.verdict, reason_code: report.reason_code }
}

function parseFrameCheck(raw: string): FrameCheck {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Vision gate returned no report')
  }
  return validateFrameCheck(parsed)
}

/** The choke point: every frame report is validated here, whatever judge
 * produced it, so a malformed report can never pass as an allow. */
function validateFrameCheck(report: unknown): FrameCheck {
  if (!report || typeof report !== 'object') throw new Error('Vision gate returned no report')
  const r = report as Record<string, unknown>
  if (r.verdict !== 'allow' && r.verdict !== 'reject') throw new Error('Vision gate returned no verdict')
  if (typeof r.reason_code !== 'string' || !r.reason_code) throw new Error('Vision gate returned no reason')
  if (typeof r.people_count !== 'number' || !Number.isFinite(r.people_count)) {
    throw new Error('Vision gate returned no people count')
  }
  if (typeof r.face_close_up !== 'boolean' || typeof r.text_visible !== 'boolean') {
    throw new Error('Vision gate returned a malformed frame report')
  }
  if (r.wardrobe_match !== undefined && typeof r.wardrobe_match !== 'boolean') {
    throw new Error('Vision gate returned a malformed wardrobe report')
  }
  return {
    verdict: r.verdict,
    reason_code: r.reason_code,
    people_count: r.people_count,
    face_close_up: r.face_close_up,
    text_visible: r.text_visible,
    ...(r.wardrobe_match !== undefined ? { wardrobe_match: r.wardrobe_match } : {}),
  }
}

/** Gate before generation: the description, never the prose, is judged. */
export async function moderateDescription(description: string): Promise<GateVerdict> {
  const raw = await safetyEffects.call({
    model: moderationModel(),
    responseSchema: GATE_SCHEMA,
    timeoutMs: 30000,
    maxTokens: 256,
    temperature: 0,
    purpose: 'media_safety_pre',
    messages: [
      { role: 'system', content: MODERATION_SYSTEM },
      { role: 'user', content: description.slice(0, 2000) },
    ],
  })
  return parseGateVerdict(raw)
}

async function visionFrame(image: Buffer, contentType: string, reference?: { data: Buffer; contentType: string }): Promise<FrameCheck> {
  return validateFrameCheck(await safetyEffects.judge(image, contentType, reference))
}

/** Injectable for audits; production judges through the vision model. */
async function judgeFrame(image: Buffer, contentType: string, reference?: { data: Buffer; contentType: string }): Promise<FrameCheck> {
  const mime = contentType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  const parts: Array<Record<string, unknown>> = [
    { type: 'text', text: reference ? `${VISION_SYSTEM} A second reference image (the still this shot started from) follows: also report whether the visible people wear the same clothes and hair as the reference.` : VISION_SYSTEM },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
  ]
  if (reference) {
    const refMime = reference.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    parts.push({ type: 'image_url', image_url: { url: `data:${refMime};base64,${reference.data.toString('base64')}` } })
  }
  // The OpenAI SDK types no image_url parts; call the REST endpoint directly.
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://everloreapp.com',
      'X-Title': 'Everlore',
    },
    body: JSON.stringify({
      model: visionModel(),
      messages: [{
        role: 'user',
        content: parts,
      }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'frame_check', strict: false, schema: VISION_SCHEMA },
      },
      max_tokens: 256,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60000),
  })
  const json = await res.json().catch(() => ({})) as {
    choices?: Array<{ message?: { content?: string } }>; error?: { message?: string }
  }
  if (!res.ok) throw new Error(`Vision gate failed (${res.status}): ${(json.error?.message || '').slice(0, 200)}`)
  return parseFrameCheck(json.choices?.[0]?.message?.content ?? '')
}

/** Gate after generation on one image. Throws on a provider failure: an
 * unchecked image is never shown. Returns the frame report for the asset. */
export async function checkImage(image: Buffer, contentType: string): Promise<FrameCheck> {
  return visionFrame(image, contentType)
}

/**
 * One shot passes iff every frame is allowed, every frame counts the same
 * people as the plan, no face fills the frame and no text is visible — and
 * the wardrobe matches whenever anyone is visible at all. With nobody
 * visible the comparison is vacuous: there is nothing that can drift.
 */
export function judgeShotFrames(frames: FrameCheck[], expectedPeople: number): boolean {
  if (!frames.length) return false
  const counts = frames.map((f) => f.people_count)
  return frames.every((f) => f.verdict === 'allow')
    && counts.every((c) => c === counts[0] && c === expectedPeople)
    && frames.every((f) => !f.face_close_up && !f.text_visible)
    && (expectedPeople === 0 || frames.every((f) => f.wardrobe_match !== false))
}

/** Gate after generation on every shot of a video: first, middle, last frame.
 * Any rejected frame rejects the shot. Throws when frames cannot be read.
 * With a still reference, the last frame is also compared for wardrobe. */
export async function checkVideoFrames(
  video: Buffer,
  reference?: { data: Buffer; contentType: string },
): Promise<FrameCheck[]> {
  const frames = await safetyEffects.frames(video)
  const checks: FrameCheck[] = []
  for (const frame of frames) checks.push(await visionFrame(frame, 'image/png', reference))
  return checks
}

/**
 * The visual description (§7.1): a cheap model turns the moment into an SFW
 * description naming who is present by portrait reference. Passing looks go
 * into this prompt only. An intimate moment becomes implied and clothed —
 * and the gates below still judge the result, not the intention.
 */
export async function describeMoment(input: {
  prose: string
  present: Array<{ name: string; has_portrait: boolean }>
  passing_look: string
  framing: 'portrait' | 'scene' | 'wide_still'
  place: string
}): Promise<string> {
  const raw = await safetyEffects.call({
    model: AI_MODELS.metadata,
    timeoutMs: 30000,
    maxTokens: 512,
    temperature: 0.3,
    purpose: 'media_describe',
    messages: [{
      role: 'system',
      content: [
        'Describe one SFW illustration for a story moment, in two sentences.',
        'Begin with who is present, using exactly the names given ("Mira and Tomas in a tavern." or "No people: rain on an empty alley."). Then the framing, setting and mood.',
        'Clothes, dirt and blood from this turn may appear; lasting looks stay as given.',
        'If the moment is intimate, describe only what surrounds it: hands, a closing door, a candle, rain on glass, distant clothed silhouettes. Never the act or the body.',
        'If violent, describe tension and aftermath, never gore. Nobody underage. No text, no logos. Return the description only.',
      ].join(' '),
    }, {
      role: 'user',
      content: JSON.stringify({
        moment: input.prose.slice(0, 1500),
        present: input.present,
        passing_look: input.passing_look.slice(0, 300),
        framing: input.framing,
        place: input.place.slice(0, 300),
      }),
    }],
  })
  return raw.trim()
}

export async function logRejection(asset: Pick<MediaAssetDoc, '_id' | 'player_id' | 'kind'> & Partial<Pick<MediaAssetDoc, 'instance_id' | 'event_id'>>, stage: 'pre' | 'post' | 'provider', reason: string, model: string): Promise<void> {
  await mongoColl.mediaRejections().insertOne({
    _id: new ObjectId(),
    player_id: asset.player_id,
    instance_id: asset.instance_id,
    event_id: asset.event_id,
    kind: asset.kind as MediaKind,
    stage,
    reason,
    model,
    created_at: new Date(),
  })
}
