import type { AuthUser } from '../middleware/auth'
import { memoryService } from '../services/memory.service'
import { characterCodexService } from '../services/character-codex.service'
import type { CharacterCodexDelta, RelationAssertion } from '../services/character-codex.service'
import { memorySupersessionService } from '../services/memory-supersession.service'
import { timeService } from '../services/time.service'
import { locationService } from '../services/location.service'
import { sideChatService } from '../services/side-chat.service'
import { entityGraphService, normalizeEntityName } from '../services/entity-graph.service'
import { kinshipGraphService } from '../services/kinship-graph.service'
import { isRelationKind } from '../utils/kinship-ontology'
import { mongoColl } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import type { EntityDoc } from '../models/entity.model'
import type { Static } from '@sinclair/typebox'
import type { EditEventBody } from '../schemas/event.schema'
import type { EditMemoryBody } from '../schemas/memory.schema'
import { idString, parseObjectId } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'
import { EVENT_WINDOWS } from '../utils/event-window'

type EditEvent = Static<typeof EditEventBody>
type EditMemory = Static<typeof EditMemoryBody>

export const chronicleController = {
  getEvents: async ({
    params,
    query,
    user,
  }: {
    params: { instanceId: string }
    query: { page?: number; limit?: number; type?: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.getEvents(params.instanceId, user.id, {
      page: Number(query.page) || 1,
      limit: Number(query.limit) || EVENT_WINDOWS.chroniclePageSize,
      type: query.type,
    })
  },

  getMemories: async ({
    params,
    query,
    user,
  }: {
    params: { instanceId: string }
    query: {
      include_archived?: boolean
      q?: string
      type?: string
      min_importance?: number
      unresolved?: boolean
    }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.getMemories(params.instanceId, user.id, {
      includeArchived: query.include_archived === true,
      q: query.q,
      type: query.type,
      minImportance:
        query.min_importance != null ? Number(query.min_importance) : undefined,
      unresolved: query.unresolved === true,
    })
  },

  getCalendar: async ({
    params,
    user,
  }: {
    params: { instanceId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return timeService.listCalendar(params.instanceId, user.id)
  },

  getRecap: async ({
    params,
    user,
  }: {
    params: { instanceId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.buildRecap(params.instanceId, user.id)
  },

  getThreads: async ({
    params,
    user,
  }: {
    params: { instanceId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.listThreads(params.instanceId, user.id)
  },

  getRelationships: async ({
    params,
    user,
  }: {
    params: { instanceId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return characterCodexService.listRelationships(params.instanceId, user.id)
  },

  getCharacterMemories: async ({
    params,
    user,
  }: {
    params: { instanceId: string; characterId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return characterCodexService.characterMemories(
      params.instanceId,
      user.id,
      params.characterId,
    )
  },

  getLocations: async ({
    params,
    user,
  }: {
    params: { instanceId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return locationService.listLocations(params.instanceId, user.id)
  },

  getLocationJournal: async ({
    params,
    user,
  }: {
    params: { instanceId: string; locationEntityId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return locationService.getLocationJournal(
      params.instanceId,
      user.id,
      params.locationEntityId,
    )
  },

  getSideChatThreads: async ({
    params,
    user,
  }: {
    params: { instanceId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return sideChatService.listThreads(params.instanceId, user.id)
  },

  getSideChatThread: async ({
    params,
    query,
    user,
  }: {
    params: { instanceId: string; characterId: string }
    query: { page?: number; limit?: number }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return sideChatService.getThread(params.instanceId, user.id, params.characterId, {
      page: Number(query.page) || 1,
      limit: Number(query.limit) || undefined,
    })
  },

  forkTimeline: async ({
    params,
    body,
    user,
  }: {
    params: { instanceId: string }
    body: { name: string; timeline_id?: string; parent_timeline_id?: string; make_active?: boolean }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return timeService.forkTimeline({
      instanceId: params.instanceId,
      playerId: user.id,
      name: body.name,
      timelineId: body.timeline_id,
      parentTimelineId: body.parent_timeline_id,
      makeActive: body.make_active,
    })
  },

  setActiveTimeline: async ({
    params,
    body,
    user,
  }: {
    params: { instanceId: string }
    body: { timeline_id: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return timeService.setActiveTimeline(params.instanceId, user.id, body.timeline_id)
  },

  updateEventTimeAnchor: async ({
    params,
    body,
    user,
  }: {
    params: { eventId: string }
    body: {
      story_calendar?: { year?: number; month?: number; day?: number; era?: string; label?: string }
      event_time_label?: string
      timeline_id?: string
    }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return timeService.updateEventTimeAnchor({
      eventId: params.eventId,
      playerId: user.id,
      storyCalendar: body.story_calendar,
      eventTimeLabel: body.event_time_label,
      timelineId: body.timeline_id,
    })
  },

  editMemory: async ({
    params,
    body,
    user,
  }: {
    params: { memoryId: string }
    body: EditMemory
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.editMemory(params.memoryId, user.id, body)
  },

  deleteMemory: async ({ params, user }: { params: { memoryId: string }; user: AuthUser | null }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.deleteMemory(params.memoryId, user.id)
  },

  editEvent: async ({
    params,
    body,
    user,
  }: {
    params: { eventId: string }
    body: EditEvent
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.editEvent(params.eventId, user.id, body)
  },

  editCharacter: async ({
    params,
    body,
    user,
  }: {
    params: { characterId: string }
    body: {
      canonical_name?: string
      role?: string
      appearance?: string
      persona?: string
      immutable_facts?: string[]
      mutable_state?: string[]
      disposition_to_player?: string
      hidden_thought?: string
    }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    const result = await characterCodexService.editCharacter({
      playerId: user.id,
      characterId: params.characterId,
      updates: body,
    })
    // Facts this edit removed → evict matching memory vectors so RAG can't
    // resurface them and contradict the player's edit.
    if (result.retiredFacts.length > 0) {
      memorySupersessionService
        .supersedeMemories({ instanceId: result.instanceId, retiredFacts: result.retiredFacts })
        .catch(() => {})
    }
    const c = result.character
    return {
      character: {
        id: idString(c._id),
        canonical_name: c.canonical_name,
        aliases: c.aliases,
        role: c.role,
        appearance: c.appearance,
        persona: c.persona,
        immutable_facts: c.immutable_facts,
        mutable_state: c.mutable_state,
        disposition_to_player: c.disposition_to_player,
        hidden_thought: c.hidden_thought,
        mention_count: c.mention_count,
        is_protagonist: c.is_protagonist === true,
      },
    }
  },

  rewind: async ({
    params,
    body,
    user,
  }: {
    params: { instanceId: string }
    body: { sequence: number }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.rewindToSequence(params.instanceId, user.id, body.sequence)
  },

  replayEvent: async ({
    params,
    user,
  }: {
    params: { eventId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.replayEvent(params.eventId, user.id)
  },

  selectReplayVariant: async ({
    params,
    body,
    user,
  }: {
    params: { eventId: string }
    body: { variant_index: number }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.selectReplayVariant(params.eventId, user.id, Number(body.variant_index))
  },

  /**
   * Player-driven CORRECTION / PROMOTE surface — the "Track this character" /
   * "This person is my sister" affordance that repairs a projection miss the
   * player noticed (a person visible in the prose who never became a card, or a
   * relation the narrator established that the graph didn't capture). Writes a
   * proper EVENT-DERIVED projection, not a free-form card mutation:
   *  1. Mints/updates the codex card via the same delta fold the turn pipeline
   *     uses (so the card is canonical, deduped, and replayable).
   *  2. Promotes the matching scene-participant / kinship STUB entity to active
   *     and links character_id (syncCodexEntities).
   *  3. Optionally writes a typed kinship edge (ensureStub creates a stub for a
   *     still-uncarded endpoint so the tie is captured immediately).
   *  4. Ledgers the synthetic delta on the most recent main-story event's
   *     codex_deltas so a rewind replays the card (the world stays an exact
   *     projection of the ledger). Kinship edges are not ledger-replayed today,
   *     so a rewind past this point may drop the edge.
   */
  trackEntity: async ({
    params,
    body,
    user,
  }: {
    params: { instanceId: string }
    body: {
      name: string
      role?: string
      appearance?: string
      persona?: string
      relation_kind?: string
      relation_label?: string
      relation_to?: string
    }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    const name = (body.name || '').trim().slice(0, 120)
    if (!name) throw new HttpError(400, 'A name is required to track a character.')

    const iid = parseObjectId(params.instanceId)
    const pid = parseObjectId(user.id)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new HttpError(404, 'Instance not found')
    const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
    const isSentient = !!template?.is_sentient

    // Sentient worlds: the player is an un-carded persona — never let a track
    // request card them (mirrors the generation-time self-card guard).
    if (isSentient && instance.persona_snapshot?.name) {
      const personaNorm = normalizeEntityName(instance.persona_snapshot.name)
      if (personaNorm && personaNorm === normalizeEntityName(name)) {
        throw new HttpError(400, 'You are the player — you cannot track yourself as a character.')
      }
    }

    // The most recent main-story turn anchors the correction's sequence and the
    // ledger entry (rewind replays it). On a fresh world (no events) the card
    // mints un-ledgered; nothing can rewind past it, so that is safe.
    const lastEvent = await mongoColl
      .events()
      .find({ instance_id: iid, type: { $ne: 'side_chat' } })
      .sort({ sequence: -1 })
      .limit(1)
      .toArray()
    const lastSeq = (lastEvent[0] as { sequence?: number } | undefined)?.sequence ?? 0
    const lastEventId = (lastEvent[0] as { _id?: unknown } | undefined)?._id as ReturnType<typeof parseObjectId> | undefined

    const delta: CharacterCodexDelta = {
      name,
      role: body.role?.trim() || undefined,
      appearance: body.appearance?.trim() || undefined,
      persona: body.persona?.trim() || undefined,
      immutable_facts: [],
      mutable_state: [],
    }
    let relationAssertion: RelationAssertion | null = null
    if (body.relation_kind && isRelationKind(body.relation_kind)) {
      relationAssertion = {
        from: name,
        to: (body.relation_to || 'player').trim(),
        kind: body.relation_kind,
        label: body.relation_label?.trim() || undefined,
        // A player-driven correction is high-authority canon (the player is the
        // author of their own world's relationships), not a character's
        // in-fiction claim that may be a lie. Treat it as narrator-level so the
        // kinship hygiene ranks it at full confidence (0.9) rather than the
        // 0.5 a character_claim gets.
        source: 'narrator',
      }
      delta.relation_assertions = [relationAssertion]
    }

    const codex = await characterCodexService.applyDeltas({
      instanceId: params.instanceId,
      playerId: user.id,
      sequence: lastSeq,
      deltas: [delta],
    })

    let entityMap: Map<string, EntityDoc>
    try {
      entityMap = await entityGraphService.syncCodexEntities({
        instanceId: params.instanceId,
        playerId: user.id,
        sequence: lastSeq,
        cards: codex,
      })
    } catch (err) {
      entityMap = new Map()
      console.warn('track syncCodexEntities failed:', (err as Error).message)
    }

    if (relationAssertion && lastEventId) {
      try {
        const protagCard = codex.find((c) => c.is_protagonist)
        let selfAnchorId: string | null = null
        if (!isSentient && protagCard) {
          const ent = entityMap.get(protagCard.name_normalized)
          selfAnchorId = ent?._id ? idString(ent._id) : null
        } else {
          const player = await entityGraphService.ensurePlayerEntity({
            instanceId: params.instanceId,
            playerId: user.id,
            name: instance.persona_snapshot?.name,
            sequence: lastSeq,
          })
          selfAnchorId = idString(player._id)
        }
        await kinshipGraphService.applyRelationAssertions({
          instanceId: params.instanceId,
          sequence: lastSeq,
          eventId: lastEventId,
          assertions: [relationAssertion],
          cards: codex,
          entitiesByCardName: entityMap,
          selfAnchorId,
          sceneText: '',
          ensureStub: (n: string) =>
            entityGraphService
              .ensureStubEntity({ instanceId: params.instanceId, playerId: user.id, sequence: lastSeq, name: n })
              .then((id) => id),
        })
      } catch (err) {
        console.warn('track kinship write failed:', (err as Error).message)
      }
    }

    // EVENT-DERIVED PROJECTION: ledger the correction delta on the most recent
    // main-story event so a rewind replays the card exactly.
    if (lastEventId) {
      try {
        await mongoColl.events().updateOne(
          { _id: lastEventId },
          { $push: { 'data.codex_deltas': delta } as never },
        )
      } catch (err) {
        console.warn('track ledger append failed:', (err as Error).message)
      }
    }

    const targetNorm = normalizeEntityName(name)
    const tracked =
      codex.find((c) => normalizeEntityName(c.canonical_name) === targetNorm) ||
      codex.find((c) => (c.aliases || []).some((a) => normalizeEntityName(a) === targetNorm))
    if (!tracked) throw new HttpError(500, 'Tracking failed: character was not created.')

    // Publish the codex update over WebSocket so every tab/device reconciles to
    // the authoritative full list (the caller's optimistic splice is a hint,
    // not truth). Mirrors the frame the generation pipeline publishes after
    // applyDeltas so the client's WS handler (onCharacterCodexUpdated) replaces
    // its list wholesale — no drift between tabs, no stale gaps after a track.
    try {
      await getRedisClient().publish(
        `user:${user.id}:events`,
        JSON.stringify({
          type: 'character_codex_updated',
          instanceId: params.instanceId,
          focused_character_id: instance.focus_character_id?.toString() ?? null,
          characters: codex.map((c) => ({
            id: idString(c._id),
            canonical_name: c.canonical_name,
            aliases: c.aliases,
            role: c.role,
            appearance: c.appearance,
            persona: c.persona,
            immutable_facts: c.immutable_facts,
            mutable_state: c.mutable_state,
            disposition_to_player: c.disposition_to_player,
            hidden_thought: c.hidden_thought,
            relationship: c.relationship || null,
            mention_count: c.mention_count,
            is_protagonist: c.is_protagonist === true,
          })),
        }),
      )
    } catch (err) {
      console.warn('track codex publish failed:', (err as Error).message)
    }

    return {
      character: {
        id: idString(tracked._id),
        canonical_name: tracked.canonical_name,
        aliases: tracked.aliases,
        role: tracked.role,
        appearance: tracked.appearance,
        persona: tracked.persona,
        immutable_facts: tracked.immutable_facts,
        mutable_state: tracked.mutable_state,
        disposition_to_player: tracked.disposition_to_player,
        hidden_thought: tracked.hidden_thought,
        mention_count: tracked.mention_count,
        is_protagonist: tracked.is_protagonist === true,
      },
      relation_asserted: relationAssertion
        ? { kind: relationAssertion.kind, label: relationAssertion.label ?? null, to: relationAssertion.to }
        : null,
    }
  },
}
