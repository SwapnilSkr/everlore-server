import type { ObjectId } from 'mongodb'

/**
 * Relationship-meter edge types (player ↔ character) mirror the codex
 * relationship ledger; narrative edges carry a free-text label ("betrayed her
 * at the ash bridge"). The set is open — extraction may mint new types — but
 * these are the ones the system itself writes.
 */
export type EntityEdgeType =
  | 'trust'
  | 'affection'
  | 'fear'
  | 'rivalry'
  | 'relationship'
  | 'kinship'
  | string

/**
 * entity_edges — typed, directed links between entities. Every edge keeps
 * source-event provenance so rewind/edit can prune exactly the assertions that
 * came from removed turns: an event id is pulled from `source_event_ids` when
 * its event is removed, and an edge with no surviving sources is deleted.
 */
export interface EntityEdgeDoc {
  _id: ObjectId
  instance_id: ObjectId
  source_entity_id: ObjectId
  target_entity_id: ObjectId
  type: EntityEdgeType
  /** Free-text description for narrative edges (what happened between them).
   *  Part of edge identity (unique with source/target/type): each distinct
   *  assertion is its own edge, so provenance pruning is exact. Meter edges
   *  store null. */
  label?: string | null
  /** Cumulative signed strength for meter edges (sum of per-turn deltas). */
  weight?: number
  /** 1-5, mirrors memory importance; used to rank neighborhood retrieval. */
  importance: number
  status: 'active' | 'stale' | 'archived' | 'ended' | 'retconned'
  source_event_ids: ObjectId[]
  // --- kinship edges (type: 'kinship') — see KINSHIP_GRAPH.md ---
  /** CLOSED structural relation kind the engine reasons over (sibling_of, …). */
  relation_kind?: import('../utils/kinship-ontology').RelationKind
  /** The kind written on the auto-closed reverse edge (for provenance/debugging). */
  inverse_kind?: import('../utils/kinship-ontology').RelationKind
  /** MODIFIER axis — biological(default)/step/half/adoptive/foster/in_law. Orthogonal
   *  to the kind so inference (co-parent) can tell a step-father from a father. */
  relation_modifier?: import('../utils/kinship-ontology').RelationModifier
  /** LIFECYCLE STATE — how the tie stands now (active/deceased/estranged/dissolved/
   *  revealed_false). Set by the TRANSITION channel; the surface ("late father") is
   *  composed from kind+modifier+state, never stored. */
  relation_state?: import('../utils/kinship-ontology').LifecycleState
  /** Gender implied by the surface label ("sister" → f), for label↔card checks. */
  gender_hint?: 'm' | 'f' | 'n' | null
  /** Where the assertion came from — gates how much downstream code trusts it.
   *  Player-authored sources (correction/narration/claim) let a player retcon a
   *  tie; see kinship-hygiene.KinshipEdgeSource / world-authority.WorldFactSource. */
  assertion_source?: import('../../worker/lib/kinship-hygiene').KinshipEdgeSource
  /** 0-1; ranks competing assertions (two "fathers") by confidence then recency. */
  confidence?: number
  /** Temporal validity: when the relation began / ended (marriage, death, reveal). */
  since_event_sequence?: number
  until_event_sequence?: number | null
  /** Sequence of the latest contributing turn (recency ranking + rewind clamp). */
  last_event_sequence: number
  created_at: Date
  updated_at: Date
}
