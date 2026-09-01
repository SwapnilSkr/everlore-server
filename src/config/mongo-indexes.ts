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
    partialFilterExpression?: Document
  }
}

export const EVERLORE_INDEXES: EverloreIndexDef[] = [
  {
    collection: COLLECTIONS.post_process_outbox,
    key: { event_id: 1, kind: 1 },
    options: { unique: true, name: 'idx_post_process_outbox_event_kind' },
  },
  {
    collection: COLLECTIONS.post_process_outbox,
    key: { status: 1, next_attempt_at: 1 },
    options: { name: 'idx_post_process_outbox_dispatch' },
  },
  // Billing is append-only. The unique idempotency key is the safety rail that
  // keeps reconnects, webhook retries, and stream retries from double charging.
  {
    collection: COLLECTIONS.ink_ledger,
    key: { player_id: 1, idempotency_key: 1 },
    options: { unique: true, name: 'idx_ink_ledger_player_idempotency' },
  },
  {
    collection: COLLECTIONS.ink_ledger,
    key: { player_id: 1, created_at: -1 },
    options: { name: 'idx_ink_ledger_player_created' },
  },
  {
    collection: COLLECTIONS.billing_entitlements,
    key: { player_id: 1, active: 1, expires_at: 1 },
    options: { name: 'idx_billing_entitlement_player_active' },
  },
  {
    collection: COLLECTIONS.store_purchases,
    key: { provider: 1, purchase_token: 1 },
    options: { unique: true, name: 'idx_store_purchase_token' },
  },
  // relation candidates — a review queue, never a source of canon by itself.
  {
    collection: COLLECTIONS.relation_candidates,
    key: { instance_id: 1, status: 1, updated_at: -1 },
    options: { name: 'idx_relation_candidates_instance_status' },
  },
  {
    collection: COLLECTIONS.relation_candidates,
    key: { source_event_id: 1, character_entity_id: 1, relation: 1 },
    options: { unique: true, name: 'idx_relation_candidates_source_relation' },
  },
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
  {
    collection: COLLECTIONS.world_instances,
    key: { player_id: 1, "meta.is_archived": 1, "meta.last_active_at": -1 },
    options: { name: "idx_world_instances_player_archived_active" },
  },
  {
    collection: COLLECTIONS.world_instances,
    key: { "current_location.entity_id": 1 },
    options: { name: "idx_world_instances_current_location_entity" },
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
  {
    collection: COLLECTIONS.events,
    key: { instance_id: 1, "location_anchor.entity_id": 1, sequence: 1 },
    options: { name: "idx_events_instance_location_sequence" },
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
    key: { text: "text", subjects: "text", objects: "text", search_terms: "text" },
    options: { name: "idx_memories_text_search_v2" },
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
  {
    collection: COLLECTIONS.memories,
    key: { instance_id: 1, location_entity_id: 1, importance: -1 },
    options: { name: "idx_memories_instance_location_importance" },
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
  // names/aliases across types. world_root_id AND parent_id join the unique key so
  // the SAME place name can exist in DIFFERENT worlds/realms ("house" in two cities)
  // AND under DIFFERENT containers within one world ("tavern" in two settlements) —
  // intra-world same-name collision was the open-world bug: world_root_id alone made
  // a name unique per world, so a 2nd "tavern" couldn't mint and FUSED onto the
  // first, bleeding place-recall. For non-location / legacy rows both fields are
  // null, so the constraint reduces to the old (instance, type, name). Reuse-vs-mint
  // is governed by AREA-scoped resolution (resolveLocationAnchor); this index is the
  // race-safe enforcement. Also serves world-scoped exact lookup. See LOCATION_GRAPH.md.
  // identity_scope joins the unique key so two people the story knows only by the
  // SAME label ("the rider") can each have their own row — the person-shaped twin
  // of the world_root_id/parent_id fix above. Null for every named character and
  // for every row that predates the field, so the key reduces to the previous one
  // and no existing document can violate it: looser, never tighter.
  {
    collection: COLLECTIONS.entities,
    key: { instance_id: 1, type: 1, world_root_id: 1, parent_id: 1, name_normalized: 1, identity_scope: 1 },
    options: { unique: true, name: "idx_entities_instance_type_root_parent_name_scope" },
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
  // Bounded candidate lookup for free-text mention matching: query only entities
  // whose normalized name/alias tokens intersect the input's tokens, instead of
  // loading the whole (stub-heavy) registry. Multikey over name_tokens[].
  {
    collection: COLLECTIONS.entities,
    key: { instance_id: 1, name_tokens: 1 },
    options: { name: "idx_entities_instance_name_tokens" },
  },
  // Children lookup + subtree world_root_id refresh on re-parent (P1 spine).
  {
    collection: COLLECTIONS.entities,
    key: { instance_id: 1, parent_id: 1 },
    options: { sparse: true, name: "idx_entities_instance_parent" },
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

  // chapter_summaries
  {
    collection: COLLECTIONS.chapter_summaries,
    key: { instance_id: 1, "event_range.end_sequence": -1 },
    options: { name: "idx_chapter_summaries_instance_event_end" },
  },

  // arc_summaries
  {
    collection: COLLECTIONS.arc_summaries,
    key: { instance_id: 1, "event_range.end_sequence": -1 },
    options: { name: "idx_arc_summaries_instance_event_end" },
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
    key: { creator_id: 1, updated_at: -1 },
    options: { name: "idx_world_templates_creator_updated" },
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

  // projection_anomalies (debug/admin surface: by instance, recent first; and a
  // type filter for "how often does extraction drop X")
  {
    collection: COLLECTIONS.projection_anomalies,
    key: { instance_id: 1, sequence: -1 },
    options: { name: "idx_projection_anomalies_instance_seq" },
  },
  {
    collection: COLLECTIONS.projection_anomalies,
    key: { instance_id: 1, type: 1 },
    options: { name: "idx_projection_anomalies_instance_type" },
  },

  // signal_ledger (FP/FN measurement: per-turn signal tallies, by instance recent
  // first; aggregations scan by instance and filter player_corrected for precision)
  {
    collection: COLLECTIONS.signal_ledger,
    key: { instance_id: 1, sequence: -1 },
    options: { name: "idx_signal_ledger_instance_seq" },
  },

  // projection_checkpoints (chunked world projection snapshots for scalable
  // replay/rewind repair: restore latest checkpoint, then replay only the suffix).
  {
    collection: COLLECTIONS.projection_checkpoints,
    key: { instance_id: 1, kind: 1, status: 1, sequence: -1 },
    options: { name: "idx_projection_checkpoints_latest" },
  },
  {
    collection: COLLECTIONS.projection_checkpoints,
    key: { instance_id: 1, sequence: 1 },
    options: { unique: true, name: "uniq_projection_checkpoint_instance_sequence" },
  },
  {
    collection: COLLECTIONS.projection_checkpoint_chunks,
    key: { checkpoint_id: 1, kind: 1, index: 1 },
    options: { name: "idx_projection_checkpoint_chunks_checkpoint_kind" },
  },
  {
    collection: COLLECTIONS.projection_checkpoint_chunks,
    key: { instance_id: 1, sequence: 1 },
    options: { name: "idx_projection_checkpoint_chunks_instance_sequence" },
  },

  // location_stats (materialized Places projection: one row per place per
  // instance, maintained incrementally so the Places tab never re-aggregates the
  // whole world). Natural key + the most-recently-seen-first read.
  {
    collection: COLLECTIONS.location_stats,
    key: { instance_id: 1, entity_id: 1 },
    options: { unique: true, name: "uniq_location_stats_instance_entity" },
  },
  {
    collection: COLLECTIONS.location_stats,
    key: { instance_id: 1, last_seen_sequence: -1 },
    options: { name: "idx_location_stats_instance_last_seen" },
  },

  // content_reports (player abuse reports). The triage read is "open reports,
  // most severe first, then oldest first" — a moderation queue is worked from
  // the back, unlike every other listing in this file.
  {
    collection: COLLECTIONS.content_reports,
    key: { status: 1, is_critical: -1, created_at: 1 },
    options: { name: "idx_content_reports_triage" },
  },
  {
    collection: COLLECTIONS.content_reports,
    key: { target_type: 1, target_id: 1, created_at: -1 },
    options: { name: "idx_content_reports_target" },
  },
  // One open report per reporter per target: re-reporting the same world is a
  // no-op rather than a way to flood the queue. Partial so a reporter can file
  // again after the first report has been resolved.
  {
    collection: COLLECTIONS.content_reports,
    key: { reporter_id: 1, target_type: 1, target_id: 1 },
    options: {
      unique: true,
      name: "uniq_content_reports_open_per_reporter",
      partialFilterExpression: { status: { $in: ["open", "reviewing"] } },
    },
  },
  // web_events (marketing-site interactions). Two reads only: "what happened in
  // the last N days, by name" for the funnel, and the per-session rollup that
  // turns raw clicks into "of the people who did A, how many went on to do C".
  {
    collection: COLLECTIONS.web_events,
    key: { created_at: -1, name: 1 },
    options: { name: "idx_web_events_recent" },
  },
  {
    collection: COLLECTIONS.web_events,
    key: { session: 1, created_at: 1 },
    options: { name: "idx_web_events_session" },
  },
  // Nobody needs to know what a stranger clicked half a year ago, and an
  // anonymous log that grows forever is a liability rather than an asset.
  {
    collection: COLLECTIONS.web_events,
    key: { created_at: 1 },
    options: { name: "ttl_web_events_180d", expireAfterSeconds: 60 * 60 * 24 * 180 },
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
  // Replaced by idx_memories_text_search_v2 (search_terms joined the text index so a
  // memory is found under alternate phrasings). Mongo allows one text index per
  // collection, so the old one must be dropped before the v2 is created.
  { collection: COLLECTIONS.memories, name: "idx_memories_text_search" },
  // Draft Phase 6A index briefly pointed at the whole object instead of entity_id.
  { collection: COLLECTIONS.world_instances, name: "idx_world_instances_current_location" },
  // Replaced by idx_entities_instance_type_root_name (world_root_id joined the unique
  // key so same-named places can coexist across different worlds/realms — P1 spine).
  { collection: COLLECTIONS.entities, name: "idx_entities_instance_type_name" },
  // Replaced by idx_entities_instance_type_root_parent_name (parent_id joined the
  // unique key so same-named places coexist under different containers in ONE world
  // — intra-world collision fix). Looser than the old key, so no existing row can
  // violate the new one; safe to drop + recreate at startup.
  { collection: COLLECTIONS.entities, name: "idx_entities_instance_type_root_name" },
  // Replaced by idx_entities_instance_type_root_parent_name_scope (identity_scope
  // joined the unique key so two same-labelled PEOPLE coexist — the character
  // twin of the intra-world place collision). Strictly looser than the old key,
  // so no existing row can violate the new one; safe to drop + recreate at
  // startup, and no data migration is required.
  { collection: COLLECTIONS.entities, name: "idx_entities_instance_type_root_parent_name" },
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
