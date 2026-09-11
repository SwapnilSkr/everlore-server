import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type {
  InteractiveLocationDoc,
  InteractiveWorldDoc,
  InteractiveWorldStateDoc,
  WorldCheckpointDoc,
  WorldCheckpointKind,
} from '../models/interactive-world.model'
import type { WorldEventDoc } from '../models/world-event.model'
import type { MemoryDoc } from '../models/memory.model'
import {
  asList,
  effectiveFlags,
  loadWorld,
  requireWorld,
  worldVocabulary,
  type WorldChoice,
} from '../worlds/world-source'
import { knowledgeFor, offerCast, portraitAssetId, presentCast } from '../worlds/cast'
import {
  applyDrill,
  choiceOffered,
  drillOpenToLead,
  leadIsDead,
  playableMembers,
  playableOf,
  promoteDiscovery,
  resolveContestedDuel,
  sceneCopyFor,
  seedRevealedIds,
  seedUnlockedIds,
  stakesForDuel,
  traitsMeet,
  traitsOf,
  visibilityFor,
  witnessedHere,
  type WayOn,
} from '../worlds/world-play'
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
import { interactiveWorldInstanceService } from './interactive-world-instance.service'
import { deletionService } from './deletion.service'
import { moderationService } from './moderation.service'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'

/** Whether authored data should replace the definition currently in Mongo. */
export function definitionNeedsRefresh(storedVersion: unknown, authoredVersion: number): boolean {
  return !Number.isInteger(storedVersion) || (storedVersion as number) < authoredVersion
}

export { visibilityFor } from '../worlds/world-play'

/**
 * Places the player may travel to in one move, derived from the authored graph.
 *
 * Visibility alone is not a route. The map can show every known open place, but
 * only an open neighbour of the place the player is standing in is a travel
 * target. Returning this on the state keeps the client from recreating that
 * distinction (and from offering a journey the action endpoint will refuse).
 */
export function travelTargetsFor(
  locations: InteractiveLocationDoc[],
  currentLocationId: string,
  flags: Record<string, boolean>,
): string[] {
  const current = locations.find((location) => location.id === currentLocationId)
  if (!current) return []
  const byId = new Map(locations.map((location) => [location.id, location]))
  return current.routes.filter((id) => {
    const destination = byId.get(id)
    return destination !== undefined && visibilityFor(destination, flags) === 'open'
  })
}

/**
 * Places already walked that are not a neighbour of here.
 *
 * Adjacent travel stays a walk. These are the roads the player has already
 * taken, offered as haste rather than as a second graph hop.
 */
export function quickTravelTargetsFor(
  locations: InteractiveLocationDoc[],
  currentLocationId: string,
  flags: Record<string, boolean>,
  seenSceneIds: string[],
  unlockedIds: string[],
): string[] {
  const adjacent = new Set(travelTargetsFor(locations, currentLocationId, flags))
  const seen = new Set(seenSceneIds)
  const unlocked = new Set(unlockedIds)
  return locations
    .filter((location) => {
      if (location.id === currentLocationId) return false
      if (adjacent.has(location.id)) return false
      if (!seen.has(location.id) || !unlocked.has(location.id)) return false
      return visibilityFor(location, flags) === 'open'
    })
    .map((location) => location.id)
}

export function canMoveTo(
  locations: InteractiveLocationDoc[],
  currentLocationId: string,
  destinationId: string,
  flags: Record<string, boolean>,
  seenSceneIds: string[],
  unlockedIds: string[],
): boolean {
  return (
    travelTargetsFor(locations, currentLocationId, flags).includes(destinationId) ||
    quickTravelTargetsFor(locations, currentLocationId, flags, seenSceneIds, unlockedIds).includes(
      destinationId,
    )
  )
}

/**
 * The state as rendered, never as stored.
 *
 * Narrated flags are derived from the instance on every read and must reach the
 * client so its map agrees with the server, but must never be copied into the
 * interactive state document. Spreading into a fresh object makes that boundary
 * explicit and gives the wire its server-derived one-step travel targets.
 */
export function worldStateView(
  state: InteractiveWorldStateDoc,
  flags: Record<string, boolean>,
  locations: InteractiveLocationDoc[],
) {
  return {
    ...state,
    flags: { ...flags },
    travel_location_ids: travelTargetsFor(locations, state.current_location_id, flags),
    quick_travel_location_ids: quickTravelTargetsFor(
      locations,
      state.current_location_id,
      flags,
      state.seen_scene_ids ?? [],
      state.unlocked_location_ids ?? [],
    ),
    checkpoints: (state.checkpoints ?? []).map(({ snapshot: _snap, ...moment }) => moment),
  }
}

function momentsOf(
  state: InteractiveWorldStateDoc,
  locations: InteractiveLocationDoc[],
) {
  const titles = new Map(locations.map((location) => [location.id, location.title]))
  return (state.checkpoints ?? []).map((point) => ({
    id: point.id,
    kind: point.kind ?? 'hinge',
    choice_id: point.choice_id,
    title: point.title,
    hint: point.hint,
    at: point.at,
    place: titles.get(point.at) ?? point.at,
    fatal: point.fatal === true,
  }))
}

