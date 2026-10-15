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
export const mediaConcurrency = () => {
  const n = Number(process.env.MEDIA_CONCURRENCY ?? 2)
  return Number.isSafeInteger(n) && n > 0 ? n : 2
}
export function voiceCatalogue(model: string) {
  if (model !== catalogue.model) throw new Error('Voice catalogue unavailable')
  return catalogue
}
