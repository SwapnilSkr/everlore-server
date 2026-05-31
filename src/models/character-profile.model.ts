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
  /** True for the world's main sentient persona (the character the player talks
   *  TO in a sentient world). Pins them to the top of the roster and excludes
   *  them from the redundant NPC-codex prompt injection. */
  is_protagonist?: boolean
  first_seen_sequence: number
  last_seen_sequence: number
  mention_count: number
  created_at: Date
  updated_at: Date
}
