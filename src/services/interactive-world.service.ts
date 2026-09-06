import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type {
  InteractiveLocationDoc,
  InteractiveVisibility,
  InteractiveWorldDoc,
  InteractiveWorldStateDoc,
} from '../models/interactive-world.model'
import type { WorldEventDoc } from '../models/world-event.model'
import type { MemoryDoc } from '../models/memory.model'
import { loadWorld, requireWorld, type WorldChoice } from '../worlds/world-source'
import { storageService } from './storage.service'
import { HttpError } from '../utils/http-error'
import { parseObjectId } from '../utils/mongo-id'

const WORLD_KEY = 'iron-verdict'
const WORLD_VERSION = 27

/**
 * What the player currently knows about a place.
 *
 * Authored visibility is the floor, and flags only ever open it further. A
 * `rumoured` place is not on the map at all until its reveal flag lands, which
 * is what makes the map grow during play instead of being laid out up front.
 */
export function visibilityFor(location: InteractiveLocationDoc, flags: Record<string, boolean>): InteractiveVisibility {
  if (location.visibility === 'rumoured' && !(location.reveal_flag && flags[location.reveal_flag] === true)) {
    return 'rumoured'
  }
  if (location.unlock_flag && flags[location.unlock_flag] !== true) return 'sealed'
  return 'open'
}