function cloneConversations(conversations: InteractiveWorldStateDoc['conversations']) {
  return JSON.parse(JSON.stringify(conversations ?? {})) as NonNullable<InteractiveWorldStateDoc['conversations']>
}

function snapshotOf(
  state: InteractiveWorldStateDoc,
  eventSequence: number,
): WorldCheckpointDoc['snapshot'] {
  return {
    flags: { ...state.flags },
    current_location_id: state.current_location_id,
    unlocked_location_ids: [...state.unlocked_location_ids],
    revealed_location_ids: [...state.revealed_location_ids],
    seen_scene_ids: [...state.seen_scene_ids],
    taken_choice_ids: [...state.taken_choice_ids],
    ledger: [...state.ledger],
    ripened_petitions: [...(state.ripened_petitions ?? [])],
    conversations: cloneConversations(state.conversations),
    walk_sequence: state.sequence,
    event_sequence: eventSequence,
  }
}

const ROAD_BEHIND_CAP = 36

function remember(
  next: InteractiveWorldStateDoc,
  state: InteractiveWorldStateDoc,
  eventSequence: number,
  now: Date,
  moment: {
    kind: WorldCheckpointKind
    ref: string
    title: string
    hint: string
    at: string
    fatal?: boolean
  },
) {
  const captured: WorldCheckpointDoc = {
    id: `${moment.kind}:${moment.ref}:${state.sequence}`,
    kind: moment.kind,
    choice_id: moment.ref,
    title: moment.title,
    hint: moment.hint,
    at: moment.at,
    fatal: moment.fatal === true,
    captured_at: now,
    snapshot: snapshotOf(state, eventSequence),
  }
  const points = [...(next.checkpoints ?? []), captured]
  if (points.length <= ROAD_BEHIND_CAP) {
    next.checkpoints = points
    return
  }
  const droppable = points
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => point.kind !== 'hinge' && !point.fatal)
  const keepCount = points.length - droppable.length
  const extraRoom = Math.max(0, ROAD_BEHIND_CAP - keepCount)
  const drop = Math.max(0, droppable.length - extraRoom)
  const dropAt = new Set(droppable.slice(0, drop).map(({ index }) => index))
  next.checkpoints = points.filter((_, index) => !dropAt.has(index))
}

async function pruneWalkAfter(instanceId: ObjectId, eventSequence?: number, capturedAt?: Date) {
  const query =
    typeof eventSequence === 'number'
      ? { instance_id: instanceId, sequence: { $gt: eventSequence } }
      : capturedAt
        ? { instance_id: instanceId, created_at: { $gte: capturedAt } }
        : null
  if (!query) return
  const doomed = await mongoColl.events()
    .find(query, { projection: { _id: 1 } })
    .toArray()
  const doomedIds = doomed.map((row) => row._id)
  if (doomedIds.length === 0) return
  await mongoColl.memories().deleteMany({ instance_id: instanceId, source_event_ids: { $in: doomedIds } })
  await mongoColl.events().deleteMany({ _id: { $in: doomedIds } })
}

function deathOf(
  authored: ReturnType<typeof requireWorld>,
  state: InteractiveWorldStateDoc,
  flags: Record<string, boolean>,
  assets: (InteractiveWorldDoc['assets'][number] & { url?: string | null })[],
) {
  const leadId = state.protagonist?.character_id
  if (!leadIsDead(leadId, flags)) return null
  const hinge =
    [...(state.checkpoints ?? [])].reverse().find((point) => point.fatal) ??
    [...(state.checkpoints ?? [])].reverse().find((point) => point.kind === 'hinge')
  return {
    title: 'The sand has you.',
    body: 'That fight is law. You may take it again, stronger, or walk this same world as someone still standing.',
    restore_id: hinge?.id ?? null,
    restore_title: hinge?.title ?? null,
    rebind: playableCards(authored, assets).filter((card) => card.character_id !== leadId),
  }
}

function drillsHere(
  authored: ReturnType<typeof requireWorld>,
  locationId: string,
  leadId: string | undefined,
) {
  return (authored.drills ?? [])
    .filter((drill) => drill.at === locationId && drillOpenToLead(drill, leadId))
    .map(({ id, at, label, raises }) => ({ id, at, label, raises }))
}

function clipBlurb(text: string, cap = 180): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= cap) return trimmed
  return `${trimmed.slice(0, cap - 1).trimEnd()}…`
}

