import { callLLM } from '../../ai/client'

/**
 * The director pass (contract §3A.1). One premium-model call turns a turn into
 * a structured shot plan. The prompt below is the contract text in
 * `everlore-docs/server/MEDIA_DIRECTOR_PROMPT.md`, verbatim — prompt changes
 * go in the task report, never here. Code validates (§3A.2) and compiles
 * (§3A.3); the director never writes a model prompt directly.
 */

export const DIRECTOR_SYSTEM_PROMPT = `You are the film director for a short scene cut in an illustrated story. You turn one moment of prose into a precise shot plan. The cut has at most three shots: an OPENING scene shot, the LINE shot (the speaker saying their line, made elsewhere; you only frame it), and an optional CLOSING scene shot.

You direct for image-to-video models that work like this: each scene shot starts from a still image you describe, then moves for 2–4 seconds. They are good at one simple, continuous motion from a well-composed still. They break when asked for anything else. Direct to their strengths.

THE NON-NEGOTIABLE RULES
1. One shot, one idea. Each scene shot has exactly one camera move (from the allowed list) and at most one subject action. No cuts, no reveals of new people, no transformations inside a shot.
2. The still IS the first frame. Describe the still as the exact composition the shot starts from, and describe the motion as a change from that still ("the camera drifts closer to the door as rain runs off the gutter"). Never describe a different composition in the motion.
3. Nobody appears who is not in the still. State every visible person in the still, and say "no other people" if there are none. A person seen from behind or in silhouette is still a person: count them.
4. No faces up close in scene shots. Scene shots use only these framings: establishing wide, wide, medium-wide from behind or in profile, over-the-shoulder from behind, or insert/detail (hands, an object, a door, rain, light). The face belongs to the LINE shot only.
5. Continuity is fixed before any shot: write the continuity sheet first (wardrobe, hair, carried props, time of day, weather, light source and its direction, colour palette). Every shot obeys it word for word. Wardrobe never changes between shots.
6. Ground every shot in the prose. Each scene shot cites one sentence from the narration, copied exactly, that it visualises. If the narration has nothing worth showing before the line, the opening is an atmosphere insert of the place itself, citing the sentence that names the place.
7. Suggestive, never explicit. An intimate moment may be shown as sensual and suggestive: an embrace, a kiss, closeness, a lingering touch, revealing but covered clothing. Never nudity and never a sexual act; if the moment goes further, show what surrounds it: hands, a door closing, a candle, rain on glass. If it is violent, show tension and aftermath, never gore. Nobody who looks underage is ever shown in a sensual or suggestive way. No real people, no logos, no text on screen.
8. Paint, don't photograph. The world's art style is given; stills are paintings in that style.

PACING
The cut runs 8–14 seconds. Typical rhythm: opening 3–4 s, the line (fixed length, given), closing 2–3 s. Leave out the closing when nothing after the line is worth showing; a cut that ends on the line is often the strongest.

TRANSITIONS AND SOUND
Pick transitions only from: "cut", "dissolve_short" (8 frames), "dip_to_black" (12 frames). Default to "cut" into the line and "dissolve_short" out of it. Use "dip_to_black" only for an ending.
Choose the voice lead-in: how many seconds of the line's voice start under the end of the opening shot (a J-cut), from 0, 0.3 or 0.6. Use 0.3 or 0.6 when the opening builds toward the speaker.
Describe the ambient sound bed in a few words (rain on stone, a crackling fire). Never voices, never music with words.

OUTPUT
Return only JSON matching the schema you are given. Fill every field. Use the speaker's and others' names exactly as given in the input. Never invent ids.`

export const DIRECTOR_FRAMINGS = [
  'establishing_wide',
  'wide',
  'medium_wide_back',
  'medium_wide_profile',
  'over_shoulder_back',
  'insert_detail',
] as const
export const DIRECTOR_CAMERA_MOVES = [
  'static',
  'slow_push_in',
  'slow_pull_out',
  'slow_pan_left',
  'slow_pan_right',
  'slow_tilt_up',
  'slow_tilt_down',
] as const
export const DIRECTOR_DURATIONS = [2, 3, 4] as const
export const DIRECTOR_TRANSITIONS_IN = ['cut', 'dissolve_short'] as const
export const DIRECTOR_TRANSITIONS_OUT = ['cut', 'dissolve_short', 'dip_to_black'] as const
export const DIRECTOR_LEAD_INS = [0, 0.3, 0.6] as const

