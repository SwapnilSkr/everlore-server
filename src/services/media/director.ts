import { callLLM } from '../../ai/client'
import { LINE_TAIL_S, type SentenceTiming } from './audio'

/**
 * The director pass (contract §3A.1). One premium-model call turns a turn into
 * a structured shot plan. The prompt below is the contract text in
 * `everlore-docs/server/MEDIA_DIRECTOR_PROMPT.md`, verbatim — prompt changes
 * also go in the task report for the doc owner. Code validates (§3A.2) and compiles
 * (§3A.3); the director never writes a model prompt directly.
 */

export const DIRECTOR_SYSTEM_PROMPT = `You are the film director for a short scene cut in an illustrated story. You turn one moment of prose into a precise shot plan. The cut has at most three shots: an optional OPENING scene shot, the LINE shot (the speaker saying their line, made elsewhere; you only frame it), and an optional CLOSING scene shot.

You direct for image-to-video models that work like this: each scene shot starts from a still image you describe, then moves for 2–4 seconds. They are good at one simple, continuous motion from a well-composed still. They break when asked for anything else. Direct to their strengths.

THE NON-NEGOTIABLE RULES
1. One shot, one idea. Each scene shot has exactly one camera move (from the allowed list) and at most one subject action. No cuts, no reveals of new people, no transformations inside a shot.
2. The still IS the first frame. Describe the still as the exact composition the shot starts from, and describe the motion as a change from that still ("the camera drifts closer to the door as rain runs off the gutter"). Never describe a different composition in the motion.
3. Nobody appears who is not in the still. State every visible person in the still, and say "no other people" if there are none. A person seen from behind or in silhouette is still a person: count them.
4. No faces up close in scene shots. Scene shots use only these framings: establishing wide, wide, medium-wide from behind or in profile, over-the-shoulder from behind, or insert/detail (hands, an object, a door, rain, light). The face belongs to the LINE shot only.
5. Continuity is fixed before any shot: write the continuity sheet first (wardrobe, hair, carried props, time of day, weather, light source and its direction, colour palette). Every shot obeys it word for word. Wardrobe never changes between shots.
6. Ground every shot in the prose. Each scene shot cites one sentence from the narration, copied exactly, that it visualises. Leave out an opening or closing when the excerpt carries the moment alone or the budget has no room for it.
7. Suggestive, never explicit. An intimate moment may be shown as sensual and suggestive: an embrace, a kiss, closeness, a lingering touch, revealing but covered clothing. Never nudity and never a sexual act; if the moment goes further, show what surrounds it: hands, a door closing, a candle, rain on glass. If it is violent, show tension and aftermath, never gore. Nobody who looks underage is ever shown in a sensual or suggestive way. No real people, no logos, no text on screen.
8. Paint, don't photograph. The world's art style is given; stills are paintings in that style.

PACING
The finished film is at most 8 seconds in total. This is a hard limit for line films and dialogue-free cuts alike. You get one call to direct the whole cut; there is no repair call.
For a line film, the input gives the spoken line as indexed whole sentences with exact measured durations and start_s/end_s in the existing full-line recording. Choose line_excerpt as a contiguous run of whole sentences, using zero-based first and last indices, inclusive, never free text. Pick the part that carries the main point; you may leave out the opening sentences, the closing sentences, or both. The full recording remains available to hear separately.
Add the exact excerpt duration (the last sentence's end_s minus the first sentence's start_s), its 0.3-second silent tail, and every scene shot's duration. Keep that total at or under the input budget_s of 8 seconds. Choose the excerpt and shots to fit; do not rely on transition overlaps or voice lead-in to fit. Either scene shot may be omitted: a line film may be the LINE shot alone. If even one sentence exceeds the budget, choose the shortest meaningful whole-sentence excerpt and omit scene shots.
For a dialogue-free cut, add all scene shot durations and keep the total at or under 8 seconds. There is no excerpt or voice.

TRANSITIONS AND SOUND
Pick transitions only from: "cut", "dissolve_short" (8 frames), "dip_to_black" (12 frames). Default to "cut" into the line and "dissolve_short" out of it. Use "dip_to_black" only for an ending.
Choose the voice lead-in: how many seconds of the line's voice start under the end of the opening shot (a J-cut), from 0, 0.3 or 0.6. Use 0.3 or 0.6 when the opening builds toward the speaker.
Describe the ambient sound bed in a few words (rain on stone, a crackling fire). Never voices, never music with words.

OUTPUT
Return only JSON matching the schema you are given. Fill every field. Use the speaker's and others' names exactly as given in the input. Never invent ids.`

