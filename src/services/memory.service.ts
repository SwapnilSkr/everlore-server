import { randomUUID } from 'crypto'
import { env } from '../config/env'
import { mongoColl } from '../config/mongo'
import { getPineconeIndex } from '../config/pinecone'
import { getRedisClient } from '../config/redis'
import { getMemoryCurationQueue, getSceneSummaryQueue, QUEUE_RETENTION } from '../queues'
import { queryRag } from '../providers/rag.provider'
import { buildPrompt } from '../utils/prompt-builder'
import { lengthMaxTokens } from '../utils/narrative-styles'
import { NSFW_MODE, DEFAULT_CHAT_MODE } from '../utils/chat-modes'
import type { ObjectId } from 'mongodb'
import { idString, parseObjectId } from '../utils/mongo-id'
import { parsePlayerInput } from '../utils/player-input-parser'
import { extractKinshipAssertions, mergeRelationAssertions } from '../../worker/lib/kinship-pattern-extractor'
import { characterCodexService } from './character-codex.service'
import { materializeTemplateCast } from './template-cast.service'
import { entityGraphService } from './entity-graph.service'
import { timeService } from './time.service'
import { applyStateMutations, applyFlagMutations } from '../utils/state-mutator'
import { repairProseHygiene, validateProseHygiene } from '../utils/prose-hygiene'
import { callLLM, callLLMStream, embed, AI_MODELS, narrationTemperature } from '../ai'
import { classifyScene } from '../../worker/lib/nsfw-classifier'
import { extractSceneMetadata } from '../../worker/lib/metadata-extractor'
import { extractCharacterCodexDeltas } from '../../worker/lib/character-codex-extractor'
import { classifyPresenceCodexGaps } from '../../worker/lib/presence-gap-detector'
import {
  adjudicateEntityCandidates,
  entityAdjudicationCandidates,
  filterAdjudicatedPresence,
} from '../../worker/lib/entity-adjudicator'
import { EVENT_WINDOWS } from '../utils/event-window'
import { HttpError } from '../utils/http-error'
import { kinshipGraphService } from './kinship-graph.service'
import { projectionCheckpointService } from './projection-checkpoint.service'
import {
  extractExplicitPhysicalDestination,
  isExplicitPlayerLocationChange,
  isExplicitSceneExit,
  refinePhysicalDestination,
  validatedContainmentHint,
} from '../../worker/lib/movement-signal'

const events = () => mongoColl.events()
const memories = () => mongoColl.memories()
const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()
const sceneSummaries = () => mongoColl.sceneSummaries()
const chapterSummaries = () => mongoColl.chapterSummaries()
const arcSummaries = () => mongoColl.arcSummaries()
const characters = () => mongoColl.characters()
const users = () => mongoColl.users()

/** Restore the cast that existed when this save began. A template may later be
 * edited, so rewind/replay must not silently acquire its new characters or
 * starting bonds. Legacy saves fall back to the template until migrated. */
