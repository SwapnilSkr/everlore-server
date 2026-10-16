import type { DirectorPlan, DirectorShot } from './director'
import { PAINTED_RENDER } from '../image.service'

/**
 * Per-model prompt templates live in data (contract §3A.3). Code fills them
 * from the director's plan; the director never writes a model prompt.
 * - Still prompt: the world's art style (§3.1) + continuity + framing + `still` + "no text".
 * - Motion prompt: `camera_move` + `subject_action` + `environment_motion` +
 *   wardrobe + "no other people appear, no cut, the composition stays continuous".
 */

const FRAMING_NOTES: Record<string, string> = {
  establishing_wide: 'an extreme wide establishing view of the whole place, no person larger than a distant figure',
  wide: 'a wide view of the place, people small in frame and never close to the lens',
  medium_wide_back: 'a medium-wide view from behind the people, faces never visible',
  medium_wide_profile: 'a medium-wide view in profile, faces small and turned aside',
  over_shoulder_back: 'an over-the-shoulder view from behind, the foreground shoulder out of focus, no face toward camera',
  insert_detail: 'a tight insert of hands, an object, a door, rain or light only, no people and no faces',
}

const CAMERA_NOTES: Record<string, string> = {
  static: 'the camera holds perfectly still',
  slow_push_in: 'the camera drifts slowly closer, starting exactly from the still',
  slow_pull_out: 'the camera drifts slowly back, starting exactly from the still',
  slow_pan_left: 'the camera pans slowly left, starting exactly from the still',
  slow_pan_right: 'the camera pans slowly right, starting exactly from the still',
  slow_tilt_up: 'the camera tilts slowly up, starting exactly from the still',
  slow_tilt_down: 'the camera tilts slowly down, starting exactly from the still',
}

export interface SceneModelTemplate {
  stillPrefix: string
  stillSuffix: string
  motionPrefix: string
  motionSuffix: string
}

export const SCENE_TEMPLATES: Record<string, SceneModelTemplate> = {
  'x-ai/grok-imagine-video-1.5-lite': {
    stillPrefix: 'Painted film still, vertical 9:16.',
    stillSuffix: 'No text, no watermark, no logo.',
    motionPrefix: 'Animate this exact still for a few seconds.',
    motionSuffix: 'No other people appear. No cut, no new composition: the motion continues the still. Painted look throughout.',
  },
  'alibaba/wan-3.0': {
    stillPrefix: 'Cinematic painted still, vertical composition.',
    stillSuffix: 'No text, no watermark, no logo. No spoken words.',
    motionPrefix: 'Bring this still to life with one continuous motion.',
    motionSuffix: 'No other people appear. A single continuous shot, no cuts, the composition stays continuous with the still. No dialogue, ambient motion only.',
  },
}

const templateFor = (model: string): SceneModelTemplate =>
  SCENE_TEMPLATES[model] || SCENE_TEMPLATES['x-ai/grok-imagine-video-1.5-lite']

export function compileStillPrompt(plan: DirectorPlan, shot: DirectorShot, model: string, styleRender: string = PAINTED_RENDER): string {
  const t = templateFor(model)
  const c = plan.continuity
  return [
    t.stillPrefix,
    `${styleRender}.`,
    `Wardrobe: ${c.wardrobe} Hair: ${c.hair} Props: ${c.props}.`,
    `Time: ${c.time_of_day}. Weather: ${c.weather}. Light: ${c.light}. Palette: ${c.palette}.`,
    `${FRAMING_NOTES[shot.framing] || shot.framing}.`,
    shot.still,
    t.stillSuffix,
  ].join(' ')
}

export function compileMotionPrompt(plan: DirectorPlan, shot: DirectorShot, model: string): string {
  const t = templateFor(model)
  const people = shot.people_in_still.length
    ? `Visible people: ${shot.people_in_still.map((p) => `${p.name} (${p.placement})`).join('; ')}.`
    : 'No people visible.'
  return [
    t.motionPrefix,
    `${CAMERA_NOTES[shot.camera_move] || shot.camera_move}.`,
    `Subject: ${shot.subject_action}`,
    `Environment: ${shot.environment_motion}`,
    people,
    `Wardrobe stays exactly: ${plan.continuity.wardrobe}`,
    t.motionSuffix,
  ].join(' ')
}

/** HeyGen line-shot prompt: the portrait says the line. Nothing else. */
export function compileLinePrompt(speakerName: string, spokenText: string): string {
  return `${speakerName}, the adult in the portrait, says: "${spokenText.slice(0, 400)}" Natural lip movement matched to the supplied voice recording. Still camera, SFW, no captions.`
}
