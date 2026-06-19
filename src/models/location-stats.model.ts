import type { ObjectId } from 'mongodb'

/**
 * location_stats — a MATERIALIZED projection of the Location Journal read surface
 * ("what places exist + how busy is each one"). One doc per (instance, place
 * entity), refreshed INCREMENTALLY as places are anchored (see
 * entityGraphService.resolveLocationAnchor → locationService.refreshLocationStat).
 *
 * WHY: the old Places endpoint aggregated EVERY anchored event + memory and then
 * loaded EVERY location entity — a full-world scan that grows O(events + places)
 * per request and does not scale to thousands of locations/turns. This projection
 * lets the endpoint read a bounded, pre-aggregated, index-sorted list instead.
 *
 * The doc mirrors exactly the per-place shape the endpoint returns (the spine
 * fields + counts), so reads are a plain find()+sort with no live aggregation.
 * Counts are recomputed for ONE place at a time (a bounded, indexed
 * countDocuments per entity_id) whenever that place is touched — never a
 * full-collection group. Backfill (backfillLocationStats) builds it once from
 * existing data; after that maintenance is purely incremental.
 */
export interface LocationStatsDoc {
  _id: ObjectId
  instance_id: ObjectId
  /** The location ENTITY this stat row projects (the natural key with instance_id). */
  entity_id: ObjectId
  /** Denormalized display name (canonical name, kept in sync on refresh). */
  name: string
  /** Containment spine fields, mirrored from the entity for tree rendering. */
  parent_id: ObjectId | null
  world_root_id: ObjectId | null
  place_kind: string | null
  /** Anchored-event / anchored-memory tallies for this place (main-visible only). */
  event_count: number
  memory_count: number
  first_seen_sequence: number | null
  last_seen_sequence: number | null
  updated_at: Date
}