export const interactiveWorldService = {
  async ensureWorld(worldKey: string = WORLD_KEY): Promise<InteractiveWorldDoc> {
    const authored = loadWorld(worldKey)
    if (!authored) throw new HttpError(404, 'Interactive world not found')
    const worlds = mongoColl.interactiveWorlds()
    const now = new Date()
    const definition = {
      version: WORLD_VERSION,
      title: authored.title,
      chapter_title: authored.chapter_title,
      map_style: authored.map_style,
      realms: authored.realms,
      assets: authored.assets,
      locations: authored.locations,
      updated_at: now,
    }
    await worlds.updateOne(
      { key: worldKey },
      { $setOnInsert: { _id: new ObjectId(), key: worldKey, created_at: now, ...definition } },
      { upsert: true },
    )
    // A published revision is never mutated under players; only an older one is
    // brought forward, and a real content change increments WORLD_VERSION.
    await worlds.updateOne({ key: worldKey, version: { $lt: WORLD_VERSION } }, { $set: definition })
    const world = await worlds.findOne({ key: worldKey })
    if (!world) throw new Error(`Could not initialise the world "${worldKey}"`)
    return world as InteractiveWorldDoc
  },

  async definition(worldKey: string) {
    // Any world with a data file is servable. There is no list of known worlds
    // in this file any more - that was the last place a world had to be named
    // in code to exist.
    const authored = loadWorld(worldKey)
    if (!authored) throw new HttpError(404, 'Interactive world not found')
    const world = await this.ensureWorld(worldKey)
    return {
      ...world,
      // Choices ship with the definition so the client renders authored copy
      // instead of carrying a switch statement per location.
      choices: authored.choices.map(({ id, at, requires, label }) => ({ id, at, requires, label })),
      assets: world.assets.map((asset) => ({ ...asset, url: storageService.urlForKey(asset.key) })),
    }
  },

  async state(worldKey: string, instanceId: string, playerId: string) {
    const authored = requireWorld(worldKey)
    const world = await this.definition(worldKey)
    const instanceOid = parseObjectId(instanceId)
    const playerOid = parseObjectId(playerId)
    const instance = await mongoColl.worldInstances().findOne({ _id: instanceOid, player_id: playerOid })
    if (!instance) throw new HttpError(404, 'World instance not found')
    const states = mongoColl.interactiveWorldStates()
    const now = new Date()
    await states.updateOne(
      { instance_id: instanceOid, world_key: worldKey },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          instance_id: instanceOid,
          player_id: playerOid,
          world_key: worldKey,
          current_location_id: authored.start_location_id,
          unlocked_location_ids: [authored.start_location_id],
          revealed_location_ids: world.locations.filter((l) => l.visibility !== 'rumoured').map((l) => l.id),
          flags: {},
          seen_scene_ids: [],
          sequence: 0,
          created_at: now,
          updated_at: now,
        },
      },
      { upsert: true },
    )
    const state = await states.findOne({ instance_id: instanceOid, world_key: worldKey })
    if (!state) throw new Error('Could not initialise interactive world state')
    return { world, state: state as InteractiveWorldStateDoc }
  },

  async act(
    worldKey: string,
    instanceId: string,
    playerId: string,
    action: { type: 'move' | 'choose'; location_id?: string; choice_id?: string },
  ) {
    const authored = requireWorld(worldKey)
    const { world, state } = await this.state(worldKey, instanceId, playerId)
    const now = new Date()
    const next: InteractiveWorldStateDoc = {
      ...state,
      flags: { ...state.flags },
      unlocked_location_ids: [...state.unlocked_location_ids],
      revealed_location_ids: [...state.revealed_location_ids],
      seen_scene_ids: [...state.seen_scene_ids],
    }
    let summary: string
    let flagSet: string | null = null
    let memory: WorldChoice['memory'] | undefined
    let isFirst = false

    if (action.type === 'move') {
      const destination = world.locations.find((l) => l.id === action.location_id)
      const current = world.locations.find((l) => l.id === state.current_location_id)
      if (!destination || !current || !current.routes.includes(destination.id)) {
        throw new HttpError(400, 'That route is not available')
      }
      const visibility = visibilityFor(destination, state.flags)
      if (visibility === 'rumoured') throw new HttpError(404, 'You know of no such place')
      if (visibility === 'sealed') throw new HttpError(403, destination.sealed_reason || 'That place is still closed to you')
      next.current_location_id = destination.id
      if (destination.scene_asset_id && !next.seen_scene_ids.includes(destination.id)) {
        next.seen_scene_ids.push(destination.id)
      }
      summary = `Travelled to ${destination.title}.`
    } else {
      const choice = authored.choices.find((c) => c.id === action.choice_id)
      if (!choice) throw new HttpError(400, 'Unknown world action')
      if (state.current_location_id !== choice.at) throw new HttpError(400, 'That choice is not available here')
      if (choice.requires && state.flags[choice.requires] !== true) {
        throw new HttpError(400, 'That is not open to you yet')
      }
      isFirst = state.flags[choice.sets] !== true
      next.flags[choice.sets] = true
      flagSet = choice.sets
      summary = choice.summary
      if (isFirst) memory = choice.memory
    }

    // One rule promotes everything: a flag can unseal a place and can lift fog.
    // Deriving both from the same pass means a new location never needs new
    // promotion code, only new data.
    for (const location of world.locations) {
      const visibility = visibilityFor(location, next.flags)
      if (visibility !== 'rumoured' && !next.revealed_location_ids.includes(location.id)) {
        next.revealed_location_ids.push(location.id)
      }
      if (visibility === 'open' && !next.unlocked_location_ids.includes(location.id)) {
        next.unlocked_location_ids.push(location.id)
      }
    }

    next.sequence += 1
    next.updated_at = now
    const { _id: _stateId, ...persisted } = next
    await mongoColl.interactiveWorldStates().updateOne({ _id: state._id }, { $set: persisted })

    const lastEvent = await mongoColl.events().findOne({ instance_id: state.instance_id }, { sort: { sequence: -1 } })
    const eventId = new ObjectId()
    await mongoColl.events().insertOne({
      _id: eventId,
      instance_id: state.instance_id,
      player_id: state.player_id,
      sequence: (lastEvent?.sequence || 0) + 1,
      type: 'interactive_world',
      data: {
        player_input: action.type === 'move' ? `Travel: ${action.location_id}` : `Choice: ${action.choice_id}`,
        ai_response: summary,
        state_mutations: {},
        flag_mutations: flagSet ? { [flagSet]: { op: 'set', value: true } } : {},
        model_used: 'interactive-world-resolver',
        tokens_in: 0,
        tokens_out: 0,
      },
      is_user_edited: false,
      edit_history: [],
      scene_tag: `interactive:${next.current_location_id}`,
      created_at: now,
    } as WorldEventDoc)

    if (memory) {
      const where = world.locations.find((l) => l.id === next.current_location_id)
      await mongoColl.memories().insertOne({
        _id: new ObjectId(),
        instance_id: state.instance_id,
        player_id: state.player_id,
        text: memory.text,
        type: 'interactive_world',
        importance: 7,
        is_nsfw: false,
        source_event_ids: [eventId],
        pinecone_id: null,
        access_count: 0,
        last_accessed_at: now,
        is_archived: false,
        subjects: memory.subjects,
        objects: memory.objects,
        search_terms: memory.terms,
        location_name: where?.title || next.current_location_id,
        emotional_valence: memory.valence,
        emotional_cause: summary,
        unresolved_thread: true,
        created_at: now,
        updated_at: now,
      } as MemoryDoc)
    }

    await mongoColl.worldInstances().updateOne(
      { _id: state.instance_id },
      { $set: { 'meta.last_active_at': now }, $inc: { 'meta.total_events': 1, ...(memory ? { 'meta.total_memories': 1 } : {}) } },
    )
    return { world, state: next, event: { sequence: next.sequence, action, summary, at: now } }
  },
}
