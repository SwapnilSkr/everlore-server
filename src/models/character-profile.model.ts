import type { ObjectId } from 'mongodb'
import type { RelationshipState } from '../utils/relationship-baseline'

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

export type RelationshipMeterKey = keyof RelationshipMeters

/** An evidence-backed, replayable reason why one bond meter moved. */
export interface RelationshipMoment {
  meter: RelationshipMeterKey
  delta: number
  /** Exact short wording from the turn; never an invented interpretation. */
  evidence: string
  sequence: number
}

/** An atomic, evidence-backed emotional truth about a character's bond toward
 * the player. These facts are the durable record; the short bond summary is a
 * deterministic projection so later model output cannot flatten history. */
export interface RelationshipFact {
  statement: string
  evidence: string
  tags?: string[]
  sequence: number
  status: 'active' | 'retired'
}

/** A validated, player-facing conversation affordance derived from a character's
 * current state. This is display metadata only; mutable_state remains the
 * canonical continuity record used by prompts and projections. */
export interface CharacterInteractionHint {
  label: string
  draft: string
  source_state: string
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
  /** Optional for backwards-compatible existing cards. */
  interaction_hints?: CharacterInteractionHint[]
  disposition_to_player: string
  hidden_thought: string
  /** Gamified relationship ledger; absent until the first meter-moving turn. */
  relationship?: RelationshipMeters
  /** Human-readable, evidence-backed meaning of the bond; deliberately open-ended. */
  relationship_state?: RelationshipState
  /** Append/retire journal behind relationship_state. */
  relationship_facts?: RelationshipFact[]
  /** Recent evidence-backed shifts; makes the displayed bond inspectable. */
  relationship_moments?: RelationshipMoment[]
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
