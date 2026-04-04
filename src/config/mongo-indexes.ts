import {
  MongoServerError,
  type Collection,
  type Db,
  type Document,
} from "mongodb";

/** listIndexes fails on brand-new DBs until the collection namespace exists (code 26). */
async function listCollectionIndexes(
  collection: Collection<Document>,
): Promise<Document[]> {
  try {
    return await collection.listIndexes().toArray();
  } catch (e) {
    if (e instanceof MongoServerError && e.code === 26) return [];
    throw e;
  }
}

/**
 * Canonical Everlore indexes. Startup reconciles same key + different options
 * (e.g. sparse) by dropping the stale index so this stays the single source of truth.
 */
export type EverloreIndexDef = {
  collection: string;
  key: Document;
  /** Options passed to createIndex (name optional; included for stable Atlas labels). */
  options?: {
    unique?: boolean;
    sparse?: boolean;
    name?: string;
    expireAfterSeconds?: number;
  };
};

export const EVERLORE_INDEXES: EverloreIndexDef[] = [
  // world_instances
  {
    collection: "world_instances",
    key: { player_id: 1, "meta.is_archived": 1 },
    options: { name: "idx_world_instances_player_archived" },
  },
  {
    collection: "world_instances",
    key: { template_id: 1 },
    options: { name: "idx_world_instances_template" },
  },
  {
    collection: "world_instances",
    key: { "meta.last_active_at": 1 },
    options: { name: "idx_world_instances_last_active" },
  },

  // events
  {
    collection: "events",
    key: { instance_id: 1, sequence: 1 },
    options: { unique: true, name: "idx_events_instance_sequence" },
  },
  {
    collection: "events",
    key: { instance_id: 1, type: 1 },
    options: { name: "idx_events_instance_type" },
  },
  {
    collection: "events",
    key: { instance_id: 1, scene_tag: 1 },
    options: { name: "idx_events_instance_scene" },
  },

  // memories
  {
    collection: "memories",
    key: { instance_id: 1, is_archived: 1, importance: -1 },
    options: { name: "idx_memories_instance_archived_importance" },
  },
  {
    collection: "memories",
    key: { instance_id: 1, type: 1 },
    options: { name: "idx_memories_instance_type" },
  },
  {
    collection: "memories",
    key: { last_accessed_at: 1, importance: 1 },
    options: { name: "idx_memories_access_importance" },
  },
  {
    collection: "memories",
    key: { pinecone_id: 1 },
    options: { unique: true, sparse: true, name: "idx_memories_pinecone_id" },
  },

  // scene_summaries
  {
    collection: "scene_summaries",
    key: { instance_id: 1, "event_range.start_sequence": 1 },
    options: { name: "idx_scene_summaries_instance_event_start" },
  },

  // world_templates
  {
    collection: "world_templates",
    key: { is_published: 1, created_at: -1 },
    options: { name: "idx_world_templates_published_created" },
  },
  {
    collection: "world_templates",
    key: { creator_id: 1 },
    options: { name: "idx_world_templates_creator" },
  },
  {
    collection: "world_templates",
    key: { slug: 1 },
    options: { unique: true, name: "idx_world_templates_slug" },
  },

  // users — sparse unique allows phone- or Google-only accounts without dummy emails
  {
    collection: "users",
    key: { email: 1 },
    options: { unique: true, sparse: true, name: "idx_users_email" },
  },
  {
    collection: "users",
    key: { username: 1 },
    options: { unique: true, name: "idx_users_username" },
  },
  {
    collection: "users",
    key: { phone: 1 },
    options: { unique: true, sparse: true, name: "idx_users_phone" },
  },
  {
    collection: "users",
    key: { google_sub: 1 },
    options: { unique: true, sparse: true, name: "idx_users_google_sub" },
  },

  // dead_letter_jobs (DLQ writes from worker; supports time-ordered ops / TTL later)
  {
    collection: "dead_letter_jobs",
    key: { failedAt: -1 },
    options: { name: "idx_dead_letter_jobs_failed_at" },
  },
];

function keysMatch(existing: Document, desired: Document): boolean {
  const ek = Object.keys(existing);
  const dk = Object.keys(desired);
  if (ek.length !== dk.length) return false;
  for (const k of dk) {
    if (existing[k] !== desired[k]) return false;
  }
  return true;
}

function optionsMatch(
  existing: Document,
  desired: EverloreIndexDef["options"],
): boolean {
  const d = desired ?? {};
  if (!!existing.unique !== !!d.unique) return false;
  if (!!existing.sparse !== !!d.sparse) return false;
  if (d.expireAfterSeconds !== undefined) {
    if (existing.expireAfterSeconds !== d.expireAfterSeconds) return false;
  }
  if (d.name !== undefined && existing.name !== d.name) return false;
  return true;
}

export async function ensureEverloreIndexes(db: Db): Promise<void> {
  for (const def of EVERLORE_INDEXES) {
    const collection = db.collection(def.collection);
    const existing = await listCollectionIndexes(collection);
    let satisfied = false;
    for (const idx of existing) {
      if (idx.name === "_id_") continue;
      if (!keysMatch(idx.key as Document, def.key)) continue;
      if (optionsMatch(idx as Document, def.options)) {
        satisfied = true;
      } else {
        await collection.dropIndex(idx.name as string);
      }
    }
    if (!satisfied) {
      await collection.createIndex(def.key, def.options ?? {});
    }
  }
}
