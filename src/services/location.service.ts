import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { parseObjectId, idString } from '../utils/mongo-id'
import type { LocationStatsDoc } from '../models/location-stats.model'
import type { EntityDoc } from '../models/entity.model'
import type { WorldEventDoc } from '../models/world-event.model'
import type { MemoryDoc } from '../models/memory.model'

/**
 * The materialized location_stats collection (see location-stats.model.ts).
 * Registered in COLLECTIONS / mongoColl with indexes in mongo-indexes.ts (built
 * at startup), so the projection is owned/provisioned like every other collection.
 */
const locationStats = () => mongoColl.locationStats()

/** Clean a one-line caption for a place's moment: prefer what the player did or
 *  said that turn, else a snippet of the narration. Strips emphasis markers and
 *  collapses whitespace; trims to a tile-friendly length on a word boundary. */
function eventPreview(playerInput?: string | null, aiResponse?: string | null): string | null {
  const clean = (s?: string | null) =>
    (s || '').replace(/[*_>#`]/g, '').replace(/\s+/g, ' ').trim()
  const raw = clean(playerInput) || clean(aiResponse)
  if (!raw) return null
  if (raw.length <= 110) return raw
  const cut = raw.slice(0, 110)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trim()}…`
}

function mainVisibleMemoryScopeFor(protagonistId: ObjectId | null | undefined) {
  return {
    $or: [
      { origin: { $ne: 'side_chat' as const } },
      ...(protagonistId ? [{ known_by_entity_ids: protagonistId }] : []),
    ],
  }
}

async function mainVisibleMemoryScope(instanceId: ReturnType<typeof parseObjectId>) {
  const protagonist = await mongoColl
    .entities()
    .findOne({ instance_id: instanceId, type: 'protagonist' }, { projection: { _id: 1 } })
  return mainVisibleMemoryScopeFor(protagonist?._id)
}

/** Exact, INDEX-BACKED tallies for ONE place — a bounded countDocuments per
 *  collection (uses idx_events_instance_location_sequence /
 *  idx_memories_instance_location_importance), never a full-collection group. */
async function countAnchorsForPlace(
  iid: ObjectId,
  entityId: ObjectId,
  protagonistId: ObjectId | null | undefined,
): Promise<{
  event_count: number
  memory_count: number
  first_seen_sequence: number | null
  last_seen_sequence: number | null
}> {
  const mainVisibleMemory = mainVisibleMemoryScopeFor(protagonistId)
  const [event_count, memory_count, firstEv, lastEv] = await Promise.all([
    mongoColl.events().countDocuments({
      instance_id: iid,
      type: { $ne: 'side_chat' },
      'location_anchor.entity_id': entityId,
    }),
    mongoColl.memories().countDocuments({
      instance_id: iid,
      location_entity_id: entityId,
      is_archived: false,
      ...mainVisibleMemory,
    }),
    mongoColl
      .events()
      .find({ instance_id: iid, type: { $ne: 'side_chat' }, 'location_anchor.entity_id': entityId }, { projection: { sequence: 1 } })
      .sort({ sequence: 1 })
      .limit(1)
      .next(),
    mongoColl
      .events()
      .find({ instance_id: iid, type: { $ne: 'side_chat' }, 'location_anchor.entity_id': entityId }, { projection: { sequence: 1 } })
      .sort({ sequence: -1 })
      .limit(1)
      .next(),
  ])
  return {
    event_count,
    memory_count,
    first_seen_sequence: firstEv?.sequence ?? null,
    last_seen_sequence: lastEv?.sequence ?? null,
  }
}

/**
 * Location Journal read surface — "what happened here before?". Events and
 * memories already carry a denormalized `location_anchor` / `location_entity_id`
 * (Phase 6A); this service just aggregates them per place for the product UI.
 * Read-only; the location cursor itself is owned by generation.
 */
export const locationService = {
  /** Every place that has at least one anchored event or memory, plus the
   *  instance's current-location cursor. Sorted most-recently-seen first.
   *
   *  Reads from the materialized `location_stats` projection — a bounded,
   *  pre-aggregated, index-sorted list — instead of grouping every anchored
   *  event + memory and loading every location entity live (the old full-world
   *  scan). The projection is maintained incrementally by {@link refreshLocationStat}
   *  as places are anchored; {@link backfillLocationStats} builds it once from
   *  existing data. If the projection is empty for an instance that DOES have
   *  places (e.g. first read after deploy, before backfill), we lazily backfill
   *  it so the endpoint is self-healing and never returns an empty atlas. The
   *  response shape is byte-for-byte the same the client already consumes. */
  async listLocations(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new Error('Instance not found')

    let stats = (await locationStats()
      .find({ instance_id: iid })
      .sort({ last_seen_sequence: -1 })
      .toArray()) as LocationStatsDoc[]

    // Self-heal: an instance that has location entities but no projection rows
    // yet (pre-backfill / fresh deploy) builds its projection on first read,
    // then re-reads. One-time cost per instance; thereafter purely incremental.
    if (stats.length === 0) {
      const hasPlaces = await mongoColl
        .entities()
        .countDocuments({ instance_id: iid, type: 'location', status: { $ne: 'archived' } })
      if (hasPlaces > 0) {
        await this.backfillLocationStats(instanceId)
        stats = (await locationStats()
          .find({ instance_id: iid })
          .sort({ last_seen_sequence: -1 })
          .toArray()) as LocationStatsDoc[]
      }
    }

    const places = stats.map((s) => ({
      entity_id: idString(s.entity_id),
      name: s.name || 'An unnamed place',
      parent_id: s.parent_id ? idString(s.parent_id) : null,
      world_root_id: s.world_root_id ? idString(s.world_root_id) : null,
      place_kind: s.place_kind ?? null,
      event_count: s.event_count ?? 0,
      memory_count: s.memory_count ?? 0,
      first_seen_sequence: s.first_seen_sequence ?? null,
      last_seen_sequence: s.last_seen_sequence ?? null,
    }))

    const cursor = instance.current_location
    return {
      current_location: cursor
        ? { entity_id: cursor.entity_id ? idString(cursor.entity_id) : null, name: cursor.name }
        : null,
      places,
    }
  },

  /**
   * Incrementally refresh the `location_stats` row for ONE place after a persisted
   * event or curated memory changes that place's counts. Recomputes only this
   * place's counts (bounded, indexed countDocuments per collection) and mirrors
   * the entity's spine fields. Best-effort + idempotent: a failure here never
   * breaks the turn pipeline — the next touch (or a backfill) reconciles. Upserts
   * on the (instance, entity) natural key.
   */
  async refreshLocationStat(instanceId: string, entityId: string): Promise<void> {
    try {
      const iid = parseObjectId(instanceId)
      const eid = parseObjectId(entityId)
      const [entity, protagonist] = await Promise.all([
        mongoColl.entities().findOne(
          { _id: eid, instance_id: iid, type: 'location' },
          { projection: { canonical_name: 1, parent_id: 1, world_root_id: 1, place_kind: 1 } },
        ) as Promise<EntityDoc | null>,
        mongoColl.entities().findOne({ instance_id: iid, type: 'protagonist' }, { projection: { _id: 1 } }),
      ])
      const counts = await countAnchorsForPlace(iid, eid, protagonist?._id)
      await locationStats().updateOne(
        { instance_id: iid, entity_id: eid },
        {
          $set: {
            name: entity?.canonical_name || 'An unnamed place',
            parent_id: entity?.parent_id ?? null,
            world_root_id: entity?.world_root_id ?? null,
            place_kind: entity?.place_kind ?? null,
            event_count: counts.event_count,
            memory_count: counts.memory_count,
            first_seen_sequence: counts.first_seen_sequence,
            last_seen_sequence: counts.last_seen_sequence,
            updated_at: new Date(),
          },
          $setOnInsert: { instance_id: iid, entity_id: eid },
        },
        { upsert: true },
      )
    } catch {
      // Projection maintenance is best-effort; the read path self-heals via backfill.
    }
  },

  /**
   * One-time backfill: build the `location_stats` projection for one instance
   * from existing entities/events/memories. Mirrors the OLD listLocations
   * aggregation exactly (same spine, same main-visible memory scope) so a
   * backfilled projection equals a freshly maintained one. Idempotent — re-running
   * recomputes every row. Safe to run live (per-instance, bounded by place count).
   */
  async backfillLocationStats(instanceId: string): Promise<{ places: number }> {
    const iid = parseObjectId(instanceId)
    const protagonist = await mongoColl
      .entities()
      .findOne({ instance_id: iid, type: 'protagonist' }, { projection: { _id: 1 } })
    const mainVisibleMemory = mainVisibleMemoryScopeFor(protagonist?._id)

    // Spine: every location entity (so empty containers still appear).
    const spine = (await mongoColl
      .entities()
      .find(
        { instance_id: iid, type: 'location', status: { $ne: 'archived' } },
        { projection: { canonical_name: 1, parent_id: 1, world_root_id: 1, place_kind: 1, first_seen_sequence: 1, last_seen_sequence: 1 } },
      )
      .toArray()) as EntityDoc[]

    const [eventAgg, memAgg] = await Promise.all([
      mongoColl
        .events()
        .aggregate([
          { $match: { instance_id: iid, type: { $ne: 'side_chat' }, 'location_anchor.entity_id': { $ne: null } } },
          { $sort: { sequence: 1 } },
          {
            $group: {
              _id: '$location_anchor.entity_id',
              name: { $last: '$location_anchor.name' },
              event_count: { $sum: 1 },
              first_seen_sequence: { $min: '$sequence' },
              last_seen_sequence: { $max: '$sequence' },
            },
          },
        ])
        .toArray(),
      mongoColl
        .memories()
        .aggregate([
          { $match: { instance_id: iid, location_entity_id: { $ne: null }, is_archived: false, ...mainVisibleMemory } },
          { $group: { _id: '$location_entity_id', name: { $last: '$location_name' }, memory_count: { $sum: 1 } } },
        ])
        .toArray(),
    ])

    const byId = new Map<string, LocationStatsDoc>()
    const mk = (eid: ObjectId): LocationStatsDoc => ({
      _id: new ObjectId(),
      instance_id: iid,
      entity_id: eid,
      name: 'An unnamed place',
      parent_id: null,
      world_root_id: null,
      place_kind: null,
      event_count: 0,
      memory_count: 0,
      first_seen_sequence: null,
      last_seen_sequence: null,
      updated_at: new Date(),
    })
    for (const s of spine) {
      const row = mk(s._id)
      row.name = s.canonical_name || 'An unnamed place'
      row.parent_id = s.parent_id ?? null
      row.world_root_id = s.world_root_id ?? null
      row.place_kind = s.place_kind ?? null
      row.first_seen_sequence = s.first_seen_sequence ?? null
      row.last_seen_sequence = s.last_seen_sequence ?? null
      byId.set(idString(s._id), row)
    }
    for (const e of eventAgg) {
      if (!e._id) continue
      const key = idString(e._id)
      const row = byId.get(key) ?? mk(e._id as ObjectId)
      row.event_count = e.event_count
      if ((!row.name || row.name === 'An unnamed place') && e.name) row.name = e.name
      // An entity can be discovered by a mention before the player ever visits
      // it. Once events are actually anchored, visit history must come from
      // those anchors—not from the entity's incidental discovery sequence.
      row.first_seen_sequence = e.first_seen_sequence ?? row.first_seen_sequence ?? null
      row.last_seen_sequence = e.last_seen_sequence ?? row.last_seen_sequence ?? null
      byId.set(key, row)
    }
    for (const m of memAgg) {
      if (!m._id) continue
      const key = idString(m._id)
      const row = byId.get(key) ?? mk(m._id as ObjectId)
      row.memory_count = m.memory_count
      if ((!row.name || row.name === 'An unnamed place') && m.name) row.name = m.name
      byId.set(key, row)
    }

    const rows = [...byId.values()]
    if (rows.length) {
      await locationStats().bulkWrite(
        rows.map((r) => ({
          updateOne: {
            filter: { instance_id: iid, entity_id: r.entity_id },
            update: {
              $set: {
                name: r.name,
                parent_id: r.parent_id,
                world_root_id: r.world_root_id,
                place_kind: r.place_kind,
                event_count: r.event_count,
                memory_count: r.memory_count,
                first_seen_sequence: r.first_seen_sequence,
                last_seen_sequence: r.last_seen_sequence,
                updated_at: new Date(),
              },
              $setOnInsert: { instance_id: iid, entity_id: r.entity_id },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      )
    }
    return { places: rows.length }
  },

  /** "What happened here before?" — events and memories anchored to one place. */
  async getLocationJournal(instanceId: string, playerId: string, locationEntityId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const leid = parseObjectId(locationEntityId)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new Error('Instance not found')
    const mainVisibleMemory = await mainVisibleMemoryScope(iid)

    const [entity, evs, mems] = await Promise.all([
      mongoColl.entities().findOne({ _id: leid, instance_id: iid }),
      mongoColl
        .events()
        .find(
          { instance_id: iid, type: { $ne: 'side_chat' }, 'location_anchor.entity_id': leid },
          {
            projection: {
              sequence: 1,
              type: 1,
              scene_tag: 1,
              time_anchor: 1,
              location_anchor: 1,
              'data.milestone': 1,
              'data.player_input': 1,
              'data.ai_response': 1,
              created_at: 1,
            },
          },
        )
        .sort({ sequence: 1 })
        .toArray(),
      mongoColl
        .memories()
        .find({ instance_id: iid, location_entity_id: leid, is_archived: false, ...mainVisibleMemory })
        .sort({ importance: -1 })
        .limit(50)
        .toArray(),
    ])

    const name =
      entity?.canonical_name ||
      evs[0]?.location_anchor?.name ||
      mems[0]?.location_name ||
      'This place'

    const factText = (list: Array<{ text: string }> | undefined) =>
      (list || []).map((f) => f.text).filter(Boolean)

    return {
      location: {
        entity_id: locationEntityId,
        name,
        permanent_facts: factText((entity as EntityDoc | null)?.location_facts),
        current_state: factText((entity as EntityDoc | null)?.location_state),
      },
      events: (evs as WorldEventDoc[]).map((e) => ({
        id: idString(e._id),
        sequence: e.sequence,
        type: e.type,
        scene_tag: e.scene_tag,
        time_anchor: e.time_anchor || null,
        milestone: e.data?.milestone || null,
        // A real one-line caption of the beat — what the player did/said here,
        // else a snippet of the narration — so the timeline reads as actual
        // moments, not a column of generic "Dialogue / Mundane" tags.
        preview: eventPreview(e.data?.player_input, e.data?.ai_response),
        created_at: e.created_at,
      })),
      memories: (mems as MemoryDoc[]).map((m) => ({
        id: idString(m._id),
        text: m.text,
        type: m.type,
        importance: m.importance,
        emotional_valence: m.emotional_valence || null,
        time_anchor: m.time_anchor || null,
      })),
    }
  },
}
