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
import {
  asList,
  choicePredicate,
  effectiveFlags,
  loadWorld,
  requireWorld,
  satisfies,
  type WorldChoice,
} from '../worlds/world-source'
import { endingFlag, endingFor, PETITIONS_OPEN, progressionFor, resolutionOf } from '../worlds/progression'
import { storageService } from './storage.service'
import { HttpError } from '../utils/http-error'
import { parseObjectId } from '../utils/mongo-id'

const WORLD_KEY = 'iron-verdict'
const WORLD_VERSION = 30

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
      choices: authored.choices.map(({ id, at, requires, forbids, label }) => ({ id, at, requires, forbids, label })),
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
          taken_choice_ids: [],
          ledger: [],
          sequence: 0,
          created_at: now,
          updated_at: now,
        },
      },
      { upsert: true },
    )
    const found = await states.findOne({ instance_id: instanceOid, world_key: worldKey })
    if (!found) throw new Error('Could not initialise interactive world state')
    // States written before standing existed have no choice list. Default it
    // here rather than at every read site.
    const state = {
      ...found,
      taken_choice_ids: found.taken_choice_ids ?? [],
      ledger: found.ledger ?? [],
    } as InteractiveWorldStateDoc
    // What the story has done counts too. Everything downstream — visibility,
    // which choices are offered, standing, the ending — reads this and never
    // `state.flags` directly, so there is one answer to "what is true".
    const flags = effectiveFlags(authored, state.flags, instance.active_flags)
    return {
      world,
      state,
      flags,
      progression: progressionFor(authored.progression, authored.reign, world.locations, { ...state, flags }),
    }
  },

  async act(
    worldKey: string,
    instanceId: string,
    playerId: string,
    action: {
      type: 'move' | 'choose' | 'rule'
      location_id?: string
      choice_id?: string
      petition_id?: string
      resolution_id?: string
    },
  ) {
    const authored = requireWorld(worldKey)
    const { world, state, flags: known } = await this.state(worldKey, instanceId, playerId)
    const now = new Date()
    const next: InteractiveWorldStateDoc = {
      ...state,
      // Only authored consequences are written back. Narrated flags stay
      // derived so an edited turn takes them with it.
      flags: { ...state.flags },
      unlocked_location_ids: [...state.unlocked_location_ids],
      revealed_location_ids: [...state.revealed_location_ids],
      seen_scene_ids: [...state.seen_scene_ids],
      taken_choice_ids: [...state.taken_choice_ids],
      ledger: [...state.ledger],
    }
    let summary = ''
    let flagsSet: string[] = []
    let memory: WorldChoice['memory'] | undefined
    let isFirst = false

    if (action.type === 'move') {
      const destination = world.locations.find((l) => l.id === action.location_id)
      const current = world.locations.find((l) => l.id === state.current_location_id)
      if (!destination || !current || !current.routes.includes(destination.id)) {
        throw new HttpError(400, 'That route is not available')
      }
      const visibility = visibilityFor(destination, known)
      if (visibility === 'rumoured') throw new HttpError(404, 'You know of no such place')
      if (visibility === 'sealed') throw new HttpError(403, destination.sealed_reason || 'That place is still closed to you')
      next.current_location_id = destination.id
      if (destination.scene_asset_id && !next.seen_scene_ids.includes(destination.id)) {
        next.seen_scene_ids.push(destination.id)
      }
      summary = `Travelled to ${destination.title}.`
    } else if (action.type === 'choose') {
      const choice = authored.choices.find((c) => c.id === action.choice_id)
      if (!choice) throw new HttpError(400, 'Unknown world action')
      if (state.current_location_id !== choice.at) throw new HttpError(400, 'That choice is not available here')
      if (!satisfies(choicePredicate(choice), { ...known, ...next.flags })) {
        // A forbidden choice and an ungated one are the same refusal to the
        // player: the road is closed, and saying which flag closed it would be
        // naming a mechanic at them.
        throw new HttpError(400, 'That is not open to you yet')
      }
      flagsSet = asList(choice.sets)
      isFirst = !state.taken_choice_ids.includes(choice.id)
      for (const flag of flagsSet) next.flags[flag] = true
      if (isFirst) next.taken_choice_ids.push(choice.id)
      summary = choice.summary
      if (isFirst) memory = choice.memory
    }

    if (action.type === 'rule') {
      if (known[PETITIONS_OPEN] !== true) throw new HttpError(400, 'No one brings you their quarrels yet')
      const found = resolutionOf(authored.reign, action.petition_id ?? '', action.resolution_id ?? '')
      if (!found) throw new HttpError(400, 'Unknown petition')
      const { petition, resolution } = found
      if (state.current_location_id !== petition.at) throw new HttpError(400, 'That petition is not before you here')
      if (petition.requires && known[petition.requires] !== true) throw new HttpError(400, 'That petition has not reached you')
      // A ruling stands. Re-ruling would let a player shop for a better
      // consequence after seeing the one they got, and the whole reign loop
      // rests on a ruling being expensive.
      if (state.ledger.some((e) => e.petition_id === petition.id)) {
        throw new HttpError(400, 'You have already ruled on that')
      }
      next.ledger.push({
        petition_id: petition.id,
        resolution_id: resolution.id,
        at: petition.at,
        made_whole: resolution.made_whole,
        made_to_pay: resolution.made_to_pay,
        principle: resolution.principle,
        ruled_at: now,
      })
      summary = resolution.consequence
      memory = {
        text: `Ruling at ${world.locations.find((l) => l.id === petition.at)?.title ?? petition.at} on ${petition.title}: ${resolution.label}. ${resolution.made_whole} was made whole and ${resolution.made_to_pay} was made to pay. The principle established: ${resolution.principle}`,
        subjects: petition.parties.map((party) => party.name),
        objects: [petition.title],
        terms: `${petition.kind}, ruling, ${petition.title}, ledger`,
        valence: 'weighty',
      }
    }

    // An ending is latched the moment its trigger first fires, and opens the
    // petition pool with it. Both are recorded as flags rather than recomputed,
    // because reaching an ending is a historical event: a later flag that
    // falsifies the trigger must not retract a succession that already
    // happened. Only fired while no ending is latched, so the first road out
    // is the one the player keeps.
    const outcome = { ...known, ...next.flags }
    const reached = endingFor(authored.progression?.endings ?? [], outcome)
    if (reached && outcome[endingFlag(reached.id)] !== true) {
      next.flags[endingFlag(reached.id)] = true
      next.flags[PETITIONS_OPEN] = true
      flagsSet = [...flagsSet, endingFlag(reached.id), PETITIONS_OPEN]
    }

    // One rule promotes everything: a flag can unseal a place and can lift fog.
    // Deriving both from the same pass means a new location never needs new
    // promotion code, only new data.
    for (const location of world.locations) {
      const visibility = visibilityFor(location, { ...outcome, ...next.flags })
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
        player_input:
          action.type === 'move'
            ? `Travel: ${action.location_id}`
            : action.type === 'rule'
              ? `Ruling: ${action.petition_id} → ${action.resolution_id}`
              : `Choice: ${action.choice_id}`,
        ai_response: summary,
        state_mutations: {},
        flag_mutations: Object.fromEntries(flagsSet.map((f) => [f, { op: 'set', value: true }])),
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
    return {
      world,
      state: next,
      progression: progressionFor(authored.progression, authored.reign, world.locations, { ...next, flags: { ...outcome, ...next.flags } }),
      event: { sequence: next.sequence, action, summary, at: now },
    }
  },
}
