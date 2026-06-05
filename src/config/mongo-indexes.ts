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

function keysMatch(existing: Document, desired: Document): boolean {
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
  for (const def of EVERLORE_INDEXES) {
    const collection = db.collection(def.collection)
    const existing = await listCollectionIndexes(collection)
    let satisfied = false
    for (const idx of existing) {
      if (idx.name === "_id_") continue
      if (!keysMatch(idx.key as Document, def.key)) continue
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
