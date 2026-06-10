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
  status: 'active' | 'stale' | 'archived'
  source_event_ids: ObjectId[]
  /** Sequence of the latest contributing turn (recency ranking + rewind clamp). */
  last_event_sequence: number
  created_at: Date
  updated_at: Date
}
