export type GroupOrigin = 'player' | 'unprompted' | 'catchup'

export interface GroupTraits {
  age: number
  /** Authored where the world states it, so the writer never guesses a body from a name. */
  gender?: 'male' | 'female' | 'non_binary'
  talkativeness: number
  speech: string
  wants: string
  start_bond: import('../../utils/relationship-baseline').RelationshipInitializationKind
  intimacy?: string
  voice?: string[]
}

/** A member's written status for each part of the player's day. */
export interface GroupStatusLines {
  morning: string
  afternoon: string
  evening: string
  night: string
}

export type GroupStatusPeriod = keyof GroupStatusLines

export interface GroupMember {
  id: string
  name: string
  role?: string
  persona?: string
  relationship?: import('../../models/character-profile.model').RelationshipMeters
  group: GroupTraits
  /** Written first text ideas, sent only on a direct thread with nothing in it yet. */
  first_texts?: string[]
  /** Written status lines; the line for now is picked per read, never stored. */
  statuses?: GroupStatusLines
}

export interface GroupState {
  silent_for: Record<string, number>
  unprompted_since_player: number
  topics_used: number
  curated_through_sequence?: number
  summarized_through_sequence?: number
  direct_threads?: Record<string, { curated_through_sequence?: number; summarized_through_sequence?: number }>
  writing_calls?: number
  tz_offset_minutes?: number
  pending_direct?: { member_id: string; scheduled_at: Date; notified_at: Date }
  last_direct_notified_at?: Date
  last_seen_at?: Date
  last_catchup_at?: Date
}

export interface GroupSelfie {
  media_id?: string
  status: 'queued' | 'processing' | 'ready' | 'unseen' | 'failed' | 'resting'
  url?: string
  resets_at?: string
}

export interface GroupLine {
  line_id?: string
  selfie?: GroupSelfie
  character_id: string
  text: string
  shown_at: Date
}

export interface NamedLine { name: string; text: string; player_action?: true }
