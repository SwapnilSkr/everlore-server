import type { ObjectId } from 'mongodb'

/**
 * characters — emergent NPC codex entries that become canonical constraints.
 */
export interface CharacterProfileDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  canonical_name: string
  name_normalized: string
  aliases: string[]
  role?: string
  appearance?: string
  persona?: string
  immutable_facts: string[]
  mutable_state: string[]
  disposition_to_player: string
  hidden_thought: string
  first_seen_sequence: number
  last_seen_sequence: number
  mention_count: number
  created_at: Date
  updated_at: Date
}
