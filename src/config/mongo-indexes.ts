import {
  MongoServerError,
  type Collection,
  type Db,
  type Document,
} from "mongodb"
import { COLLECTIONS } from "../models/collections"

/** listIndexes fails on brand-new DBs until the collection namespace exists (code 26). */
async function listCollectionIndexes(
  collection: Collection<Document>,
): Promise<Document[]> {
  try {
    return await collection.listIndexes().toArray()
  } catch (e) {
    if (e instanceof MongoServerError && e.code === 26) return []
    throw e
  }
}

/**
 * Canonical Everlore indexes. Startup reconciles same key + different options
 * (e.g. sparse) by dropping the stale index so this stays the single source of truth.
 *
 * Collection names must match {@link COLLECTIONS} — index keys are unchanged.
 */
export type EverloreIndexDef = {
  collection: string
  key: Document
  /** Options passed to createIndex (name optional; included for stable Atlas labels). */
  options?: {
    unique?: boolean
    sparse?: boolean
    name?: string
    expireAfterSeconds?: number
  }
}

export const EVERLORE_INDEXES: EverloreIndexDef[] = [
  // world_instances
  {
    collection: COLLECTIONS.world_instances,
    key: { player_id: 1, "meta.is_archived": 1 },
    options: { name: "idx_world_instances_player_archived" },
  },
  {
    collection: COLLECTIONS.world_instances,
    key: { template_id: 1 },
    options: { name: "idx_world_instances_template" },
  },
  {
    collection: COLLECTIONS.world_instances,
    key: { player_id: 1, template_id: 1, "meta.is_archived": 1 },
    options: { name: "idx_world_instances_player_template_archived" },
  },
  {
    collection: COLLECTIONS.world_instances,
    key: { "meta.last_active_at": 1 },
    options: { name: "idx_world_instances_last_active" },
  },

  // events
  {
    collection: COLLECTIONS.events,
    key: { instance_id: 1, sequence: 1 },
    options: { unique: true, name: "idx_events_instance_sequence" },
  },
  {
    collection: COLLECTIONS.events,
    key: { instance_id: 1, type: 1 },
    options: { name: "idx_events_instance_type" },
  },
  {
    collection: COLLECTIONS.events,
    key: { instance_id: 1, scene_tag: 1 },
    options: { name: "idx_events_instance_scene" },
  },
  {
    collection: COLLECTIONS.events,
    key: { instance_id: 1, "time_anchor.timeline_id": 1, sequence: 1 },
    options: { name: "idx_events_instance_timeline_sequence" },
  },
  {
    collection: COLLECTIONS.events,
    key: { instance_id: 1, "time_anchor.story_calendar.calendar_id": 1, "time_anchor.story_calendar.year": 1, "time_anchor.story_calendar.month": 1, "time_anchor.story_calendar.day": 1 },
    options: { name: "idx_events_instance_story_date" },
  },

  // memories
  {
    collection: COLLECTIONS.memories,
    key: { instance_id: 1, is_archived: 1, importance: -1 },
    options: { name: "idx_memories_instance_archived_importance" },
  },
  {
    collection: COLLECTIONS.memories,
    key: { instance_id: 1, type: 1 },
    options: { name: "idx_memories_instance_type" },
  },
  {
    collection: COLLECTIONS.memories,
    key: { last_accessed_at: 1, importance: 1 },
    options: { name: "idx_memories_access_importance" },
  },
  {
    collection: COLLECTIONS.memories,
    key: { pinecone_id: 1 },
    options: { unique: true, sparse: true, name: "idx_memories_pinecone_id" },
  },
  // Keyword half of hybrid retrieval: exact names, places, promises, artifacts —
  // the recall mode pure vector search is weakest at. One text index max per
  // collection (Mongo limit); subjects/objects are entity-name arrays.
  {
    collection: COLLECTIONS.memories,
    key: { text: "text", subjects: "text", objects: "text" },
    options: { name: "idx_memories_text_search" },
  },
  // Entity-neighborhood retrieval: memories linked to mentioned entities.
  {
    collection: COLLECTIONS.memories,
    key: { instance_id: 1, subject_entity_ids: 1 },
    options: { name: "idx_memories_instance_subject_entities" },
  },
  {
    collection: COLLECTIONS.memories,
    key: { instance_id: 1, object_entity_ids: 1 },
    options: { name: "idx_memories_instance_object_entities" },
  },
  {
    collection: COLLECTIONS.memories,
    key: { instance_id: 1, timeline_id: 1, "time_anchor.sequence": 1, importance: -1 },
    options: { name: "idx_memories_instance_timeline_sequence" },
  },
  {
    collection: COLLECTIONS.memories,
    key: { instance_id: 1, "time_anchor.story_calendar.calendar_id": 1, "time_anchor.story_calendar.year": 1, "time_anchor.story_calendar.month": 1, "time_anchor.story_calendar.day": 1 },
    options: { name: "idx_memories_instance_story_date" },
  },
  // Open-thread surfacing: unresolved promises/conflicts ranked by importance.
  {
    collection: COLLECTIONS.memories,
    key: { instance_id: 1, unresolved_thread: 1, is_archived: 1, importance: -1 },
    options: { name: "idx_memories_instance_unresolved" },
  },

  // characters (self-building codex)
  {
    collection: COLLECTIONS.characters,
    key: { instance_id: 1, name_normalized: 1 },
    options: { unique: true, name: "idx_characters_instance_name" },
  },
  {
    collection: COLLECTIONS.characters,
    key: { instance_id: 1, mention_count: -1, updated_at: -1 },
    options: { name: "idx_characters_instance_rank" },
  },

  // entities (entity graph nodes) — type is part of the natural key so a
  // character "Mira" and a location "Mira" can coexist; resolution still scans
  // names/aliases across types.
  {
    collection: COLLECTIONS.entities,
    key: { instance_id: 1, type: 1, name_normalized: 1 },
    options: { unique: true, name: "idx_entities_instance_type_name" },
  },
  {
    collection: COLLECTIONS.entities,
    key: { instance_id: 1, name_normalized: 1 },
    options: { name: "idx_entities_instance_name" },
  },
  {
    collection: COLLECTIONS.entities,
    key: { instance_id: 1, character_id: 1 },
    options: { sparse: true, name: "idx_entities_instance_character" },
  },

  // entity_edges (entity graph edges). `label` is part of edge identity so
  // each narrative ASSERTION ("betrayed…", "forgave…") is its own edge with
  // its own event provenance — rewind/edit then prunes exactly the assertions
  // whose source turns were removed, instead of leaving a merged edge wearing
  // the latest label. Meter edges carry no label (null), so they stay unique
  // per (source, target, type).
  {
    collection: COLLECTIONS.entity_edges,
    key: { instance_id: 1, source_entity_id: 1, target_entity_id: 1, type: 1, label: 1 },
    options: { unique: true, name: "idx_entity_edges_assertion" },
  },
  // Multikey provenance index: rewind/edit pulls removed event ids from edges.
  {
    collection: COLLECTIONS.entity_edges,
    key: { instance_id: 1, source_event_ids: 1 },
    options: { name: "idx_entity_edges_instance_sources" },
  },
  {
    collection: COLLECTIONS.entity_edges,
    key: { instance_id: 1, status: 1, importance: -1 },
    options: { name: "idx_entity_edges_instance_status" },
  },

  // story calendars / timelines
  {
    collection: COLLECTIONS.story_calendars,
    key: { instance_id: 1, is_default: 1 },
    options: { name: "idx_story_calendars_instance_default" },
  },
  {
    collection: COLLECTIONS.story_calendars,
    key: { template_id: 1, is_default: 1 },
    options: { name: "idx_story_calendars_template_default" },
  },
  {
    collection: COLLECTIONS.timeline_branches,
    key: { instance_id: 1, timeline_id: 1 },
    options: { unique: true, name: "idx_timeline_branches_instance_timeline" },
  },
  {
    collection: COLLECTIONS.timeline_branches,
    key: { instance_id: 1, status: 1 },
    options: { name: "idx_timeline_branches_instance_status" },
  },

  // personas
  {
    collection: COLLECTIONS.personas,
    key: { player_id: 1, updated_at: -1 },
    options: { name: "idx_personas_player_updated" },
  },
  {
    collection: COLLECTIONS.personas,
    key: { player_id: 1, name: 1 },
    options: { name: "idx_personas_player_name" },
  },

  // scene_summaries
  {
    collection: COLLECTIONS.scene_summaries,
    key: { instance_id: 1, "event_range.start_sequence": 1 },
    options: { name: "idx_scene_summaries_instance_event_start" },
  },

  // world_templates
  {
    collection: COLLECTIONS.world_templates,
    key: { is_published: 1, created_at: -1 },
    options: { name: "idx_world_templates_published_created" },
  },
  {
    collection: COLLECTIONS.world_templates,
    key: { creator_id: 1 },
    options: { name: "idx_world_templates_creator" },
  },
  {
    collection: COLLECTIONS.world_templates,
    key: { slug: 1 },
    options: { unique: true, name: "idx_world_templates_slug" },
  },

  // users — sparse unique allows phone- or Google-only accounts without dummy emails
  {
    collection: COLLECTIONS.users,
    key: { email: 1 },
    options: { unique: true, sparse: true, name: "idx_users_email" },
  },
  {
    collection: COLLECTIONS.users,
    key: { username: 1 },
    options: { unique: true, name: "idx_users_username" },
  },
  {
    collection: COLLECTIONS.users,
    key: { phone: 1 },
    options: { unique: true, sparse: true, name: "idx_users_phone" },
  },
  {
    collection: COLLECTIONS.users,
    key: { google_sub: 1 },
    options: { unique: true, sparse: true, name: "idx_users_google_sub" },
  },

  // dead_letter_jobs (DLQ writes from worker; supports time-ordered ops / TTL later)
  {
    collection: COLLECTIONS.dead_letter_jobs,
    key: { failedAt: -1 },
    options: { name: "idx_dead_letter_jobs_failed_at" },
  },

  // nsfw_lexicon (term is the natural key; seeder upserts on it)
  {
    collection: COLLECTIONS.nsfw_lexicon,
    key: { term: 1 },
    options: { unique: true, name: "uniq_nsfw_lexicon_term" },
  },
  {
    collection: COLLECTIONS.nsfw_lexicon,
    key: { weight: 1, is_phrase: 1 },
    options: { name: "idx_nsfw_lexicon_weight_phrase" },
  },
]

