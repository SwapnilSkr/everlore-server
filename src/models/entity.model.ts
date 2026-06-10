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
  status: 'active' | 'archived'
  first_seen_sequence: number
  last_seen_sequence: number
  mention_count: number
  created_at: Date
  updated_at: Date
}