function wayOnOf(
  authored: ReturnType<typeof requireWorld>,
  world: InteractiveWorldDoc,
  locationId: string,
  flags: Record<string, boolean>,
  taken: string[],
  leadId: string | undefined,
  present: { id: string; name: string; role: string }[],
  conversations: InteractiveWorldStateDoc['conversations'],
  unlockedIds: string[],
): WayOn | null {
  const hereChoices = authored.choices.filter((choice) =>
    choiceOffered(choice, locationId, flags, taken, leadId),
  )
  const hinge = hereChoices.find((choice) => choice.critical)
  const pick = hinge ?? hereChoices[0]
  if (pick) {
    return {
      kind: 'choice',
      at: locationId,
      label: pick.label,
      blurb: clipBlurb(pick.critical?.hint || pick.summary),
    }
  }
  const work = drillsHere(authored, locationId, leadId)[0]
  if (work) {
    return {
      kind: 'train',
      at: locationId,
      label: work.label,
      blurb: 'Work this place before the road asks more of you.',
    }
  }
  const unmet = present.find((member) => conversations?.[member.id] === undefined)
  if (unmet) {
    return {
      kind: 'talk',
      at: locationId,
      label: `Speak with ${unmet.name}`,
      blurb: clipBlurb(unmet.role),
      character_id: unmet.id,
    }
  }
  for (const location of world.locations) {
    if (location.id === locationId) continue
    if (!unlockedIds.includes(location.id)) continue
    if (visibilityFor(location, flags) !== 'open') continue
    const next = authored.choices.find((choice) =>
      choiceOffered(choice, location.id, flags, taken, leadId),
    )
    if (!next) continue
    return {
      kind: 'travel',
      at: location.id,
      label: location.title,
      blurb: clipBlurb(next.critical?.hint || next.label),
    }
  }
  const neighbour = travelTargetsFor(world.locations, locationId, flags)[0]
  if (!neighbour) return null
  const dest = world.locations.find((location) => location.id === neighbour)
  return {
    kind: 'travel',
    at: neighbour,
    label: dest?.title ?? neighbour,
    blurb: clipBlurb(dest?.description || 'The road is open.'),
  }
}

function playableCards(
  authored: ReturnType<typeof requireWorld>,
  assets: (InteractiveWorldDoc['assets'][number] & { url?: string | null })[],
) {
  const urls = new Map(assets.map((asset) => [asset.id, asset.url ?? null]))
  return playableMembers(authored).map((member) => {
    const sceneId = member.prologue?.scene_asset_id
    return {
      character_id: member.id,
      name: member.name,
      role: member.role,
      portrait_url: urls.get(portraitAssetId(member, undefined)) ?? null,
      scene_url: sceneId ? urls.get(sceneId) ?? null : null,
      want: member.wants,
      start_traits: traitsOf(member.start_traits),
    }
  })
}

function contestsHere(
  authored: ReturnType<typeof requireWorld>,
  locationId: string,
  flags: Record<string, boolean>,
  taken: string[],
  leadId: string | undefined,
  traits: InteractiveWorldStateDoc['traits'],
) {
  return authored.choices.flatMap((choice) => {
    if (!choiceOffered(choice, locationId, flags, taken, leadId)) return []
    const duel = duelForChoice(authored, choice.id)
    if (!duel) return []
    const stakes = stakesForDuel(duel, traits, leadId, choice.train_hint)
    if (!stakes) return []
    return [{ ...stakes, choice_id: choice.id }]
  })
}

function leadView(
  authored: ReturnType<typeof requireWorld>,
  assets: (InteractiveWorldDoc['assets'][number] & { url?: string | null })[],
  characterId: string | undefined,
) {
  if (!characterId) return null
  const member = authored.cast.find((c) => c.id === characterId)
  if (!member) return null
  const urls = new Map(assets.map((asset) => [asset.id, asset.url ?? null]))
  return {
    character_id: member.id,
    name: member.name,
    role: member.role,
    portrait_url: urls.get(portraitAssetId(member, undefined)) ?? null,
  }
}

function prologueView(
  authored: ReturnType<typeof requireWorld>,
  assets: (InteractiveWorldDoc['assets'][number] & { url?: string | null })[],
  characterId: string,
) {
  const member = playableOf(authored, characterId)
  if (!member?.prologue) return null
  const urls = new Map(assets.map((asset) => [asset.id, asset.url ?? null]))
  const sceneId = member.prologue.scene_asset_id
  return {
    headline: member.prologue.headline,
    beats: member.prologue.beats,
    scene_url: sceneId ? urls.get(sceneId) ?? null : null,
  }
}

