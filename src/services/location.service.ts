import { mongoColl } from '../config/mongo'
import { parseObjectId, idString } from '../utils/mongo-id'
import type { WorldEventDoc } from '../models/world-event.model'
import type { MemoryDoc } from '../models/memory.model'
import type { EntityDoc } from '../models/entity.model'

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

async function mainVisibleMemoryScope(instanceId: ReturnType<typeof parseObjectId>) {
  const protagonist = await mongoColl
    .entities()
    .findOne({ instance_id: instanceId, type: 'protagonist' }, { projection: { _id: 1 } })

  return {
    $or: [
      { origin: { $ne: 'side_chat' as const } },
      ...(protagonist?._id ? [{ known_by_entity_ids: protagonist._id }] : []),
    ],
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
   *  instance's current-location cursor. Sorted most-recently-seen first. */
  async listLocations(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new Error('Instance not found')
    const mainVisibleMemory = await mainVisibleMemoryScope(iid)

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
          {
            $match: {
              instance_id: iid,
              location_entity_id: { $ne: null },
              is_archived: false,
              ...mainVisibleMemory,
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

    // The full containment spine — EVERY location entity, so empty containers
    // (a building/region with no events of its own yet) still appear in the
    // atlas tree. Event/memory counts are overlaid below.
    const spine = (await mongoColl
      .entities()
      .find(
        { instance_id: iid, type: 'location', status: { $ne: 'archived' } },
        { projection: { canonical_name: 1, parent_id: 1, world_root_id: 1, place_kind: 1, first_seen_sequence: 1, last_seen_sequence: 1 } },
      )
      .toArray()) as EntityDoc[]

    const byId = new Map<string, any>()
    for (const s of spine) {
      byId.set(idString(s._id), {
        entity_id: idString(s._id),
        name: s.canonical_name || 'An unnamed place',
        parent_id: s.parent_id ? idString(s.parent_id) : null,
        world_root_id: s.world_root_id ? idString(s.world_root_id) : null,
        place_kind: s.place_kind ?? null,
        event_count: 0,
        memory_count: 0,
        first_seen_sequence: s.first_seen_sequence ?? null,
        last_seen_sequence: s.last_seen_sequence ?? null,
      })
    }
    for (const e of eventAgg) {
      if (!e._id) continue
      const key = idString(e._id)
      const existing = byId.get(key)
      if (existing) {
        existing.event_count = e.event_count
        if ((!existing.name || existing.name === 'An unnamed place') && e.name) existing.name = e.name
        existing.first_seen_sequence = existing.first_seen_sequence ?? e.first_seen_sequence ?? null
        existing.last_seen_sequence = Math.max(existing.last_seen_sequence ?? -1, e.last_seen_sequence ?? -1)
      } else {
        byId.set(key, {
          entity_id: key,
          name: e.name || 'An unnamed place',
          parent_id: null,
          world_root_id: null,
          place_kind: null,
          event_count: e.event_count,
          memory_count: 0,
          first_seen_sequence: e.first_seen_sequence ?? null,
          last_seen_sequence: e.last_seen_sequence ?? null,
        })
      }
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
          parent_id: null,
          world_root_id: null,
          place_kind: null,
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
