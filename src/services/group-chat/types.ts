export type GroupOrigin = 'player' | 'unprompted' | 'catchup'

export interface GroupTraits {
  age: number
  talkativeness: number
  speech: string
  wants: string
  intimacy?: string
  voice?: string[]
}

export interface GroupMember {
  id: string
  name: string
  role?: string
  persona?: string
  group: GroupTraits
}

export interface GroupState {
  silent_for: Record<string, number>
  unprompted_since_player: number
  topics_used: number
  writing_calls?: number
  tz_offset_minutes?: number
  last_seen_at?: Date
  last_catchup_at?: Date
}

export interface GroupLine {
  character_id: string
  text: string
  shown_at: Date
}

export interface NamedLine { name: string; text: string }
