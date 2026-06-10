import type { ObjectId } from 'mongodb'
import type { ProjectionStatus } from './projection.model'
import type { TimeAnchorDoc } from './time.model'

/**
 * memories — curated long-term facts with optional Pinecone vector id.
 *
 * Rich-atom fields (all optional — pre-upgrade rows simply lack them) carry the
 * emotional/relational structure that lets the world feel like it remembers
 * thousands of turns later, and power keyword retrieval + open-thread surfacing.
 */
export interface MemoryDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  text: string
  type: string
  importance: number
  is_nsfw: boolean
  source_event_ids: ObjectId[]
  pinecone_id: string | null
  access_count: number
  last_accessed_at: Date
  is_archived: boolean
  /** Projection lifecycle (see projection.model). `is_archived` remains the
   *  retrieval gate for back-compat; status records WHY a row left retrieval
   *  ('superseded' vs 'archived'). Absent on pre-unification rows. */
  status?: ProjectionStatus
  /** Canonical entity names this memory is primarily about (who acted/felt). */
  subjects?: string[]
  /** Canonical entity names acted upon or affected. */
  objects?: string[]
  /** Entity-graph ids resolved from `subjects` (strings kept for compat). */
  subject_entity_ids?: ObjectId[]
  /** Entity-graph ids resolved from `objects`. */
  object_entity_ids?: ObjectId[]
  /** Story-time anchor copied from the source event for timeline/calendar filtering. */
  time_anchor?: TimeAnchorDoc
  timeline_id?: string
  /** One-word emotional tone of the memory (e.g. "tender", "bitter"). */
  emotional_valence?: string
  /** What caused the emotional impact, when the memory carries one. */
  emotional_cause?: string
  /** Lasting behavioral/relational effect (the part that matters 1000 turns later). */
  emotional_effect?: string
  /** How a relationship shifted because of this moment, if it did. */
  relationship_delta?: string
  /** True while this memory is an open promise/conflict/question awaiting payoff. */
  unresolved_thread?: boolean
  /** Set when a later turn resolved this thread. */
  resolved_at?: Date | null
  created_at: Date
  updated_at: Date
}
