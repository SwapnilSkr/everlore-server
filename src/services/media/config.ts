import type { MediaKind } from '../../models/media.model'
import catalogue from './voices/eleven-v4-turbo.json'

const defaults: Record<MediaKind, number> = { voice: 100, picture: 15, video: 2, portrait: 20 }
export function mediaLimit(kind: MediaKind): number {
  const value = Number(process.env[`MEDIA_DAILY_${kind.toUpperCase()}`] ?? defaults[kind])
  return Number.isSafeInteger(value) && value >= 0 ? value : defaults[kind]
}
export function mediaEnabled(kind?: MediaKind): boolean {
  return process.env.MEDIA_ENABLED === 'true' && (!kind || process.env[`MEDIA_${kind.toUpperCase()}_ENABLED`] !== 'false')
}
export const voiceModel = () => process.env.MEDIA_VOICE_MODEL || catalogue.model
/** Portrait / picture stills. Painted look matches the house style (owner, Oct 16 2026). */
export const imageModel = () => process.env.MEDIA_IMAGE_MODEL || 'black-forest-labs/flux.2-klein-4b'
/** The line shot: portrait lip-synced to the exact clip the player heard. */
export const videoModel = () => process.env.MEDIA_VIDEO_MODEL || 'heygen/avatar-iv'
/** Scene shots, image-to-video from their own wide stills. */
export const sceneModel = () => process.env.MEDIA_SCENE_MODEL || 'x-ai/grok-imagine-video-1.5-lite'
/** Automatic fallback for a failed scene shot; its audio track is always dropped. */
export const sceneFallbackModel = () => process.env.MEDIA_SCENE_FALLBACK_MODEL || 'alibaba/wan-3.0'
/** Shot direction. Chosen by the text-only bake-off in media-server-2 (Sol:
 *  first-pass valid at the default token budget, richest continuity sheets,
 *  cheapest of the fully-reliable two). */
export const directorModel = () => process.env.MEDIA_DIRECTOR_MODEL || 'openai/gpt-6.1-sol'
/** Pre-generation moderation gate on the visual description (cheap, OpenRouter). */
export const moderationModel = () => process.env.MEDIA_MODERATION_MODEL || 'openai/gpt-4o-mini'
/** Post-generation vision gate on images and sampled video frames. */
export const visionModel = () => process.env.MEDIA_VISION_MODEL || 'google/gemini-2.5-flash-lite'
/** ffmpeg/ffprobe locations. Prod is Linux: both default to PATH, never to a
 * macOS Homebrew prefix. The prod box needs ffmpeg (with ffprobe) installed. */
export const ffmpegPath = () => process.env.FFMPEG_PATH || 'ffmpeg'
export const ffprobePath = () => process.env.FFPROBE_PATH || 'ffprobe'
export const mediaConcurrency = () => {
  const n = Number(process.env.MEDIA_CONCURRENCY ?? 2)
  return Number.isSafeInteger(n) && n > 0 ? n : 2
}
export function voiceCatalogue(model: string) {
  if (model !== catalogue.model) throw new Error('Voice catalogue unavailable')
  return catalogue
}
