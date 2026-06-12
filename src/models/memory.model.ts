import type { ObjectId } from 'mongodb'
import type { ProjectionStatus } from './projection.model'
import type { TimeAnchorDoc } from './time.model'
import type { LocationAnchorDoc } from './location.model'

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
  /** Where this memory was curated from. Absent = main narration. */
  origin?: 'main' | 'side_chat'
  /** Who-knows-this scope for private (side-chat) memories: entity ids of the
   *  conversation's participants. Main narration may retrieve a side-chat
   *  memory ONLY when the protagonist is among them (hard gate — a secret
   *  enters the main story by being shared there, which mints a new
   *  main-scoped memory). Side chats retrieve only their own character's. */
  known_by_entity_ids?: ObjectId[]
  /** Canonical entity names this memory is primarily about (who acted/felt). */
  subjects?: string[]
  /** Canonical entity names acted upon or affected. */
  objects?: string[]
  /** Curator-emitted alternate phrasings/synonyms for this fact, comma-joined.
   *  Embedded WITH the atom and part of the text index so the memory is found
   *  when a later turn is worded differently from `text`. */
  search_terms?: string
  /** Entity-graph ids resolved from `subjects` (strings kept for compat). */
  subject_entity_ids?: ObjectId[]
  /** Entity-graph ids resolved from `objects`. */
  object_entity_ids?: ObjectId[]
  /** Story-time anchor copied from the source event for timeline/calendar filtering. */
  time_anchor?: TimeAnchorDoc
  timeline_id?: string
  /** Location anchor copied from the source event for place-scoped recall. */
  location_anchor?: LocationAnchorDoc | null
  location_entity_id?: ObjectId
  location_name?: string
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
  /** Memory version graph (Phase 2). Forward links FROM this atom TO earlier
   *  atoms it evolves. `updates` = this atom supersedes/corrects the earlier one
   *  (the earlier atom is archived `status:superseded`); `extends` = refines
   *  canon without replacing (both stay active); `derives_from` = a higher-order
   *  inference synthesized from earlier atoms. Currently only `updates` has a
   *  producer (the codex-retirement supersession seam); the other two are
   *  reserved (schema present, inert) until a refine-detection / inference pass
   *  exists. Additive — a pre-version-graph row simply lacks them. */
  updates_memory_ids?: ObjectId[]
  extends_memory_ids?: ObjectId[]
  derives_from_memory_ids?: ObjectId[]
  /** Backward lineage: the event(s) whose codex retirement superseded this atom
   *  (set when `status:superseded`). Race-free single-writer signal (the
   *  supersession seam) from which the forward `updates_memory_ids` on the newer
   *  correcting atoms is materialized/reconciled. */
  superseded_by_event_ids?: ObjectId[]
  created_at: Date
  updated_at: Date
}
