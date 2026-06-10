import type { ObjectId } from 'mongodb'

/**
 * Structured relationship meters toward the player (0-100). Trust/affection
 * start neutral (50); fear/rivalry start absent (0). Mutated only through
 * clamped per-turn deltas — never set directly by the model.
 */
export interface RelationshipMeters {
  trust: number
  affection: number
  fear: number
  rivalry: number
}

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
  /** Gamified relationship ledger; absent until the first meter-moving turn. */
  relationship?: RelationshipMeters
  /** 1:1 link to this card's entity-graph node (lazily backfilled). */
  entity_id?: ObjectId
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