/**
 * Indexes superseded by a definition with DIFFERENT keys (the reconciler above
 * only handles same-key option drift). Startup drops these if present.
 */
export const DEPRECATED_INDEXES: Array<{ collection: string; name: string }> = [
  // Replaced by idx_entity_edges_assertion (label joined the unique key).
  { collection: COLLECTIONS.entity_edges, name: "idx_entity_edges_endpoints_type" },
  // Replaced by idx_memories_instance_timeline_sequence (parent-branch clamps by sequence).
  { collection: COLLECTIONS.memories, name: "idx_memories_instance_timeline_importance" },
]

function isTextIndexDef(desired: Document): boolean {
  return Object.values(desired).some((v) => v === "text")
}

function keysMatch(existingIndex: Document, desired: Document): boolean {
  const existing = (existingIndex.key ?? {}) as Document
  // Mongo stores text indexes with a normalized { _fts: "text", _ftsx: 1 } key
  // (the indexed fields move into the index's `weights`), so a literal key
  // comparison would recreate the index every startup. Compare weights instead.
  if (isTextIndexDef(desired)) {
    if (existing._fts !== "text") return false
    const weights = (existingIndex.weights ?? {}) as Document
    const desiredTextFields = Object.keys(desired).filter((k) => desired[k] === "text")
    return (
      desiredTextFields.length === Object.keys(weights).length &&
      desiredTextFields.every((f) => weights[f] !== undefined)
    )
  }
  const ek = Object.keys(existing)
  const dk = Object.keys(desired)
  if (ek.length !== dk.length) return false
  for (const k of dk) {
    if (existing[k] !== desired[k]) return false
  }
  return true
}

