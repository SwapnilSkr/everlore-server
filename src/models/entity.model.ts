import type { ObjectId } from 'mongodb'

/**
 * Entity types the graph can reason about. Characters/protagonist/player map
 * 1:1 onto codex cards (via `character_id`); the rest are first-class nouns
 * that previously existed only as loose strings inside memory text.
 */
export type EntityType =
  | 'player'
  | 'protagonist'
  | 'character'
  | 'location'
  | 'faction'
  | 'item'
  | 'quest'
  | 'concept'

/**
 * A single provenance-tracked fact about a location entity. `source_sequence`
 * makes rewind pruning a cheap range query; `source_event_id` makes edit/replay
 * recuration exact — a fact whose source turn was removed or rewritten goes
 * with it, so the place never asserts something that no longer happened.
 */
export interface LocationFactDoc {
  text: string
  source_event_id: ObjectId
  source_sequence: number
  created_at: Date
}

/**
 * entities — the reusable nouns of a playthrough (WHO/WHAT/WHERE as linked IDs,
 * not loose strings). Created on first mention with dedup by normalized
 * name/alias; memories link to entities via subject/object_entity_ids and the
 * codex links via character_id, so retrieval can walk from a mention to
 * everything known about it.
 */
export interface EntityDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  type: EntityType
  canonical_name: string
  name_normalized: string
  aliases: string[]
  /** 1:1 link to the codex card for player/protagonist/character entities. */
  character_id?: ObjectId
  /** Lifecycle of a graph node:
   *  - 'stub': a freshly witnessed-but-uncarded entity (a scene participant or a
   *    kinship endpoint) that exists so the graph can reference it before a full
   *    codex card exists. High recall, low authority: NOT injected as canon, NOT
   *    shown in the Bonds ledger (that reads cards).
   *  - 'anchored_stub': a stub that earned PROVENANCE — a kinship/relationship
   *    edge, a memory reference, a location association, or repeated witnessing.
   *    Survives indefinitely (never archived) because something points at it.
   *  - 'dormant_stub': an OLD stub with some provenance but long out of the active
   *    window — preserved (not noise) and WAKABLE by name/alias/edge/location/
   *    memory cue, but not surfaced until a cue hits.
   *  - 'active': a full canonical entity backed by a codex card (or a location).
   *    A stub is promoted to 'active' the moment a codex card mints for this name
   *    (syncCodexEntities links character_id) — same row, never a duplicate.
   *  - 'archived': unreferenced low-confidence one-off noise, retired to keep the
   *    witness tier from becoming a junk drawer. */
  status: 'stub' | 'dormant_stub' | 'anchored_stub' | 'active' | 'archived'
  first_seen_sequence: number
  last_seen_sequence: number
  mention_count: number
  // ── stub provenance (the witness tier) — drives anchoring + waking ──
  /** Bounded list of event ids that witnessed this entity, for rewind pruning and
   *  "wake by source event". Newest last. */
  source_event_ids?: ObjectId[]
  /** The location entity this stub was first / most-recently witnessed in, so a
   *  dormant stub can wake when the viewpoint returns to that place. */
  first_location_entity_id?: ObjectId | null
  last_location_entity_id?: ObjectId | null
  /** A coarse role/descriptor the prose gave an unnamed witness ("the butler",
   *  "the veiled pianist") — helps resolve + display a stub before it earns a card. */
  role_label?: string
  /** 0-1 confidence the stub is a real trackable person (from the presence tier
   *  that minted it: confirmed > probable). Low-confidence one-offs archive first. */
  confidence?: number
  /** How many distinct turns witnessed this entity (≥ mention_count is per-prose). */
  witness_count?: number
  /** Why a dormant stub was last woken ("named in input", "kin edge", "same place",
   *  "memory hit") — for logs/audit/debug. */
  last_wake_reason?: string
  /** location entities only — mutable world state of the place ("the gate now
   *  lies in ruins"). Newest last; bounded; pruned on rewind/edit. */
  location_state?: LocationFactDoc[]
  /** location entities only — enduring canonical facts about the place ("built
   *  over a buried god"). Append-only canon; bounded; pruned on rewind/edit. */
  location_facts?: LocationFactDoc[]
  /** location entities only — the containment spine. `parent_id` is the immediate
   *  container (room → building → settlement → …); null/absent = a world root or a
   *  place whose parent isn't discovered yet. `world_root_id` is the denormalized
   *  top of THIS place's chain (the world/realm it belongs to) for O(1)
   *  world-scoped resolution + retrieval — null/absent on legacy + single-world
   *  rows (treated as one implicit root). `place_kind` is a coarse granularity tier
   *  for UI grouping + cartographer defaults. See LOCATION_GRAPH.md (P1). */
  parent_id?: ObjectId | null
  world_root_id?: ObjectId | null
  place_kind?: 'world' | 'region' | 'settlement' | 'building' | 'area' | 'room' | string
  created_at: Date
  updated_at: Date
}