function overtureView(
  authored: ReturnType<typeof requireWorld>,
  assets: (InteractiveWorldDoc['assets'][number] & { url?: string | null })[],
) {
  const tour = authored.overture
  if (!tour?.beats.length) return null
  const urls = new Map(assets.map((asset) => [asset.id, asset.url ?? null]))
  return {
    headline: tour.headline,
    kicker: tour.kicker,
    beats: tour.beats.map((beat) => ({
      mark: beat.mark,
      title: beat.title,
      body: beat.body,
      scene_url: urls.get(beat.scene_asset_id) ?? null,
    })),
  }
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
  async ensureWorld(worldKey: string): Promise<InteractiveWorldDoc> {
    const authored = loadWorld(worldKey)
    if (!authored) throw new HttpError(404, 'Interactive world not found')
    const worlds = mongoColl.interactiveWorlds()
    const now = new Date()
    const definition = {
      version: authored.definition_version,
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
      {
        $setOnInsert: {
          _id: new ObjectId(),
          key: worldKey,
          created_at: now,
          is_published: false,
          ...definition,
        },
      },
      { upsert: true },
    )
    // Each world owns its definition version. Asset revision is deliberately a
    // different number: adding a new asset id changes the stored manifest but
    // does not change the immutable CDN keys of art already published.
    let world = await worlds.findOne({ key: worldKey })
    if (!world) throw new Error(`Could not initialise the world "${worldKey}"`)
    if (definitionNeedsRefresh(world.version, authored.definition_version)) {
      // Guard the write as well as the read so concurrent initialisers cannot
      // replace a newer definition with the stale one they observed.
      await worlds.updateOne(
        {
          _id: world._id,
          $or: [
            { version: { $lt: authored.definition_version } },
            { version: { $exists: false } },
          ],
        },
        { $set: definition },
      )
      world = await worlds.findOne({ key: worldKey })
      if (!world) throw new Error(`Could not refresh the world "${worldKey}"`)
    }
    return world as InteractiveWorldDoc
  },

  catalogCard(world: InteractiveWorldDoc) {
    const authored = loadWorld(world.key)
    const cover = authored ? coverFor(authored, world) : null
    const image = typeof world.image_url === 'string' ? world.image_url.trim() : ''
    const coverUrl = (image.length > 0 ? image : null) ?? cover
    const blurb = (world.description ?? authored?.blurb ?? world.chapter_title) || null
    const id = idString(world._id)
    return {
      _id: world._id,
      key: world.key,
      world_key: world.key,
      slug: world.key,
      title: world.title,
      chapter_title: world.chapter_title,
      description: world.description ?? world.chapter_title ?? '',
      blurb,
      image_url: coverUrl ?? '',
      cover_url: coverUrl,
      creator_id: world.creator_id,
      is_published: world.is_published === true,
      interactive_world_key: world.key,
      template_id: id,
      world_id: id,
      created_at: world.created_at,
      updated_at: world.updated_at,
    }
  },

  async listPublished(userId?: string, search?: string) {
    const filter: Record<string, unknown> = {
      is_published: true,
      ...(await moderationService.discoveryFilter(userId)),
    }
    const term = search?.trim()
    if (term) {
      filter.$or = [
        { title: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } },
        { chapter_title: { $regex: term, $options: 'i' } },
      ]
    }
    const docs = (await mongoColl
      .interactiveWorlds()
      .find(filter)
      .sort({ created_at: -1 })
      .toArray()) as InteractiveWorldDoc[]
    return docs.filter((world) => loadWorld(world.key)).map((world) => this.catalogCard(world))
  },

  async listMine(creatorId: string, page: number = 1, limit: number = 20, search?: string) {
    const filter: Record<string, unknown> = { creator_id: parseObjectId(creatorId) }
    const term = search?.trim()
    if (term) {
      filter.$or = [
        { title: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } },
        { chapter_title: { $regex: term, $options: 'i' } },
      ]
    }
    const safePage = Math.max(1, page)
    const safeLimit = Math.min(50, Math.max(1, limit))
    const [docs, total] = await Promise.all([
      mongoColl
        .interactiveWorlds()
        .find(filter)
        .sort({ updated_at: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .toArray() as Promise<InteractiveWorldDoc[]>,
      mongoColl.interactiveWorlds().countDocuments(filter),
    ])
    return {
      templates: docs.map((world) => this.catalogCard(world)),
      total,
      page: safePage,
    }
  },

  async publish(worldKey: string, creatorId: string) {
    const world = (await mongoColl.interactiveWorlds().findOne({
      key: worldKey.trim(),
      creator_id: parseObjectId(creatorId),
    })) as InteractiveWorldDoc | null
    if (!world) throw new HttpError(404, 'Walk not found')
    if (world.is_published) return { success: true }
    await mongoColl.interactiveWorlds().updateOne(
      { _id: world._id },
      { $set: { is_published: true, updated_at: new Date() } },
    )
    return { success: true }
  },

  async deleteOwned(worldKey: string, creatorId: string) {
    return deletionService.deleteInteractiveWorld(worldKey, creatorId)
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
      choices: authored.choices.map(
        ({ id, at, requires, forbids, label, for_leads, not_for_leads, require_traits, train_hint, critical }) => ({
          id,
          at,
          requires,
          forbids,
          label,
          for_leads,
          not_for_leads,
          require_traits,
          train_hint,
          critical,
        }),
      ),
      drills: (authored.drills ?? []).map(({ id, at, label, raises, for_leads, not_for_leads }) => ({
        id,
        at,
        label,
        raises,
        for_leads,
        not_for_leads,
      })),
      assets: world.assets.map((asset) => ({ ...asset, url: storageService.urlForKey(asset.key) })),
    }
  },

  async state(worldKey: string, instanceId: string, playerId: string, forMutation: boolean = false) {
    const authored = requireWorld(worldKey)
    const { instance } = await interactiveWorldInstanceService.requireBound(worldKey, instanceId, playerId)
    const world = await this.definition(worldKey)
    const instanceOid = instance._id
    const playerOid = instance.player_id
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
          revealed_location_ids: seedRevealedIds(world.locations, authored.start_location_id, {}),
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
      checkpoints: found.checkpoints ?? [],
      drills_taken: found.drills_taken ?? 0,
    } as InteractiveWorldStateDoc
    // What the story has done counts too. Everything downstream — visibility,
    // which choices are offered, standing, the ending — reads this and never
    // `state.flags` directly, so there is one answer to "what is true".
    const flags = effectiveFlags(authored, state.flags, undefined)
    const leadId = state.protagonist?.character_id
    const here = world.locations.find((l) => l.id === state.current_location_id)
    const standing = leadId
      ? presentCast(authored, state.current_location_id, flags, leadId)
      : []
    return {
      world,
      // act() needs the stored form so derived narration is never persisted.
      // Every route response receives the rendered form instead.
      state: (forMutation ? state : worldStateView(state, flags, world.locations)) as InteractiveWorldStateDoc,
      flags,
      needs_identity: !leadId,
      playable: playableCards(authored, world.assets),
      lead: leadView(authored, world.assets, leadId),
      prologue: leadId && state.prologue_seen !== true ? prologueView(authored, world.assets, leadId) : null,
      overture:
        !leadId && state.overture_seen !== true ? overtureView(authored, world.assets) : null,
      scene: here ? sceneCopyFor(here, flags, leadId) : null,
      // Who is standing here is derived from the same flags as everything else,
      // so a character the story loop unlocked is present the moment the map
      // agrees they are — see `presentCast` for which field is the gate.
      cast: leadId
        ? offerCast(
            standing,
            world.assets,
            (id) => state.conversations?.[id] !== undefined,
            (id) => state.conversations?.[id]?.disposition,
            (id) => state.conversations?.[id]?.exchanges,
          )
        : [],
      way_on: leadId
        ? wayOnOf(
            authored,
            world,
            state.current_location_id,
            flags,
            state.taken_choice_ids ?? [],
            leadId,
            standing,
            state.conversations,
            state.unlocked_location_ids,
          )
        : null,
      progression: progressionFor(authored.progression, authored.reign, world.locations, { ...state, flags }),
      moments: momentsOf(state, world.locations),
      death: deathOf(authored, state, flags, world.assets),
      drills: drillsHere(authored, state.current_location_id, leadId),
      contests: contestsHere(
        authored,
        state.current_location_id,
        flags,
        state.taken_choice_ids ?? [],
        leadId,
        state.traits,
      ),
    }
  },

  async act(
    worldKey: string,
    instanceId: string,
    playerId: string,
    action: {
      type: 'move' | 'choose' | 'rule' | 'talk' | 'bind' | 'begin' | 'restore' | 'rebind' | 'train' | 'tour'
      location_id?: string
      choice_id?: string
      petition_id?: string
      resolution_id?: string
      character_id?: string
      checkpoint_id?: string
      drill_id?: string
      /** Free-form player speech. Bounded at the route; never interpreted as a command. */
      said?: string
    },
  ) {
    const authored = requireWorld(worldKey)
    const { world, state, flags: known } = await this.state(worldKey, instanceId, playerId, true)
    const now = new Date()
    if (action.type !== 'bind' && action.type !== 'tour' && !state.protagonist?.character_id) {
      throw new HttpError(403, 'Choose who walks before the world will move.')
    }
    if (
      leadIsDead(state.protagonist?.character_id, state.flags) &&
      action.type !== 'restore' &&
      action.type !== 'rebind'
    ) {
      throw new HttpError(403, 'The sand has you. Take the fight again, or walk as someone still standing.')
    }
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
      checkpoints: [...(state.checkpoints ?? [])],
    }
    const lastWalkEvent = await mongoColl.events().findOne(
      { instance_id: state.instance_id },
      { sort: { sequence: -1 }, projection: { sequence: 1 } },
    )
    const eventSequence = lastWalkEvent?.sequence ?? 0
    // A ripened grievance is only before the player once a season of further
    // rulings has passed. The same gate the offer is made under has to hold on
    // the way in as well, or a client could rule on a petition it was never
    // shown by naming its id.
    const ripe = (state.ripened_petitions ?? []).filter((p) => state.ledger.length >= p.ripe_at_ledger_length)
    let summary = ''
    let flagsSet: string[] = []
    let seeding: Parameters<typeof ripenGrievance>[0] | null = null
    let memory: WorldChoice['memory'] | undefined
    let spoken: {
      character_id: string
      name: string
      line: string
      portrait_url: string | null
      initiated?: boolean
    } | null = null
    let fought: ReturnType<typeof duelForChoice> = null
    let skipEvent = false
    let hingeChoice: WorldChoice | undefined

    if (action.type === 'bind') {
      if (state.protagonist?.character_id) throw new HttpError(400, 'You have already chosen who walks.')
      const member = playableOf(authored, action.character_id ?? '')
      if (!member) throw new HttpError(400, 'That person cannot walk this world.')
      const startId = member.start_location_id ?? authored.start_location_id
      const startFlags = { ...(member.start_flags ?? {}) }
      next.protagonist = { character_id: member.id }
      next.traits = traitsOf(member.start_traits)
      next.flags = { ...startFlags }
      next.current_location_id = startId
      next.unlocked_location_ids = seedUnlockedIds(world.locations, startId, startFlags)
      next.revealed_location_ids = seedRevealedIds(world.locations, startId, startFlags)
      next.prologue_seen = false
      next.overture_seen = true
      const start = world.locations.find((l) => l.id === startId)
      next.seen_scene_ids = start?.scene_asset_id ? [startId] : []
      summary = `Chose to walk as ${member.name}.`
    } else if (action.type === 'tour') {
      next.overture_seen = true
      skipEvent = true
      summary = 'The duchy has been shown.'
    } else if (action.type === 'begin') {
      next.prologue_seen = true
      skipEvent = true
      summary = 'The walk begins.'
    } else if (action.type === 'restore') {
      const point = (state.checkpoints ?? []).find((entry) => entry.id === action.checkpoint_id)
      if (!point) throw new HttpError(400, 'That moment is not yours to take again.')
      const snap = point.snapshot
      const keptTraits = next.traits ?? state.traits
      const keptLead = next.protagonist
      const keptDrills = next.drills_taken ?? state.drills_taken ?? 0
      next.flags = { ...snap.flags }
      next.current_location_id = snap.current_location_id
      next.unlocked_location_ids = [...snap.unlocked_location_ids]
      next.revealed_location_ids = [...snap.revealed_location_ids]
      next.seen_scene_ids = [...snap.seen_scene_ids]
      next.taken_choice_ids = [...snap.taken_choice_ids]
      next.ledger = [...snap.ledger]
      next.ripened_petitions = [...snap.ripened_petitions]
      next.conversations =
        snap.conversations !== undefined ? cloneConversations(snap.conversations) : next.conversations
      next.traits = keptTraits
      next.protagonist = keptLead
      next.drills_taken = keptDrills
      next.checkpoints = (state.checkpoints ?? []).filter((entry) => {
        const seq = entry.snapshot.walk_sequence
        if (typeof seq === 'number' && typeof snap.walk_sequence === 'number') {
          return seq <= snap.walk_sequence
        }
        return entry.id === point.id || snap.taken_choice_ids.includes(entry.choice_id)
      })
      await pruneWalkAfter(state.instance_id, snap.event_sequence, point.captured_at)
      skipEvent = true
      summary = `Returned to ${point.title}.`
    } else if (action.type === 'rebind') {
      if (!leadIsDead(state.protagonist?.character_id, { ...known, ...next.flags })) {
        throw new HttpError(400, 'You have already chosen who walks.')
      }
      const member = playableOf(authored, action.character_id ?? '')
      if (!member || member.id === state.protagonist?.character_id) {
        throw new HttpError(400, 'That person cannot walk this world.')
      }
      const startId = member.start_location_id ?? authored.start_location_id
      next.protagonist = { character_id: member.id }
      next.traits = traitsOf(member.start_traits)
      next.prologue_seen = true
      next.current_location_id = startId
      const merged = { ...next.flags, ...(member.start_flags ?? {}) }
      // The previous lead's death is history. Leaving this set would treat the
      // new walker as already fallen the moment they take a step.
      delete merged.player_fallen
      next.flags = merged
      next.unlocked_location_ids = seedUnlockedIds(world.locations, startId, merged)
      const revealed = new Set([
        ...next.revealed_location_ids,
        ...seedRevealedIds(world.locations, startId, merged),
      ])
      next.revealed_location_ids = [...revealed]
      const start = world.locations.find((l) => l.id === startId)
      if (start?.scene_asset_id && !next.seen_scene_ids.includes(startId)) next.seen_scene_ids.push(startId)
      summary = `Walked on as ${member.name}.`
    } else if (action.type === 'train') {
      const drill = (authored.drills ?? []).find((entry) => entry.id === action.drill_id)
      if (!drill) throw new HttpError(400, 'There is no such work here.')
      if (drill.at !== state.current_location_id) throw new HttpError(400, 'That is not open to you yet')
      if (!drillOpenToLead(drill, state.protagonist?.character_id)) {
        throw new HttpError(400, 'That is not open to you yet')
      }
      const trained = applyDrill(traitsOf(next.traits ?? state.traits), drill.raises, next.drills_taken ?? 0)
      next.traits = trained.traits
      next.drills_taken = trained.drills_taken
      skipEvent = true
      summary = drill.label
    } else if (action.type === 'move') {
      const destination = world.locations.find((l) => l.id === action.location_id)
      const current = world.locations.find((l) => l.id === state.current_location_id)
      if (
        !destination ||
        !current ||
        !canMoveTo(
          world.locations,
          state.current_location_id,
          destination.id,
          known,
          state.seen_scene_ids ?? [],
          state.unlocked_location_ids ?? [],
        )
      ) {
        throw new HttpError(400, 'That route is not available')
      }
      const visibility = visibilityFor(destination, known)
      if (visibility === 'rumoured') throw new HttpError(404, 'You know of no such place')
      if (visibility === 'sealed') throw new HttpError(403, destination.sealed_reason || 'That place is still closed to you')
      remember(next, state, eventSequence, now, {
        kind: 'travel',
        ref: destination.id,
        title: `The road to ${destination.title}`,
        hint: 'Return to before you walked here. What you did after this on the road is undone.',
        at: state.current_location_id,
      })
      next.current_location_id = destination.id
      if (destination.scene_asset_id && !next.seen_scene_ids.includes(destination.id)) {
        next.seen_scene_ids.push(destination.id)
      }
      summary = `Travelled to ${destination.title}.`
    } else if (action.type === 'choose') {
      const choice = authored.choices.find((c) => c.id === action.choice_id)
      if (!choice) throw new HttpError(400, 'Unknown world action')
      const leadId = next.protagonist?.character_id
      if (state.taken_choice_ids.includes(choice.id)) throw new HttpError(400, 'That has already been done')
      if (!choiceOffered(choice, state.current_location_id, { ...known, ...next.flags }, state.taken_choice_ids, leadId)) {
        throw new HttpError(400, 'That is not open to you yet')
      }
      if (!traitsMeet(choice.require_traits, next.traits ?? state.traits)) {
        throw new HttpError(400, choice.train_hint || 'You have not the strength for that')
      }
      remember(next, state, eventSequence, now, {
        kind: choice.critical ? 'hinge' : 'choice',
        ref: choice.id,
        title: choice.critical?.title || choice.label,
        hint:
          choice.critical?.hint ||
          'Take this deed again. What followed is undone. Strength you earned stays.',
        at: choice.at,
      })
      flagsSet = asList(choice.sets)
      fought = duelForChoice(authored, choice.id)
      if (fought) {
        fought = resolveContestedDuel(fought, next.traits ?? state.traits, leadId)
        flagsSet = fought.outcome.sets
      }
      for (const flag of flagsSet) next.flags[flag] = true
      next.taken_choice_ids.push(choice.id)
      const hinge = [...(next.checkpoints ?? [])].reverse().find((entry) => entry.choice_id === choice.id)
      if (hinge) {
        hinge.fatal =
          flagsSet.includes('cassian_dead') ||
          flagsSet.includes('player_fallen') ||
          fought?.outcome.fatal === true
      }
      summary = choice.summary
      memory = choice.memory
      hingeChoice = choice
    }

    if (action.type === 'talk') {
      const said = (action.said ?? '').replace(/\s+/g, ' ').trim()
      const here = world.locations.find((l) => l.id === state.current_location_id)
      const member = presentCast(
        authored,
        state.current_location_id,
        known,
        state.protagonist?.character_id,
      ).find((c) => c.id === action.character_id)
      // Presence is checked on the way IN as well as on the way out. Otherwise
      // a client could name a character it was never shown and hold a
      // conversation with someone who is not in the room, or worse, someone the
      // player has not earned the right to have met.
      if (!said || !here || !member) throw new HttpError(400, 'There is no one here to say that to')
      if (member.id === state.protagonist?.character_id) throw new HttpError(400, 'There is no one here to say that to')
      remember(next, state, eventSequence, now, {
        kind: 'talk',
        ref: member.id,
        title: `Spoke with ${member.name}`,
        hint: 'Unsay this. The map and the law after it come back with you.',
        at: state.current_location_id,
      })
      const prior = state.conversations?.[member.id]
      // The vocabulary is the same guard narration is held to: a character can
      // open a road the world already gates on, and nothing else.
      const vocabulary = worldVocabulary(authored)
      const scene = sceneCopyFor(here, known, state.protagonist?.character_id)
      const reply = await speakAs(
        {
          member,
          // Filtered against the LIVE flags. A guarded fact the player has not
          // earned never reaches the model, so it cannot reach the player.
          knowledge: knowledgeFor(member, known),
          witnessed: witnessedHere(
            authored,
            state.current_location_id,
            known,
            state.taken_choice_ids ?? [],
            state.protagonist?.character_id,
          ),
          where: { ...here, description: scene.body || here.description },
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
      remember(next, state, eventSequence, now, {
        kind: 'rule',
        ref: petition.id,
        title: petition.title,
        hint: 'Rule again. Later petitions that grew from this are undone.',
        at: petition.at,
      })
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
    //
    // Restore and rebind replace the flag map rather than adding to it.
    // Spreading the pre-action flags over the snapshot would keep a death
    // that the hinge had already taken back.
    const outcome =
      action.type === 'restore' || action.type === 'rebind'
        ? { ...next.flags }
        : { ...known, ...next.flags }
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

    // One rule promotes travel; fog grows only along the graph. A flag can
    // unseal a distant place without drawing it, and a rumoured neighbour
    // appears as a lock the moment its reveal flag lands.
    const promoted = promoteDiscovery(
      world.locations,
      next.current_location_id,
      { ...outcome, ...next.flags },
      next.revealed_location_ids,
      next.unlocked_location_ids,
    )
    next.revealed_location_ids = promoted.revealed
    next.unlocked_location_ids = promoted.unlocked

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

    const lastEvent = skipEvent
      ? null
      : await mongoColl.events().findOne({ instance_id: state.instance_id }, { sort: { sequence: -1 } })
    const eventId = new ObjectId()
    if (!skipEvent) {
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
                  ? `Said to ${spoken?.name ?? action.character_id}: ${action.said ?? ''}`
                  : action.type === 'bind' || action.type === 'rebind'
                    ? summary
                    : action.type === 'restore' || action.type === 'train' || action.type === 'tour'
                      ? summary
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
    }

    if (memory && !skipEvent) {
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

    if (!skipEvent) {
      await interactiveWorldInstanceService.touch(state.instance_id, now, {
        events: 1,
        memories: memory ? 1 : 0,
      })
    }
    const leadId = next.protagonist?.character_id
    const here = world.locations.find((l) => l.id === next.current_location_id)
    const flags = { ...outcome, ...next.flags }
    const standing = presentCast(authored, next.current_location_id, flags, leadId)
    const speaker = standing[0]
    const shouldAddress =
      action.type === 'choose' &&
      speaker !== undefined &&
      here !== undefined &&
      (hingeChoice?.critical !== undefined || fought !== null) &&
      !leadIsDead(leadId, flags)

    // Staged AFTER everything is written down. The fight is already law by
    // the time the first blow is described, so a provider that is slow or down
    // can only cost the player the prose — never the flags. The person still
    // standing here is addressed in parallel, with the same witnessed facts
    // talk uses, so they cannot deny what just happened in this room.
    const vocabulary = worldVocabulary(authored)
    const scene = here ? sceneCopyFor(here, flags, leadId) : null
    const [staged, addressed] = await Promise.all([
      fought ? stageDuel(fought, authored, String(state.instance_id), leadId) : Promise.resolve(null),
      shouldAddress && speaker && here
        ? speakAs(
            {
              member: speaker,
              knowledge: knowledgeFor(speaker, flags),
              witnessed: witnessedHere(
                authored,
                next.current_location_id,
                flags,
                next.taken_choice_ids ?? [],
                leadId,
              ),
              where: { ...here, description: scene?.body || here.description },
              disposition: next.conversations?.[speaker.id]?.disposition ?? speaker.disposition_start,
              met: next.conversations?.[speaker.id] !== undefined,
              history: next.conversations?.[speaker.id]?.exchanges ?? [],
              said:
                '(They are still here after what just took place. Speak to the person standing in front of you about it.)',
            },
            (flag) => vocabulary.has(flag),
            String(state.instance_id),
          )
        : Promise.resolve(null),
    ])

    if (addressed && speaker) {
      const prior = next.conversations?.[speaker.id]
      next.conversations = {
        ...next.conversations,
        [speaker.id]: {
          disposition: addressed.disposition,
          exchanges: [...(prior?.exchanges ?? []), { said: '', replied: addressed.line }].slice(
            -RECALLED_EXCHANGES,
          ),
        },
      }
      const portraitId = addressed.portrait_asset_id
      spoken = {
        character_id: speaker.id,
        name: speaker.name,
        line: addressed.line,
        portrait_url: world.assets.find((asset) => asset.id === portraitId)?.url ?? null,
        initiated: true,
      }
      await mongoColl.interactiveWorldStates().updateOne(
        { _id: state._id },
        { $set: { conversations: next.conversations } },
      )
    }

    const duel: OfferedDuel | null = staged ? offerDuel(staged, world.assets) : null

    return {
      world,
      state: worldStateView(next, flags, world.locations),
      needs_identity: !leadId,
      playable: playableCards(authored, world.assets),
      lead: leadView(authored, world.assets, leadId),
      prologue: leadId && next.prologue_seen !== true ? prologueView(authored, world.assets, leadId) : null,
      overture:
        !leadId && next.overture_seen !== true ? overtureView(authored, world.assets) : null,
      scene: here ? sceneCopyFor(here, flags, leadId) : null,
      duel,
      cast: offerCast(
        standing,
        world.assets,
        (id) => next.conversations?.[id] !== undefined,
        (id) => next.conversations?.[id]?.disposition,
        (id) => next.conversations?.[id]?.exchanges,
      ),
      way_on: leadId
        ? wayOnOf(
            authored,
            world,
            next.current_location_id,
            flags,
            next.taken_choice_ids ?? [],
            leadId,
            standing,
            next.conversations,
            next.unlocked_location_ids,
          )
        : null,
      progression: progressionFor(authored.progression, authored.reign, world.locations, { ...next, flags }),
      moments: momentsOf(next, world.locations),
      death: deathOf(authored, next, flags, world.assets),
      drills: drillsHere(authored, next.current_location_id, leadId),
      contests: contestsHere(
        authored,
        next.current_location_id,
        flags,
        next.taken_choice_ids ?? [],
        leadId,
        next.traits,
      ),
      reign_opened: reignOpened,
      spoken,
      event: { sequence: next.sequence, action, summary, at: now },
    }
  },
}
