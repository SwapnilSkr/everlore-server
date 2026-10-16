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
  /** The save this belongs to. Omitted for standalone persona portraits, which
   * follow the persona across worlds and must survive any one save's purge. */
  instance_id?: ObjectId
  /** Omitted for portraits painted outside any turn (card/persona screens). */
  event_id?: ObjectId
  kind: MediaKind
  /** The spoken line for voice/video; the turn marker for picture. */
  line_id: string
  /** The single face for voice/video/portrait; absent on multi-face pictures. */
  character_id?: ObjectId
  /** The persona a persona portrait is painted for; never combined with character_id. */
  persona_id?: ObjectId
  source: 'generated' | 'authored'
  model: string
  /** Voice id for voice/video; undefined for picture/portrait. Omitted, never null. */
  voice_id?: string
  cache_key: string
  /** Prose revision fences edits, replay and late provider responses. */
  revision: string
  input: string
  cost_usd: number
  cost_source?: 'catalogue' | 'generation'
  notified_at?: Date
  generation_id?: string
  status: 'queued' | 'processing' | 'ready' | 'failed' | 'unseen'
  asset_key?: string
  url?: string
  duration_ms?: number
  /** Portrait this image was painted from (picture, scene still, line shot). */
  reference_asset_key?: string
  /** Scene-still inputs not yet deleted (item 5): stills are inputs, not
   * deliverables. Recorded before assembly so a crash still leaves them
   * purgeable; cleared once deleted. purgeMedia removes these. */
  still_keys?: string[]
  /** Scene-cut plan, compiled prompts and per-shot check results (§3A.3). */
  plan?: Record<string, unknown>
  created_at: Date
  started_at?: Date
}
/** A portrait belongs where the character belongs (contract §3). Only
 * generated/authored faces are stored here; uploads never are. */
export interface PortraitRef {
  asset_key: string
  source: 'generated' | 'authored'
  appearance_version: number
  painted_at: Date
}
/** Every §7 rejection is logged for review: kind, stage and reason, no image. */
export interface MediaRejectionDoc {
  _id: ObjectId
  player_id: ObjectId
  instance_id?: ObjectId
  event_id?: ObjectId
  kind: MediaKind
  stage: 'pre' | 'post'
  reason: string
  model: string
  created_at: Date
}
export interface MediaUsageDoc {
  _id: ObjectId
  player_id: ObjectId
  /** Omitted for standalone persona portraits: the allowance is per player,
   * per kind, per day, and a persona face belongs to no save. */
  instance_id?: ObjectId
  event_id?: ObjectId
  kind: MediaKind
  day: string
  /** Only live reservations/settlements own a slot. Released rows omit it. */
  slot?: number
  status: 'reserved' | 'settled' | 'released'
  created_at: Date
}
