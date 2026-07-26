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
import { isRelationKind, surfaceToKind } from '../utils/kinship-ontology'
import { relationCandidateService } from '../services/relation-candidate.service'
import { TRANSITION_PLAYER } from '../../worker/lib/kinship-transition-extractor'
import { mongoColl } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import type { EntityDoc } from '../models/entity.model'
import type { Static } from '@sinclair/typebox'
import type { EditEventBody } from '../schemas/event.schema'
import type { EditMemoryBody } from '../schemas/memory.schema'
import { idString, parseObjectId } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'
import { EVENT_WINDOWS } from '../utils/event-window'
import { ObjectId } from 'mongodb'
import { randomUUID } from 'crypto'
import {
  GENERATION_LOCK_TTL_SECONDS,
  generationLockKey,
  releaseGenerationLock,
  startGenerationLockHeartbeat,
} from '../utils/generation-lock'

type EditEvent = Static<typeof EditEventBody>
type EditMemory = Static<typeof EditMemoryBody>

export const chronicleController = {
  getEvents: async ({
    params,
    query,
    user,
  }: {
    params: { instanceId: string }
    query: { page?: number; limit?: number; before_sequence?: number; type?: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.getEvents(params.instanceId, user.id, {
      page: Number(query.page) || 1,
      limit: Number(query.limit) || EVENT_WINDOWS.chroniclePageSize,
      beforeSequence: query.before_sequence != null ? Number(query.before_sequence) : undefined,
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

  getConfirmedKinship: async ({
    params,
    user,
  }: {
    params: { instanceId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    const instance = await mongoColl.worldInstances().findOne({
      _id: parseObjectId(params.instanceId),
      player_id: parseObjectId(user.id),
    })
    if (!instance) throw new HttpError(404, 'World not found')
    const template = await mongoColl.worldTemplates().findOne(
      { _id: instance.template_id },
      { projection: { is_sentient: 1 } },
    )
    return {
      relations: await kinshipGraphService.confirmedRelationsToSelf(
        params.instanceId,
        template?.is_sentient ? 'player' : 'protagonist',
      ),
    }
  },

  setKinship: async ({ params, body, user }: {
    params: { instanceId: string }
    body: { character: string; relation: string; correction?: boolean; replaces_relation?: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    const instance = await mongoColl.worldInstances().findOne({ _id: parseObjectId(params.instanceId), player_id: parseObjectId(user.id) })
    if (!instance) throw new HttpError(404, 'World not found')
    const mapped = surfaceToKind(body.relation)
    const replacement = body.replaces_relation ? surfaceToKind(body.replaces_relation) : null
    if (!mapped || !body.character.trim() || (body.correction && !replacement)) throw new HttpError(400, 'Invalid relationship')
    const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id }, { projection: { is_sentient: 1 } })
    const cards = await characterCodexService.listForInstance(params.instanceId, 100)
    const entityMap = await entityGraphService.syncCodexEntities({ instanceId: params.instanceId, playerId: user.id, sequence: Math.max(0, ...cards.map((card) => card.last_seen_sequence)), cards })
    let selfAnchorId: string | null = null
    if (template?.is_sentient) {
      selfAnchorId = idString((await entityGraphService.ensurePlayerEntity({ instanceId: params.instanceId, playerId: user.id, sequence: Math.max(0, ...cards.map((card) => card.last_seen_sequence)) }))._id)
    } else {
      const protagonist = cards.find((card) => card.is_protagonist)
      const entity = protagonist ? entityMap.get(protagonist.name_normalized) : null
      selfAnchorId = entity?._id ? idString(entity._id) : null
    }
    if (!selfAnchorId) throw new HttpError(409, 'Player character is not established yet')
    const assertions: RelationAssertion[] = [{ from: body.character.trim(), to: 'player', kind: mapped.kind, label: body.relation, gender: mapped.gender, modifier: mapped.modifier, polarity: 'assert', source: body.correction ? 'player_correction' : 'player_narration' }]
    if (replacement && replacement.kind !== mapped.kind) assertions.unshift({ from: body.character.trim(), to: 'player', kind: replacement.kind, label: body.replaces_relation, gender: replacement.gender, modifier: replacement.modifier, polarity: 'sever', source: 'player_correction' })
    const written = await kinshipGraphService.applyRelationAssertions({
      instanceId: params.instanceId, sequence: Math.max(0, ...cards.map((card) => card.last_seen_sequence)), eventId: new ObjectId(), assertions, cards, entitiesByCardName: entityMap, selfAnchorId, sceneText: '',
      ensureStub: (name) => entityGraphService.ensureStubEntity({ instanceId: params.instanceId, playerId: user.id, sequence: 0, name }),
    })
    if (!written.written) throw new HttpError(409, 'Could not resolve this character safely')
    // Relationship-sheet edits are authorial canon, not chat turns. Persist a
    // compact ordered overlay after the graph write so rewind/replay rebuilds
    // reapply the exact same asserts/severs after the authored premise seed.
    // Keeping this outside the event ledger intentionally means rewinding prose
    // never undoes an explicit player correction made in the canon controls.
    await mongoColl.worldInstances().updateOne(
      { _id: parseObjectId(params.instanceId), player_id: parseObjectId(user.id) },
      {
        $push: {
          manual_relation_assertions: {
            $each: assertions,
            $slice: -120,
          },
        },
        $set: { updated_at: new Date() },
      } as never,
    )
    return { saved: true }
  },

  getRelationCandidates: async ({
    params,
    user,
  }: {
    params: { instanceId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    const rows = await relationCandidateService.listOpen(params.instanceId, user.id)
    return { candidates: rows.map((candidate) => relationCandidateService.toClient(candidate)) }
  },

  resolveRelationCandidate: async ({
    params,
    body,
    user,
  }: {
    params: { candidateId: string }
    body: { action: 'accept' | 'reject' | 'defer'; relation?: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    const candidate = await relationCandidateService.getOpen(params.candidateId, user.id)
    if (!candidate) throw new HttpError(404, 'Relationship review not found')

    if (body.action !== 'accept') {
      const ok = await relationCandidateService.resolve({
        candidateId: params.candidateId,
        playerId: user.id,
        status: body.action === 'reject' ? 'rejected' : 'deferred',
      })
      return { resolved: ok }
    }

    const kind = candidate.kind || 'kinship'
    if (kind === 'identity_rename') {
      if (!candidate.proposed_name) throw new HttpError(409, 'This identity reveal is incomplete')
      const character = await characterCodexService.confirmIdentityRename({
        playerId: user.id,
        characterEntityId: idString(candidate.character_entity_id),
        proposedName: candidate.proposed_name,
      })
      // Keep the graph's canonical label/token registry in lockstep with the
      // card; aliases preserve old narration and existing relationship edges.
      await entityGraphService.syncCodexEntities({
        instanceId: idString(candidate.instance_id),
        playerId: user.id,
        sequence: candidate.sequence,
        cards: [character],
      })
      await mongoColl.worldInstances().updateOne(
        { _id: candidate.instance_id, player_id: parseObjectId(user.id) },
        {
          $push: {
            manual_identity_revisions: {
              $each: [{ kind, source_name: candidate.character_name, target_name: character.canonical_name }],
              $slice: -80,
            },
          },
          $set: { updated_at: new Date() },
        } as never,
      )
      await relationCandidateService.resolve({
        candidateId: params.candidateId,
        playerId: user.id,
        status: 'accepted',
        relation: candidate.proposed_name,
      })
      return { resolved: true, kind, name: character.canonical_name }
    }
    if (kind === 'identity_merge') {
      if (!candidate.counterpart_entity_id) throw new HttpError(409, 'This identity merge is incomplete')
      const merged = await characterCodexService.confirmIdentityMerge({
        playerId: user.id,
        sourceEntityId: idString(candidate.character_entity_id),
        targetEntityId: idString(candidate.counterpart_entity_id),
      })
      await entityGraphService.mergeCharacterEntities({
        instanceId: idString(candidate.instance_id),
        playerId: user.id,
        sourceEntityId: idString(candidate.character_entity_id),
        targetEntityId: idString(candidate.counterpart_entity_id),
        targetCard: merged.target,
      })
      await characterCodexService.finalizeIdentityMerge({
        playerId: user.id,
        sourceCharacterId: idString(merged.source._id),
      })
      await mongoColl.worldInstances().updateOne(
        { _id: candidate.instance_id, player_id: parseObjectId(user.id) },
        {
          $push: {
            manual_identity_revisions: {
              $each: [{ kind, source_name: merged.source.canonical_name, target_name: merged.target.canonical_name }],
              $slice: -80,
            },
          },
          $set: { updated_at: new Date() },
        } as never,
      )
      await relationCandidateService.resolve({
        candidateId: params.candidateId,
        playerId: user.id,
        status: 'accepted',
        relation: merged.target.canonical_name,
      })
      return { resolved: true, kind, name: merged.target.canonical_name }
    }
    if (kind === 'kinship_revision') {
      const relation = String(candidate.replaces_relation || candidate.relation || '').toLowerCase()
      const result = await kinshipGraphService.applyLifecycleTransitions({
        instanceId: idString(candidate.instance_id),
        sequence: candidate.sequence,
        transitions: [{ owner: TRANSITION_PLAYER, rel: relation, state: 'revealed_false', source: 'player_correction' }],
        resolveName: () => null,
        selfAnchorId: idString(candidate.player_entity_id),
      })
      if (!result.changed) throw new HttpError(409, 'No active relationship could be revised safely')
      await mongoColl.worldInstances().updateOne(
        { _id: candidate.instance_id, player_id: parseObjectId(user.id) },
        {
          $push: { manual_lifecycle_transitions: { $each: [{ rel: relation, state: 'revealed_false' }], $slice: -120 } },
          $set: { updated_at: new Date() },
        } as never,
      )
      await relationCandidateService.resolve({
        candidateId: params.candidateId,
        playerId: user.id,
        status: 'accepted',
        relation,
      })
      return { resolved: true, kind, relation }
    }

    const relation = String(body.relation || candidate.relation).toLowerCase()
    const mapped = surfaceToKind(relation)
    if (!mapped) throw new HttpError(400, 'Unsupported relationship')
    const conflict = await mongoColl.entityEdges().findOne({
      instance_id: candidate.instance_id,
      type: 'kinship',
      status: 'active',
      $or: [
        { source_entity_id: candidate.character_entity_id, target_entity_id: candidate.player_entity_id },
        { source_entity_id: candidate.player_entity_id, target_entity_id: candidate.character_entity_id },
      ],
    })
    if (conflict) {
      throw new HttpError(409, 'A confirmed relationship already exists. Use a correction instead.')
    }

    const cards = await characterCodexService.listForInstance(idString(candidate.instance_id), 100)
    const entitiesByCardName = await entityGraphService.syncCodexEntities({
      instanceId: idString(candidate.instance_id),
      playerId: user.id,
      sequence: candidate.sequence,
      cards,
    })
    const assertions: RelationAssertion[] = [{
      from: candidate.character_name,
      to: 'player',
      kind: mapped.kind,
      label: relation,
      gender: mapped.gender,
      modifier: mapped.modifier,
      polarity: 'assert',
      source: 'player_correction',
    }]
    const result = await kinshipGraphService.applyRelationAssertions({
      instanceId: idString(candidate.instance_id),
      sequence: candidate.sequence,
      eventId: candidate.source_event_id,
      assertions,
      cards,
      entitiesByCardName,
      selfAnchorId: idString(candidate.player_entity_id),
      sceneText: candidate.evidence,
      ensureStub: (name) => entityGraphService.ensureStubEntity({
        instanceId: idString(candidate.instance_id),
        playerId: user.id,
        sequence: candidate.sequence,
        name,
      }),
    })
    if (!result.written) throw new HttpError(409, 'Could not resolve this character safely')
    // Candidate acceptance is the player's explicit canon decision, even though
    // it was prompted by story evidence. Persist it with the other non-chat
    // relationship edits so a graph rebuild cannot erase the confirmation.
    await mongoColl.worldInstances().updateOne(
      { _id: candidate.instance_id, player_id: parseObjectId(user.id) },
      {
        $push: {
          manual_relation_assertions: {
            $each: assertions,
            $slice: -120,
          },
        },
        $set: { updated_at: new Date() },
      } as never,
    )
    await relationCandidateService.resolve({
      candidateId: params.candidateId,
      playerId: user.id,
      status: 'accepted',
      relation,
    })
    return { resolved: true, relation }
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

  getSideChatReachability: async ({
    params,
    user,
  }: {
    params: { instanceId: string; characterId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return sideChatService.checkReachability(params.instanceId, user.id, params.characterId)
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
    // A rename changes presentation, never identity. Synchronize the one
    // card's existing entity row now (rather than waiting for the next turn),
    // so all typed edges and alias lookup immediately resolve to the new name.
    try {
      await entityGraphService.syncCodexEntities({
        instanceId: result.instanceId,
        playerId: user.id,
        sequence: result.character.last_seen_sequence,
        cards: [result.character],
      })
    } catch {
      // Generation also syncs cards to entities. A temporary graph hiccup must
      // not reject an otherwise valid character edit.
    }
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
        interaction_hints: c.interaction_hints || [],
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
    const redis = getRedisClient()
    const lockKey = generationLockKey(user.id, params.instanceId)
    const lockValue = `rewind:${randomUUID()}`
    const acquired = await redis.set(
      lockKey,
      lockValue,
      'EX',
      GENERATION_LOCK_TTL_SECONDS,
      'NX',
    )
    if (!acquired) {
      throw new HttpError(409, 'Another story operation is still in progress. Please wait for it to finish.')
    }

    // A rewind may rebuild several projections and outlive the normal dispatch
    // TTL. Keep the shared lock alive, then release only our own value.
    const stopHeartbeat = startGenerationLockHeartbeat(redis, lockKey, lockValue)
    try {
      return await memoryService.rewindToSequence(params.instanceId, user.id, body.sequence)
    } finally {
      stopHeartbeat()
      await releaseGenerationLock(redis, lockKey, lockValue).catch(() => {})
    }
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
   *     projection of the ledger). The relation assertion rides on the same
   *     codex delta, so kinship edges ARE ledger-replayed now: a rewind rebuilds
   *     the typed edges from the surviving codex_deltas (kinshipGraphService
   *     .rebuildFromLedger), so a rewind past this point reconstructs the edge
   *     deterministically rather than dropping it.
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
            interaction_hints: c.interaction_hints || [],
            disposition_to_player: c.disposition_to_player,
            hidden_thought: c.hidden_thought,
            relationship: c.relationship || null,
            relationship_state: c.relationship_state || null,
            mention_count: c.mention_count,
            is_protagonist: c.is_protagonist === true,
          })),
        }),
      )
    } catch (err) {
      console.warn('track codex publish failed:', (err as Error).message)
    }

    // SHARED CONTRACT v1 item 4: a track repairs the codex (and possibly a
    // kinship edge), so notify clients which projection surfaces changed.
    try {
      await getRedisClient().publish(
        `user:${user.id}:events`,
        JSON.stringify({
          type: 'world_projection_updated',
          instance_id: params.instanceId,
          scopes: relationAssertion
            ? ['bonds', 'codex', 'presence']
            : ['codex', 'presence'],
          source: 'track',
        }),
      )
    } catch (err) {
      console.warn('track world_projection_updated publish failed:', (err as Error).message)
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
        interaction_hints: tracked.interaction_hints || [],
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
