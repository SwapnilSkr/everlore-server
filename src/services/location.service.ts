import { mongoColl } from '../config/mongo'
import { parseObjectId, idString } from '../utils/mongo-id'
import type { WorldEventDoc } from '../models/world-event.model'
import type { MemoryDoc } from '../models/memory.model'

/**
 * Location Journal read surface — "what happened here before?". Events and
 * memories already carry a denormalized `location_anchor` / `location_entity_id`
 * (Phase 6A); this service just aggregates them per place for the product UI.
 * Read-only; the location cursor itself is owned by generation.
 */
export const locationService = {
  /** Every place that has at least one anchored event or memory, plus the
   *  instance's current-location cursor. Sorted most-recently-seen first. */
  async listLocations(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new Error('Instance not found')

    const [eventAgg, memAgg] = await Promise.all([
      mongoColl
        .events()
        .aggregate([
          { $match: { instance_id: iid, 'location_anchor.entity_id': { $ne: null } } },
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
          {
            $match: {
              instance_id: iid,
              location_entity_id: { $ne: null },
              is_archived: false,
            },
          },
          {
            $group: {
              _id: '$location_entity_id',
              name: { $last: '$location_name' },
              memory_count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
    ])

    const byId = new Map<string, any>()
    for (const e of eventAgg) {
      if (!e._id) continue
      byId.set(idString(e._id), {
        entity_id: idString(e._id),
        name: e.name || 'An unnamed place',
        event_count: e.event_count,
        memory_count: 0,
        first_seen_sequence: e.first_seen_sequence ?? null,
        last_seen_sequence: e.last_seen_sequence ?? null,
      })
    }
    for (const m of memAgg) {
      if (!m._id) continue
      const key = idString(m._id)
      const existing = byId.get(key)
      if (existing) {
        existing.memory_count = m.memory_count
        if ((!existing.name || existing.name === 'An unnamed place') && m.name) {
          existing.name = m.name
        }
      } else {
        byId.set(key, {
          entity_id: key,
          name: m.name || 'An unnamed place',
          event_count: 0,
          memory_count: m.memory_count,
          first_seen_sequence: null,
          last_seen_sequence: null,
        })
      }
    }

    const places = [...byId.values()].sort(
      (a, b) => (b.last_seen_sequence ?? -1) - (a.last_seen_sequence ?? -1),
    )

    const cursor = instance.current_location
    return {
      current_location: cursor
        ? { entity_id: cursor.entity_id ? idString(cursor.entity_id) : null, name: cursor.name }
        : null,
      places,
    }
  },

  /** "What happened here before?" — events and memories anchored to one place. */
  async getLocationJournal(instanceId: string, playerId: string, locationEntityId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const leid = parseObjectId(locationEntityId)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new Error('Instance not found')

    const [entity, evs, mems] = await Promise.all([
      mongoColl.entities().findOne({ _id: leid, instance_id: iid }),
      mongoColl
        .events()
        .find(
          { instance_id: iid, 'location_anchor.entity_id': leid },
          {
            projection: {
              sequence: 1,
              type: 1,
              scene_tag: 1,
              time_anchor: 1,
              location_anchor: 1,
              'data.milestone': 1,
              created_at: 1,
            },
          },
        )
        .sort({ sequence: 1 })
        .toArray(),
      mongoColl
        .memories()
        .find({ instance_id: iid, location_entity_id: leid, is_archived: false })
        .sort({ importance: -1 })
        .limit(50)
        .toArray(),
    ])

    const name =
      entity?.canonical_name ||
      evs[0]?.location_anchor?.name ||
      mems[0]?.location_name ||
      'This place'

    return {
      location: { entity_id: locationEntityId, name },
      events: (evs as WorldEventDoc[]).map((e) => ({
        id: idString(e._id),
        sequence: e.sequence,
        type: e.type,
        scene_tag: e.scene_tag,
        time_anchor: e.time_anchor || null,
        milestone: e.data?.milestone || null,
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
