import type { SpokenLine, VoiceTraits } from '../../models/media.model'
import catalogue from './voices/eleven-v4-turbo.json'
import { compactWhitespace } from './detection'

export const ALLOWED_VOICE_TAGS = ['[shouting]', '[whispers]', '[sighs]', '[breathless]'] as const
export const filterVoiceTags = (tags: unknown): string[] => Array.isArray(tags)
  ? tags.filter((tag): tag is string => typeof tag === 'string' && (ALLOWED_VOICE_TAGS as readonly string[]).includes(tag)).slice(0, 1) : []
export const isVerbatim = (span: string, spoken: string): boolean => !!compactWhitespace(spoken)
  && compactWhitespace(span).includes(compactWhitespace(spoken))
export const matureVoiceAllowed = (intent: boolean | undefined, optedIn: boolean): boolean => !intent || optedIn
export function utcMediaDay(now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  return { day, resets_at: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString() }
}
export interface VoiceHolder { voice_id: string; last_spoken_at?: Date }
export function chooseVoice(traits: VoiceTraits, holders: VoiceHolder[], voices = catalogue.voices): string {
  const scores = voices.map((voice) => Object.entries(traits).reduce((score, [key, value]) =>
    score + (voice.traits[key as keyof typeof voice.traits]?.includes(value) ? catalogue.trait_weights[key as keyof typeof catalogue.trait_weights] : 0), 0))
  const best = Math.max(...scores)
  const fitting = voices.filter((_, i) => scores[i] === best)
  const free = fitting.find((voice) => !holders.some((holder) => holder.voice_id === voice.id))
  if (free) return free.id
  // For a shared voice use its MOST recent holder: every holder must be quiet.
  const last = (id: string) => Math.max(0, ...holders.filter((h) => h.voice_id === id).map((h) => h.last_spoken_at?.getTime() || 0))
  return fitting.reduce((winner, voice) => last(voice.id) < last(winner.id) ? voice : winner).id
}
export function publicSpokenLines(lines: SpokenLine[]): SpokenLine[] {
  return lines.map(({ line_id, start, end, voice }) => ({ line_id, start, end,
    ...(voice?.status === 'unvoiceable' ? { voice } : {}),
  }))
}
