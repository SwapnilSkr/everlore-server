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
  worldVocabulary,
  type WorldChoice,
} from '../worlds/world-source'
import { knowledgeFor, offerCast, presentCast } from '../worlds/cast'
import { RECALLED_EXCHANGES, speakAs } from './character-speech.service'
import {
  endingFlag,
  endingFor,
  PETITIONS_OPEN,
  progressionFor,
  resolutionOf,
  ripensTo,
  seasonLength,
} from '../worlds/progression'
import { ripenGrievance } from './grievance-ripening.service'
import { duelForChoice, offerDuel, stageDuel, type OfferedDuel } from './duel.service'
import { storageService } from './storage.service'
import { reasonCannotStart } from './instance.service'
import { HttpError } from '../utils/http-error'
import { parseObjectId } from '../utils/mongo-id'

const WORLD_KEY = 'iron-verdict'
const WORLD_VERSION = 32

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

/**
 * The one painting that stands for a whole world.
 *
 * The place the player opens on, because that is the world as they will first
 * see it. A world whose opening was never painted falls back to its terrain,
 * and one with neither is drawn as a world with no face rather than as a
 * broken frame.
 */
function coverFor(authored: ReturnType<typeof requireWorld>, world: InteractiveWorldDoc): string | null {
  const opening = authored.locations.find((l) => l.id === authored.start_location_id)?.scene_asset_id
  const id = opening ?? world.map_style?.plates?.[0]?.asset_id
  const asset = id ? world.assets.find((a) => a.id === id) : undefined
  return asset ? storageService.urlForKey(asset.key) : null
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

  /**
   * The walkable worlds this player may enter, as an entrance is drawn.
   *
   * Driven by the TEMPLATES that carry an interactive key, not by the data
   * files: a world can exist as data with nobody having seeded a template for
   * it, and an entrance offered for one refuses the moment it is taken. The
   * same gate the start path uses decides what is listed here, so what is
   * offered and what opens cannot drift apart.
   *
   * This is what the client used to hardcode. One world was named in the
   * client by hand, with its title, its blurb and its key written into a
   * widget, so a second walkable world would have been invisible until
   * somebody remembered to add another card.
   */
  async listPlayable(playerId: string) {
    const templates = await mongoColl
      .worldTemplates()
      .find({ interactive_world_key: { $exists: true } })
      .sort({ created_at: 1 })
      .toArray()

    const seen = new Set<string>()
    const offered = []
    for (const template of templates) {
      const key = String(template.interactive_world_key ?? '').trim()
      if (!key || seen.has(key)) continue
      if (reasonCannotStart(template, playerId)) continue
      const authored = loadWorld(key)
      // A template pointing at a world whose data is gone is not an entrance.
      // Listing it would put a card on the screen that 404s when tapped.
      if (!authored) continue
      seen.add(key)
      const world = await this.ensureWorld(key)
      offered.push({
        world_key: key,
        title: authored.title,
        chapter_title: authored.chapter_title,
        blurb: authored.blurb ?? null,
        // The world's own painting, never an icon standing in for one. The
        // place the player opens on is the honest face of the world; the
        // terrain is what is left if it was never painted.
        cover_url: coverFor(authored, world),
      })
    }
    return offered
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
      ripened_petitions: found.ripened_petitions ?? [],
    } as InteractiveWorldStateDoc
    // What the story has done counts too. Everything downstream — visibility,
    // which choices are offered, standing, the ending — reads this and never
    // `state.flags` directly, so there is one answer to "what is true".
    const flags = effectiveFlags(authored, state.flags, instance.active_flags)
    return {
      world,
      state,
      flags,
      // Who is standing here is derived from the same flags as everything else,
      // so a character the story loop unlocked is present the moment the map
      // agrees they are — see `presentCast` for which field is the gate.
      cast: offerCast(
        presentCast(authored, state.current_location_id, flags),
        world.assets,
        (id) => state.conversations?.[id] !== undefined,
      ),
      progression: progressionFor(authored.progression, authored.reign, world.locations, { ...state, flags }),
    }
  },

  async act(
    worldKey: string,
    instanceId: string,
    playerId: string,
    action: {
      type: 'move' | 'choose' | 'rule' | 'talk'
      location_id?: string
      choice_id?: string
      petition_id?: string
      resolution_id?: string
      character_id?: string
      /** Free-form player speech. Bounded at the route; never interpreted as a command. */
      said?: string
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
      ripened_petitions: [...(state.ripened_petitions ?? [])],
      conversations: { ...(state.conversations ?? {}) },
    }
    // A ripened grievance is only before the player once a season of further
    // rulings has passed. The same gate the offer is made under has to hold on
    // the way in as well, or a client could rule on a petition it was never
    // shown by naming its id.
    const ripe = (state.ripened_petitions ?? []).filter((p) => state.ledger.length >= p.ripe_at_ledger_length)
    let summary = ''
    let flagsSet: string[] = []
    let seeding: Parameters<typeof ripenGrievance>[0] | null = null
    let memory: WorldChoice['memory'] | undefined
    let isFirst = false
    let spoken: { character_id: string; name: string; line: string; portrait_url: string | null } | null = null
    let fought: ReturnType<typeof duelForChoice> = null

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
      // A choice that is settled on the sand. The flags above are still what
      // writes the outcome — this only decides whether the player watches it
      // happen or reads one line saying it did.
      fought = duelForChoice(authored, choice.id)
    }

    if (action.type === 'talk') {
      const said = (action.said ?? '').replace(/\s+/g, ' ').trim()
      const here = world.locations.find((l) => l.id === state.current_location_id)
      const member = presentCast(authored, state.current_location_id, known).find((c) => c.id === action.character_id)
      // Presence is checked on the way IN as well as on the way out. Otherwise
      // a client could name a character it was never shown and hold a
      // conversation with someone who is not in the room, or worse, someone the
      // player has not earned the right to have met.
      if (!said || !here || !member) throw new HttpError(400, 'There is no one here to say that to')
      const prior = state.conversations?.[member.id]
      // The vocabulary is the same guard narration is held to: a character can
      // open a road the world already gates on, and nothing else.
      const vocabulary = worldVocabulary(authored)
      const reply = await speakAs(
        {
          member,
          // Filtered against the LIVE flags. A guarded fact the player has not
          // earned never reaches the model, so it cannot reach the player.
          knowledge: knowledgeFor(member, known),
          where: here,
          disposition: prior?.disposition ?? member.disposition_start,
          met: prior !== undefined,
          history: prior?.exchanges ?? [],
          said,
        },
        (flag) => vocabulary.has(flag),
        String(state.instance_id),
      )
      if (reply) {
        next.conversations = {
          ...next.conversations,
          [member.id]: {
            disposition: reply.disposition,
            exchanges: [...(prior?.exchanges ?? []), { said, replied: reply.line }].slice(-RECALLED_EXCHANGES),
          },
        }
        if (reply.sets_flag) {
          next.flags[reply.sets_flag] = true
          flagsSet = [reply.sets_flag]
        }
      }
      // A character who could not be made to answer is narrated, not errored,
      // and nothing about them is written down — so the player can say
      // something else and the exchange has cost them nothing.
      const line = reply?.line ?? authored.cast_unanswered ?? ''
      const portraitId = reply?.portrait_asset_id ?? member.portraits.default!
      spoken = {
        character_id: member.id,
        name: member.name,
        line,
        portrait_url: world.assets.find((a) => a.id === portraitId)?.url ?? null,
      }
      summary = line
    }

    if (action.type === 'rule') {
      if (known[PETITIONS_OPEN] !== true) throw new HttpError(400, 'No one brings you their quarrels yet')
      const found = resolutionOf(authored.reign, action.petition_id ?? '', action.resolution_id ?? '', ripe)
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

      // The party made to pay carries the grievance, and this is where it is
      // seeded. Two conditions, and both of them are terminations:
      //
      //   — the petition must be AUTHORED. Ruling on a grievance that already
      //     came back is ledgered and cited like anything else and seeds
      //     nothing further, so one ruling can never open an endless chain.
      //   — its kind must have a successor in the authored ladder. A quarrel
      //     that is already a killing has nowhere worse to go.
      //
      // Written now, read a season from now: generating it here costs the
      // player nothing because nothing awaits it, and by the time it is ripe it
      // has either been stored or it never will be.
      const authoredSeed = (authored.reign?.petitions ?? []).some((p) => p.id === petition.id)
      const harder = authoredSeed ? ripensTo(authored.reign, petition.kind) : null
      const alreadySeeded = (state.ripened_petitions ?? []).some((p) => p.seeded_by.resolution_id === resolution.id)
      if (harder && !alreadySeeded) {
        seeding = {
          seed: { petition, resolution },
          ripensToKind: harder,
          locations: world.locations,
          openLocationIds: next.unlocked_location_ids,
          ripeAtLedgerLength: next.ledger.length + seasonLength(authored.reign),
          instanceId: String(state.instance_id),
        }
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
    // The reign's opening beat must fire exactly once. It is returned on the
    // turn the ending latches and never again, which needs no flag to track —
    // latching is already a one-time event, so anchoring the beat to it is
    // both simpler and impossible to replay.
    let reignOpened: { title: string; opening_beat: string } | null = null
    if (reached && outcome[endingFlag(reached.id)] !== true) {
      next.flags[endingFlag(reached.id)] = true
      next.flags[PETITIONS_OPEN] = true
      flagsSet = [...flagsSet, endingFlag(reached.id), PETITIONS_OPEN]
      const beat = authored.reign?.reign?.[reached.id]?.opening_beat
      if (beat) reignOpened = { title: reached.title, opening_beat: beat }
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
    // Ripened petitions are deliberately NOT part of this write. They are the
    // one piece of reign state that is stored rather than derived, they are
    // appended by a background pass that can land at any moment, and a turn
    // that wrote the whole document back would silently drop one that arrived
    // mid-turn. They are only ever appended, by `$push`, below.
    const { _id: _stateId, ripened_petitions: _ripened, ...persisted } = next
    await mongoColl.interactiveWorldStates().updateOne({ _id: state._id }, { $set: persisted })

    // Off the player's path entirely: the response does not wait for it, and a
    // provider that is slow, rate-limited or down costs a ruling nothing. A
    // failure stores no petition and the reign continues on authored ones.
    if (seeding) {
      void ripenGrievance(seeding)
        .then((ripened) => {
          if (!ripened) return
          // Guarded on the seed rather than the id so a retry, a replayed turn
          // or two overlapping fires cannot seat the same grievance twice.
          return mongoColl.interactiveWorldStates().updateOne(
            { _id: state._id, 'ripened_petitions.seeded_by.resolution_id': { $ne: ripened.seeded_by.resolution_id } },
            { $push: { ripened_petitions: ripened } },
          )
        })
        .catch(() => {})
    }

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
              : action.type === 'talk'
                // The player's own words, so the story loop reads what was said
                // rather than that something was said.
                ? `Said to ${spoken?.name ?? action.character_id}: ${action.said ?? ''}`
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
        // The field is LEFT OUT, not set to null. `idx_memories_pinecone_id` is
        // unique and sparse, and sparse skips a document only when the field is
        // ABSENT — an explicit null is a value, and a second one collides with
        // the first. Writing null here meant every memory this world tried to
        // keep was rejected by the index, and the throw landed after the state
        // had already been written: the choice took effect, the player was
        // shown a refusal, and taking it again "worked" because a repeat is not
        // a first and writes no memory. Nothing in the chat path sets this
        // field either, which is why only this world was affected.
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
    // Staged AFTER everything is written down. The Verdict is already law by
    // the time the first blow is described, so a provider that is slow or down
    // can only cost the player the prose — never the flags, the ledger or the
    // place the choice opened. `stageDuel` degrades to the authored beats
    // rather than throwing, so this cannot fail the turn either.
    const duel: OfferedDuel | null = fought
      ? offerDuel(await stageDuel(fought, authored, String(state.instance_id)), world.assets)
      : null

    const flags = { ...outcome, ...next.flags }
    return {
      world,
      state: next,
      // Present only on the turn the fight happens. A client that has never
      // heard of a duel renders the summary it always did.
      duel,
      // Recomputed AFTER the turn, because a conversation can summon the rest
      // of the room: winning Lady Sereth over opens the Court, and the two
      // people that puts in front of the player have to be in this response or
      // the client shows an empty hall until it asks again.
      cast: offerCast(
        presentCast(authored, next.current_location_id, flags),
        world.assets,
        (id) => next.conversations?.[id] !== undefined,
      ),
      progression: progressionFor(authored.progression, authored.reign, world.locations, { ...next, flags }),
      reign_opened: reignOpened,
      spoken,
      event: { sequence: next.sequence, action, summary, at: now },
    }
  },
}