export interface DirectorShot {
  role: 'opening' | 'closing'
  evidence: string
  framing: string
  people_in_still: Array<{ name: string; placement: string; facing: string }>
  still: string
  camera_move: string
  subject_action: string
  environment_motion: string
  duration_s: number
}
export interface DirectorPlan {
  continuity: {
    wardrobe: string
    hair: string
    props: string
    time_of_day: string
    weather: string
    light: string
    palette: string
  }
  shots: DirectorShot[]
  line_shot: { transition_in: string; voice_lead_in_s: number }
  ending: { transition_out: string }
  ambient: string
}
export interface DirectorInput {
  art_style: string
  narration_before: string
  line: { speaker_name: string; spoken_text: string; duration_s: number }
  narration_after: string
  speaker: { appearance: string; passing_look: string }
  others_present: Array<{ name: string; appearance: string }>
  place: string
}

export const DIRECTOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['continuity', 'shots', 'line_shot', 'ending', 'ambient'],
  properties: {
    continuity: {
      type: 'object',
      additionalProperties: false,
      required: ['wardrobe', 'hair', 'props', 'time_of_day', 'weather', 'light', 'palette'],
      properties: {
        wardrobe: { type: 'string' },
        hair: { type: 'string' },
        props: { type: 'string' },
        time_of_day: { type: 'string' },
        weather: { type: 'string' },
        light: { type: 'string' },
        palette: { type: 'string' },
      },
    },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'evidence', 'framing', 'people_in_still', 'still', 'camera_move', 'subject_action', 'environment_motion', 'duration_s'],
        properties: {
          role: { type: 'string', enum: ['opening', 'closing'] },
          evidence: { type: 'string' },
          framing: { type: 'string', enum: [...DIRECTOR_FRAMINGS] },
          people_in_still: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'placement', 'facing'],
              properties: {
                name: { type: 'string' },
                placement: { type: 'string' },
                facing: { type: 'string', enum: ['away', 'profile', 'none'] },
              },
            },
          },
          still: { type: 'string' },
          camera_move: { type: 'string', enum: [...DIRECTOR_CAMERA_MOVES] },
          subject_action: { type: 'string' },
          environment_motion: { type: 'string' },
          duration_s: { type: 'number', enum: [...DIRECTOR_DURATIONS] },
        },
      },
    },
    line_shot: {
      type: 'object',
      additionalProperties: false,
      required: ['transition_in', 'voice_lead_in_s'],
      properties: {
        transition_in: { type: 'string', enum: [...DIRECTOR_TRANSITIONS_IN] },
        voice_lead_in_s: { type: 'number', enum: [...DIRECTOR_LEAD_INS] },
      },
    },
    ending: {
      type: 'object',
      additionalProperties: false,
      required: ['transition_out'],
      properties: {
        transition_out: { type: 'string', enum: [...DIRECTOR_TRANSITIONS_OUT] },
      },
    },
    ambient: { type: 'string' },
  },
} as const

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/**
 * Validation in code (contract §3A.2): the probe's glitches, closed
 * structurally. Names are resolved against the speaker and the present cast —
 * never a word list. Returns every violation; empty means the plan directs.
 */