function optionsMatch(
  existing: Document,
  desired: EverloreIndexDef["options"],
): boolean {
  const d = desired ?? {}
  if (!!existing.unique !== !!d.unique) return false
  if (!!existing.sparse !== !!d.sparse) return false
  if (d.expireAfterSeconds !== undefined) {
    if (existing.expireAfterSeconds !== d.expireAfterSeconds) return false
  }
  if (d.name !== undefined && existing.name !== d.name) return false
  return true
}

export async function ensureEverloreIndexes(db: Db): Promise<void> {
  for (const dep of DEPRECATED_INDEXES) {
    const collection = db.collection(dep.collection)
    const existing = await listCollectionIndexes(collection)
    if (existing.some((idx) => idx.name === dep.name)) {
      await collection.dropIndex(dep.name)
    }
  }
  for (const def of EVERLORE_INDEXES) {
    const collection = db.collection(def.collection)
    const existing = await listCollectionIndexes(collection)
    let satisfied = false
    for (const idx of existing) {
      if (idx.name === "_id_") continue
      if (!keysMatch(idx as Document, def.key)) continue
      if (optionsMatch(idx as Document, def.options)) {
        satisfied = true
      } else {
        await collection.dropIndex(idx.name as string)
      }
    }
    if (!satisfied) {
      await collection.createIndex(def.key, def.options ?? {})
    }
  }
}
