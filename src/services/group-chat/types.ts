export type GroupOrigin = 'player' | 'unprompted' | 'catchup'

export interface GroupTraits {
  age: number
  talkativeness: number
  speech: string
  wants: string
  start_bond: import('../../utils/relationship-baseline').RelationshipInitializationKind
  intimacy?: string
  voice?: string[]
}

export interface GroupMember {
  id: string
  name: string
  role?: string
  persona?: string
  relationship?: import('../../models/character-profile.model').RelationshipMeters
  group: GroupTraits
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

export interface GroupLine {
  character_id: string
  text: string
  shown_at: Date
}

export interface NamedLine { name: string; text: string; player_action?: true }