async function restoreInitialTemplateCast(params: {
  instanceId: string
  playerId: string
  instance: any
  template: any
}) {
  const { instanceId, playerId, instance, template } = params
  await materializeTemplateCast({
    template: {
      seed_cast: instance.seed_cast_snapshot ?? template.seed_cast,
      protagonist: template.protagonist,
    },
    instanceId,
    playerId,
    sequence: 0,
  })
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

function continuityText(value: string, max = 220): string {
  return String(value || '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * Formatting normalization for replay alternatives.  A replay is a deliberate
 * request for a new telling; accepting the same response with different
 * asterisks/whitespace is never useful.  Keep this exact rather than fuzzy so
 * a legitimately similar beat is not rejected merely for sharing vocabulary.
 */
function normalizedNarrative(value: string): string {
  return String(value || '')
    .replace(/[“”]/g, '"')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function duplicatesExistingReplay(narrative: string, variants: Array<{ narrative?: string }>): boolean {
  const normalized = normalizedNarrative(narrative)
  if (!normalized) return false
  return variants.some((variant) => normalizedNarrative(variant.narrative || '') === normalized)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function openingCharacterName(recentEvents: any[], names: string[]): string | null {
  const last = [...(recentEvents || [])].reverse().find((event) => String(event.data?.ai_response || '').trim())
  const text = String(last?.data?.ai_response || '')
    .trim()
    .replace(/^[\s*_]+/, '')
  for (const name of names) {
    if (!name) continue
    const re = new RegExp(`^${escapeRegExp(name)}(?:\\b|'s\\b)`, 'i')
    if (re.test(text)) return name
  }
  return null
}

function baseReplayVariantFor(event: any) {
  return {
    id: `base_${idString(event._id)}`,
    narrative: event.data?.ai_response || '',
    model_used: event.data?.model_used || AI_MODELS.narrationSfw,
    created_at: event.created_at || new Date(),
    source: 'base',
    choices: Array.isArray(event.data?.choices) ? event.data.choices : [],
    present_characters: Array.isArray(event.data?.present_characters) ? event.data.present_characters : [],
    retrieval_profile: {
      lore_top_k: 10,
      memory_top_k: 25,
      recent_event_window: 6,
    },
  }
}

function normalizeReplayVariants(event: any): any[] {
  const existing = Array.isArray(event.data?.replay_variants)
    ? event.data.replay_variants.filter((v: any) => typeof v?.narrative === 'string')
    : []
  if (existing.length > 0) return existing
  if (typeof event.data?.ai_response === 'string' && event.data.ai_response.trim()) {
    return [baseReplayVariantFor(event)]
  }
  return []
}

async function characterNamesForInstance(instanceId: any): Promise<string[]> {
  const codex = await characters()
    .find({ instance_id: instanceId }, { projection: { canonical_name: 1 } })
    .limit(40)
    .toArray()
  return codex.map((c: any) => c.canonical_name).filter(Boolean)
}

function carryReplayPresence(
  meta: Awaited<ReturnType<typeof extractSceneMetadata>>,
  priorPresent: string[],
  locationChanged: boolean,
  playerBrokeScene: boolean,
): string[] {
  const sceneBroke = playerBrokeScene || meta.viewpoint_moved === true || !!meta.time_elapsed || locationChanged
  const candidates = sceneBroke ? meta.present_characters || [] : [...priorPresent, ...(meta.present_characters || [])]
  const departed = new Set(
    (meta.characters_departed || [])
      .map((name) =>
        String(name || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  )
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of candidates) {
    const name = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim()
    const key = name.toLowerCase()
    if (!name || seen.has(key) || departed.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= 12) break
  }
  return out
}

function trackableMentionsForProse(params: { prose: string; present: string[]; codex: any[]; exclude?: string[] }) {
  const codexNames: string[] = []
  for (const c of params.codex || []) {
    if (c?.canonical_name) codexNames.push(c.canonical_name)
    for (const a of c?.aliases || []) {
      if (a) codexNames.push(a)
    }
  }
  return classifyPresenceCodexGaps(params.prose, {
    present: params.present,
    codex: codexNames,
    exclude: params.exclude || [],
  })
    .filter((m) => m.tier === 'confirmed' || m.tier === 'probable')
    .map((m) => ({
      key: m.key,
      display: m.display,
      tier: m.tier,
      evidence: m.evidence,
    }))
}

const SCENE_SUMMARY_BLOCK = 12

async function projectLatestReplayTurn(params: {
  event: any
  playerId: string
  instance: any
  template: any
  narrative: string
  codex: any[]
}) {
  const { event, playerId, instance, template, narrative, codex } = params
  const instanceId = idString(event.instance_id)
  const eventSequence = Number(event.sequence || 0)

  const priorEvents = await events()
    .find({
      instance_id: event.instance_id,
      sequence: { $lt: eventSequence },
      type: { $ne: 'side_chat' },
    })
    .sort({ sequence: -1 })
    .limit(EVENT_WINDOWS.promptRecentEvents)
    .toArray()
  priorEvents.reverse()

  const priorEvent = priorEvents[priorEvents.length - 1] as any | undefined
  const priorLocation = priorEvent?.location_anchor || null
  const priorPresent = Array.isArray(priorEvent?.data?.present_characters)
    ? priorEvent.data.present_characters.filter((n: unknown) => typeof n === 'string')
    : []

  const protagonistCard = (codex as any[]).find((c) => c.is_protagonist)
  const choiceProtagonist = template.is_sentient
    ? instance.persona_snapshot?.name
      ? { name: instance.persona_snapshot.name, aliases: [] }
      : null
    : protagonistCard
      ? {
          name: protagonistCard.canonical_name,
          aliases: protagonistCard.aliases || [],
        }
      : instance.persona_snapshot?.name
        ? { name: instance.persona_snapshot.name, aliases: [] }
        : null
  const roster = (codex as any[])
    .filter((c) => c.canonical_name && (template.is_sentient || !c.is_protagonist))
    .map((c) => ({
      name: c.canonical_name as string,
      aliases: (c.aliases || []) as string[],
    }))
  const knownPlaces = await entityGraphService
    .listKnownLocations(instanceId, 30)
    .catch(() => [] as { name: string; aliases: string[] }[])

  const knownNames = (codex as any[]).flatMap((card) => [
    card?.canonical_name,
    ...((card?.aliases as string[]) || []),
  ]).filter((name): name is string => typeof name === 'string' && !!name.trim())
  const entityCandidates = entityAdjudicationCandidates({
    prose: narrative,
    knownNames,
    exclude: [
      ...knownPlaces.flatMap((place) => [place.name, ...(place.aliases || [])]),
      choiceProtagonist?.name || '',
      ...(choiceProtagonist?.aliases || []),
    ],
  })

  const [meta, entityAdjudication] = await Promise.all([
    extractSceneMetadata(
      narrative,
      Object.keys(instance.world_state || {}),
      Object.keys(instance.active_flags || {}),
      {
        isSentient: !!template.is_sentient,
        currentLocationName: priorLocation?.name || null,
        priorPresent,
        protagonist: choiceProtagonist,
        roster,
        knownPlaces,
        worldContext: [template.seed_prompt, template.global_lore].filter(Boolean).join('\n'),
      },
    ),
    adjudicateEntityCandidates({
      prose: narrative,
      candidates: entityCandidates,
      knownCast: knownNames,
      knownPlaces: knownPlaces.map((place) => place.name),
      worldContext: [template.seed_prompt, template.global_lore].filter(Boolean).join('\n'),
    }),
  ])
  meta.present_characters = filterAdjudicatedPresence(
    meta.present_characters || [],
    entityCandidates,
    entityAdjudication,
  )

  // Replay is a projection of the same player-authored turn, so it must use the
  // live transition authority rather than letting a fresh witness response move
  // the map by itself. This keeps replay from resurrecting old companions or
  // minting a different location graph than the original turn.
  const replayInput = String(event.data?.player_input || event.userMessage || '')
  const replayAction = event.data?.world_action
  const replayPlayerDestination = replayAction?.kind === 'travel'
    ? String(replayAction.destination || '').trim() || null
    : extractExplicitPhysicalDestination(replayInput)
  const replayPlaceName = replayPlayerDestination
    ? refinePhysicalDestination(replayPlayerDestination, meta.current_location)
    : meta.current_location
  const replayViewpointMoved =
    !!replayPlayerDestination ||
    isExplicitPlayerLocationChange(replayInput, replayPlaceName, choiceProtagonist?.name || null)
  const replayExitedScene = isExplicitSceneExit(replayInput)
  const replayContainmentHint = replayViewpointMoved
    ? validatedContainmentHint({
        destination: replayPlaceName,
        witnessLocation: meta.current_location,
        witnessContainment: meta.containment_hint,
        currentLocationName: priorLocation?.name || null,
        knownLocationNames: knownPlaces.map((place) => place.name),
      })
    : null
  const replayWitnessMovement = meta.movement || 'none'
  const replayMovement = replayContainmentHint && ['deeper', 'out', 'lateral', 'world_shift'].includes(replayWitnessMovement)
    ? replayWitnessMovement
    : replayViewpointMoved
      ? 'lateral'
      : 'none'
  const resolvedLocation = replayViewpointMoved && replayPlaceName
    ? await entityGraphService
        .placeLocation({
          instanceId,
          playerId,
          sequence: eventSequence,
          name: replayPlaceName,
          containmentHint: replayContainmentHint,
          movement: replayMovement,
          viewpointMoved: replayViewpointMoved,
          cursorEntityId: priorLocation?.entity_id ?? null,
        })
        .catch((err) => {
          console.warn('Replay projection: location anchor resolution failed:', (err as Error).message)
          return null
        })
    : null
  const locationAnchor = resolvedLocation || priorLocation || null
  const locationChanged =
    !!resolvedLocation && !!priorLocation && idString(resolvedLocation.entity_id) !== idString(priorLocation.entity_id)
  meta.present_characters = carryReplayPresence(meta, priorPresent, locationChanged, replayExitedScene || replayViewpointMoved)

  const statLimits: Record<string, { min: number; max: number }> = {}
  let worldState: Record<string, number> = {}
  for (const [key, def] of Object.entries(template.base_stats_template || {}) as Array<[string, any]>) {
    worldState[key] = def.default
    statLimits[key] = { min: def.min, max: def.max }
  }
  let activeFlags: Record<string, unknown> = {}
  for (const [key, def] of Object.entries(template.flag_definitions || {}) as Array<[string, any]>) {
    activeFlags[key] = def.default
  }

  // FINDING 1: resume from the most recent projection checkpoint strictly BEFORE
  // this turn and replay only the SUFFIX of prior turns' deltas, rather than
  // scanning every prior event. Same final state — purely O(n)->O(suffix).
  // Falls back to a full prior-event scan when no usable checkpoint exists.
  const snapshot = await projectionCheckpointService
    .instanceStateBefore(instanceId, eventSequence - 1, {
      mustBeBefore: eventSequence,
    })
    .catch(() => null)
  const priorScanGt = snapshot ? snapshot.sequence : -1
  if (snapshot) {
    // Seed from the checkpoint, but keep any template-default keys the snapshot
    // lacks (a stat added after the checkpoint was written).
    worldState = { ...worldState, ...(snapshot.world_state || {}) }
    activeFlags = { ...activeFlags, ...(snapshot.active_flags || {}) }
  }

  const projectionEvents = await events()
    .find(
      {
        instance_id: event.instance_id,
        sequence: { $lt: eventSequence, $gt: priorScanGt },
        type: { $ne: 'side_chat' },
      },
      {
        projection: {
          sequence: 1,
          scene_tag: 1,
          'data.state_mutations': 1,
          'data.flag_mutations': 1,
        },
      },
    )
    .sort({ sequence: 1 })
    .toArray()
  for (const ev of projectionEvents) {
    worldState = applyStateMutations(worldState, ev.data?.state_mutations || {}, statLimits)
    activeFlags = applyFlagMutations(activeFlags, ev.data?.flag_mutations || {})
  }
  worldState = applyStateMutations(worldState, meta.state_mutations || {}, statLimits)
  activeFlags = applyFlagMutations(activeFlags, meta.flag_mutations || {})

  // Scene turn-count: walk the tail (this turn + the suffix) back to the first
  // scene-tag change. If the run of matching tags reaches the start of the
  // suffix without breaking and we haven't hit the summary threshold, the run
  // may extend behind the checkpoint — fall back to a full prior-event scan so
  // the count stays exact.
  const sceneEvents = [...projectionEvents.map((ev) => ({ scene_tag: ev.scene_tag })), { scene_tag: meta.scene_tag }]
  let rawTurnCount = 0
  let runReachedSuffixStart = false
  for (let i = sceneEvents.length - 1; i >= 0; i--) {
    if (sceneEvents[i].scene_tag === meta.scene_tag) {
      rawTurnCount++
      if (i === 0) runReachedSuffixStart = true
    } else {
      runReachedSuffixStart = false
      break
    }
  }
  if (snapshot && runReachedSuffixStart && rawTurnCount < SCENE_SUMMARY_BLOCK && priorScanGt >= 0) {
    const behindCheckpoint = await events()
      .find(
        {
          instance_id: event.instance_id,
          sequence: { $lte: priorScanGt },
          type: { $ne: 'side_chat' },
        },
        { projection: { scene_tag: 1 } },
      )
      .sort({ sequence: -1 })
      .toArray()
    for (const ev of behindCheckpoint) {
      if (ev.scene_tag === meta.scene_tag) rawTurnCount++
      else break
    }
  }
  const shouldSummarize = rawTurnCount >= SCENE_SUMMARY_BLOCK
  const currentScene = {
    tag: meta.scene_tag,
    turn_count: shouldSummarize ? 0 : rawTurnCount,
    summary_pending: shouldSummarize,
  }

  return { meta, locationAnchor, worldState, activeFlags, currentScene }
}

async function extractReplayCodexDeltas(params: {
  event: any
  playerId: string
  instance: any
  template: any
  narrative: string
  presentCharacters: string[]
}) {
  const { event, instance, template, narrative, presentCharacters } = params
  const existing = await characters()
    .find({ instance_id: event.instance_id })
    .sort({ mention_count: -1, updated_at: -1 })
    .toArray()
  const deltas = await extractCharacterCodexDeltas({
    playerInput: event.data?.player_input || '',
    aiResponse: narrative,
    existing: existing.map((c: any) => ({
      canonical_name: c.canonical_name,
      aliases: c.aliases || [],
      role: c.role,
      appearance: c.appearance,
      persona: c.persona,
      disposition_to_player: c.disposition_to_player,
      relationship: c.relationship,
      relationship_moments: c.relationship_moments || [],
      relationship_state: c.relationship_state,
      relationship_facts: c.relationship_facts || [],
      mutable_state: c.mutable_state || [],
      immutable_facts: c.immutable_facts || [],
    })),
    seedPrompt: template.seed_prompt,
    isSentient: !!template.is_sentient,
    protagonistName: (existing as any[]).find((c) => c.is_protagonist)?.canonical_name,
    playerPersonaName: instance.persona_snapshot?.name,
    presentCast: presentCharacters,
  }).catch((err) => {
    console.warn('Replay projection: codex extraction failed:', (err as Error).message)
    return []
  })
  if (!template.is_sentient) {
    for (const d of deltas) {
      if (d.is_protagonist) delete d.relationship_deltas
    }
  }
  return deltas
}

function codexSocketPayload(codex: any[]) {
  return codex.map((c) => ({
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
  }))
}

async function publishCodexUpdated(playerId: string, instance: any, codex: any[]) {
  try {
    await getRedisClient().publish(
      `user:${playerId}:events`,
      JSON.stringify({
        type: 'character_codex_updated',
        instanceId: idString(instance._id),
        focused_character_id: instance.focus_character_id ? idString(instance.focus_character_id) : null,
        characters: codexSocketPayload(codex),
      }),
    )
  } catch (err) {
    console.warn('Replay projection: codex publish failed:', (err as Error).message)
  }
}

async function rebuildCodexAndRelationsAfterReplay(params: {
  event: any
  playerId: string
  instance: any
  template: any
  narrative: string
  deltas: any[]
  forceExactRebuild: boolean
}) {
  const { event, playerId, instance, template, narrative, deltas, forceExactRebuild } = params
  const instanceId = idString(event.instance_id)
  if (forceExactRebuild) {
    try {
      const checkpointed = await rebuildCodexKinshipFromCheckpoint({
        instanceId,
        playerId,
        instance,
        template,
        beforeOrAtSequence: Math.max(0, event.sequence - 1),
        checkpointMustBeBefore: event.sequence,
      })
      if (checkpointed.used) return checkpointed.codex || characterCodexService.listForInstance(instanceId, 200)
    } catch (err) {
      console.warn('Replay projection: checkpoint rebuild failed, falling back to full ledger:', (err as Error).message)
    }
  }
  const priorProtagonist = await characters().findOne({
    instance_id: event.instance_id,
    is_protagonist: true,
  })
  const ledgerEvents = await events()
    .find(
      { instance_id: event.instance_id, type: { $ne: 'side_chat' } },
      { projection: { sequence: 1, 'data.codex_deltas': 1 } },
    )
    .sort({ sequence: 1 })
    .toArray()
  const batches = ledgerEvents
    .filter((ev) => Array.isArray(ev.data?.codex_deltas) && ev.data.codex_deltas.length > 0)
    .map((ev) => ({ sequence: ev.sequence, deltas: ev.data!.codex_deltas! }))

  if (forceExactRebuild || batches.length > 0) {
    await characters().deleteMany({ instance_id: event.instance_id })
    const protoName = priorProtagonist?.canonical_name ?? template.protagonist?.name
    if (protoName) {
      await characterCodexService.seedProtagonist({
        instanceId,
        playerId,
        name: protoName,
        persona: priorProtagonist?.persona ?? template.protagonist?.persona,
        appearance: priorProtagonist?.appearance ?? template.protagonist?.appearance,
        aliases: priorProtagonist?.aliases || [],
        isPlayer: !template.is_sentient,
      })
    }
    await characterCodexService.applyManualIdentityRevisions({ instanceId, playerId })
    await restoreInitialTemplateCast({ instanceId, playerId, instance, template })
    if (batches.length > 0) {
      await characterCodexService.rebuildCodexFromLedger({
        instanceId,
        playerId,
        batches,
      })
    }
  } else if (deltas.length > 0) {
    await characterCodexService.applyDeltas({
      instanceId,
      playerId,
      sequence: event.sequence,
      deltas,
    })
  }

  const codex = await characterCodexService.listForInstance(instanceId, 200)
  const entityMap = await entityGraphService.syncCodexEntities({
    instanceId,
    playerId,
    sequence: event.sequence,
    cards: codex,
  })
  await entityGraphService.syncRelationshipEdges({
    instanceId,
    playerId,
    sequence: event.sequence,
    eventId: event._id,
    cards: codex,
    entitiesByCardName: entityMap,
    playerName: instance.persona_snapshot?.name,
  })

  if (forceExactRebuild) {
    // Exact rebuild: the codex was dropped + replayed, so rebuild the kinship graph
    // from the whole surviving ledger (authority + sever/retcon order reconstructed
    // exactly) rather than re-applying only this one event's assertions.
    await kinshipGraphService
      .rebuildFromLedger({
        instanceId,
        playerId,
        isSentient: !!template.is_sentient,
        playerName: instance.persona_snapshot?.name,
      })
      .catch((err) => {
        console.warn('Replay projection: kinship graph rebuild failed:', (err as Error).message)
      })
  } else {
    // Incremental: merge this turn's LLM assertions with a deterministic pass over
    // its input + prose, then apply on top of the existing edges.
    const parsedInput = parsePlayerInput(event.data?.player_input || '')
    const relationAssertions = mergeRelationAssertions(
      deltas.flatMap((d) => d.relation_assertions || []),
      extractKinshipAssertions({
        corrections: parsedInput.corrections,
        narrationFacts: parsedInput.narrationFacts,
        claims: parsedInput.claims,
        prose: narrative,
      }),
    )
    if (relationAssertions.length > 0) {
      const protagCard = codex.find((c) => c.is_protagonist)
      let selfAnchorId: string | null = null
      if (!template.is_sentient && protagCard) {
        const ent = entityMap.get(protagCard.name_normalized)
        selfAnchorId = ent?._id ? idString(ent._id) : null
      } else {
        const player = await entityGraphService.ensurePlayerEntity({
          instanceId,
          playerId,
          name: instance.persona_snapshot?.name,
          sequence: event.sequence,
        })
        selfAnchorId = idString(player._id)
      }
      await kinshipGraphService
        .applyRelationAssertions({
          instanceId,
          sequence: event.sequence,
          eventId: event._id,
          assertions: relationAssertions,
          cards: codex,
          entitiesByCardName: entityMap,
          selfAnchorId,
          sceneText: narrative,
          ensureStub: (name: string) =>
            entityGraphService.ensureStubEntity({
              instanceId,
              playerId,
              sequence: event.sequence,
              name,
            }),
        })
        .catch((err) => {
          console.warn('Replay projection: kinship graph write failed:', (err as Error).message)
        })
    }
  }

  await publishCodexUpdated(playerId, instance, codex)
  return codex
}

async function rebuildCodexKinshipFromCheckpoint(params: {
  instanceId: string
  playerId: string
  instance: any
  template: any
  beforeOrAtSequence: number
  checkpointMustBeBefore?: number
}): Promise<{
  used: boolean
  checkpointSequence?: number
  suffixEvents?: number
  codex?: any[]
}> {
  const { instanceId, playerId, instance, template, beforeOrAtSequence, checkpointMustBeBefore } = params
  const latest = await projectionCheckpointService.latestBefore(instanceId, beforeOrAtSequence)
  if (!latest) return { used: false }
  if (typeof checkpointMustBeBefore === 'number' && latest.sequence >= checkpointMustBeBefore) {
    return { used: false }
  }

  await projectionCheckpointService.restoreCodexAndKinship(latest._id)
  await restoreInitialTemplateCast({ instanceId, playerId, instance, template })

  const iid = parseObjectId(instanceId)
  const suffix = await events()
    .find(
      {
        instance_id: iid,
        type: { $ne: 'side_chat' },
        sequence: { $gt: latest.sequence },
      },
      { projection: { sequence: 1, 'data.codex_deltas': 1 } },
    )
    .sort({ sequence: 1 })
    .toArray()
  const batches = suffix
    .filter((ev) => Array.isArray(ev.data?.codex_deltas) && ev.data.codex_deltas.length > 0)
    .map((ev) => ({ sequence: ev.sequence, deltas: ev.data!.codex_deltas! }))
  if (batches.length > 0) {
    await characterCodexService.rebuildCodexFromLedger({
      instanceId,
      playerId,
      batches,
    })
  }
  await characterCodexService.applyManualIdentityRevisions({ instanceId, playerId })

  const codex = await characterCodexService.listForInstance(instanceId, 200)
  const entityMap = await entityGraphService.syncCodexEntities({
    instanceId,
    playerId,
    sequence: beforeOrAtSequence,
    cards: codex,
  })
  await entityGraphService.syncRelationshipEdges({
    instanceId,
    playerId,
    sequence: beforeOrAtSequence,
    eventId: null,
    cards: codex,
    entitiesByCardName: entityMap,
    playerName: instance.persona_snapshot?.name,
  })
  await kinshipGraphService.applyLedgerSince({
    instanceId,
    playerId,
    isSentient: !!template.is_sentient,
    playerName: instance.persona_snapshot?.name,
    fromSequence: latest.sequence,
  })
  await publishCodexUpdated(playerId, instance, codex)
  return {
    used: true,
    checkpointSequence: latest.sequence,
    suffixEvents: suffix.length,
    codex,
  }
}

/**
 * Projection provenance: when a turn's content changes, any scene summary whose
 * range covers that turn now describes events that no longer happened. Mark it
 * stale (prompts skip stale summaries) and requeue a rebuild for the same range.
 */
async function staleSummariesCoveringEvent(event: any): Promise<number> {
  const covering = await sceneSummaries()
    .find({
      instance_id: event.instance_id,
      'event_range.start_sequence': { $lte: event.sequence },
      'event_range.end_sequence': { $gte: event.sequence },
      status: { $ne: 'stale' },
    })
    .toArray()
  if (covering.length === 0) return 0

  await sceneSummaries().updateMany({ _id: { $in: covering.map((s) => s._id) } }, { $set: { status: 'stale' } })

  const queue = getSceneSummaryQueue()
  for (const s of covering) {
    await queue.add(
      'summarize',
      {
        instanceId: idString(event.instance_id),
        sceneTag: s.scene_tag,
        startSequence: s.event_range.start_sequence,
        endSequence: s.event_range.end_sequence,
      },
      {
        priority: 15,
        delay: 2000,
        removeOnComplete: QUEUE_RETENTION.sceneSummary.removeOnComplete,
        removeOnFail: QUEUE_RETENTION.sceneSummary.removeOnFail,
      },
    )
  }

  // A chapter built over any of these scenes now describes a superseded span:
  // stale it and requeue a rebuild over the same scene set (delayed so the
  // child scene summaries above are rebuilt first).
  const coveringChapters = await chapterSummaries()
    .find({
      instance_id: event.instance_id,
      'event_range.start_sequence': { $lte: event.sequence },
      'event_range.end_sequence': { $gte: event.sequence },
      status: { $ne: 'stale' },
    })
    .toArray()
  if (coveringChapters.length > 0) {
    await chapterSummaries().updateMany(
      { _id: { $in: coveringChapters.map((c) => c._id) } },
      { $set: { status: 'stale' } },
    )
    for (const c of coveringChapters) {
      await queue.add(
        'summarize',
        {
          kind: 'chapter',
          instanceId: idString(event.instance_id),
          chapterIndex: c.chapter_index,
          startSequence: c.event_range.start_sequence,
          endSequence: c.event_range.end_sequence,
          sceneSummaryIds: c.scene_summary_ids.map((id) => idString(id)),
        },
        {
          priority: 16,
          delay: 5000,
          removeOnComplete: QUEUE_RETENTION.sceneSummary.removeOnComplete,
          removeOnFail: QUEUE_RETENTION.sceneSummary.removeOnFail,
        },
      )
    }
  }

  // Arcs sit above chapters: an arc over any affected chapter is now superseded.
  // Stale it and requeue (longer delay so the chapters above rebuild first).
  const coveringArcs = await arcSummaries()
    .find({
      instance_id: event.instance_id,
      'event_range.start_sequence': { $lte: event.sequence },
      'event_range.end_sequence': { $gte: event.sequence },
      status: { $ne: 'stale' },
    })
    .toArray()
  if (coveringArcs.length > 0) {
    await arcSummaries().updateMany({ _id: { $in: coveringArcs.map((a) => a._id) } }, { $set: { status: 'stale' } })
    for (const a of coveringArcs) {
      await queue.add(
        'summarize',
        {
          kind: 'arc',
          instanceId: idString(event.instance_id),
          arcIndex: a.arc_index,
          startSequence: a.event_range.start_sequence,
          endSequence: a.event_range.end_sequence,
        },
        {
          priority: 17,
          delay: 9000,
          removeOnComplete: QUEUE_RETENTION.sceneSummary.removeOnComplete,
          removeOnFail: QUEUE_RETENTION.sceneSummary.removeOnFail,
        },
      )
    }
  }

  return covering.length
}

/**
 * Memory version graph (Phase 2) prune: when atoms are removed (rewind / edit
 * re-curation / delete), any SURVIVING atom whose forward version links point at
 * a removed atom would dangle. `$pull` the removed ids from all three link
 * fields. Mirrors the entity-edge provenance pruning — links are a projection,
 * so a removed source must leave no stale reference. Idempotent.
 */
async function pruneMemoryVersionLinks(instanceId: ObjectId, removedMemoryIds: ObjectId[]): Promise<void> {
  if (removedMemoryIds.length === 0) return
  try {
    await memories().updateMany(
      {
        instance_id: instanceId,
        $or: [
          { updates_memory_ids: { $in: removedMemoryIds } },
          { extends_memory_ids: { $in: removedMemoryIds } },
          { derives_from_memory_ids: { $in: removedMemoryIds } },
        ],
      },
      {
        $pull: {
          updates_memory_ids: { $in: removedMemoryIds },
          extends_memory_ids: { $in: removedMemoryIds },
          derives_from_memory_ids: { $in: removedMemoryIds },
        } as never,
      },
    )
  } catch (err) {
    console.warn('Memory version-link prune skipped:', (err as Error).message)
  }
}

async function pruneDanglingMemoryVersionLinks(instanceId: ObjectId): Promise<void> {
  const linked = await memories()
    .find(
      {
        instance_id: instanceId,
        $or: [
          { updates_memory_ids: { $exists: true, $ne: [] } },
          { extends_memory_ids: { $exists: true, $ne: [] } },
          { derives_from_memory_ids: { $exists: true, $ne: [] } },
        ],
      },
      {
        projection: {
          updates_memory_ids: 1,
          extends_memory_ids: 1,
          derives_from_memory_ids: 1,
        },
      },
    )
    .toArray()
  const referenced = [
    ...new Set(
      linked
        .flatMap((m) => [
          ...(m.updates_memory_ids || []),
          ...(m.extends_memory_ids || []),
          ...(m.derives_from_memory_ids || []),
        ])
        .map(idString),
    ),
  ]
  if (referenced.length === 0) return
  const alive = new Set(
    (
      await memories()
        .find({ _id: { $in: referenced.map((id) => parseObjectId(id)) } }, { projection: { _id: 1 } })
        .toArray()
    ).map((m) => idString(m._id)),
  )
  const dead = referenced.filter((id) => !alive.has(id)).map((id) => parseObjectId(id))
  if (dead.length === 0) return
  await pruneMemoryVersionLinks(instanceId, dead)
}

async function pruneAsymmetricMemoryUpdates(instanceId: ObjectId): Promise<void> {
  const linked = await memories()
    .find(
      {
        instance_id: instanceId,
        updates_memory_ids: { $exists: true, $ne: [] },
      },
      { projection: { updates_memory_ids: 1, source_event_ids: 1 } },
    )
    .toArray()
  if (!linked.length) return
  const oldIds = [...new Set(linked.flatMap((m) => m.updates_memory_ids || []).map(idString))].map((id) =>
    parseObjectId(id),
  )
  const oldDocs = oldIds.length
    ? await memories()
        .find(
          { _id: { $in: oldIds } },
          {
            projection: {
              _id: 1,
              superseded_by_event_ids: 1,
              status: 1,
              is_archived: 1,
            },
          },
        )
        .toArray()
    : []
  const oldById = new Map(oldDocs.map((m) => [idString(m._id), m]))
  for (const m of linked) {
    const sourceEvents = new Set((m.source_event_ids || []).map(idString))
    const invalid = (m.updates_memory_ids || []).filter((oldId) => {
      const old = oldById.get(idString(oldId))
      if (!old || old.status !== 'superseded' || old.is_archived !== true) return true
      return !(old.superseded_by_event_ids || []).some((ev) => sourceEvents.has(idString(ev)))
    })
    if (invalid.length > 0) {
      await memories().updateOne({ _id: m._id }, {
        $pull: { updates_memory_ids: { $in: invalid } },
        $set: { updated_at: new Date() },
      } as never)
    }
  }
}

async function pruneDanglingMemoryEntityRefs(instanceId: ObjectId): Promise<void> {
  const mems = await memories()
    .find(
      {
        instance_id: instanceId,
        is_archived: false,
        $or: [{ subject_entity_ids: { $exists: true, $ne: [] } }, { object_entity_ids: { $exists: true, $ne: [] } }],
      },
      { projection: { subject_entity_ids: 1, object_entity_ids: 1 } },
    )
    .toArray()
  const refs = [
    ...new Set(mems.flatMap((m) => [...(m.subject_entity_ids || []), ...(m.object_entity_ids || [])]).map(idString)),
  ]
  if (!refs.length) return
  const alive = new Set(
    (
      await mongoColl
        .entities()
        .find(
          {
            instance_id: instanceId,
            _id: { $in: refs.map((id) => parseObjectId(id)) },
          },
          { projection: { _id: 1 } },
        )
        .toArray()
    ).map((e) => idString(e._id)),
  )
  const dead = refs.filter((id) => !alive.has(id)).map((id) => parseObjectId(id))
  if (!dead.length) return
  await memories().updateMany({ instance_id: instanceId }, {
    $pull: {
      subject_entity_ids: { $in: dead },
      object_entity_ids: { $in: dead },
    },
  } as never)
}

async function recurateMemoriesForEvent(
  event: any,
  playerId: string,
  playerInputRaw: string,
  playerSpokenInput: string,
  playerNarrationFacts: string[],
  aiResponse: string,
): Promise<number> {
  let deletedMemories = 0
  const staleMemories = await memories().find({ instance_id: event.instance_id, source_event_ids: event._id }).toArray()

  if (staleMemories.length > 0) {
    const ns = getPineconeIndex().namespace(`mem_${idString(event.instance_id)}`)
    for (const m of staleMemories) {
      if (!m.pinecone_id) continue
      try {
        await ns.deleteOne({ id: m.pinecone_id })
      } catch (err) {
        console.warn('Event recuration: failed to delete vector', m.pinecone_id, (err as Error).message)
      }
    }

    await memories().deleteMany({
      _id: { $in: staleMemories.map((m) => m._id) },
    })
    deletedMemories = staleMemories.length
    await pruneMemoryVersionLinks(
      event.instance_id,
      staleMemories.map((m) => m._id),
    )
    await pruneDanglingMemoryVersionLinks(event.instance_id)
    await pruneAsymmetricMemoryUpdates(event.instance_id)
    await worldInstances().updateOne({ _id: event.instance_id }, { $inc: { 'meta.total_memories': -deletedMemories } })
  }

  // Graph edges asserted from the old content of this turn no longer hold;
  // re-curation re-creates whatever the new content still supports. Entities
  // whose ONLY reference was the deleted memories are pruned too — an edited-
  // out first mention must not linger as an active entity.
  try {
    await entityGraphService.removeEventProvenance(idString(event.instance_id), [event._id])
    // Location state/facts asserted by this turn's old content go with it; the
    // re-curated turn re-applies whatever the new prose still supports.
    await entityGraphService.pruneLocationFactsByEvents(idString(event.instance_id), [event._id])
    const candidateEntityIds = [
      ...new Map(
        staleMemories
          .flatMap((m) => [...(m.subject_entity_ids || []), ...(m.object_entity_ids || [])])
          .map((id) => [idString(id), id] as const),
      ).values(),
    ]
    await entityGraphService.pruneOrphanEntities(idString(event.instance_id), candidateEntityIds)
  } catch (err) {
    console.warn('Event recuration: entity graph prune failed:', (err as Error).message)
  }

  const memoryCurationQueue = getMemoryCurationQueue()
  await memoryCurationQueue.add(
    'curate',
    {
      instanceId: idString(event.instance_id),
      playerId,
      eventId: idString(event._id),
      playerInput: playerInputRaw,
      playerSpokenInput,
      playerNarrationFacts,
      aiResponse: aiResponse || '',
      sceneTag: event.scene_tag || 'dialogue',
    },
    {
      jobId: `memory-curation:${idString(event._id)}`,
      priority: 5,
      delay: 500,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: QUEUE_RETENTION.memoryCuration.removeOnComplete,
      removeOnFail: QUEUE_RETENTION.memoryCuration.removeOnFail,
    },
  )

  return deletedMemories
}

export const memoryService = {
  async getEvents(instanceId: string, playerId: string, opts: any) {
    const limit = opts.limit || EVENT_WINDOWS.chroniclePageSize
    const skip = ((opts.page || 1) - 1) * limit
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    // Timeline is the MAIN-story chronicle; private side chats have their own
    // thread view and never appear here (a side_chat type filter is ignored).
    const filter: Record<string, unknown> = {
      instance_id: iid,
      player_id: pid,
      type: { $ne: 'side_chat' },
    }
    if (opts.type && opts.type !== 'side_chat') filter.type = opts.type

    // The play feed uses this cursor rather than offset pagination. New turns
    // can arrive while the reader is paging upward; `sequence < before` keeps
    // the older window stable, with neither duplicate nor skipped entries.
    const beforeSequence = Number(opts.beforeSequence)
    const cursorFilter = Number.isFinite(beforeSequence) && beforeSequence > 0
      ? { ...filter, sequence: { $lt: beforeSequence } }
      : filter
    const query = events().find(cursorFilter).sort({ sequence: -1 }).limit(limit)
    if (cursorFilter === filter) query.skip(skip)
    const evs = await query.toArray()

    const total = await events().countDocuments(filter)
    const oldestSequence = evs.length ? evs[evs.length - 1].sequence : null
    const hasOlder = oldestSequence != null
      ? await events().countDocuments({ ...filter, sequence: { $lt: oldestSequence } }) > 0
      : false
    return { events: evs.reverse(), total, page: opts.page || 1, hasOlder }
  },

  async getMemories(instanceId: string, playerId: string, opts: any) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const filter: Record<string, unknown> = {
      instance_id: iid,
      player_id: pid,
    }
    if (!opts.includeArchived) filter.is_archived = false
    // Echoes is a MAIN-story surface: private side-chat atoms only surface when
    // the protagonist is among their knowers (fail-closed, mirrors queryRag).
    Object.assign(filter, await mainVisibleMemoryScope(iid))

    // Advanced filters (all optional; absent = today's behavior).
    if (opts.type) filter.type = opts.type
    if (typeof opts.minImportance === 'number') {
      filter.importance = { $gte: opts.minImportance }
    }
    if (opts.unresolved) filter.unresolved_thread = true

    const q = typeof opts.q === 'string' ? opts.q.trim() : ''
    if (q) {
      // Full-text over text/subjects/objects, ranked by relevance.
      filter.$text = { $search: q }
      return memories()
        .find(filter, { projection: { score: { $meta: 'textScore' } } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(100)
        .toArray()
    }

    return memories().find(filter).sort({ importance: -1, updated_at: -1 }).toArray()
  },

  /**
   * Promise/Quest Tracker (Phase 10): the open and recently-resolved story
   * threads — the same `unresolved_thread` atoms that feed the open-threads
   * prompt section. Open threads rank by importance; resolved ones by when
   * they closed. Read-only.
   */
  async listThreads(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    // Main-story tracker: a private side-chat thread surfaces only if the
    // protagonist is among its knowers (same gate as the Recap preview).
    const mainVisibleMemory = await mainVisibleMemoryScope(iid)

    const [open, resolved] = await Promise.all([
      memories()
        .find({
          instance_id: iid,
          player_id: pid,
          unresolved_thread: true,
          is_archived: false,
          ...mainVisibleMemory,
        })
        .sort({ importance: -1, updated_at: -1 })
        .limit(50)
        .toArray(),
      memories()
        .find({
          instance_id: iid,
          player_id: pid,
          resolved_at: { $ne: null },
          is_archived: false,
          ...mainVisibleMemory,
        })
        .sort({ resolved_at: -1 })
        .limit(30)
        .toArray(),
    ])

    const shape = (m: (typeof open)[number]) => ({
      id: idString(m._id),
      text: m.text,
      type: m.type,
      importance: m.importance,
      emotional_valence: m.emotional_valence || null,
      resolved_at: m.resolved_at || null,
      time_anchor: m.time_anchor || null,
    })

    return { open: open.map(shape), resolved: resolved.map(shape) }
  },

  /**
   * Memory-aware recap (Phase 10): a "Story so far" card for re-entering a
   * world after time away. Deterministic — it reuses the latest scene summary
   * (already LLM prose) as the spine and layers the live open threads,
   * relationship standings, and current place/time on top. No new LLM call, so
   * it's free to open and always reflects the current projections.
   */
  async buildRecap(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const instance = await worldInstances().findOne({
      _id: iid,
      player_id: pid,
    })
    if (!instance) throw new Error('Instance not found')
    const mainVisibleMemory = await mainVisibleMemoryScope(iid)

    const [latestSummary, latestEvent, openThreads, bondCards] = await Promise.all([
      sceneSummaries().findOne(
        { instance_id: iid, status: { $ne: 'stale' } },
        { sort: { 'event_range.end_sequence': -1 } },
      ),
      // Main story only — a private side chat must never become the recap spine.
      events().findOne(
        { instance_id: iid, type: { $ne: 'side_chat' } },
        {
          sort: { sequence: -1 },
          projection: { 'data.ai_response': 1, sequence: 1 },
        },
      ),
      memories()
        .find({
          instance_id: iid,
          unresolved_thread: true,
          is_archived: false,
          ...mainVisibleMemory,
        })
        .sort({ importance: -1, updated_at: -1 })
        .limit(5)
        .toArray(),
      // Cast members with a tracked bond, most-recently-touched first.
      characters()
        .find({
          instance_id: iid,
          is_protagonist: { $ne: true },
          relationship: { $exists: true },
        })
        .sort({ updated_at: -1 })
        .limit(4)
        .toArray(),
    ])

    // Prose spine: the most recent scene summary, else a trimmed snippet of the
    // last thing that happened so a young playthrough still gets a recap.
    let spine: string | null = latestSummary?.summary_text || null
    const lastResponse = latestEvent?.data?.ai_response
    if (!spine && lastResponse) {
      const raw = lastResponse.trim()
      spine = raw.length > 400 ? `${raw.slice(0, 400).trimEnd()}…` : raw
    }

    const currentPlace = instance.current_location?.name || null
    const currentWhen =
      instance.current_time_anchor?.event_time_label || instance.current_time_anchor?.story_calendar?.label || null

    return {
      spine,
      recap_text: spine,
      where: currentPlace,
      current_place: currentPlace,
      when: currentWhen,
      open_threads: openThreads.map((m) => ({
        id: idString(m._id),
        text: m.text,
        importance: m.importance,
      })),
      bonds: bondCards.map((c) => ({
        id: idString(c._id),
        name: c.canonical_name,
        disposition: c.disposition_to_player || null,
        meters: c.relationship
          ? {
              trust: c.relationship.trust,
              affection: c.relationship.affection,
              fear: c.relationship.fear,
              rivalry: c.relationship.rivalry,
            }
          : null,
      })),
    }
  },

  async editMemory(memoryId: string, playerId: string, updates: any) {
    const mid = parseObjectId(memoryId)
    const pid = parseObjectId(playerId)

    const memory = await memories().findOne({
      _id: mid,
      player_id: pid,
    })
    if (!memory) throw new Error('Memory not found')

    const updateFields: Record<string, unknown> = { updated_at: new Date() }
    if (updates.text) updateFields.text = updates.text
    if (updates.type) updateFields.type = updates.type
    if (updates.importance !== undefined) updateFields.importance = updates.importance

    await memories().updateOne({ _id: mid }, { $set: updateFields })

    if (updates.text) {
      const newEmbedding = await embed(updates.text)
      const index = getPineconeIndex()
      const ns = idString(memory.instance_id)
      const namespace = index.namespace(`mem_${ns}`)

      const vectorMetadata: Record<string, string | number | boolean | string[]> = {
        text: updates.text,
        type: updates.type || memory.type,
        importance: updates.importance ?? memory.importance,
        is_nsfw: memory.is_nsfw,
        mongo_id: idString(mid),
        unresolved_thread: memory.unresolved_thread === true,
        created_at: memory.created_at.toISOString(),
      }
      if (memory.subjects && memory.subjects.length > 0) {
        vectorMetadata.subjects = memory.subjects
      }
      if (memory.pinecone_id) {
        await namespace.upsert({
          records: [
            {
              id: memory.pinecone_id,
              values: newEmbedding,
              metadata: vectorMetadata,
            },
          ],
        })
      } else {
        const newVecId = randomUUID()
        await namespace.upsert({
          records: [
            {
              id: newVecId,
              values: newEmbedding,
              metadata: vectorMetadata,
            },
          ],
        })
        await memories().updateOne(
          { _id: mid },
          {
            $set: {
              pinecone_id: newVecId,
              is_archived: false,
              status: 'active',
            },
          },
        )
      }
    }

    return { success: true }
  },

  async deleteMemory(memoryId: string, playerId: string) {
    const mid = parseObjectId(memoryId)
    const pid = parseObjectId(playerId)

    const memory = await memories().findOne({
      _id: mid,
      player_id: pid,
    })
    if (!memory) throw new Error('Memory not found')

    if (memory.pinecone_id) {
      const index = getPineconeIndex()
      const ns = idString(memory.instance_id)
      await index.namespace(`mem_${ns}`).deleteOne({ id: memory.pinecone_id })
    }

    await memories().deleteOne({ _id: mid })
    await worldInstances().updateOne({ _id: memory.instance_id }, { $inc: { 'meta.total_memories': -1 } })

    return { success: true }
  },

  /**
   * Rewind a playthrough to a chosen turn: removes the event at [sequence] and
   * every event after it, then rolls everything back to that point —
   *  - deletes memories sourced from the removed turns (+ their Pinecone vectors,
   *    so they can't resurface via RAG),
   *  - deletes scene summaries covering the removed range,
   *  - recomputes world_state / active_flags by replaying the surviving turns
   *    from the template defaults (stats are stored as deltas, not snapshots),
   *  - recomputes the current scene + meta counts,
   *  - busts the cached session so the next turn rebuilds from fresh state.
   */
  async rewindToSequence(instanceId: string, playerId: string, sequence: number) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)

    const instance = await worldInstances().findOne({
      _id: iid,
      player_id: pid,
    })
    if (!instance) throw new Error('Instance not found')

    const template = await worldTemplates().findOne({
      _id: instance.template_id,
    })
    if (!template) throw new Error('Template not found')

    // Events being removed: the chosen turn and everything after it.
    const doomed = await events()
      .find({ instance_id: iid, sequence: { $gte: sequence } }, { projection: { _id: 1 } })
      .toArray()
    const doomedIds = doomed.map((e) => e._id)

    // 1. Memories sourced from removed turns → delete docs + Pinecone vectors.
    let deletedMemories = 0
    if (doomedIds.length > 0) {
      const mems = await memories()
        .find({ instance_id: iid, source_event_ids: { $in: doomedIds } }, { projection: { _id: 1, pinecone_id: 1 } })
        .toArray()
      if (mems.length > 0) {
        const ns = getPineconeIndex().namespace(`mem_${instanceId}`)
        for (const m of mems) {
          if (!m.pinecone_id) continue
          try {
            await ns.deleteOne({ id: m.pinecone_id })
          } catch (err) {
            console.warn('Rewind: failed to delete vector', m.pinecone_id, (err as Error).message)
          }
        }
        await memories().deleteMany({ _id: { $in: mems.map((m) => m._id) } })
        deletedMemories = mems.length
        await pruneMemoryVersionLinks(
          iid,
          mems.map((m) => m._id),
        )
      }
    }
    // The removed turns can no longer be a supersession trigger — drop their
    // backward version-graph marks from any surviving (re-activated) atom.
    if (doomedIds.length > 0) {
      try {
        await memories().updateMany(
          { instance_id: iid, superseded_by_event_ids: { $in: doomedIds } },
          { $pull: { superseded_by_event_ids: { $in: doomedIds } } as never },
        )
      } catch (err) {
        console.warn('Rewind: superseded-by prune skipped:', (err as Error).message)
      }
    }

    // 2. Scene + chapter summaries covering the removed range, plus their
    //    Pinecone vectors (summary retrieval namespace).
    const doomedSummaries = await sceneSummaries()
      .find({ instance_id: iid, 'event_range.end_sequence': { $gte: sequence } }, { projection: { pinecone_id: 1 } })
      .toArray()
    const doomedChapters = await chapterSummaries()
      .find({ instance_id: iid, 'event_range.end_sequence': { $gte: sequence } }, { projection: { pinecone_id: 1 } })
      .toArray()
    const doomedArcs = await arcSummaries()
      .find({ instance_id: iid, 'event_range.end_sequence': { $gte: sequence } }, { projection: { pinecone_id: 1 } })
      .toArray()
    const summaryVecIds = [...doomedSummaries, ...doomedChapters, ...doomedArcs]
      .map((s) => s.pinecone_id)
      .filter((id): id is string => !!id)
    if (summaryVecIds.length > 0) {
      try {
        await getPineconeIndex()
          .namespace(`sum_${idString(iid)}`)
          .deleteMany({ ids: summaryVecIds })
      } catch (err) {
        console.warn('rewind: summary vector cleanup failed:', (err as Error).message)
      }
    }
    await sceneSummaries().deleteMany({
      instance_id: iid,
      'event_range.end_sequence': { $gte: sequence },
    })
    await chapterSummaries().deleteMany({
      instance_id: iid,
      'event_range.end_sequence': { $gte: sequence },
    })
    await arcSummaries().deleteMany({
      instance_id: iid,
      'event_range.end_sequence': { $gte: sequence },
    })

    // 3. The events themselves.
    await events().deleteMany({
      instance_id: iid,
      sequence: { $gte: sequence },
    })

    // 3b. Rebuild the character codex as an EXACT projection of the surviving
    // ledger. The per-turn codex deltas are stored on each event (like
    // state_mutations), so the codex is replayed deterministically from the
    // survivors — no LLM, and not one fact or relationship-meter value from a
    // removed turn can linger. The protagonist's authored/onboarded identity is
    // re-seeded first so replayed deltas attach to it; its evolved facts/state
    // then rebuild from the surviving deltas too.
    const priorProtagonist = await characters().findOne({
      instance_id: iid,
      is_protagonist: true,
    })
    const reseedProtagonist = async () => {
      const protoName = priorProtagonist?.canonical_name || template.protagonist?.name
      if (!protoName) return
      await characterCodexService.seedProtagonist({
        instanceId,
        playerId,
        name: protoName,
        persona: priorProtagonist?.persona ?? template.protagonist?.persona,
        appearance: priorProtagonist?.appearance ?? template.protagonist?.appearance,
        aliases: priorProtagonist?.aliases || [],
        isPlayer: !template.is_sentient,
      })
    }
    // Load the surviving events ONCE, projecting only the fields the two
    // replays need (state/flag/codex deltas + scene tag) — never the full prose
    // or replay variants. Reused for both the codex rebuild here and the
    // world-state replay in step 4, so a deep rewind doesn't pull the entire
    // (potentially huge) transcript into memory, let alone twice.
    const survivors = await events()
      .find(
        { instance_id: iid },
        {
          projection: {
            sequence: 1,
            scene_tag: 1,
            time_anchor: 1,
            location_anchor: 1,
            'data.state_mutations': 1,
            'data.flag_mutations': 1,
            'data.codex_deltas': 1,
          },
        },
      )
      .sort({ sequence: 1 })
      .toArray()
    const hasLedgeredDeltas = survivors.some((e) => Array.isArray(e.data?.codex_deltas))

    let usedCheckpointRebuild = false
    if (hasLedgeredDeltas) {
      try {
        const checkpointed = await rebuildCodexKinshipFromCheckpoint({
          instanceId,
          playerId,
          instance,
          template,
          beforeOrAtSequence: Math.max(0, sequence - 1),
        })
        usedCheckpointRebuild = checkpointed.used
      } catch (err) {
        console.warn('Rewind: checkpoint rebuild failed, falling back to full ledger:', (err as Error).message)
      }
    }

    if (hasLedgeredDeltas && !usedCheckpointRebuild) {
      // Exact rebuild: drop the whole codex, restore protagonist identity, then
      // replay the surviving turns' stored deltas. The replay folds entirely in
      // memory and persists with a single bulk write, so a rewind at turn
      // 13,567 costs the same as one at turn 13 — no per-turn DB round-trips.
      await characters().deleteMany({ instance_id: iid })
      await reseedProtagonist()
      await restoreInitialTemplateCast({ instanceId, playerId, instance, template })
      const batches = survivors
        .filter((ev) => Array.isArray(ev.data?.codex_deltas) && ev.data.codex_deltas.length > 0)
        .map((ev) => ({
          sequence: ev.sequence,
          deltas: ev.data!.codex_deltas!,
        }))
      await characterCodexService.rebuildCodexFromLedger({
        instanceId,
        playerId,
        batches,
      })
    } else {
      // Legacy worlds whose events predate ledgered deltas: there is nothing to
      // replay, so fall back to provenance pruning — keep the pre-rewind cast,
      // delete only characters first introduced in removed turns, clamp
      // survivors' last_seen. New play accrues deltas, so a later rewind of the
      // same world becomes exact.
      await characters().deleteMany({
        instance_id: iid,
        first_seen_sequence: { $gte: sequence },
      })
      await characters().updateMany(
        { instance_id: iid, last_seen_sequence: { $gte: sequence } },
        { $set: { last_seen_sequence: Math.max(0, sequence - 1) } },
      )
      const survivingProtagonist = await characters().findOne({
        instance_id: iid,
        is_protagonist: true,
      })
      if (!survivingProtagonist) await reseedProtagonist()
    }

    await characterCodexService.applyManualIdentityRevisions({ instanceId, playerId })

    // 3c. Entity-graph repair: entities born in removed turns are deleted,
    // edge provenance from removed events is pruned (empty edges dropped),
    // character entities re-link to the freshly re-minted codex cards, and
    // meter edges re-project from the rebuilt relationship ledger. Best-effort:
    // a graph hiccup must never abort the rewind itself.
    try {
      await entityGraphService.repairAfterRewind({
        instanceId,
        playerId,
        sequence,
        doomedEventIds: doomedIds,
        lastSurvivingEventId: survivors.length ? survivors[survivors.length - 1]._id : null,
      })
    } catch (err) {
      console.warn('Rewind: entity graph repair failed:', (err as Error).message)
    }
    // 3d. Kinship graph: when the codex was exactly rebuilt from the ledger, rebuild
    // the typed relationship edges from the same surviving ledger so authority and
    // sever/retcon order are reconstructed exactly (not just provenance-pruned).
    // Best-effort; a kinship hiccup must never abort the rewind.
    if (hasLedgeredDeltas && !usedCheckpointRebuild) {
      try {
        await kinshipGraphService.rebuildFromLedger({
          instanceId,
          playerId,
          isSentient: !!template.is_sentient,
          playerName: instance.persona_snapshot?.name,
        })
      } catch (err) {
        console.warn('Rewind: kinship graph rebuild failed:', (err as Error).message)
      }
    }
    try {
      await pruneDanglingMemoryEntityRefs(iid)
      await pruneDanglingMemoryVersionLinks(iid)
      await pruneAsymmetricMemoryUpdates(iid)
    } catch (err) {
      console.warn('Rewind: memory graph cleanup failed:', (err as Error).message)
    }

    // 4. Replay survivors from template defaults to rebuild state.
    const statLimits: Record<string, { min: number; max: number }> = {}
    let worldState: Record<string, number> = {}
    for (const [key, def] of Object.entries(template.base_stats_template)) {
      worldState[key] = def.default
      statLimits[key] = { min: def.min, max: def.max }
    }
    let activeFlags: Record<string, unknown> = {}
    for (const [key, def] of Object.entries(template.flag_definitions || {})) {
      activeFlags[key] = def.default
    }

    // FINDING 2: resume from the most recent projection checkpoint at/before the
    // last surviving turn and replay only the SUFFIX of survivor deltas, instead
    // of folding every surviving turn. Same final state; falls back to a full
    // survivor replay when no usable checkpoint exists. `survivors` itself is
    // still loaded in full above for the codex/kinship/graph rebuilds.
    const lastSurvivingSeq = survivors.length ? survivors[survivors.length - 1].sequence : 0
    const stateSnapshot =
      lastSurvivingSeq > 0
        ? await projectionCheckpointService.instanceStateBefore(instanceId, lastSurvivingSeq).catch(() => null)
        : null
    if (stateSnapshot) {
      worldState = { ...worldState, ...(stateSnapshot.world_state || {}) }
      activeFlags = { ...activeFlags, ...(stateSnapshot.active_flags || {}) }
    }
    const stateSuffix = stateSnapshot ? survivors.filter((ev) => ev.sequence > stateSnapshot.sequence) : survivors
    for (const ev of stateSuffix) {
      worldState = applyStateMutations(worldState, ev.data?.state_mutations || {}, statLimits)
      activeFlags = applyFlagMutations(activeFlags, ev.data?.flag_mutations || {})
    }

    // 5. Current scene from the tail of survivors.
    const last = survivors[survivors.length - 1]
    const sceneTag = last?.scene_tag || 'dialogue'
    let turnCount = 0
    for (let i = survivors.length - 1; i >= 0; i--) {
      if (survivors[i].scene_tag === sceneTag) turnCount++
      else break
    }
    const rewindTimeAnchor =
      last?.time_anchor ||
      (await timeService.initialAnchor({
        instanceId,
        templateId: idString(template._id),
        sequence: 0,
      }))
    const rewindLocation = last?.location_anchor || null

    // 6. Persist rolled-back instance state.
    await worldInstances().updateOne(
      { _id: iid },
      {
        $set: {
          world_state: worldState,
          active_flags: activeFlags,
          current_scene: {
            tag: sceneTag,
            turn_count: turnCount,
            summary_pending: false,
          },
          current_time_anchor: rewindTimeAnchor,
          active_timeline_id: rewindTimeAnchor.timeline_id,
          default_calendar_id: rewindTimeAnchor.story_calendar?.calendar_id,
          current_location: rewindLocation,
          focus_character_id: null,
          'meta.total_events': survivors.length,
          'meta.total_memories': Math.max(0, (instance.meta?.total_memories || 0) - deletedMemories),
          // Milestones earned in the removed turns no longer happened.
          'meta.milestones': (instance.meta?.milestones || []).filter((m) => m.sequence < sequence),
          // The fate-seed marker may point at a removed turn; clamp it below the
          // rewind point so fate seeding isn't blocked on surviving play.
          'meta.last_fate_seed_sequence': Math.min(
            instance.meta?.last_fate_seed_sequence || 0,
            Math.max(0, sequence - 1),
          ),
          updated_at: new Date(),
        },
      },
    )

    // 7. Drop the cached session so the next generation uses fresh state.
    await getRedisClient().del(`session:${instanceId}`)

    // Tell every connected client which projections this rewind invalidated so
    // they can refetch the affected surfaces (see SHARED CONTRACT v1 item 4).
    try {
      await getRedisClient().publish(
        `user:${playerId}:events`,
        JSON.stringify({
          type: 'world_projection_updated',
          instance_id: instanceId,
          scopes: ['bonds', 'threads', 'recap', 'places', 'calendar', 'codex', 'presence'],
          source: 'rewind',
        }),
      )
    } catch (err) {
      console.warn('Rewind: world_projection_updated publish failed:', (err as Error).message)
    }

    return { success: true, deletedEvents: doomedIds.length, deletedMemories }
  },

  async editEvent(eventId: string, playerId: string, updates: any) {
    const eid = parseObjectId(eventId)
    const pid = parseObjectId(playerId)

    if (typeof updates.ai_response === 'string' && updates.ai_response.trim().length === 0) {
      throw new HttpError(400, 'ai_response cannot be empty.')
    }
    if (typeof updates.player_input === 'string' && updates.player_input.trim().length === 0) {
      throw new HttpError(400, 'player_input cannot be empty.')
    }
    const hasAiResponse = typeof updates.ai_response === 'string'
    const hasPlayerInput = typeof updates.player_input === 'string'
    if (!hasAiResponse && !hasPlayerInput) {
      throw new HttpError(400, 'No editable event fields provided. Use ai_response and/or player_input.')
    }

    const event = await events().findOne({
      _id: eid,
      player_id: pid,
    })
    if (!event) throw new Error('Event not found')

    const nextAiResponse = updates.ai_response ?? event.data.ai_response
    const nextPlayerInput = updates.player_input ?? event.data.player_input
    const parsedPlayerInput = parsePlayerInput(nextPlayerInput || '')
    const aiChanged = typeof updates.ai_response === 'string' && updates.ai_response !== event.data.ai_response
    const playerChanged = typeof updates.player_input === 'string' && updates.player_input !== event.data.player_input
    const contentChanged = aiChanged || playerChanged
    if (!contentChanged) {
      throw new HttpError(400, 'Event edit did not change ai_response or player_input.')
    }
    const replayVariants = normalizeReplayVariants(event)
    const [editCharacterNames, editInstance] = await Promise.all([
      characterNamesForInstance(event.instance_id),
      worldInstances().findOne(
        { _id: event.instance_id, player_id: pid },
        {
          projection: {
            message_length: 1,
            narration_pov: 1,
            template_id: 1,
            world_state: 1,
            active_flags: 1,
            persona_snapshot: 1,
            current_location: 1,
          },
        },
      ),
    ])
    const editTemplate = editInstance
      ? await worldTemplates().findOne(
          { _id: editInstance.template_id },
          { projection: { is_sentient: 1, seed_prompt: 1, global_lore: 1 } },
        )
      : null
    const proseHygieneIssues = validateProseHygiene({
      narrative: nextAiResponse || '',
      characterNames: editCharacterNames,
      messageLength: editInstance?.message_length || 'medium',
      playerAddressMode: editTemplate?.is_sentient ? 'you' : editInstance?.narration_pov === 'first' ? 'self' : 'role',
      avoidOpeningNames: editCharacterNames,
    })
    let nextReplayVariants = replayVariants
    let nextSelectedReplayIndex =
      typeof event.data?.selected_replay_index === 'number'
        ? event.data.selected_replay_index
        : Math.max(0, replayVariants.length - 1)
    // A rewritten narrative invalidates the old chips + presence. Rather than
    // blank them, regenerate from the NEW prose (same extractor/anchor/roster as
    // a primary turn) and store them on the new 'edit' variant so it behaves like
    // any other variant. Only the AI text matters here; a player-only edit leaves
    // the prose — and its chips — unchanged.
    let editChoices: Awaited<ReturnType<typeof extractSceneMetadata>>['choices'] | null = null
    let editPresent: string[] | null = null
    let editTrackableMentions: ReturnType<typeof trackableMentionsForProse> | null = null

    if (aiChanged && typeof nextAiResponse === 'string' && nextAiResponse.trim()) {
      const editCodex = await characters()
        .find({ instance_id: event.instance_id })
        .sort({ mention_count: -1, updated_at: -1 })
        .limit(16)
        .toArray()
      const editProtagonistCard = (editCodex as any[]).find((c) => c.is_protagonist)
      const editProtagonist = editTemplate?.is_sentient
        ? editInstance?.persona_snapshot?.name
          ? { name: editInstance.persona_snapshot.name, aliases: [] }
          : null
        : editProtagonistCard
          ? {
              name: editProtagonistCard.canonical_name,
              aliases: editProtagonistCard.aliases || [],
            }
          : editInstance?.persona_snapshot?.name
            ? { name: editInstance.persona_snapshot.name, aliases: [] }
            : null
      const editRoster = (editCodex as any[])
        .filter((c) => c.canonical_name && (editTemplate?.is_sentient || !c.is_protagonist))
        .map((c) => ({
          name: c.canonical_name as string,
          aliases: (c.aliases || []) as string[],
        }))
      const editKnownNames = (editCodex as any[]).flatMap((card) => [
        card?.canonical_name,
        ...((card?.aliases as string[]) || []),
      ]).filter((name): name is string => typeof name === 'string' && !!name.trim())
      const editCandidates = entityAdjudicationCandidates({
        prose: nextAiResponse,
        knownNames: editKnownNames,
        exclude: [editProtagonist?.name || '', ...(editProtagonist?.aliases || [])],
      })
      const [editMeta, editEntityAdjudication] = await Promise.all([
        extractSceneMetadata(
          nextAiResponse,
          Object.keys(editInstance?.world_state || {}),
          Object.keys(editInstance?.active_flags || {}),
          {
            isSentient: !!editTemplate?.is_sentient,
            currentLocationName: (event as any).location_anchor?.name || editInstance?.current_location?.name || null,
            protagonist: editProtagonist,
            roster: editRoster,
            worldContext: [editTemplate?.seed_prompt, editTemplate?.global_lore].filter(Boolean).join('\n'),
          },
        ),
        adjudicateEntityCandidates({
          prose: nextAiResponse,
          candidates: editCandidates,
          knownCast: editKnownNames,
          knownPlaces: [],
          worldContext: [editTemplate?.seed_prompt, editTemplate?.global_lore].filter(Boolean).join('\n'),
        }),
      ])
      editMeta.present_characters = filterAdjudicatedPresence(
        editMeta.present_characters || [],
        editCandidates,
        editEntityAdjudication,
      )
      editChoices = editMeta.choices
      editPresent = editMeta.present_characters
      editTrackableMentions = trackableMentionsForProse({
        prose: nextAiResponse,
        present: editPresent,
        codex: editCodex,
        exclude: editInstance?.persona_snapshot?.name ? [editInstance.persona_snapshot.name] : [],
      })

      nextReplayVariants = [...replayVariants]
      if (nextReplayVariants[nextReplayVariants.length - 1]?.narrative !== nextAiResponse) {
        nextReplayVariants.push({
          id: randomUUID(),
          narrative: nextAiResponse,
          model_used: event.data?.model_used || AI_MODELS.narrationSfw,
          created_at: new Date(),
          source: 'edit',
          prose_hygiene_issues: proseHygieneIssues,
          choices: editChoices,
          present_characters: editPresent,
          trackable_mentions: editTrackableMentions || [],
        })
      }
      nextSelectedReplayIndex = nextReplayVariants.length - 1
    }

    await events().updateOne({ _id: eid }, {
      $push: {
        edit_history: {
          previous_data: event.data,
          edited_at: new Date(),
        },
      },
      $set: {
        'data.ai_response': nextAiResponse,
        'data.player_input': nextPlayerInput,
        'data.player_spoken_input': parsedPlayerInput.spoken,
        'data.player_narration_facts': parsedPlayerInput.narrationFacts,
        'data.replay_variants': nextReplayVariants,
        'data.selected_replay_index': nextSelectedReplayIndex,
        'data.prose_hygiene_issues': proseHygieneIssues,
        // Fresh chips + presence re-derived from the rewritten narrative.
        ...(aiChanged
          ? {
              'data.choices': editChoices || [],
              'data.present_characters': editPresent || [],
              'data.trackable_mentions': editTrackableMentions || [],
            }
          : {}),
        is_user_edited: true,
        updated_at: new Date(),
      },
    } as import('mongodb').UpdateFilter<import('../models/world-event.model').WorldEventDoc>)

    let deletedMemories = 0

    if (contentChanged) {
      deletedMemories = await recurateMemoriesForEvent(
        event,
        playerId,
        parsedPlayerInput.raw,
        parsedPlayerInput.spoken,
        parsedPlayerInput.narrationFacts,
        nextAiResponse || '',
      )
      await staleSummariesCoveringEvent(event)
    }

    // Notify clients which projections this edit invalidated (SHARED CONTRACT v1
    // item 4). An AI rewrite can move bonds/threads/codex/places/etc.; a
    // player-only edit only reshapes recap/threads.
    try {
      await getRedisClient().publish(
        `user:${playerId}:events`,
        JSON.stringify({
          type: 'world_projection_updated',
          instance_id: idString(event.instance_id),
          scopes: aiChanged
            ? ['bonds', 'threads', 'recap', 'places', 'calendar', 'codex', 'presence']
            : ['threads', 'recap'],
          source: 'edit',
        }),
      )
    } catch (err) {
      console.warn('editEvent: world_projection_updated publish failed:', (err as Error).message)
    }

    return {
      success: true,
      memories_deleted: deletedMemories,
      recuration_queued: contentChanged,
      // Fresh chips + presence when the narrative was rewritten, so the client
      // can swap stale ones without a refetch (null when the prose was untouched).
      choices: editChoices,
      present_characters: editPresent,
      trackable_mentions: editTrackableMentions,
    }
  },

  /**
   * Generate an alternative response for an event. When [onDelta] is supplied
   * the narration is streamed token-by-token through the callback (used by the
   * streaming worker path); otherwise it is generated in one shot (REST).
   */
  async replayEvent(eventId: string, playerId: string, onDelta?: (chunk: string) => void) {
    const eid = parseObjectId(eventId)
    const pid = parseObjectId(playerId)

    const event = await events().findOne({ _id: eid, player_id: pid })
    if (!event) throw new Error('Event not found')
    if (!(event.data?.ai_response || '').trim() || event.data?.model_used === 'seed') {
      throw new Error('Replay is only supported for generated AI turns')
    }

    // Keep state consistency simple: replay only the latest turn in a thread.
    const newerCount = await events().countDocuments({
      instance_id: event.instance_id,
      sequence: { $gt: event.sequence },
    })
    if (newerCount > 0) {
      throw new Error('Replay is only available for the latest turn. Rewind first for earlier turns.')
    }

    const instance = await worldInstances().findOne({
      _id: event.instance_id,
      player_id: pid,
    })
    if (!instance) throw new Error('Instance not found')
    const template = await worldTemplates().findOne({
      _id: instance.template_id,
    })
    if (!template) throw new Error('Template not found')

    const player = await users().findOne({ _id: pid }, { projection: { 'preferences.nsfw_enabled': 1 } })
    const userNsfwEnabled = player?.preferences?.nsfw_enabled === true

    const parsed = parsePlayerInput(event.data.player_input || '')
    const replayVariants = normalizeReplayVariants(event)
    const replayDepth = replayVariants.length // 1-based progression after base

    // Incremental retrieval widening per replay, bounded aggressively.
    const factor = Math.min(1 + replayDepth * 0.35, 2.5)
    const loreTopK = Math.min(
      Math.max(Math.round((template.max_lore_results || 10) * factor), template.max_lore_results || 10),
      40,
    )
    const memoryTopK = Math.min(
      Math.max(Math.round((template.max_context_memories || 25) * factor), template.max_context_memories || 25),
      80,
    )
    const recentWindow = Math.min(6 + replayDepth * 2, 20)

    const priorEvents = await events()
      .find({
        instance_id: event.instance_id,
        sequence: { $lt: event.sequence },
      })
      .sort({ sequence: -1 })
      .limit(recentWindow)
      .toArray()
    priorEvents.reverse()

    const activeSummary = await sceneSummaries().findOne(
      {
        instance_id: event.instance_id,
        'event_range.end_sequence': { $lt: priorEvents[0]?.sequence || 0 },
        status: { $ne: 'stale' },
      },
      { sort: { 'event_range.end_sequence': -1 } },
    )

    const codex = await characters()
      .find({ instance_id: event.instance_id })
      .sort({ mention_count: -1, updated_at: -1 })
      .limit(16)
      .toArray()
    const replayCodex: any[] = [...(codex as any[])]
    if (
      template.is_sentient &&
      template.protagonist?.name &&
      !replayCodex.some((c) => c.is_protagonist || c.canonical_name === template.protagonist?.name)
    ) {
      replayCodex.unshift({
        canonical_name: template.protagonist.name,
        persona: template.protagonist.persona,
        appearance: template.protagonist.appearance,
        immutable_facts: [],
        mutable_state: [],
        mention_count: 0,
        last_seen_sequence: event.sequence,
        is_protagonist: true,
      })
    }

    const ragQuery = parsed.raw || event.data.ai_response || template.seed_prompt
    const rag = await queryRag(idString(template._id), idString(event.instance_id), ragQuery, loreTopK, memoryTopK)

    const mode = instance.mode || DEFAULT_CHAT_MODE
    const modeWantsNsfw = mode === NSFW_MODE
    const sceneClass =
      template.is_nsfw_capable && userNsfwEnabled
        ? modeWantsNsfw
          ? 'nsfw'
          : classifyScene(parsed.raw, priorEvents)
        : 'sfw'
    const modelId =
      sceneClass === 'nsfw'
        ? template.model_preferences?.narration_nsfw || AI_MODELS.narrationNsfw
        : template.model_preferences?.narration_sfw || AI_MODELS.narrationSfw

    const prompt = buildPrompt({
      seedPrompt: template.seed_prompt,
      isSentient: template.is_sentient,
      worldState: instance.world_state,
      activeFlags: instance.active_flags,
      globalLore: template.global_lore,
      retrievedLore: rag.loreTexts,
      retrievedMemories: rag.memoryTexts,
      openThreads: rag.openThreads,
      sceneSummary: activeSummary?.summary_text || null,
      recentEvents: priorEvents,
      userMessage: parsed.spoken || '[No spoken dialogue from player this turn.]',
      userSpokenInput: parsed.spoken,
      userNarrationFacts: parsed.narrationFacts,
      maxTokens: 7000,
      proseOnly: true,
      narrationPov: instance.narration_pov || 'third',
      chatMode: mode,
      narrativeStyle: template.narrative_style || '',
      narrationTone: instance.narration_tone,
      toneExampleSeed: idString(instance._id),
      styleNotes: template.style_notes || '',
      playerPersona: instance.persona_snapshot || null,
      messageLength: instance.message_length || 'medium',
      characterCodex: replayCodex,
      focusCharacterName: (() => {
        const fid = instance.focus_character_id ? idString(instance.focus_character_id) : ''
        const c = replayCodex.find((x) => x._id && idString(x._id) === fid)
        return c?.canonical_name
      })(),
    })

    const replayDirective = replayVariants
      .slice(-3)
      .map(
        (v, i) =>
          `Variant ${replayVariants.length - Math.min(3, replayVariants.length) + i + 1}: ${continuityText(v.narrative || '')}`,
      )
      .join('\n')

    // The replay directive MUST sit BEFORE the final user turn. If appended
    // after it, the model often "answers" the directive — emitting the raw
    // REQUIREMENTS/bullet text instead of narrating. Splicing it in just before
    // the user message keeps the user turn last, so the model replies in-story.
    const baseMessages = prompt.messages
    const lastUserTurn = baseMessages[baseMessages.length - 1]
    const head = baseMessages.slice(0, -1)
    const replayMessages = [
      ...head,
      {
        role: 'system',
        content: `REPLAY OPTIMIZATION DIRECTIVE (instruction — do NOT repeat or quote this; respond only with in-character story prose):
- Produce a DISTINCT alternative response to the same turn.
- Improve precision, characterization, and continuity.
- Keep canonical narration facts true.
- Keep within context constraints (do not invent off-screen lore).
- If prior variants were weak, correct that.

REPLAY HYGIENE:
- This is an alternative handling of the SAME story beat, not a new timeline branch.
- Keep the same player intent, scene scope, involved characters, and canonical facts.
- Do not introduce new named characters, locations, lore, danger, romance, or escalation merely to be distinct.
- Distinct means better characterization, clearer prose, sharper continuity, cleaner formatting, or better pacing.
- If prior variants had hygiene issues, fix them; do not imitate their wording, structure, or mistakes.
- Do not line-edit, paraphrase, or lightly expand the immediately previous variant. Recompose the beat from the player turn and continuity facts.
- Preserve the player's *action/narration* facts as already happened in this same beat; never respond as if those actions are only pending.
- Natural conversation flow is mandatory: do not open with a character name, do not repeat protagonist or side-character names unless clarity requires it, and avoid full canonical names in ordinary narration.

Recent variants (for contrast, do not copy):
${replayDirective || '(none)'}`,
      },
      lastUserTurn,
    ]
    const replayTemp = Math.max(0.4, narrationTemperature(modelId) - replayDepth * 0.04)
    // Match the alternative's length budget to the player's chosen reply length,
    // exactly like the primary turn — so a regenerate respects short/medium/long
    // instead of always running to a fixed 900-token ceiling.
    const replayMaxTokens = lengthMaxTokens(instance.message_length || 'medium')
    const replayNarrative = onDelta
      ? await callLLMStream(
          {
            model: modelId,
            messages: replayMessages,
            temperature: replayTemp,
            maxTokens: replayMaxTokens,
            sessionId: idString(instance._id),
          },
          onDelta,
        )
      : await callLLM({
          model: modelId,
          messages: replayMessages,
          temperature: replayTemp,
          maxTokens: replayMaxTokens,
          sessionId: idString(instance._id),
        })
    const repairedReplay = await repairProseHygiene({
      narrative: replayNarrative.trim(),
      characterNames: replayCodex.map((c) => c.canonical_name),
      messageLength: instance.message_length || 'medium',
      playerAddressMode: template.is_sentient
          ? 'you'
          : (instance.narration_pov || 'third') === 'first'
          ? 'self'
          : 'role',
      previousOpeningNames: (() => {
        const previousOpeningName = openingCharacterName(
          priorEvents,
          replayCodex.map((c) => c.canonical_name),
        )
        return previousOpeningName ? [previousOpeningName] : []
      })(),
      avoidOpeningNames: replayCodex.map((c) => c.canonical_name),
      // Replay repair follows the same reliable formatting path as live turns.
      model: AI_MODELS.metadata,
    })

    // A replay must never overwrite the selected version with the same prose.
    // The model may vary only Markdown markers while returning an otherwise
    // identical completion; normalize those cosmetic differences before the
    // comparison.  The client restores the original event on this error, so an
    // unhelpful duplicate cannot become canonical or pollute rewind history.
    if (duplicatesExistingReplay(repairedReplay.narrative, replayVariants)) {
      throw new HttpError(
        422,
        'That replay matched the existing response. Nothing was changed; please try Replay again.',
      )
    }

    // Regenerate the turn projections FROM THE NEW VARIANT. Replay is limited to
    // the latest turn, so we can safely recompute the instance's current state
    // from prior event deltas + this replay's extracted mutations/location.
    const replayProjection = await projectLatestReplayTurn({
      event,
      playerId,
      instance,
      template,
      narrative: repairedReplay.narrative,
      codex: replayCodex,
    })
    const replayMeta = replayProjection.meta
    const replayCodexDeltas = await extractReplayCodexDeltas({
      event,
      playerId,
      instance,
      template,
      narrative: repairedReplay.narrative,
      presentCharacters: replayMeta.present_characters,
    })
    const replayTrackableMentions = trackableMentionsForProse({
      prose: repairedReplay.narrative,
      present: replayMeta.present_characters,
      codex: replayCodex,
      exclude: instance.persona_snapshot?.name ? [instance.persona_snapshot.name] : [],
    })
    const hadLedgeredCodexDeltas = Array.isArray(event.data?.codex_deltas)

    const nextVariant = {
      id: randomUUID(),
      narrative: repairedReplay.narrative,
      model_used: modelId,
      created_at: new Date(),
      source: 'replay',
      prose_hygiene_issues: repairedReplay.issues,
      choices: replayMeta.choices,
      present_characters: replayMeta.present_characters,
      trackable_mentions: replayTrackableMentions,
      state_mutations: replayMeta.state_mutations,
      flag_mutations: replayMeta.flag_mutations,
      scene_tag: replayMeta.scene_tag,
      retrieval_profile: {
        lore_top_k: loreTopK,
        memory_top_k: memoryTopK,
        recent_event_window: recentWindow,
      },
    }
    const nextVariants = [...replayVariants, nextVariant]
    const selectedIdx = nextVariants.length - 1

    await events().updateOne({ _id: eid }, {
      $push: {
        edit_history: {
          previous_data: event.data,
          edited_at: new Date(),
        },
      },
      $set: {
        'data.ai_response': nextVariant.narrative,
        'data.model_used': modelId,
        'data.replay_variants': nextVariants,
        'data.selected_replay_index': selectedIdx,
        'data.prose_hygiene_issues': repairedReplay.issues,
        // Fresh projections, re-derived from the NEW variant (the prior ones
        // reflected the replaced prose).
        'data.choices': replayMeta.choices,
        'data.present_characters': replayMeta.present_characters,
        'data.trackable_mentions': replayTrackableMentions,
        'data.state_mutations': replayMeta.state_mutations,
        'data.flag_mutations': replayMeta.flag_mutations,
        'data.codex_deltas': replayCodexDeltas,
        scene_tag: replayMeta.scene_tag,
        location_anchor: replayProjection.locationAnchor,
        updated_at: new Date(),
      },
    } as import('mongodb').UpdateFilter<import('../models/world-event.model').WorldEventDoc>)

    await worldInstances().updateOne(
      { _id: event.instance_id, player_id: pid },
      {
        $set: {
          world_state: replayProjection.worldState,
          active_flags: replayProjection.activeFlags,
          current_scene: replayProjection.currentScene,
          current_location: replayProjection.locationAnchor,
          updated_at: new Date(),
        },
      },
    )
    await getRedisClient().del(`session:${idString(event.instance_id)}`)

    const deletedMemories = await recurateMemoriesForEvent(
      event,
      playerId,
      parsed.raw,
      parsed.spoken,
      parsed.narrationFacts,
      nextVariant.narrative,
    )
    await staleSummariesCoveringEvent(event)
    await rebuildCodexAndRelationsAfterReplay({
      event,
      playerId,
      instance,
      template,
      narrative: nextVariant.narrative,
      deltas: replayCodexDeltas,
      forceExactRebuild: hadLedgeredCodexDeltas,
    }).catch((err) => {
      console.warn('Replay projection: codex/kinship rebuild skipped:', (err as Error).message)
    })

    const updated = await events().findOne({ _id: eid })
    // Post-replay instance projection for the replay_complete frame (SHARED
    // CONTRACT v1 item 3) so the client can update the Play instance directly.
    // current_time_anchor is unchanged by replay, so read it from the instance.
    const instance_state = {
      world_state: replayProjection.worldState,
      active_flags: replayProjection.activeFlags,
      current_scene: replayProjection.currentScene,
      current_location: replayProjection.locationAnchor,
      current_time_anchor: (instance as any).current_time_anchor ?? null,
    }
    return {
      success: true,
      event: updated,
      replay_count: nextVariants.length,
      selected_index: selectedIdx,
      memories_deleted: deletedMemories,
      instance_state,
    }
  },

  async selectReplayVariant(eventId: string, playerId: string, variantIndex: number) {
    const eid = parseObjectId(eventId)
    const pid = parseObjectId(playerId)
    const event = await events().findOne({ _id: eid, player_id: pid })
    if (!event) throw new Error('Event not found')

    const variants = normalizeReplayVariants(event)
    if (variantIndex < 0 || variantIndex >= variants.length) {
      throw new Error('Invalid replay variant index')
    }

    const newerCount = await events().countDocuments({
      instance_id: event.instance_id,
      sequence: { $gt: event.sequence },
    })
    if (newerCount > 0) {
      throw new Error('Replay variant selection is only available for the latest turn. Rewind first for earlier turns.')
    }

    const chosen = variants[variantIndex]
    const nextAi = chosen.narrative || event.data.ai_response || ''
    const changed = nextAi !== event.data.ai_response
    const [selectedCharacterNames, selectedInstance, selectedCodex] = await Promise.all([
      characterNamesForInstance(event.instance_id),
      worldInstances().findOne(
        { _id: event.instance_id, player_id: pid },
        {
          projection: {
            message_length: 1,
            narration_pov: 1,
            template_id: 1,
            world_state: 1,
            active_flags: 1,
            persona_snapshot: 1,
            current_location: 1,
            focus_character_id: 1,
          },
        },
      ),
      characters()
        .find({ instance_id: event.instance_id })
        .sort({ mention_count: -1, updated_at: -1 })
        .limit(16)
        .toArray(),
    ])
    const selectedTemplate = selectedInstance
      ? await worldTemplates().findOne(
          { _id: selectedInstance.template_id },
          {
            projection: {
              is_sentient: 1,
              seed_prompt: 1,
              global_lore: 1,
              base_stats_template: 1,
              flag_definitions: 1,
            },
          },
        )
      : null
    const proseHygieneIssues = Array.isArray(chosen.prose_hygiene_issues)
      ? chosen.prose_hygiene_issues
      : validateProseHygiene({
          narrative: nextAi,
          characterNames: selectedCharacterNames,
          messageLength: selectedInstance?.message_length || 'medium',
          playerAddressMode: selectedTemplate?.is_sentient
            ? 'you'
            : selectedInstance?.narration_pov === 'first'
              ? 'self'
              : 'role',
          avoidOpeningNames: selectedCharacterNames,
        })

    const selectedProjection =
      changed && selectedInstance && selectedTemplate
        ? await projectLatestReplayTurn({
            event,
            playerId,
            instance: selectedInstance,
            template: selectedTemplate,
            narrative: nextAi,
            codex: selectedCodex as any[],
          })
        : null
    const selectedCodexDeltas =
      changed && selectedProjection && selectedInstance && selectedTemplate
        ? await extractReplayCodexDeltas({
            event,
            playerId,
            instance: selectedInstance,
            template: selectedTemplate,
            narrative: nextAi,
            presentCharacters: selectedProjection.meta.present_characters,
          })
        : null
    const selectedTrackableMentions =
      changed && selectedProjection && selectedInstance
        ? trackableMentionsForProse({
            prose: nextAi,
            present: selectedProjection.meta.present_characters,
            codex: selectedCodex,
            exclude: selectedInstance.persona_snapshot?.name ? [selectedInstance.persona_snapshot.name] : [],
        })
        : null
    const hadLedgeredCodexDeltas = Array.isArray(event.data?.codex_deltas)

    // Choices/presence are part of a replay variant's player-facing snapshot.
    // Do not overwrite a stored variant's chips merely because choosing it also
    // reprojects state: a second metadata extraction is nondeterministic and
    // made the base variant display a different menu from the one it saved.
    // Only legacy variants with no saved snapshot fall back to re-extraction.
    const selectedChoices = Array.isArray(chosen.choices) && chosen.choices.length > 0
      ? chosen.choices
      : selectedProjection?.meta.choices ?? []
    const selectedPresentCharacters = Array.isArray(chosen.present_characters)
      ? chosen.present_characters
      : selectedProjection?.meta.present_characters ?? []

    const nextVariants = [...variants]
    if (selectedProjection) {
      nextVariants[variantIndex] = {
        ...chosen,
        prose_hygiene_issues: proseHygieneIssues,
        choices: selectedChoices,
        present_characters: selectedPresentCharacters,
        trackable_mentions: selectedTrackableMentions ?? chosen.trackable_mentions ?? [],
        state_mutations: selectedProjection.meta.state_mutations,
        flag_mutations: selectedProjection.meta.flag_mutations,
        scene_tag: selectedProjection.meta.scene_tag,
      }
    }

    await events().updateOne({ _id: eid }, {
      $push: {
        edit_history: {
          previous_data: event.data,
          edited_at: new Date(),
        },
      },
      $set: {
        'data.ai_response': nextAi,
        'data.model_used': chosen.model_used || event.data.model_used,
        'data.replay_variants': nextVariants,
        'data.selected_replay_index': variantIndex,
        'data.prose_hygiene_issues': proseHygieneIssues,
        // Restore the chosen variant's projections. If this selection changes
        // canonical prose, re-extract so older variants that predate projection
        // fields cannot leave stale chips/presence/state behind.
        'data.choices': selectedChoices,
        'data.present_characters': selectedPresentCharacters,
        ...(selectedTrackableMentions ? { 'data.trackable_mentions': selectedTrackableMentions } : {}),
        ...(selectedCodexDeltas ? { 'data.codex_deltas': selectedCodexDeltas } : {}),
        ...(selectedProjection
          ? {
              'data.state_mutations': selectedProjection.meta.state_mutations,
              'data.flag_mutations': selectedProjection.meta.flag_mutations,
              scene_tag: selectedProjection.meta.scene_tag,
              location_anchor: selectedProjection.locationAnchor,
            }
          : {}),
        updated_at: new Date(),
      },
    } as import('mongodb').UpdateFilter<import('../models/world-event.model').WorldEventDoc>)

    if (selectedProjection) {
      await worldInstances().updateOne(
        { _id: event.instance_id, player_id: pid },
        {
          $set: {
            world_state: selectedProjection.worldState,
            active_flags: selectedProjection.activeFlags,
            current_scene: selectedProjection.currentScene,
            current_location: selectedProjection.locationAnchor,
            updated_at: new Date(),
          },
        },
      )
      await getRedisClient().del(`session:${idString(event.instance_id)}`)
    }

    let deletedMemories = 0
    if (changed) {
      const parsed = parsePlayerInput(event.data.player_input || '')
      deletedMemories = await recurateMemoriesForEvent(
        event,
        playerId,
        parsed.raw,
        parsed.spoken,
        parsed.narrationFacts,
        nextAi,
      )
      await staleSummariesCoveringEvent(event)
      if (selectedProjection && selectedInstance && selectedTemplate && selectedCodexDeltas) {
        await rebuildCodexAndRelationsAfterReplay({
          event,
          playerId,
          instance: selectedInstance,
          template: selectedTemplate,
          narrative: nextAi,
          deltas: selectedCodexDeltas,
          forceExactRebuild: hadLedgeredCodexDeltas,
        }).catch((err) => {
          console.warn('Replay selection: codex/kinship rebuild skipped:', (err as Error).message)
        })
      }
    }

    if (changed) {
      // Selecting a different variant re-projects the turn — same surfaces an
      // edit touches (SHARED CONTRACT v1 item 4).
      try {
        await getRedisClient().publish(
          `user:${playerId}:events`,
          JSON.stringify({
            type: 'world_projection_updated',
            instance_id: idString(event.instance_id),
            scopes: ['bonds', 'threads', 'recap', 'places', 'calendar', 'codex', 'presence'],
            source: 'edit',
          }),
        )
      } catch (err) {
        console.warn('selectReplayVariant: world_projection_updated publish failed:', (err as Error).message)
      }
    }

    const updated = await events().findOne({ _id: eid })
    return {
      success: true,
      event: updated,
      replay_count: nextVariants.length,
      selected_index: variantIndex,
      memories_deleted: deletedMemories,
    }
  },
}