export function validateDirectorPlan(plan: unknown, input: DirectorInput): string[] {
  const errors: string[] = []
  if (!plan || typeof plan !== 'object') return ['plan is not an object']
  const p = plan as Record<string, unknown>
  const continuity = p.continuity as Record<string, unknown> | undefined
  for (const key of ['wardrobe', 'hair', 'props', 'time_of_day', 'weather', 'light', 'palette']) {
    if (!continuity || !nonEmpty(continuity[key])) errors.push(`continuity.${key} is empty`)
  }
  const shots = Array.isArray(p.shots) ? p.shots as DirectorShot[] : undefined
  if (!shots) {
    errors.push('shots is not an array')
  } else {
    if (shots.filter((s) => s?.role === 'opening').length > 1) errors.push('more than one opening shot')
    if (shots.filter((s) => s?.role === 'closing').length > 1) errors.push('more than one closing shot')
    const known = new Set([input.line.speaker_name, ...input.others_present.map((o) => o.name)])
    for (const [index, shot] of shots.entries()) {
      const where = `shots[${index}]`
      if (shot?.role !== 'opening' && shot?.role !== 'closing') errors.push(`${where}.role outside the list`)
      if (!(DIRECTOR_FRAMINGS as readonly string[]).includes(shot?.framing)) errors.push(`${where}.framing outside the list`)
      if (!(DIRECTOR_CAMERA_MOVES as readonly string[]).includes(shot?.camera_move)) errors.push(`${where}.camera_move outside the list`)
      if (!(DIRECTOR_DURATIONS as readonly number[]).includes(shot?.duration_s)) errors.push(`${where}.duration_s outside 2|3|4`)
      if (!nonEmpty(shot?.still)) errors.push(`${where}.still is empty`)
      if (!nonEmpty(shot?.subject_action)) errors.push(`${where}.subject_action is empty`)
      if (!nonEmpty(shot?.environment_motion)) errors.push(`${where}.environment_motion is empty`)
      // The evidence sentence must come verbatim from the right narration span.
      const span = shot?.role === 'opening' ? input.narration_before : input.narration_after
      if (!nonEmpty(shot?.evidence) || !span.includes(shot.evidence.trim())) {
        errors.push(`${where}.evidence is not a verbatim sentence of the ${shot?.role} narration`)
      }
      if (!Array.isArray(shot?.people_in_still)) {
        errors.push(`${where}.people_in_still is not an array`)
      } else {
        for (const person of shot.people_in_still) {
          if (!known.has(person?.name)) errors.push(`${where}.people_in_still names an unknown person: ${person?.name}`)
          if (!['away', 'profile', 'none'].includes(person?.facing)) errors.push(`${where}.people_in_still facing outside the list`)
        }
      }
    }
  }
  const lineShot = p.line_shot as Record<string, unknown> | undefined
  if (!(DIRECTOR_TRANSITIONS_IN as readonly string[]).includes(lineShot?.transition_in as string)) {
    errors.push('line_shot.transition_in outside the list')
  }
  if (!(DIRECTOR_LEAD_INS as readonly number[]).includes(lineShot?.voice_lead_in_s as number)) {
    errors.push('line_shot.voice_lead_in_s outside 0|0.3|0.6')
  }
  const ending = p.ending as Record<string, unknown> | undefined
  if (!(DIRECTOR_TRANSITIONS_OUT as readonly string[]).includes(ending?.transition_out as string)) {
    errors.push('ending.transition_out outside the list')
  }
  if (!nonEmpty(p.ambient)) errors.push('ambient is empty')
  return errors
}

export const directorEffects = {
  call: (req: Parameters<typeof callLLM>[0]) => callLLM(req),
}

/**
 * One director call plus at most one repair call with the validator's errors.
 * A plan that still fails degrades to the line shot alone — the caller drops
 * the scene shots, never the video.
 */
export async function directScene(
  model: string,
  input: DirectorInput,
  opts: { reasoningEffort?: 'low' | 'medium' | 'high'; timeoutMs?: number } = {},
): Promise<{ plan: DirectorPlan | null; errors: string[]; repaired: boolean }> {
  const user = JSON.stringify(input)
  const first = await directorEffects.call({
    model,
    responseSchema: DIRECTOR_SCHEMA,
    timeoutMs: opts.timeoutMs ?? 60000,
    maxTokens: 2048,
    temperature: 0.2,
    purpose: 'media_director',
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    messages: [
      { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
  })
  let plan = parsePlan(first)
  let errors = plan ? validateDirectorPlan(plan, input) : ['director output was not JSON']
  if (!errors.length) return { plan, errors, repaired: false }
  const retry = await directorEffects.call({
    model,
    responseSchema: DIRECTOR_SCHEMA,
    timeoutMs: opts.timeoutMs ?? 60000,
    maxTokens: 2048,
    temperature: 0.2,
    purpose: 'media_director_repair',
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    messages: [
      { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
      { role: 'user', content: user },
      {
        role: 'user',
        content: `Your last plan was rejected for these rule violations. Fix every one of them; change nothing else unless a rule demands it:\n${errors.map((e) => `- ${e}`).join('\n')}`,
      },
    ],
  })
  plan = parsePlan(retry)
  errors = plan ? validateDirectorPlan(plan, input) : ['director repair output was not JSON']
  return { plan: errors.length ? null : plan, errors, repaired: true }
}

function parsePlan(raw: string): DirectorPlan | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as DirectorPlan
  } catch {
    return null
  }
}
