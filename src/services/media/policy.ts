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

/**
 * Voice-trait closed lists the attribution call reports from. An enum
 * validation, not a heuristic word list: the model must answer from these
 * values, and anything else is dropped by filterVoiceTraits below.
 */
export const VOICE_TRAIT_LISTS = {
  gender_presentation: ['feminine', 'masculine', 'neutral', 'unclear'],
  age_band: ['child', 'young', 'adult', 'older', 'elderly'],
  timbre: ['light', 'warm', 'deep', 'rough', 'airy', 'unclear'],
} as const

/** Keep only closed-list values; an invalid trait is ignored, never fatal. */
export function filterVoiceTraits(raw: unknown): VoiceTraits {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, list] of Object.entries(VOICE_TRAIT_LISTS)) {
    const value = r[key]
    if (typeof value === 'string' && (list as readonly string[]).includes(value)) out[key] = value
  }
  return out
}

export function chooseVoice(traits: VoiceTraits, holders: VoiceHolder[], voices = catalogue.voices): string {
  // Card traits use the attribution vocabulary (feminine, older, …); catalogue
  // voices carry the provider's labels (female, middle_aged, …). The mapping
  // lives in the catalogue data (trait_aliases), never here — with identity
  // fallbacks so authored seed traits in catalogue labels keep working.
  const table = (catalogue as unknown as { trait_aliases?: Record<string, Record<string, string[]>> }).trait_aliases ?? {}
  const labels = (key: string, value: string): string[] => table[key]?.[value] ?? [value]
  const scores = voices.map((voice) => Object.entries(traits).reduce((score, [key, value]) =>
    score + (typeof value === 'string'
      && (voice.traits[key as keyof typeof voice.traits] as unknown as string[] | undefined)?.some((label) => labels(key, value).includes(label))
      ? catalogue.trait_weights[key as keyof typeof catalogue.trait_weights] ?? 0 : 0), 0))
  const best = Math.max(...scores)
  const fitting = voices.filter((_, i) => scores[i] === best)
  const free = fitting.find((voice) => !holders.some((holder) => holder.voice_id === voice.id))
  if (free) return free.id
  // For a shared voice use its MOST recent holder: every holder must be quiet.
  const last = (id: string) => Math.max(0, ...holders.filter((h) => h.voice_id === id).map((h) => h.last_spoken_at?.getTime() || 0))
  return fitting.reduce((winner, voice) => last(voice.id) < last(winner.id) ? voice : winner).id
}
export function publicSpokenLines(lines: SpokenLine[]): SpokenLine[] {
  return lines.map(({ line_id, start, end, voice, filmable }) => ({ line_id, start, end,
    ...(filmable === false ? { filmable } : {}),
    ...(voice?.status === 'unvoiceable' ? { voice } : {}),
  }))
}
