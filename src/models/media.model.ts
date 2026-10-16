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
/** Missing versions are legacy. Failed calls are done at the current version too. */
export interface VoiceAttribution {
  status: 'processing' | 'done'
  claimed_at: Date
  rule_version?: number
}
export interface SpokenLine {
  line_id: string
  start: number
  end: number
  filmable?: false
  voice?: { status: 'unvoiceable' } | {
    status: 'voiceable'
    character_id?: string
    model?: string
    voice_id?: string
    speaker_name: string
    spoken_text: string
    tags: string[]
    /** Voice traits the attribution call returned for this speaker, validated
     * against the closed lists. Absent when the call returned none. Never
     * sent to the player (publicSpokenLines strips voiceable voices). */
    voice_traits?: VoiceTraits
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
  /** The style key a portrait/persona-portrait was painted in (the template's
   *  narrative_style key). Omitted for the painted default and on every legacy
   *  row, which counts as painted. Part of the portrait cache identity. */
  art_style?: string
  /** Why a failed job failed: the pipeline stage and the sanitized message.
   * Set by failMedia on every failed row; absent on queued/ready/unseen rows. */
  error?: { stage: string; message: string }
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
 *  generated/authored faces are stored here; uploads never are. */
export interface PortraitRef {
  asset_key: string
  source: 'generated' | 'authored'
  appearance_version: number
  /** The style key it was painted in (the template's narrative_style key). A
   *  portrait whose key differs from the world's current key is out of date,
   *  like a behind appearance_version. Omitted for the painted default — and
   *  on every legacy portrait, which counts as painted. Never null. */
  art_style?: string
  painted_at: Date
}
/** Every §7 rejection is logged for review: kind, stage and reason, no image. */
export interface MediaRejectionDoc {
  _id: ObjectId
  player_id: ObjectId
  instance_id?: ObjectId
  event_id?: ObjectId
  kind: MediaKind
  /** pre: moderation gate before generation; post: vision gate after;
   * provider: the image/video provider refused the request for content. */
  stage: 'pre' | 'post' | 'provider'
  reason: string
  /** The sanitised provider message on provider refusals (URLs redacted, at
   * most 300 chars). Absent on pre/post gate rejections. */
  message?: string
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
