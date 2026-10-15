import type { ObjectId } from 'mongodb'

export type MediaKind = 'voice' | 'picture' | 'video' | 'portrait'
export interface CharacterVoice { model: string; voice_id: string }
/** Authored categories; prose is never classified with keyword heuristics. */
export interface VoiceTraits {
  gender_presentation?: string
  age_band?: string
  timbre?: string
  temperament?: string
}
export interface SpokenLine {
  line_id: string
  start: number
  end: number
  voice?: { status: 'unvoiceable' } | {
    status: 'voiceable'
    character_id: string
    speaker_name: string
    spoken_text: string
    tags: string[]
  }
}
export interface MediaAssetDoc {
  _id: ObjectId
  player_id: ObjectId
  instance_id: ObjectId
  event_id: ObjectId
  kind: MediaKind
  line_id: string
  character_id: ObjectId
  source: 'generated'
  model: string
  voice_id: string
  cache_key: string
  /** Prose revision fences edits, replay and late provider responses. */
  revision: string
  input: string
  cost_usd: number
  cost_source?: 'catalogue' | 'generation'
  notified_at?: Date
  generation_id?: string
  status: 'queued' | 'processing' | 'ready' | 'failed'
  asset_key?: string
  url?: string
  duration_ms?: number
  created_at: Date
  started_at?: Date
}
export interface MediaUsageDoc {
  _id: ObjectId
  player_id: ObjectId
  instance_id: ObjectId
  event_id: ObjectId
  kind: MediaKind
  day: string
  /** Only live reservations/settlements own a slot. Released rows omit it. */
  slot?: number
  status: 'reserved' | 'settled' | 'released'
  created_at: Date
}