/** Mode addendum; the base system prompt remains the verbatim contract. */
export const DIRECTOR_DIALOGUE_FREE_PROMPT = `DIALOGUE-FREE MODE
When mode is "dialogue_free", there is no LINE shot and no voice. Plan exactly one OPENING and one CLOSING scene shot, in that order, each 3–4 seconds, about 6–8 seconds in total. Both narration spans contain the turn; ground each shot in its narration. The finished film is at most 8 seconds in total, a hard limit. Return line_shot and line_excerpt as null. Use ending.transition_out between the scene shots. Keep the ambient bed, never voices.`

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
  line_excerpt: { first: number; last: number } | null
  line_shot: { transition_in: string; voice_lead_in_s: number } | null
  ending: { transition_out: string }
  ambient: string
}
export interface DirectorInput {
  mode?: 'line' | 'dialogue_free'
  /** Optional for legacy offline probes; production always supplies the budget and timings. */
  budget_s?: number
  art_style: string
  narration_before: string
  line: { speaker_name: string; spoken_text: string; duration_s: number; sentences?: SentenceTiming[] }
  narration_after: string
  speaker: { appearance: string; passing_look: string }
  others_present: Array<{ name: string; appearance: string }>
  place: string
}

export const DIRECTOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['continuity', 'shots', 'line_excerpt', 'line_shot', 'ending', 'ambient'],
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
    line_excerpt: {
      type: 'object', additionalProperties: false, required: ['first', 'last'],
      properties: { first: { type: 'integer', minimum: 0 }, last: { type: 'integer', minimum: 0 } },
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
  if (!plan || typeof plan !== 'object') return validateDirectorPlan({}, input)
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
    if (input.mode === 'dialogue_free') {
      if (shots.length !== 2 || shots[0]?.role !== 'opening' || shots[1]?.role !== 'closing') errors.push('dialogue-free cut needs opening then closing')
      if (shots.some((s) => s?.duration_s !== 3 && s?.duration_s !== 4)) errors.push('dialogue-free duration outside 3|4')
    }
    const known = new Set([...(input.mode === 'dialogue_free' ? [] : [input.line.speaker_name]), ...input.others_present.map((o) => o.name)])
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
  if (input.mode === 'dialogue_free') {
    if (p.line_excerpt !== null) errors.push('dialogue-free cut cannot have a line excerpt')
  } else if (!validLineExcerpt(p.line_excerpt, input.line.sentences?.length ?? 1)) {
    errors.push('line_excerpt must be a contiguous in-range run of whole sentences')
  }
  const lineShot = p.line_shot as Record<string, unknown> | undefined
  if (input.mode === 'dialogue_free' && p.line_shot !== null) errors.push('dialogue-free cut cannot have a line shot')
  if (input.mode !== 'dialogue_free' && !(DIRECTOR_TRANSITIONS_IN as readonly string[]).includes(lineShot?.transition_in as string)) {
    errors.push('line_shot.transition_in outside the list')
  }
  if (input.mode !== 'dialogue_free' && !(DIRECTOR_LEAD_INS as readonly number[]).includes(lineShot?.voice_lead_in_s as number)) {
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

/** A range cannot encode skipped sentences or model-authored replacement words. */
export function validLineExcerpt(value: unknown, count: number): value is { first: number; last: number } {
  if (!value || typeof value !== 'object') return false
  const range = value as Record<string, unknown>
  return Object.keys(range).length === 2 && Number.isInteger(range.first) && Number.isInteger(range.last)
    && Number(range.first) >= 0 && Number(range.last) >= Number(range.first) && Number(range.last) < count
}

/** Keep individually valid shots; shared invalid continuity drops all scene shots. */
function degradePlan(raw: DirectorPlan | null, input: DirectorInput, errors: string[]): DirectorPlan | null {
  const shots: DirectorShot[] = []
  if (raw && Array.isArray(raw.shots) && !errors.some((e) => e.startsWith('continuity.'))) {
    raw.shots.forEach((shot, index) => {
      if (!errors.some((e) => e.startsWith(`shots[${index}].`))
        && !(input.mode === 'dialogue_free' && shot.duration_s !== 3 && shot.duration_s !== 4)
        && !shots.some((s) => s.role === shot.role)) shots.push(shot)
    })
  }
  shots.sort((a, b) => Number(a.role === 'closing') - Number(b.role === 'closing'))
  if (input.mode === 'dialogue_free' && !shots.length) return null
  const sentences = input.line.sentences ?? [{ index: 0, text: input.line.spoken_text, start_s: 0, end_s: input.line.duration_s, duration_s: input.line.duration_s }]
  let excerpt = raw?.line_excerpt
  if (input.mode !== 'dialogue_free' && !validLineExcerpt(excerpt, sentences.length)) {
    const available = (input.budget_s ?? 8) - shots.reduce((sum, shot) => sum + shot.duration_s, 0)
    let last = 0, duration = sentences[0].duration_s
    while (last + 1 < sentences.length && duration + sentences[last + 1].duration_s <= available) {
      duration += sentences[++last].duration_s
    }
    excerpt = { first: 0, last }
  }
  return {
    continuity: raw?.continuity ?? { wardrobe: '', hair: '', props: '', time_of_day: '', weather: '', light: '', palette: '' },
    shots, line_excerpt: input.mode === 'dialogue_free' ? null : excerpt!,
    line_shot: input.mode === 'dialogue_free' ? null : {
      transition_in: errors.some((e) => e.startsWith('line_shot.transition_in')) ? 'cut' : raw!.line_shot!.transition_in,
      voice_lead_in_s: errors.some((e) => e.startsWith('line_shot.voice_lead_in_s')) ? 0 : raw!.line_shot!.voice_lead_in_s,
    },
    ending: { transition_out: errors.some((e) => e.startsWith('ending.')) ? 'cut' : raw!.ending.transition_out },
    ambient: errors.includes('ambient is empty') ? 'Quiet atmosphere.' : raw!.ambient,
  }
}

/** One call, then structural degradation only. Never re-plan an over-budget cut. */
export async function directScene(
  model: string,
  input: DirectorInput,
  opts: { reasoningEffort?: 'low' | 'medium' | 'high'; timeoutMs?: number } = {},
): Promise<{ plan: DirectorPlan | null; errors: string[] }> {
  const system = input.mode === 'dialogue_free' ? `${DIRECTOR_SYSTEM_PROMPT}\n\n${DIRECTOR_DIALOGUE_FREE_PROMPT}` : DIRECTOR_SYSTEM_PROMPT
  const schema = input.mode === 'dialogue_free'
    ? { ...DIRECTOR_SCHEMA, properties: { ...DIRECTOR_SCHEMA.properties, line_shot: { type: 'null' }, line_excerpt: { type: 'null' } } }
    : DIRECTOR_SCHEMA
  const response = await directorEffects.call({
    model, responseSchema: schema, timeoutMs: opts.timeoutMs ?? 60000,
    maxTokens: 2048, temperature: 0.2, purpose: 'media_director',
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
  })
  const raw = parsePlan(response)
  const errors = validateDirectorPlan(raw, input)
  return { plan: degradePlan(raw, input, errors), errors }
}

/** Conservative planned duration: overlaps can only shorten this sum. */
export function plannedFilmSeconds(plan: DirectorPlan, input: DirectorInput): number {
  const range = plan.line_excerpt
  const sentences = input.line.sentences
  const voice = input.mode === 'dialogue_free' ? 0 : range && sentences
    ? sentences[range.last].end_s - sentences[range.first].start_s + LINE_TAIL_S
    : input.line.duration_s + LINE_TAIL_S
  return voice + plan.shots.reduce((sum, shot) => sum + shot.duration_s, 0)
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
