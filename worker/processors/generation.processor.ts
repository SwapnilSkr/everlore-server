import { ObjectId } from 'mongodb'
import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { getRedisClient } from '../../src/config/redis'
import { callLLMStreamWithFallback, AI_MODELS, narrationTemperature, runWithLLMUsage, isLLMUsageActive, snapshotLLMUsage } from '../../src/ai'
import { buildContextPacket } from '../../src/services/context-packet.service'
import { buildPrompt } from '../../src/utils/prompt-builder'
import { lengthMaxTokens } from '../../src/utils/narrative-styles'
import { NSFW_MODE } from '../../src/utils/chat-modes'
import { parsePlayerInput } from '../../src/utils/player-input-parser'
import { extractKinshipAssertions, mergeRelationAssertions } from '../lib/kinship-pattern-extractor'
import { extractLifecycleTransitions } from '../lib/kinship-transition-extractor'
import { applyStateMutations, applyFlagMutations } from '../../src/utils/state-mutator'
import { countTokens } from '../../src/utils/token-counter'
import { normalizeNarrationMarkers, validateProseHygiene } from '../../src/utils/prose-hygiene'
import { idString, parseObjectId } from '../../src/utils/mongo-id'
import { generationLockKey, releaseGenerationLock } from '../../src/utils/generation-lock'
import { scoreScene, classifyBorderlineIntent } from '../lib/nsfw-classifier'
import { type GenerationOutput, sanitizeChoices } from '../lib/structured-output'
import { makeChoiceTailFilter } from '../lib/choice-tail'
import { makeProseStreamFilter } from '../lib/prose-stream-filter'
import { extractSceneMetadata, statDescriptors } from '../lib/metadata-extractor'
import { extractCharacterCodexDeltas, looksLikeUnnamedLabel } from '../lib/character-codex-extractor'
import { compactImmutableFacts } from '../lib/codex-compactor'
import { classifyPresenceCodexGaps, isActionableMention, hasSceneParticipationGrammar } from '../lib/presence-gap-detector'
import {
  adjudicateEntityCandidates,
  adjudicatedPersonKeys,
  entityAdjudicationCandidates,
  filterAdjudicatedPresence,
} from '../lib/entity-adjudicator'
import {
  adjudicateSceneEndpoint,
  mergePresenceCandidates,
  citationAdmitsToPresent,
  showsParticipationInPassage,
} from '../lib/scene-endpoint-adjudicator'
import { characterCodexService, type RelationAssertion } from '../../src/services/character-codex.service'
import { kinshipGraphService } from '../../src/services/kinship-graph.service'
import { entityGraphService, normalizeEntityName } from '../../src/services/entity-graph.service'
import { locationService } from '../../src/services/location.service'
import {
  extractExplicitPhysicalDestination,
  isExplicitSceneExit,
  isExplicitPlayerSceneTransition,
  hasGroundedWitnessLocationEvidence,
  isSafeWitnessLocationCandidate,
  validatedContainmentHint,
  detectNarratedMovement,
  locationNamesCompatible,
} from '../lib/movement-signal'
import {
  evaluateLocationCitation,
  citationAdmitsLocation,
  passageSituatesViewpoint,
  extractStatedPosition,
} from '../lib/location-citation'
import { evaluateTimeCitation, citationAdmitsTimeSkip } from '../lib/time-citation'
import { decidePartyDecay, type DriftState } from '../lib/cursor-drift'
import { decideLocation } from '../lib/location-decision'
import { decidePlacePromotion, classifyPlaceRelation } from '../lib/place-promotion'
import { auditChoices } from '../lib/choice-grounding-audit'
import { classifyChoiceGrounding, computeGroundingContext } from '../lib/choice-grounding'
import { detectProjectionAnomalies } from '../lib/projection-anomaly-detector'
import { buildSignalLedger } from '../lib/signal-ledger'
import { detectNarratedTimeSkip } from '../lib/time-skip-signal'
import { detectCompanionJoins, detectCompanionDepartures, detectSoloTravel } from '../lib/party-signal'
import { type WorldFactSource, SOURCE_RANK, confidenceFor, isWorldFactSource } from '../../src/utils/world-authority'
import { memorySupersessionService } from '../../src/services/memory-supersession.service'
import { relationCandidateService } from '../../src/services/relation-candidate.service'
import { timeService } from '../../src/services/time.service'
import { replayProcessor } from './replay.processor'
import { log } from '../../src/utils/logger'
import { recordAnomaly } from '../../src/utils/record-anomaly'
import { projectCharacterEvent } from './character-projection.processor'
import { deriveNextSceneState, renderSceneStateForPrompt, PRESENCE_TITLE_WORDS, sceneIdentityKey } from '../../src/services/scene-state.service'
import type { PlayerWorldAction } from '../../src/utils/world-action'
import { surfaceToKind } from '../../src/utils/kinship-ontology'
import { detectNarratedRelationCandidates } from '../lib/relation-candidate-detector'
import { detectCanonRevisionCandidates } from '../lib/canon-revision-detector'
import { dispatchPostProcessOutbox, stagePostProcess } from '../../src/services/post-process-outbox.service'
import {
  activeCastInteractionCandidates,
  extractPlayerInteractionSignals,
} from '../lib/player-interaction-signal'
import type { PlayerInteractionSignalDoc } from '../../src/models/world-event.model'
import { extractCharacterDeaths } from '../lib/character-lifecycle-extractor'
import { createExtractorRawSink } from '../lib/extractor-raw'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Identity key for the explicit journey UI. Match the presence projection's
 * common article variants without allowing a full codex lookup to summon an
 * absent person into the scene. */
function travelPresenceKey(value: string): string {
  return normalizeEntityName(String(value || ''))
    .replace(/^(?:the|a|an)\s+/, '')
    .trim()
}

function openingCharacterName(events: any[], names: string[]): string | null {
  const last = [...(events || [])].reverse().find((event) => String(event.data?.ai_response || '').trim())
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

/**
 * Remove only an unfinished trailing fragment from a provider response.
 *
 * A max-token stop often leaves several complete sentences before its final
 * clause. Keeping that complete beat is strictly safer than asking the player
 * to wait through another full generation, and it cannot introduce new story
 * facts. We only accept a prefix whose narration markers and dialogue quotes
 * remain balanced; otherwise the normal retry path handles the rare malformed
 * response.
 */
function completeNarrativePrefix(narrative: string): string | null {
  const normalized = normalizeNarrationMarkers(narrative).trim()
  const endings: number[] = []
  const terminal = /[.!?…](?=(?:["*]|\s|$))/g
  for (let match = terminal.exec(normalized); match; match = terminal.exec(normalized)) {
    endings.push(match.index)
  }

  for (let i = endings.length - 1; i >= 0; i--) {
    let end = endings[i] + 1
    // Include a closing dialogue quote and/or narration marker immediately
    // following the terminal punctuation before testing the candidate.
    while (end < normalized.length && /["*]/.test(normalized[end])) end++
    const candidate = normalized.slice(0, end).trim()
    if (!candidate) continue
    const italicsBalanced = (candidate.match(/\*/g) || []).length % 2 === 0
    const quotesBalanced = (candidate.match(/"/g) || []).length % 2 === 0
    if (italicsBalanced && quotesBalanced) return candidate
  }
  return null
}

const CHOICE_CONTEXT_TOKEN_LIMIT = 3_200

/**
 * Build the small, fact-only packet the structured choice model needs to make
 * the same grounded decisions as the narrator. It deliberately excludes the
 * narrator's large static instruction prefix and all raw historical prose, so
 * this second request cannot bloat toward the narration context window or turn
 * earlier dialogue into a copyable completion example.
 */
function buildChoiceDecisionContext(input: {
  isSentient: boolean
  playerName?: string | null
  playerInput: string
  locationContext?: string | null
  timeContext?: string | null
  worldState: Record<string, unknown>
  activeFlags: Record<string, unknown>
  characterCodex: any[]
  loreTexts: string[]
  memoryTexts: string[]
  openThreads: string[]
  sceneSummary?: string | null
  relevantSummaries: string[]
  relationshipFacts: string[]
  positionFacts: string[]
  /** Who is physically in the room. Choices that reference an absent character
   *  are exactly what the grounding guard has to drop after the fact; giving
   *  the choice pass the real roster prevents most of them being minted. */
  sceneStateText?: string
  companionFacts: string[]
  recentEvents: any[]
}): string {
  const sections: string[] = []
  const playerLabel = input.isSentient
    ? `The player is ${input.playerName || 'a separate person interacting with the cast'}.`
    : `The player is the GM-world protagonist${input.playerName ? `, ${input.playerName}` : ''}.`
  sections.push(`WORLD MODE\n${playerLabel}\nCurrent player turn: ${input.playerInput.slice(0, 900) || '(continue)'}`)
  const onlyOpening = input.recentEvents.length === 1 && input.recentEvents[0]?.data?.model_used === 'seed'
    ? String(input.recentEvents[0]?.data?.ai_response || '').trim()
    : ''
  if (onlyOpening) {
    sections.push(`AUTHORED OPENING SCENE\n${onlyOpening.slice(0, 1_800)}`)
  }
  if (input.sceneStateText) sections.push(`SCENE STATE (who is physically here)\n${input.sceneStateText.slice(0, 700)}`)
  if (input.locationContext) sections.push(`CURRENT PLACE\n${input.locationContext.slice(0, 700)}`)
  if (input.timeContext) sections.push(`STORY TIME\n${input.timeContext.slice(0, 360)}`)
  if (Object.keys(input.worldState || {}).length || Object.keys(input.activeFlags || {}).length) {
    sections.push(`CURRENT STATE\nStats: ${JSON.stringify(input.worldState || {}).slice(0, 700)}\nFlags: ${JSON.stringify(input.activeFlags || {}).slice(0, 500)}`)
  }

  // Most recent semantic continuity is highly relevant to a player's next
  // move, so reserve it before the larger cast/retrieval sections consume the
  // bounded packet.
  const recent = input.recentEvents.slice(-4).map((event) => {
    const ledger = event?.data?.beat_ledger
    const facts = [
      ...(Array.isArray(ledger?.npc_beats) ? ledger.npc_beats.map((beat: any) => `${beat.character}: ${beat.intent}`).filter(Boolean) : []),
      ledger?.consequence ? `Consequence: ${ledger.consequence}` : '',
      ledger?.unresolved_hook ? `Open pressure: ${ledger.unresolved_hook}` : '',
    ].filter(Boolean)
    return facts.length ? `- Turn ${event?.sequence || '?'}: ${facts.join('; ')}` : ''
  }).filter(Boolean)
  if (recent.length) sections.push(`RECENT SEMANTIC CONTINUITY\n${recent.join('\n')}`)

  const cast = (input.characterCodex || []).slice(0, 16).map((card) => {
    const name = String(card?.canonical_name || '').trim()
    if (!name) return ''
    const details = [
      card.role,
      card.persona,
      Array.isArray(card.immutable_facts) ? card.immutable_facts.slice(0, 2).join('; ') : '',
      Array.isArray(card.mutable_state) ? card.mutable_state.slice(0, 2).join('; ') : '',
      card.disposition_to_player ? `Disposition: ${card.disposition_to_player}` : '',
      card.relationship_state?.summary ? `Bond: ${card.relationship_state.summary}` : '',
    ].filter(Boolean).join(' — ')
    return `- ${name}${details ? `: ${String(details).slice(0, 420)}` : ''}`
  }).filter(Boolean)
  if (cast.length) sections.push(`ACTIVE CAST & CHARACTER FACTS\n${cast.join('\n')}`)

  const canon = [
    ...input.relationshipFacts.slice(0, 10),
    ...input.positionFacts.slice(0, 8),
    ...input.companionFacts.slice(0, 6),
  ].filter(Boolean)
  if (canon.length) sections.push(`CANON BRIEF\n${canon.map((fact) => `- ${String(fact).slice(0, 260)}`).join('\n')}`)
  if (input.sceneSummary) sections.push(`SCENE SUMMARY\n${input.sceneSummary.slice(0, 650)}`)
  if (input.openThreads.length) sections.push(`OPEN THREADS\n${input.openThreads.slice(0, 5).map((item) => `- ${String(item).slice(0, 260)}`).join('\n')}`)
  if (input.relevantSummaries.length) sections.push(`RELEVANT PAST CHAPTERS\n${input.relevantSummaries.slice(0, 3).map((item) => `- ${String(item).slice(0, 360)}`).join('\n')}`)
  if (input.loreTexts.length) sections.push(`RETRIEVED LORE\n${input.loreTexts.slice(0, 4).map((item) => `- ${String(item).slice(0, 420)}`).join('\n')}`)
  if (input.memoryTexts.length) sections.push(`RETRIEVED MEMORIES\n${input.memoryTexts.slice(0, 5).map((item) => `- ${String(item).slice(0, 360)}`).join('\n')}`)

  const out: string[] = []
  let used = 0
  for (const section of sections) {
    const tokens = countTokens(section)
    if (used + tokens > CHOICE_CONTEXT_TOKEN_LIMIT) break
    out.push(section)
    used += tokens
  }
  return out.join('\n\n')
}

/** An explicit player destination is a semantic commitment, not a stylistic
 * suggestion. This check is diagnostic only: by the time all prose is available
 * it has already streamed to the player, so rejecting it here turns a harmless
 * narrator omission into a visibly completed turn that gets deleted. The player
 * destination remains the authoritative location transition below. */
function narrativeHonorsDestination(narrative: string, destination: string): boolean {
  const meaningful = String(destination || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, ' ')
    .split(/\s+/)
    .filter(
      (word) =>
        word.length >= 3 && !new Set(['the', 'and', 'for', 'into', 'toward', 'towards', 'local', 'place']).has(word),
    )
  if (!meaningful.length) return true
  const text = String(narrative || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, ' ')
  return meaningful.every((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`).test(text))
}

/** Normalize a persona/character name for identity comparison. */
function normalizePersonaName(value: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Deterministically pull the name the PLAYER introduces for THEMSELVES from
 * their first-person input ("I'm Kael", "my name is Swapnil", "call me Alex",
 * "I am Lena"). Sentient worlds frequently start with no authored persona name,
 * so the player names themselves in chat — and that name must NOT become a codex
 * card alongside the existing "The Player" entity (the dual-identity bug). Only a
 * proper-cased name (1-3 tokens) is accepted, so an "I am tired" never matches.
 */
export function detectSelfIntroName(input: string): string | null {
  const text = String(input || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  // Capture a Proper-Cased name (1-3 tokens) immediately after a first-person
  // self-introduction trigger. The trigger match is case-insensitive; the
  // captured name must still be Proper-Cased (enforced post-capture) so "I am
  // tired" never matches but "I am Lena" does.
  const proper = `([A-Za-z][A-Za-z'’-]+(?:\\s+[A-Za-z'’-]+){0,2})`
  const patterns = [
    new RegExp(`\\b(?:my name is|call me|i am called|they call me|name['’]s)\\s+${proper}`, 'i'),
    new RegExp(`\\b(?:i am|i['’]m|im)\\s+${proper}`, 'i'),
  ]
  // Frequent first-person continuations that look like a name but aren't.
  const STOP = new Set([
    'sorry',
    'here',
    'fine',
    'okay',
    'ok',
    'good',
    'ready',
    'back',
    'afraid',
    'sure',
    'glad',
    'happy',
    'tired',
    'done',
    'not',
    'the',
    'a',
    'an',
    'going',
    'trying',
    'looking',
    'just',
    'still',
    'so',
    'really',
    'very',
  ])
  for (const re of patterns) {
    const m = text.match(re)
    if (!m || !m[1]) continue
    const name = m[1].trim()
    const firstToken = name.split(/\s+/)[0] || ''
    // The first token must be capitalized in the ORIGINAL text — a real name.
    if (!/^[A-Z]/.test(firstToken)) continue
    if (STOP.has(name.toLowerCase()) || STOP.has(firstToken.toLowerCase())) continue
    return name
  }
  return null
}

function positiveLocationStateFromInput(input: string, placeName?: string | null): string[] {
  const text = String(input || '').toLowerCase()
  if (!text) return []
  const place = placeName || 'the current place'
  if (/\b(sanctify|sanctifies|sanctified|consecrate|consecrates|consecrated|bless|blessed)\b/.test(text)) {
    return [`${place} has been sanctified`]
  }
  if (/\b(heal|heals|healed|restore|restores|restored|renew|renews|renewed|repair|repairs|repaired)\b/.test(text)) {
    return [`${place} has been restored`]
  }
  if (/\b(cleanse|cleanses|cleansed|purify|purifies|purified)\b/.test(text)) {
    return [`${place} has been cleansed`]
  }
  if (/\b(seal|seals|sealed)\b/.test(text)) {
    return [`${place} has been sealed`]
  }
  return []
}

const MAX_CONTEXT_TOKENS = 6000
/** Turns of one continuous scene that fold into a single recap (non-overlapping). */
const SCENE_SUMMARY_BLOCK = 12
/** Human labels for calendar-tick spans (keys arrive from the client). */
const TIME_ADVANCE_LABELS: Record<string, string> = {
  hours: 'several hours',
  day: 'a day',
  days: 'several days',
  season: 'a season',
}

function worldActionNarration(action: PlayerWorldAction | undefined): string {
  if (!action) return ''
  if (action.kind === 'travel') {
    const company = action.companions.length ? ` with ${action.companions.join(', ')}` : ' alone'
    return `*I travel to ${action.destination}${company}.*`
  }
  const correction = action.correction ? 'Actually, ' : ''
  return `*${correction}${action.character} is my ${action.relation}.*`
}

function worldActionDirective(action: PlayerWorldAction): string {
  if (action.kind === 'travel') {
    const company = action.companions.length ? action.companions.join(', ') : 'the player alone'
    const time = action.timeAdvance
      ? ` The player explicitly chose a ${TIME_ADVANCE_LABELS[action.timeAdvance]} passage.`
      : ' Do not imply an additional calendar skip unless the player chose one.'
    return `[PLAYER WORLD ACTION — TRAVEL: The player has already committed to travelling to ${action.destination} with ${company}.${time} Narrate the journey and arrival grounded in established canon. Do not redirect, veto, or reinterpret the destination or travelling party.]`
  }
  return `[PLAYER WORLD ACTION — RELATIONSHIP: The player ${action.correction ? 'corrected' : 'confirmed'} that ${action.character} is their ${action.relation}. Treat this as established canon. Acknowledge it naturally; do not question or reinterpret the relationship.]`
}
/** Min turns between fate-seeded tick beats — keeps old promises from nagging. */
const FATE_SEED_COOLDOWN_TURNS = 8


/** How long the fence will spend repairing the previous turn before giving up
 *  and generating anyway. The player is waiting on this — a stale-but-prompt
 *  turn beats a correct one that never arrives. */
const PROJECTION_FENCE_BUDGET_MS = 4_000

/**
 * Refuse to read the previous turn's state while it is known to be incomplete.
 *
 * Projections are asynchronous, so a turn can finish streaming before its codex
 * deltas land — and if that projection then FAILS, every later turn silently
 * reads the turn-before-last as though it were current. Repair it inline when
 * we can, and record the degradation when we cannot, so a desynchronised
 * session is a visible event rather than an inexplicable run of bad prose.
 */
async function fenceOnPriorProjection(params: {
  instanceId: string
  playerId: string
  instanceOid: ObjectId
  playerOid: ObjectId
}): Promise<void> {
  const { instanceId, playerId, instanceOid, playerOid } = params
  try {
    const prior = await mongoColl
      .events()
      .find(
        { instance_id: instanceOid, type: { $ne: 'side_chat' } },
        { projection: { _id: 1, sequence: 1, 'data.codex_projection_status': 1, 'data.ai_response': 1, 'data.model_used': 1 } },
      )
      .sort({ sequence: -1 })
      .limit(1)
      .next()
    if (!prior) return
    const status = (prior as any).data?.codex_projection_status
    // The authored opening has no extraction pass and never will; only a
    // generated turn can be unprojected in the sense that matters here.
    if ((prior as any).data?.model_used === 'seed') return
    if (!status || status === 'completed') return

    const startedAt = Date.now()
    let repaired = false

    // 'processing' with a live claim is the NORMAL case, not a fault: projections
    // run asynchronously on the turn tail, so the previous one is often still in
    // flight when the next turn starts. The correctness requirement is simply to
    // WAIT for it. Treating this as staleness (the first version did) fires an
    // error on every healthy turn and drowns the real signal.
    if (status === 'processing') {
      while (Date.now() - startedAt < PROJECTION_FENCE_BUDGET_MS) {
        await new Promise((resolve) => setTimeout(resolve, 120))
        const now = await mongoColl
          .events()
          .findOne({ _id: prior._id }, { projection: { 'data.codex_projection_status': 1 } })
        const nowStatus = (now as any)?.data?.codex_projection_status
        if (!nowStatus || nowStatus === 'completed') {
          repaired = true
          break
        }
        if (nowStatus !== 'processing') break
      }
      if (repaired) return
    }

    if (status !== 'failed') {
      try {
        const result = (await Promise.race([
          projectCharacterEvent({ instanceId, playerId, eventId: idString(prior._id) }),
          new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), PROJECTION_FENCE_BUDGET_MS)),
        ])) as Record<string, unknown>
        repaired =
          result?.projected === true ||
          result?.skipped === 'already_projected' ||
          // Another worker holds a live claim and is still applying it. That is
          // progress, not staleness.
          result?.skipped === 'claimed_by_active_worker'
      } catch {
        repaired = false
      }
    }
    if (repaired) {
      log.info('projection.fence_repaired', {
        instanceId,
        sequence: (prior as any).sequence,
        ms: Date.now() - startedAt,
      })
      return
    }
    await recordAnomaly({
      instanceId: instanceOid,
      playerId: playerOid,
      eventId: prior._id,
      sequence: (prior as any).sequence,
      type: 'stale_scene_state',
      severity: 'error',
      details: `generated on top of turn ${(prior as any).sequence} whose projection is '${status}'`,
    })
    log.warn('projection.fence_degraded', { instanceId, sequence: (prior as any).sequence, status })
  } catch (err) {
    // The fence is a safety net, never a new failure mode.
    log.warn('projection.fence_error', { instanceId, reason: (err as Error).message })
  }
}

export async function generationProcessor(job: Job): Promise<{ eventId: string; sequence: number } | void> {
  // Replay turns reuse the generation queue/worker but follow a distinct path:
  // they stream an alternative for an existing event instead of appending one.
  if (job.data?.mode === 'replay') {
    return replayProcessor(job)
  }
  if (!isLLMUsageActive()) {
    return runWithLLMUsage(() => generationProcessor(job))
  }

  const {
    instanceId,
    playerId,
    userMessage,
    isContinuation = false,
    timeAdvance,
    worldAction,
    session,
    userNsfwEnabled,
  } = job.data
  let confirmedWorldAction = worldAction as PlayerWorldAction | undefined
  const actionTimeAdvance = confirmedWorldAction?.kind === 'travel' ? confirmedWorldAction.timeAdvance : undefined
  const actionTimeAdvanceLabel = actionTimeAdvance ? TIME_ADVANCE_LABELS[actionTimeAdvance] : undefined

  const workerStartedAt = Date.now()
  // Separate queue wait, worker context construction, and provider TTFT. The
  // user experiences all three; only the last is model/provider latency.
  const queueWaitMs = Math.max(0, workerStartedAt - (Number(job.timestamp) || workerStartedAt))
  const requestStartedAt = Number(job.data?.requestedAt) || Number(job.timestamp) || workerStartedAt
  // The context packet is deliberately rich, and can take a moment on a cold
  // vector/database path. Tell the client which phase it is in immediately so
  // an otherwise blank first-token wait never looks like a stuck send.
  const redis = getRedisClient()
  redis.publish(`user:${playerId}:events`, JSON.stringify({ type: 'generation_started', instanceId }))

  // A journey can take only established characters physically in the last
  // settled scene. The UI applies the same rule, but this server-side gate is
  // authoritative: a raw presence label may be a capitalized place, and the
  // global codex must not become a teleport/summon menu through a crafted or
  // stale client payload.
  if (confirmedWorldAction?.kind === 'travel' && confirmedWorldAction.companions.length) {
    try {
      const instanceObjectId = parseObjectId(instanceId)
      const [latest, cards, locations] = await Promise.all([
        mongoColl.events().findOne(
          { instance_id: parseObjectId(instanceId) },
          {
            sort: { sequence: -1 },
            projection: { 'data.present_characters': 1 },
          },
        ),
        mongoColl
          .characters()
          .find({ instance_id: instanceObjectId }, { projection: { canonical_name: 1, aliases: 1, role: 1 } })
          .toArray(),
        mongoColl
          .entities()
          .find(
            {
              instance_id: instanceObjectId,
              type: 'location',
              status: { $ne: 'archived' },
            },
            { projection: { name_normalized: 1, aliases: 1 } },
          )
          .toArray(),
      ])
      const present = Array.isArray(latest?.data?.present_characters)
        ? latest.data.present_characters.filter((name: unknown): name is string => typeof name === 'string')
        : []
      const presentKeys = new Set(present.map(travelPresenceKey).filter(Boolean))
      const characterKeys = new Set<string>()
      for (const card of cards) {
        if (
          String(card.role || '')
            .trim()
            .toLowerCase() === 'location'
        )
          continue
        characterKeys.add(travelPresenceKey(card.canonical_name))
        for (const alias of card.aliases || []) characterKeys.add(travelPresenceKey(alias))
      }
      const locationKeys = new Set<string>()
      for (const location of locations) {
        locationKeys.add(travelPresenceKey(location.name_normalized))
        for (const alias of location.aliases || []) locationKeys.add(travelPresenceKey(alias))
      }
      const companions = confirmedWorldAction.companions.filter(
        (name) =>
          presentKeys.has(travelPresenceKey(name)) &&
          characterKeys.has(travelPresenceKey(name)) &&
          !locationKeys.has(travelPresenceKey(name)),
      )
      if (companions.length !== confirmedWorldAction.companions.length) {
        log.warn('travel.absent_companions_removed', {
          jobId: job.id,
          instanceId,
          requested: confirmedWorldAction.companions,
          allowed: companions,
        })
        confirmedWorldAction = { ...confirmedWorldAction, companions }
      }
    } catch (err) {
      // Fail closed: a travel still works solo, but a database read failure must
      // never turn an unknown presence set into permission to bring anyone.
      log.warn('travel.presence_check_failed', {
        jobId: job.id,
        instanceId,
        error: (err as Error).message,
      })
      confirmedWorldAction = { ...confirmedWorldAction, companions: [] }
    }
  }

  // A continue with a time span becomes a calendar tick: story time advances.
  const timeAdvanceLabel: string | undefined =
    isContinuation && timeAdvance ? TIME_ADVANCE_LABELS[String(timeAdvance)] : undefined

  // On a "continue" turn the player says nothing — the world advances on its
  // own. We feed the model a directive (but store no player input on the event).
  const actionNarration = worldActionNarration(confirmedWorldAction)
  const parsedPlayerInput = isContinuation
    ? {
        raw: '',
        spoken: '',
        narrationFacts: [] as string[],
        corrections: [] as string[],
        claims: [] as string[],
        actionFacts: [] as string[],
        fragments: [],
      }
    : parsePlayerInput(actionNarration || userMessage)

  // A normal choice chip remains editable prose, but an action that explicitly
  // names a physical destination is still a player commitment. Carry it into
  // the narrator prompt and the location seam so “Head for the cafe” cannot
  // become an unrequested warehouse detour.
  const explicitPhysicalDestination = confirmedWorldAction
    ? null
    : extractExplicitPhysicalDestination(parsedPlayerInput.raw)
  // THE LOOP THIS BREAKS. The narrator is told `CURRENT PLACE: <cursor>` every
  // turn. When the cursor is stale and the player writes their own movement, the
  // narrator follows the cursor and writes them back where they were — and that
  // prose then re-confirms the stale cursor to every post-stream extractor. No
  // extractor improvement can break it: by the time they run, the fiction has
  // already been written the wrong way.
  //
  // The existing guard required the destination to match PHYSICAL_DESTINATION_WORD,
  // a place vocabulary that — unlike the other place vocabulary in the same file —
  // does not contain "bridge". So "I walk to the canal bridge" produced nothing,
  // and a world's map sat in a bar for a dozen turns because of a missing word in
  // one of two lists that disagree. This quotes the player instead of resolving a
  // place: no vocabulary, nothing minted, nothing validated.
  const statedPosition = confirmedWorldAction || isContinuation
    ? null
    : extractStatedPosition(parsedPlayerInput.raw)
  // This only governs narrator viewpoint and presence folding. Location graph
  // changes remain witness-evidence gated below, so a natural-language exit
  // cannot mint a place from a stray phrase.
  const playerSceneTransition =
    !confirmedWorldAction &&
    !isContinuation &&
    isExplicitPlayerSceneTransition(parsedPlayerInput.raw)
  // The explicit travel control is the same boundary in stronger form: its
  // selected companions are the complete travelling party, so locals from the
  // place left behind may never reappear at the destination by metadata drift.
  const playerForcesFreshCast =
    playerSceneTransition || confirmedWorldAction?.kind === 'travel'

  const promptUserMessage = confirmedWorldAction
    ? worldActionDirective(confirmedWorldAction)
    : statedPosition && !explicitPhysicalDestination
      ? `[PLAYER POSITION: The player has placed themselves "${statedPosition}". That is where this scene happens. Narrate from there. Do not return them to the previous place, and do not contradict their own statement of where they are.]`
    : explicitPhysicalDestination
      ? `[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to ${explicitPhysicalDestination}. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]
PLAYER ACTION: ${parsedPlayerInput.raw}`
      : playerSceneTransition
        ? `[PLAYER SCENE TRANSITION: The player has physically left the prior scene. Keep the narration anchored to the player's viewpoint and the place they reach. Do NOT cut away to, or keep scene focus on, people they left behind unless the player explicitly brought them along.]
PLAYER ACTION: ${parsedPlayerInput.raw}`
      : isContinuation
        ? "[The player waits and observes. Continue the current beat naturally without asking what they do. You MUST move the scene through a concrete response: a present NPC speaks (preferred in a conversation), takes a meaningful action, makes a decision, reveals information, or produces a consequence. Do NOT answer a Continue with only silence, tension, glances, hesitation, body language, or atmospheric description; never repeat a stalled silence from the preceding beat. A detached or disinterested character still responds through a terse dismissal, evasion, refusal, cold action, or consequential withdrawal. Do not introduce a new complication, location, character, danger, romance escalation, or major plot turn unless it was already clearly set up by recent events. Because this is an autonomous continuation, do not open with the active character's name; begin with pronoun, action, body language, speech, or setting instead.]"
        : parsedPlayerInput.spoken || '[No spoken dialogue from player this turn.]'
  // World actions are structured control-plane commands, not chat authored by
  // the player. Keep their canonical payload on `data.world_action` and their
  // result in the travel/kinship ledgers; never persist the synthetic
  // `*I travel to …*` helper as a player message.
  const storedPlayerInput = isContinuation || confirmedWorldAction ? '' : userMessage
  const storedPlayerSpokenInput = confirmedWorldAction ? '' : parsedPlayerInput.spoken
  const storedPlayerNarrationFacts = confirmedWorldAction ? [] : parsedPlayerInput.narrationFacts
  const classifyText = isContinuation ? '' : actionNarration || userMessage

  // The turn lock's TTL is kept alive by the worker-level heartbeat (see
  // worker/index.ts); we only need to release it explicitly on success below.
  const lockKey = generationLockKey(playerId, instanceId)
  const instanceOid = parseObjectId(instanceId)
  const playerOid = parseObjectId(playerId)
  const extractorRaw = createExtractorRawSink()

  // Started during context assembly, never awaited before buildPrompt/stream.
  // If it settles in the existing context window, the current narrator can use
  // it; otherwise it becomes continuity for the next turn after this prose has
  // safely streamed. It can never reject or replace a visible response.
  let interactionSignalPromise: Promise<PlayerInteractionSignalDoc[]> | null = null
  let settledInteractionSignals: PlayerInteractionSignalDoc[] = []
  let interactionSignalSettled = false

  // ── FENCE ───────────────────────────────────────────────────────────────
  // Never generate on top of a turn whose projection did not complete. When the
  // previous turn's codex/scene projection is missing, the cards and scene state
  // this turn reads are silently the turn-BEFORE-last's: a released grip is
  // still gripped, someone who left is still in the room. That is not a rare
  // edge — one dropped projection is enough to desynchronise the rest of a
  // session, because every later turn compounds the stale reading.
  //
  // Repair it inline, bounded, before assembling context. If it cannot be
  // repaired in time we still generate (the player is waiting, and a late turn
  // is worse than a slightly stale one) but the degradation is recorded rather
  // than invisible.
  await fenceOnPriorProjection({ instanceId, playerId, instanceOid, playerOid })

  // Explicit context packet, assembled here in the worker so RETRIEVAL RUNS
  // BEFORE CODEX SELECTION: cards pin both for names in the player's input and
  // for characters the retrieved memories are about (indirect references).
  const packet = await buildContextPacket({
    instanceId,
    playerId,
    session,
    userMessage: actionNarration || userMessage,
    isContinuation,
    onActiveCastReady: ({ characterCodex, currentSequence, presentNames, recentTurns }) => {
      if (isContinuation || confirmedWorldAction || interactionSignalPromise) return
      const candidates = activeCastInteractionCandidates(characterCodex, presentNames)
      interactionSignalPromise = extractPlayerInteractionSignals({
        playerInput: storedPlayerInput,
        candidates,
        sequence: currentSequence + 1,
        recentTurns,
        onRaw: extractorRaw.capture('player_interaction'),
      }).then((signals) => {
        settledInteractionSignals = signals
        interactionSignalSettled = true
        return signals
      })
    },
  })
  const contextLatencyMs = Date.now() - workerStartedAt
  const {
    recentEvents,
    characterCodex,
    loreTexts,
    memoryTexts,
    openThreads,
    currentTimeAnchor,
    timeContext,
    currentLocation,
    locationContext,
  } = packet
  const activeSummary = packet.sceneSummary
  const nextSequence = packet.currentSequence + 1

  // Fate seeding: on a calendar tick, the highest-importance open thread may
  // come due — but only past the cooldown, so the world doesn't feel like a
  // debt collector opening every time skip with an old promise.
  let fateThread: string | undefined
  if ((timeAdvanceLabel || actionTimeAdvanceLabel) && openThreads.length > 0) {
    try {
      const inst = await mongoColl
        .worldInstances()
        .findOne({ _id: instanceOid }, { projection: { 'meta.last_fate_seed_sequence': 1 } })
      const lastSeed = inst?.meta?.last_fate_seed_sequence || 0
      if (nextSequence - lastSeed >= FATE_SEED_COOLDOWN_TURNS) {
        fateThread = openThreads[0]
      }
    } catch {
      // Seeding is an enhancement; the tick proceeds without it.
    }
  }

  const tickDirective = timeAdvanceLabel
    ? `[TIME ADVANCES: ${timeAdvanceLabel} pass(es) in the story. Narrate this span as a flowing interlude, then land on a concrete new beat.
- Show what changed across the span: characters pursued their own lives, recent events settled into consequences, the world moved without the player.
- Stay grounded in established canon, current world state, and active flags. Do not invent major new characters, locations, or lore.
- End IN SCENE on a specific moment — an arrival, an encounter, a discovery, a change — that naturally invites the player's next move. Do not ask the player what they do.${
        fateThread
          ? `\n- During this span, an unresolved matter comes due. Weave its consequence into the new beat naturally and concretely (do not resolve it on the player's behalf): ${fateThread}`
          : ''
      }]`
    : undefined

  // Decide routing first so the prompt asks for the right output shape.
  // NSFW routing requires BOTH the world being mature-capable AND the player
  // having opted in via their account preference. Either alone keeps it SFW.
  let modelId = session.model_preferences?.narration_sfw || AI_MODELS.narrationSfw
  let isNsfwTurn = false

  // 'Ardent' chat mode is the structured NSFW on-ramp and the PRIMARY intent
  // signal: when the world allows it and the player opted in, it forces the
  // explicit path. Otherwise THIS turn routes on the deterministic lexicon score
  // alone — pure regex/string work, no network — so NOTHING is added to TTFT.
  // Clean-language intent the word list misses (score 1–2) can't be judged here
  // without an LLM call, and that call would sit on the critical path before the
  // first token. Instead we flag the turn as borderline and run the intent check
  // AFTER the stream (see `nsfwIntent` below), persisting a signal that arms the
  // NEXT turn's momentum. Cost: a one-turn lag on the first clean escalation —
  // the irreducible floor under a zero-TTFT constraint.
  const modeWantsNsfw = session.mode === NSFW_MODE
  let sceneClassification: 'sfw' | 'nsfw' = 'sfw'
  let borderlineForIntent = false
  let currentTurnScore = 0
  if (session.is_nsfw_capable && userNsfwEnabled) {
    if (modeWantsNsfw) {
      sceneClassification = 'nsfw'
    } else {
      // Keep the current turn's score separate from scene momentum. Only a
      // current, verified sexual signal may arm the following turn; otherwise a
      // prior false-positive can keep Free Play permanently on the NSFW route.
      currentTurnScore = scoreScene(classifyText, []).score
      const scored = scoreScene(classifyText, recentEvents)
      sceneClassification = scored.decision
      borderlineForIntent = currentTurnScore >= 1 && currentTurnScore <= 2
    }
  }
  if (sceneClassification === 'nsfw') {
    modelId = session.model_preferences?.narration_nsfw || AI_MODELS.narrationNsfw
    isNsfwTurn = true
  }
  const requestedModelId = modelId
  const narrationFallbackModels = isNsfwTurn
    ? AI_MODELS.narrationNsfwFallbacks
    : AI_MODELS.narrationSfwFallbacks

  // Choices are deliberately NOT authored in a prose-model tail. Different
  // narrators treat markdown/quotes inconsistently, which can mix the chip
  // heading with its prefilled value. The structured choice pass below is now
  // authoritative and receives a bounded equivalent of the narrator's story
  // context, so it stays grounded without depending on tail syntax.
  const prompt = buildPrompt({
    seedPrompt: session.seed_prompt,
    isSentient: session.is_sentient,
    worldState: session.world_state,
    activeFlags: session.active_flags,
    globalLore: session.global_lore,
    retrievedLore: loreTexts,
    retrievedMemories: memoryTexts,
    openThreads,
    sceneSummary: activeSummary,
    relevantSummaries: packet.relevantSummaries,
    relationshipFacts: packet.relationshipFacts,
    positionFacts: packet.positionFacts,
    sceneStateText: renderSceneStateForPrompt(packet.sceneState),
    companionFacts: packet.companionFacts,
    recentEvents,
    currentInteractionSignals: interactionSignalSettled ? settledInteractionSignals : [],
    userMessage: tickDirective ?? promptUserMessage,
    userSpokenInput: parsedPlayerInput.spoken,
    userNarrationFacts: parsedPlayerInput.narrationFacts,
    isContinuation,
    maxTokens: MAX_CONTEXT_TOKENS,
    narrationPov: session.narration_pov,
    chatMode: session.mode,
    narrativeStyle: session.narrative_style,
    narrationTone: session.narration_tone,
    toneExampleSeed: instanceId,
    styleNotes: session.style_notes,
    playerPersona: session.persona_snapshot || null,
    messageLength: session.message_length,
    characterCodex,
    deceasedCharacterNames: packet.deceasedCharacterNames,
    timeContext,
    locationContext,
    focusCharacterName: (() => {
      const focusedId = session.focus_character_id
      if (!focusedId) return undefined
      const focused = (characterCodex as any[]).find((c) => idString(c._id) === focusedId)
      return focused?.canonical_name
    })(),
    // Always request plain prose: it lets us stream tokens to the player as they
    // arrive (low TTFT), and uncensored models can't do the JSON envelope anyway.
    // Structured fields (stats/flags/scene tag) are derived in a cheap pass below.
    proseOnly: true,
    emitChoices: false,
  })

  const choicePlayerName = session.is_sentient
    ? session.persona_snapshot?.name || null
    : (characterCodex as any[]).find((card) => card?.is_protagonist)?.canonical_name || session.protagonist?.name || null
  const choiceDecisionContext = buildChoiceDecisionContext({
    isSentient: !!session.is_sentient,
    playerName: choicePlayerName,
    playerInput: confirmedWorldAction ? actionNarration : isContinuation ? 'Continue the current scene.' : parsedPlayerInput.raw,
    locationContext,
    timeContext,
    worldState: session.world_state || {},
    activeFlags: session.active_flags || {},
    characterCodex: characterCodex as any[],
    loreTexts,
    memoryTexts,
    openThreads,
    sceneSummary: activeSummary,
    relevantSummaries: packet.relevantSummaries,
    relationshipFacts: packet.relationshipFacts,
    positionFacts: packet.positionFacts,
    sceneStateText: renderSceneStateForPrompt(packet.sceneState),
    companionFacts: packet.companionFacts,
    recentEvents,
  })
  const choiceContextTokens = countTokens(choiceDecisionContext)

  // Stream the narrative token-by-token so the player sees words within ~1s
  // instead of waiting for the full completion. Deltas ride the same Redis
  // pub/sub channel that the API forwards to the player's WebSocket.
  const channel = `user:${playerId}:events`
  const genStart = Date.now()
  let ttftMs = 0
  let firstTokenAt = 0
  // When the narrator emits its own choices, strip the trailing CHOICES block out
  // of the player-facing delta stream so the marker/choices never render as prose.
  // Always filter choice-protocol syntax, even when narrator-owned choices are
  // disabled. A model may still hallucinate an old `==CHOICES==` menu; those
  // rows are never player-facing prose and must not duplicate the app chips.
  const choiceFilter = makeChoiceTailFilter()
  const proseFilter = makeProseStreamFilter()
  let visibleAttemptMarked = false
  const markVisibleAttempt = () => {
    if (visibleAttemptMarked) return
    visibleAttemptMarked = true
    // Once a player has received prose, a BullMQ retry would generate a second
    // incompatible answer for the same turn. `discard` is local to this active
    // job and stops BullMQ from scheduling that replacement on a later tail
    // failure. The data marker lets the worker's failure observer suppress its
    // generic reset notification as well.
    job.discard()
    job.data.visibleStreamStarted = true
    void job.updateData(job.data).catch((err) => {
      log.warn('generation.visible_stream_marker_failed', {
        jobId: job.id,
        instanceId,
        error: (err as Error).message,
      })
    })
  }
  const publishDelta = (delta: string) => {
    if (!delta) return
    redis.publish(channel, JSON.stringify({ type: 'generation_delta', instanceId, delta }))
  }
  let streamedVisibleProse = ''
  const publishVisibleDelta = (delta: string) => {
    const visibleDelta = choiceFilter.push(delta)
    if (visibleDelta) {
      markVisibleAttempt()
      streamedVisibleProse += visibleDelta
      publishDelta(visibleDelta)
    }
    // A destination-bound turn is still provisional until the completed prose
    // passes the destination-commitment guard below. Do not show a settled end
    // state (or enable its choices) only to reset it milliseconds later.
    if (choiceFilter.inTail() && !explicitPhysicalDestination) {
      publishStreamEnd(choiceFilter.prose())
    }
  }
  // The visible stream ends — and the typing indicator stops — when this fires. We
  // send it the INSTANT the choices sentinel is seen (the story prose is complete
  // there), not after the model finishes writing the hidden choices tail. Guarded
  // so it's published exactly once.
  let streamEnded = false
  const publishStreamEnd = (narrative: string) => {
    if (streamEnded) return
    streamEnded = true
    redis.publish(
      channel,
      JSON.stringify({
        type: 'generation_stream_end',
        instanceId,
        narrative: narrative.trim(),
      }),
    )
  }
  // Reset only when no usable prose ever reached the player. Once a turn has
  // visibly started, its output is an interaction contract: quality and length
  // misses become prompt feedback for future turns, never a mid-stream restart.
  let resetPublished = false
  const publishGenerationReset = async () => {
    if (resetPublished) return
    resetPublished = true
    try {
      await redis.publish(channel, JSON.stringify({ type: 'generation_reset', instanceId }))
    } catch (resetErr) {
      log.warn('generation.reset_publish_failed', {
        jobId: job.id,
        instanceId,
        error: (resetErr as Error).message,
      })
    }
  }

  let streamFailure: unknown = null
  let fallbackAttempts: Array<{ from: string; to: string }> = []
  try {
    const narration = await callLLMStreamWithFallback(
      {
        model: modelId,
        purpose: 'narration',
        messages: prompt.messages,
        temperature: narrationTemperature(modelId),
        maxTokens: lengthMaxTokens(session.message_length),
        sessionId: instanceId,
      },
      narrationFallbackModels,
      (chunk) => {
        // First streamed delta = the latency the player actually feels.
        if (ttftMs === 0) {
          firstTokenAt = Date.now()
          ttftMs = firstTokenAt - genStart
        }
        publishVisibleDelta(proseFilter.push(chunk))
        // Once the sentinel arrives, all prose is in and the rest is hidden choices —
        // close the visible stream now so the indicator doesn't hang through them.
      },
      ({ from, to, error }) => {
        // This happens only before any prose was published. The client keeps its
        // existing loading state, so the reroute is invisible to the player.
        log.warn('generation.model_rate_limited_fallback', {
          jobId: job.id,
          instanceId,
          from,
          to,
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )
    modelId = narration.model
    fallbackAttempts = narration.fallbackAttempts
  } catch (err) {
    streamFailure = err
  }
  // Flush a JSON-envelope recovery (normally empty) before flushing the choice
  // filter's held-back sentinel tail.
  publishVisibleDelta(proseFilter.end())
  if (proseFilter.malformedNarrativeEnvelope()) {
    // The filter withheld a broken legacy JSON envelope. Reset the provisional
    // bubble and retry this turn; protocol text must never become playable prose.
    await publishGenerationReset()
    throw new Error('LLM stream ended with a malformed narrative envelope')
  }
  // Flush the small held-back tail (kept so a partial sentinel never flashes).
  publishDelta(choiceFilter.end())
  // The prose the player saw — with the choices tail removed when present.
  const prose = choiceFilter.prose()
  if (streamFailure && !prose.trim()) {
    await publishGenerationReset()
    throw streamFailure
  }
  if (streamFailure) {
    log.warn('generation.provider_interrupted_after_visible_prose', {
      jobId: job.id,
      instanceId,
      visibleCharacters: streamedVisibleProse.length,
      error: (streamFailure as Error).message,
    })
  }
  const latencyMs = Date.now() - genStart
  const endToEndTtftMs = firstTokenAt > 0 ? firstTokenAt - requestStartedAt : 0

  log.info('generation.stream', {
    jobId: job.id,
    instanceId,
    // This is the player-facing streaming narrator. Hygiene uses the stable
    // metadata model later, off the TTFT path, and is reported separately so
    // operational logs cannot make a DeepSeek narration look like gpt-4o-mini.
    model: modelId,
    requestedModel: requestedModelId,
    fallbackAttempts,
    hygieneModel: AI_MODELS.metadata,
    contextLatencyMs,
    queueWaitMs,
    ttftMs,
    endToEndTtftMs,
    latencyMs,
    choiceContextTokens,
  })

  // Guard: choices_ready is published AT MOST ONCE per turn. Do not publish
  // narrator-tail choices until the full structural + grounding audit has run:
  // showing a fast malformed chip and silently replacing it later is worse UX
  // than a brief post-prose preparation state.
  let choicesReadySent = false

  // RAW witness prose: what the model actually generated. All world-state
  // extractors (metadata, choice grounding, codex, kinship, memory) witness
  // THIS. If a provider stopped in a
  // dangling final clause, discard only that clause first — it contains no
  // complete fact and must never enter canonical history.
  let rawNarrative = prose.trim()

  if (explicitPhysicalDestination && !narrativeHonorsDestination(rawNarrative, explicitPhysicalDestination)) {
    log.warn('generation.destination_not_named', {
      jobId: job.id,
      instanceId,
      destination: explicitPhysicalDestination,
      // Compact only for diagnostics; prose remains the streamed story, never a
      // post-hoc retry trigger.
      narrativeCharacters: rawNarrative.length,
    })
  }

  const characterNames = (characterCodex || []).map((c: any) => c.canonical_name)
  const playerAddressMode = session.is_sentient
    ? 'you'
    : session.narration_pov === 'first'
      ? 'self'
      : 'role'
  const streamIssues = validateProseHygiene({
    narrative: rawNarrative,
    characterNames,
    messageLength: session.message_length,
    playerAddressMode,
  })
  const lengthIssueCodes = streamIssues
    .filter((issue) =>
      [
        'length_too_short',
        'length_too_long',
        'short_reply_overexpanded',
        'long_reply_underdeveloped',
        'too_many_paragraphs',
        'too_few_paragraphs',
      ].includes(issue.code),
    )
    .map((issue) => issue.code)
  if (lengthIssueCodes.length > 0) {
    // Length is enforced up front by the prompt + output ceiling. If a model
    // still misses it, record the miss for the next-turn reminder—never reset,
    // rewrite, or retry prose that the player is already reading.
    log.info('generation.length_target_missed', {
      jobId: job.id,
      instanceId,
      requestedLength: session.message_length,
      issues: lengthIssueCodes,
    })
  }
  if (streamIssues.some((issue) => issue.code === 'incomplete_ending')) {
    const completePrefix = completeNarrativePrefix(rawNarrative)
    if (completePrefix) {
      log.warn('generation.trailing_fragment_discarded', {
        jobId: job.id,
        instanceId,
        model: modelId,
        originalCharacters: rawNarrative.length,
        keptCharacters: completePrefix.length,
      })
      rawNarrative = completePrefix
    } else {
      // Never replace an already streamed response with a second model pass.
      // Preserve the visible prose and let the next-turn prompt correct the
      // incomplete-ending warning instead of making the reader watch it start over.
      log.warn('generation.incomplete_stream_preserved', {
        jobId: job.id,
        instanceId,
        model: modelId,
        visibleCharacters: streamedVisibleProse.length,
      })
    }
  }

  // No tail (flag off, or narrator emitted none) → close the stream after the
  // completion guard has processed it. This never swaps out visible prose for
  // a fresh generation just because it missed a quality target.
  publishStreamEnd(rawNarrative)

  const previousOpeningName = openingCharacterName(recentEvents || [], characterNames)
  // A live stream is an interaction contract: once prose is visible, no
  // post-stream system may silently rewrite it into a different scene. Hygiene
  // therefore audits the exact streamed witness and supplies corrections to the
  // next prompt; it does not produce a second, canonical version of this turn.
  // Replay/edit flows are unstreamed replacements and retain their dedicated
  // hygiene-repair path in memory.service.
  const proseHygieneIssues = validateProseHygiene({
    narrative: rawNarrative,
    characterNames,
    messageLength: session.message_length,
    playerAddressMode,
    previousOpeningNames: previousOpeningName ? [previousOpeningName] : [],
    avoidOpeningNames: characterNames,
  })

  // Anchor choice generation to the player's identity so the choice viewpoint
  // can't drift. GM worlds: the protagonist card IS the player's character.
  // Sentient worlds: the player is the persona talking to the locked character.
  const protagonistCard = (characterCodex as any[]).find((c) => c.is_protagonist)
  const choiceProtagonist = session.is_sentient
    ? session.persona_snapshot?.name
      ? { name: session.persona_snapshot.name, aliases: [] }
      : null
    : protagonistCard
      ? {
          name: protagonistCard.canonical_name,
          aliases: protagonistCard.aliases || [],
        }
      : session.persona_snapshot?.name
        ? { name: session.persona_snapshot.name, aliases: [] }
        : null
  // Known cast for name normalization: the selected codex minus the PLAYER, so
  // present_characters + choice references come back as canonical names the app
  // can match exactly (instead of whatever alias/role the prose used). In GM
  // worlds the player IS the is_protagonist card, so drop it; in sentient worlds
  // the player is the (un-carded) persona and the is_protagonist card is the AI
  // character the player talks to — very much an "other", so keep it.
  const choiceRoster = (characterCodex as any[])
    .filter((c) => c.canonical_name && (session.is_sentient || !c.is_protagonist))
    .map((c) => ({
      name: c.canonical_name as string,
      aliases: (c.aliases || []) as string[],
    }))
  // Presence persists across a continuous scene: seed the extractor with whoever
  // was present at the end of the most recent main-story turn, so a character
  // still in the room but not named this passage isn't dropped to "elsewhere".
  const priorPresent: string[] = (() => {
    for (let i = (recentEvents as any[]).length - 1; i >= 0; i--) {
      const pc = (recentEvents as any[])[i]?.data?.present_characters
      if (Array.isArray(pc)) return pc.filter((n) => typeof n === 'string')
    }
    return []
  })()
  const persistedDeceasedKeys = new Set(packet.deceasedCharacterNames.map((name) => normalizeEntityName(name)))
  // Known places so a RETURN reuses a location's canonical name instead of
  // minting a near-duplicate entity (which would split the Places journal).
  //
  // Filtered through the same hygiene gate that decides what may be minted
  // today, because minting is self-justifying: `knownPlaces` is a short-circuit
  // meaning "this is definitely a place", so a node written before the gate
  // existed hands its own mistake back as authority — to the witness as a
  // location to anchor on, and to the gate as proof that a name is a place.
  // A live world carries "Cedric Take care of stuff here when I am gone okay"
  // and "the war room where Father is already waiting" as locations; the
  // witness duly reported the war room for a scene at a dinner table, on turn
  // two, before the player had gone anywhere. The graph is not repaired here —
  // that is `repair:duplicate-places` and `merge:location` — but nothing the
  // gate would refuse today gets to speak as canon.
  const knownPlaces = (
    await entityGraphService
      .listKnownLocations(instanceId, 30)
      .catch(() => [] as { name: string; aliases: string[] }[])
  ).filter((place) => isSafeWitnessLocationCandidate(place.name))
  // Places are a separate graph type from people. Keep their names available to
  // every downstream presence seam so a capitalized city/landmark cannot become
  // a participant merely because the narrator personifies it.
  const knownPlacePresenceKeys = new Set<string>()
  for (const place of knownPlaces) {
    const canonical = normalizeEntityName(place.name || '')
    if (canonical) knownPlacePresenceKeys.add(canonical)
    for (const alias of place.aliases || []) {
      const key = normalizeEntityName(alias || '')
      if (key) knownPlacePresenceKeys.add(key)
    }
  }
  if (currentLocation?.name) {
    const key = normalizeEntityName(currentLocation.name)
    if (key) knownPlacePresenceKeys.add(key)
  }
  const priorCardNamesForPresence = (characterCodex as any[])
    .flatMap((card) => [card?.canonical_name, ...((card?.aliases as string[]) || [])])
    .filter((name): name is string => typeof name === 'string' && !!name.trim())
  const entityCandidates = entityAdjudicationCandidates({
    prose: rawNarrative,
    knownNames: priorCardNamesForPresence,
    exclude: [...knownPlacePresenceKeys, choiceProtagonist?.name || '', ...(choiceProtagonist?.aliases || [])],
  })
  // This semantic classification is intentionally post-stream and parallel to
  // hygiene + metadata. It can only gate unfamiliar-candidate promotion; it
  // cannot write prose or alter established cast/canon by itself.
  const entityAdjudicationPromise = adjudicateEntityCandidates({
    prose: rawNarrative,
    candidates: entityCandidates,
    knownCast: priorCardNamesForPresence,
    knownPlaces: knownPlaces.map((place) => place.name),
    worldContext: [session.seed_prompt, session.global_lore].filter(Boolean).join('\n'),
    onRaw: extractorRaw.capture('entity_adjudication'),
  })
  const metaPromise = extractSceneMetadata(
    rawNarrative,
    statDescriptors(session.stat_definitions || session.world_state),
    Object.keys(session.active_flags || {}),
    {
      isSentient: session.is_sentient,
      currentLocationName: currentLocation?.name || null,
      priorPresent,
      // Open configurations entering this turn, so the witness can close the
      // ones this passage ends instead of leaving them to outlive the story.
      priorPhysical: (packet.sceneState?.physical || []).map((fact) => fact.statement),
      protagonist: choiceProtagonist,
      roster: choiceRoster,
      knownPlaces,
      playerInput: parsedPlayerInput.raw,
      // The world premise/lore, so the extractor can tell a LITERAL ghost (a real
      // spirit in a horror/fantasy world) from a FIGURATIVE one (a metaphor for an
      // overlooked person in a grounded drama) instead of reifying the metaphor
      // into a "ask her about the ghost" choice.
      worldContext: [session.seed_prompt, session.global_lore].filter(Boolean).join('\n'),
      choiceContext: choiceDecisionContext,
      onRaw: (stage, raw) => extractorRaw.capture(stage)(raw),
    },
  )
  // Do not wait for the broad metadata pass just to build a candidate set. The
  // endpoint judge receives the prior cast, every known card/alias, and the
  // same gated walk-on candidates the entity judge sees. That is sufficient to
  // verify physical co-location while keeping this call in the post-stream
  // parallel batch rather than adding a second completion-time round trip.
  const endpointAdjudicationPromise = adjudicateSceneEndpoint({
    prose: rawNarrative,
    playerInput: parsedPlayerInput.raw,
    candidates: [
      ...priorPresent,
      ...choiceRoster.flatMap((card) => [card.name, ...(card.aliases || [])]),
      ...entityCandidates.map((candidate) => candidate.display),
    ],
    onRaw: extractorRaw.capture('scene_endpoint'),
  })
  const deathExtractionPromise = extractCharacterDeaths({
    prose: rawNarrative,
    candidates: characterCodex as any[],
    sequence: nextSequence,
    onRaw: extractorRaw.capture('character_deaths'),
  })
  // All post-stream checks run together. None is allowed to alter visible prose
  // or delay the narrator's first token.
  const [meta, entityAdjudication, characterLifecycleDeltas, endpointAdjudication] = await Promise.all([
    metaPromise,
    entityAdjudicationPromise,
    deathExtractionPromise,
    endpointAdjudicationPromise,
  ])
  if (endpointAdjudication.citationVerdicts.length > 0) {
    log.info('presence.citation_advisory', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      verdicts: endpointAdjudication.citationVerdicts.slice(0, 12).map((v) => ({
        name: v.name,
        a: v.a,
        b: v.b,
        c: v.c,
        rejected: v.rejected,
      })),
    })
    // (a) still admits on scene break. An excerpt that does not name the
    // candidate would rewrite the cast if present[] were consumed — the
    // Vesperkeep steward ← "He stays perfectly still" class. Advisory until
    // a deeper sample says (b) is safe to enforce.
    const nameMismatch = endpointAdjudication.citationVerdicts
      .filter((v) => v.a && !v.b)
      .map((v) => v.name)
    if (nameMismatch.length > 0) {
      log.info('presence.citation_name_mismatch', {
        instanceId: idString(instanceId),
        sequence: nextSequence,
        labels: nameMismatch.slice(0, 12),
      })
    }
  }
  const finalNarrative = rawNarrative
  const parsed: GenerationOutput = { narrative: finalNarrative, ...meta }
  const independentlyCorroboratedPeople = adjudicatedPersonKeys(entityCandidates, entityAdjudication)
  parsed.present_characters = filterAdjudicatedPresence(
    parsed.present_characters || [],
    entityCandidates,
    entityAdjudication,
  )
  const deceasedThisTurn = new Set(characterLifecycleDeltas.map((delta) => delta.name_normalized))
  const blockedLifeStateKeys = new Set([...persistedDeceasedKeys, ...deceasedThisTurn])
  const blockedLifeStateNames = [...packet.deceasedCharacterNames, ...characterLifecycleDeltas.map((delta) => delta.name)]
  if (deceasedThisTurn.size) {
    parsed.present_characters = parsed.present_characters.filter((name) => !blockedLifeStateKeys.has(normalizeEntityName(name)))
    parsed.choices = (parsed.choices || []).filter((choice) =>
      !characterLifecycleDeltas.some((delta) => new RegExp(`\\b${escapeRegExp(delta.name)}\\b`, 'i').test(`${choice.label} ${choice.send}`)),
    )
  }
  if (entityAdjudication.available && entityAdjudication.decisions.some((decision) => decision.verdict !== 'person')) {
    log.info('entity.adjudication.held', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      decisions: entityAdjudication.decisions
        .filter((decision) => decision.verdict !== 'person')
        .map((decision) => ({ key: decision.key, verdict: decision.verdict, evidence: decision.evidenceType })),
    })
  }
  // Choices come solely from the schema-enforced choice metadata pass. The
  // prose narrator never controls their wire format or their visibility.
  if (blockedLifeStateKeys.size) {
    parsed.choices = (parsed.choices || []).filter((choice) =>
      !blockedLifeStateNames.some((name) => name && new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(`${choice.label} ${choice.send}`)),
    )
  }
  // Closed-check backstop on the choices: the metadata model is *told* never to
  // invent characters, but nothing enforced it — a small model would fabricate a
  // relative the cast doesn't have ("Encourage my brother" when the player has
  // only a sister) and the bad choice reached the player. Drop any choice that
  // references a kinship relation no codex card carries. Pure string work, off
  // the TTFT path (the prose already streamed) → zero added latency. Every kin
  // the cast DOES have is whitelisted, so a valid "confront my sister" survives.
  const castVocab = (characterCodex as any[]).flatMap((c) => [
    c?.canonical_name,
    c?.name_normalized,
    c?.role,
    ...((c?.aliases as string[]) || []),
  ])
  // Authoritative source: the kinship GRAPH as it stood after PRIOR turns (a cheap
  // pre-turn READ — the graph for THIS turn is written later on the tail). Gives
  // the player's actual relatives' labels, perspective-correct. GM worlds anchor on
  // the protagonist card's entity; sentient/empty fall back to cast+prose. Flag
  // KINSHIP_GRAPH_READS=off disables consumption (write path keeps shadowing).
  let graphLabels: string[] = []
  if (process.env.KINSHIP_GRAPH_READS !== 'off' && !session.is_sentient) {
    const selfReadId = protagonistCard?.entity_id ? idString(protagonistCard.entity_id) : null
    if (selfReadId) {
      const summary = await kinshipGraphService.kinSummary(idString(instanceId), selfReadId).catch(() => ({
        kinds: new Set(),
        labelsByKind: {} as Record<string, string[]>,
      }))
      graphLabels = Object.values(summary.labelsByKind).flat() as string[]
    }
  }
  // Pass the grounded narrator prose so a relative introduced THIS turn (not yet
  // in the pre-turn codex) isn't mistaken for a fabrication; and the world
  // premise/lore so a SUPERNATURAL being only survives when the world establishes
  // it as real (otherwise "Ask her about the ghost" for a metaphorical ghost in a
  // grounded drama is dropped — the prompt rule alone is unreliable on the small
  // model). Real ghosts in a horror world: their premise names them or they're carded.
  const worldText = [session.seed_prompt, session.global_lore].filter(Boolean).join('\n')
  // Reuse the exact premise-aware classification for scene presence. Choices
  // already cannot turn a figurative "ghost" into an option in a grounded
  // world; without this companion guard, a faulty witness could still promote
  // that label into present_characters and subsequently mint a graph stub.
  const choiceGroundingContext = computeGroundingContext(castVocab, rawNarrative, graphLabels, worldText, {
    protagonist: choiceProtagonist,
    isSentient: !!session.is_sentient,
    currentLocationName: currentLocation?.name || null,
  })
  // Audit + REPAIR ungrounded choices (fabricated/wrong-perspective kin, reified
  // metaphor beings) in place rather than dropping them, so the player keeps a full
  // set of grounded options ("attack the ghost" → "investigate the presence").
  // Unrepairable / duplicate-after-repair choices are still dropped. Off TTFT.
  const audited = auditChoices(parsed.choices || [], castVocab, rawNarrative, graphLabels, worldText, {
    protagonist: choiceProtagonist,
    isSentient: !!session.is_sentient,
    currentLocationName: currentLocation?.name || null,
  })
  if (audited.repairedCount > 0 || audited.dropped.length > 0) {
    log.warn('choice-grounding audited choices', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      repaired: audited.results
        .filter((r) => r.repaired)
        .map((r) => ({
          from: r.choice.label,
          to: r.repaired!.label,
          issue: r.issues[0]?.type,
        })),
      dropped: audited.dropped.map((d) => ({
        label: d.choice.label,
        issue: d.issues[0]?.type,
      })),
    })
  }
  parsed.choices = audited.choices

  // The structural + grounding audit is complete. `parsed.choices` now holds the
  // ONLY set the player may see — narrator-tail or metadata fallback alike. Ship
  // it before persistence/back-office projections, but never expose an earlier,
  // unvalidated preview that could have mismatched labels and composer values.
  if (!choicesReadySent && (parsed.choices?.length ?? 0) > 0) {
    redis.publish(
      channel,
      JSON.stringify({
        type: 'choices_ready',
        instanceId,
        choices: parsed.choices,
      }),
    )
    choicesReadySent = true
  }

  const statLimits = Object.fromEntries(
    Object.entries(session.stat_definitions || {}).map(([key, raw]) => {
      const def = raw as any
      return [key, { min: Number.isFinite(def?.min) ? def.min : 0, max: Number.isFinite(def?.max) ? def.max : 100 }]
    }),
  )
  const newWorldState = applyStateMutations(session.world_state, parsed.state_mutations, statLimits)
  const newFlags = applyFlagMutations(session.active_flags, parsed.flag_mutations)
  const eventCreatedAt = new Date()
  const previousEventId = recentEvents.length ? (recentEvents[recentEvents.length - 1] as any)._id : null
  // The scene witness is the sole semantic authority for a normal prose move.
  // We intentionally do NOT derive a location from keyword/regex signals in the
  // player input: that was how dialogue such as "Cedric, take care of things…"
  // turned into a Places node. The worker only verifies the witness's compact
  // label and exact evidence before it can touch the durable graph.
  const playerExitedScene = !isContinuation && isExplicitSceneExit(parsedPlayerInput.raw)
  const locationCandidateOptions = {
    knownPeople: priorCardNamesForPresence,
    knownPlaces: [...knownPlaces.map((place) => place.name), currentLocation?.name || ''],
  }
  const validWitnessLocation = isSafeWitnessLocationCandidate(parsed.current_location, locationCandidateOptions)

  // The whole decision now lives in worker/lib/location-decision.ts as a pure
  // function of this turn's evidence, with the pre-citation stack beside it, so
  // `corpus:location-ab` can replay both over identical extractor output and
  // attribute a difference to the logic rather than to model noise. It used to
  // be ~120 lines inline here, which meant the only way to ask whether a change
  // helped was to play turns and squint.
  const locationDecision = decideLocation({
    isContinuation,
    playerInput: parsedPlayerInput.raw,
    narrative: rawNarrative,
    cursorName: currentLocation?.name || null,
    knownPeople: priorCardNamesForPresence,
    knownPlaceNames: knownPlaces.map((place) => place.name),
    witness: {
      current_location: parsed.current_location ?? null,
      player_destination: parsed.player_destination ?? null,
      player_travel_confirmed: parsed.player_travel_confirmed === true,
      viewpoint_moved: parsed.viewpoint_moved === true,
      location_evidence: parsed.location_evidence ?? null,
      location_evidence_source: parsed.location_evidence_source ?? null,
    },
    actionDestination: confirmedWorldAction?.kind === 'travel' ? confirmedWorldAction.destination : null,
    endpoint: {
      available: endpointAdjudication.available,
      sceneTransition: endpointAdjudication.sceneTransition,
      location: endpointAdjudication.location,
    },
    priorDrift: (session as { location_drift?: DriftState | null }).location_drift ?? null,
    sequence: nextSequence,
  })
  const placeName = locationDecision.placeName
  const viewpointMoved = locationDecision.viewpointMoved
  const sceneAnchor = locationDecision.sceneAnchor
  const { next: nextDrift, repair: driftRepair, count: driftCount } = locationDecision.drift
  if (sceneAnchor && !locationNamesCompatible(sceneAnchor, currentLocation?.name || null)) {
    log.info('location.drift', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      cursor: currentLocation?.name || null,
      anchor: sceneAnchor,
      count: driftCount,
      repaired: !!driftRepair,
    })
  }
  if (locationDecision.judgedRejectedAsNotAPlace) {
    log.info('location.judged_name_not_a_place', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      name: locationDecision.judgedRejectedAsNotAPlace,
    })
  }

  // The witness is a semantic observer, not a world-authority. Its containment
  // claim reaches the graph only after it corroborates the player-selected
  // destination and names an already-known parent (normally the current cursor).
  // This preserves nested places without allowing a hallucinated hierarchy.
  const approvedContainmentHint = viewpointMoved
    ? validatedContainmentHint({
        destination: placeName,
        witnessLocation: parsed.current_location,
        witnessContainment: parsed.containment_hint,
        currentLocationName: currentLocation?.name || null,
        knownLocationNames: knownPlaces.map((place) => place.name),
      })
    : null
  const witnessMovement = parsed.movement || 'none'
  const approvedMovement = approvedContainmentHint && ['deeper', 'out', 'lateral', 'world_shift'].includes(witnessMovement)
    ? witnessMovement
    : viewpointMoved
      ? 'lateral'
      : 'none'
  const moveSource: WorldFactSource = 'player_narration'
  const moveConfidence = confidenceFor(moveSource)
  // The first anchor comes from the witness's cited narration, never from a
  // word-pattern scan. A mentioned/anticipated place cannot pass this gate
  // because the witness must cite the exact sentence that physically establishes
  // the current setting.
  const sceneEstablishedLocation = locationDecision.sceneEstablished
  const locationSource: WorldFactSource = viewpointMoved ? moveSource : 'narrator'
  const locationConfidence = viewpointMoved ? moveConfidence : 0.98
  // ── PROMOTION GATE ──────────────────────────────────────────────────────
  //
  // A name the cursor lands on is a SCENE ANCHOR. It becomes a MAP NODE only
  // once the world has watched the viewpoint enter and leave it, or seen it
  // contain something, or the author named it. Until then nothing is minted, so
  // it never reaches `knownPlaces` — which is what let one furniture write
  // permanently disable the hygiene gate that would have refused it.
  //
  // A provisional anchor still drives the cursor and the narrator for this turn.
  // Being wrong about it costs one turn instead of the rest of the run.
  const promotionCandidate = placeName ? String(placeName).trim() : ''
  let placePromoted = !promotionCandidate
  let promotionReason = 'none'
  if (promotionCandidate) {
    const candidateKey = normalizeEntityName(promotionCandidate)
    const priorAccrual = candidateKey
      ? await mongoColl
          .placeCandidates()
          .findOne({ instance_id: instanceOid, name_normalized: candidateKey })
          .catch(() => null)
      : null
    const decision = decidePlacePromotion({
      candidate: promotionCandidate,
      sequence: nextSequence,
      relation: classifyPlaceRelation(promotionCandidate, rawNarrative, { people: priorCardNamesForPresence }),
      containment: !!approvedContainmentHint,
      // An authored place is the world's own canon: a typed travel destination
      // the player chose in the product, or a place the template already knows.
      authored:
        confirmedWorldAction?.kind === 'travel' ||
        knownPlaces.some((place) => locationNamesCompatible(place.name, promotionCandidate)),
      prior: priorAccrual as any,
    })
    placePromoted = decision.promote
    promotionReason = decision.reason
    if (candidateKey) {
      await mongoColl
        .placeCandidates()
        .updateOne(
          { instance_id: instanceOid, name_normalized: candidateKey },
          { $set: { ...decision.next, instance_id: instanceOid, name_normalized: candidateKey, promoted: decision.promote } },
          { upsert: true },
        )
        .catch(() => null)
    }
    log.info('location.promotion', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      candidate: promotionCandidate,
      promote: decision.promote,
      reason: decision.reason,
      entries: decision.next.entries,
      exits: decision.next.exits,
      sightings: decision.next.sightings,
    })
  }

  const resolvedLocation =
    (viewpointMoved || sceneEstablishedLocation) && placeName && placePromoted
      ? await entityGraphService
          .placeLocation({
            instanceId,
            playerId,
            sequence: nextSequence,
            name: placeName,
            containmentHint: approvedContainmentHint,
            movement: approvedMovement,
            viewpointMoved,
            cursorEntityId: currentLocation?.entity_id ?? null,
          })
          .catch((err) => {
            console.warn('location anchor resolution failed:', (err as Error).message)
            return null
          })
      : null
  // A provisional anchor has no entity_id: it is a name the narrator and the
  // cursor can use, and nothing downstream may treat as a durable place.
  const provisionalAnchor =
    !placePromoted && placeName && (viewpointMoved || sceneEstablishedLocation)
      ? { entity_id: null, name: String(placeName), name_normalized: normalizeEntityName(String(placeName)) }
      : null
  const locationAnchor = resolvedLocation || provisionalAnchor || currentLocation || null
  // The location cursor had NO logging of any kind, which is why "the cursor is
  // stuck" survived several playtests as folklore: every gate input is a witness
  // field that is never persisted, so a stuck cursor was indistinguishable from a
  // correctly-refused phantom move after the fact. Log the whole decision.
  log.info('location.decision', {
    instanceId: idString(instanceId),
    sequence: nextSequence,
    from: currentLocation?.name || null,
    to: locationAnchor?.name || null,
    moved: viewpointMoved,
    placeName,
    w_travel: parsed.player_travel_confirmed,
    w_moved: parsed.viewpoint_moved,
    w_current: parsed.current_location,
    w_dest: parsed.player_destination,
    w_evsrc: parsed.location_evidence_source,
    w_ev: String(parsed.location_evidence || '').slice(0, 80),
    validLoc: validWitnessLocation,
    path: locationDecision.path,
    corroborated: locationDecision.transitionCorroborated,
    cite: locationDecision.citation,
    judged: locationDecision.judgedLocation,
    j_place: endpointAdjudication.location?.name || null,
    anchor: sceneAnchor,
    drift: driftCount,
    driftRepair,
    promoted: placePromoted,
    promotion: promotionReason,
    compatible: locationNamesCompatible(parsed.current_location, currentLocation?.name || null),
  })

  // A travel marker now follows the same high-precision player destination gate.
  const isTravel =
    !isContinuation &&
    viewpointMoved &&
    !!currentLocation &&
    !!resolvedLocation &&
    idString(resolvedLocation.entity_id) !== idString(currentLocation.entity_id)

  // Narrated time skips advance the calendar on any turn (travel, "weeks
  // passed"), not just the explicit wait/continue tick. The continuation tick's
  // label still wins when present. Deterministic backstop: the extractor reads only
  // the AI prose, so a skip the player wrote ("Weeks pass.") that the narrator
  // didn't restate is lost — recover it from the player's own input. The witness's
  // label is telemetry only: calendar mistakes are not recoverable enough to accept
  // a model-only guess.
  const witnessTimeLabel = !isContinuation ? parsed.time_elapsed || undefined : undefined
  const playerTimeLabel = !isContinuation ? detectNarratedTimeSkip(parsedPlayerInput.raw) || undefined : undefined
  // The witness may now move the calendar, but only by quoting the sentence
  // that says the time passed. Until this, `time_elapsed` reached the signal
  // ledger and nothing else — the calendar was 100% regex over the PLAYER'S
  // text, so a skip only the narrator wrote ("Two days later, the rain finally
  // stopped") left the date untouched for the rest of the run. The player's own
  // label still wins: their text is authored canon, the witness is a reader.
  const timeCitation = witnessTimeLabel
    ? evaluateTimeCitation({
        label: witnessTimeLabel,
        evidence: parsed.time_evidence || '',
        source: rawNarrative,
      })
    : null
  const citedWitnessTimeLabel =
    timeCitation && citationAdmitsTimeSkip(timeCitation) ? witnessTimeLabel : undefined
  const narratedTimeLabel = !isContinuation ? playerTimeLabel || citedWitnessTimeLabel : undefined
  if (witnessTimeLabel && !playerTimeLabel) {
    log.info('time.witness_citation', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      label: witnessTimeLabel,
      evidence: String(parsed.time_evidence || '').slice(0, 80),
      a: timeCitation?.a ?? null,
      b: timeCitation?.b ?? null,
      accepted: !!citedWitnessTimeLabel,
    })
  }
  const effectiveTimeAdvance = timeAdvanceLabel || actionTimeAdvanceLabel || narratedTimeLabel
  // Provenance of the time advance (world-authority), for the rebuildable time_delta:
  // continuation ticks and accepted player-narrated skips are player-authored.
  let timeSource: WorldFactSource | null = null
  let timeConfidence = 0
  if (effectiveTimeAdvance) {
    if (timeAdvanceLabel || actionTimeAdvanceLabel || playerTimeLabel) {
      timeSource = 'player_narration'
      timeConfidence = confidenceFor('player_narration')
    } else if (citedWitnessTimeLabel) {
      // A cited skip is the narrator's own statement about the world.
      timeSource = 'narrator'
      timeConfidence = confidenceFor('narrator')
    }
  }

  // Presence carry-forward (deterministic — not left to the model): a continuous
  // scene keeps everyone who was here, minus anyone the model says explicitly
  // left this turn. A scene break — the viewpoint physically moved, or in-world
  // time skipped — starts presence fresh from whoever this passage shows. This
  // stops a present-but-unnamed character (e.g. a quiet sibling at the table)
  // from flickering to "elsewhere" just because one reply didn't name them.
  // A scene break starts presence fresh. Beyond the model's move flag and a time
  // skip, treat ANY change of the resolved location ENTITY as a break — if the
  // cursor genuinely moved to a different place, whoever was in the old room does
  // NOT carry into the new one (the "parents followed me into my bedroom" class).
  const placeEntityChanged =
    !!resolvedLocation &&
    !!currentLocation &&
    idString(resolvedLocation.entity_id) !== idString(currentLocation.entity_id)
  // An explicit physical exit proves the old room's cast is no longer with the
  // player even when the next room has not been named. Likewise, establishing
  // the very first concrete setting starts a fresh scene instead of carrying an
  // unanchored cast into it (the Mother/Charles-at-the-café bug).
  const sceneBroke =
    viewpointMoved ||
    playerSceneTransition ||
    playerExitedScene ||
    sceneEstablishedLocation ||
    !!narratedTimeLabel ||
    placeEntityChanged ||
    (endpointAdjudication.available && endpointAdjudication.playerViewpointAtEnd && endpointAdjudication.sceneTransition)
  // Resolve every presence name to a CANONICAL identity before set ops, using the
  // SAME registry the codex resolves with (normalizeEntityName over each card's
  // canonical_name + aliases). Without this, "the captain" and "Bram" are two
  // different lowercased strings — so a carried alias is dropped or double-counted.
  // Unknown walk-ons (no matching card) fall back to their normalized string, so
  // they are de-duped/departed correctly but never dropped.
  // presenceKeyOf → canonical IDENTITY key (for set ops); presenceDisplayOf →
  // the card's canonical SPELLING (for the surfaced label), so a carried alias
  // shows as "Bram", not whichever string happened to appear first. Unknown
  // walk-ons fall back to their own normalized key / original string.
  // normalizeEntityName does NOT strip leading articles, so "the father" never
  // matched the "father" card and leaked as a phantom present-character; and a
  // model-confabulated alias like "Sister Thompson" (Sister + surname, not a
  // real alias) split off as its own ghost. So beyond canonical/normalized/alias
  // keys we also index the ARTICLE-STRIPPED form ("the father" → "father") and a
  // conflict-safe FIRST TOKEN ("Sister Thompson"/"Mara Thompson" → the Sister
  // card) — the latter only when that token maps unambiguously to a single card.
  const articleStrip = (s: string) => s.replace(/^(?:the|a|an)\s+/, '').trim()
  const { presenceKeyOf, presenceDisplayOf, presenceIsKnown } = (() => {
    const byName = new Map<string, string>()
    const displayByKey = new Map<string, string>()
    const knownKeys = new Set<string>()
    // First-token → card, with collision detection: a token shared by two cards
    // (e.g. a common surname) is ambiguous and must NOT resolve to either.
    const firstTokenMap = new Map<string, string>()
    const ambiguousTokens = new Set<string>()
    const addAlias = (raw: string, canonKey: string) => {
      const k = normalizeEntityName(String(raw || ''))
      if (!k) return
      byName.set(k, canonKey)
      const stripped = articleStrip(k)
      if (stripped && stripped !== k) byName.set(stripped, canonKey)
      const tok = stripped.split(' ')[0]
      if (tok) {
        const prior = firstTokenMap.get(tok)
        if (prior && prior !== canonKey) ambiguousTokens.add(tok)
        else firstTokenMap.set(tok, canonKey)
      }
    }
    for (const c of characterCodex as any[]) {
      const canon = c?.canonical_name
      if (!canon) continue
      const canonKey = normalizeEntityName(String(canon))
      if (!canonKey) continue
      knownKeys.add(canonKey)
      displayByKey.set(canonKey, String(canon))
      addAlias(String(canon), canonKey)
      if (c?.name_normalized) addAlias(String(c.name_normalized), canonKey)
      for (const a of (c?.aliases || []) as string[]) addAlias(String(a || ''), canonKey)
    }
    for (const tok of ambiguousTokens) firstTokenMap.delete(tok)
    const keyOf = (name: string): string => {
      const n = normalizeEntityName(String(name || ''))
      const stripped = articleStrip(n)
      return byName.get(n) || byName.get(stripped) || firstTokenMap.get(stripped.split(' ')[0]) || stripped || n
    }
    return {
      presenceKeyOf: keyOf,
      presenceDisplayOf: (name: string): string => displayByKey.get(keyOf(name)) || name,
      presenceIsKnown: (name: string): boolean => knownKeys.has(keyOf(name)),
    }
  })()
  // The player must never appear in their own scene's present-cast. In a GM world
  // the player IS the is_protagonist card, so exclude that identity; in a sentient
  // world the is_protagonist card is the AI the player talks to (an "other") and
  // is force-added below, so it stays.
  const playerPresenceKey =
    !session.is_sentient && protagonistCard?.canonical_name
      ? presenceKeyOf(String(protagonistCard.canonical_name))
      : null
  const priorPresenceKeys = new Set(priorPresent.map((name) => presenceKeyOf(name)).filter(Boolean))
  const endpointPresenceNames = endpointAdjudication.playerViewpointAtEnd
    ? endpointAdjudication.present.map((entry) => entry.name)
    : []
  const endpointPresenceKeys = new Set(endpointPresenceNames.map((name) => presenceKeyOf(name)).filter(Boolean))
  if (endpointAdjudication.available) {
    const witnessOnlyNames = (parsed.present_characters || []).filter((name) => !endpointPresenceKeys.has(presenceKeyOf(name)))
    const endpointOnlyNames = endpointPresenceNames.filter((name) =>
      !(parsed.present_characters || []).some((witness) => presenceKeyOf(witness) === presenceKeyOf(name)),
    )
    if (witnessOnlyNames.length || endpointOnlyNames.length || !endpointAdjudication.playerViewpointAtEnd || sceneBroke) {
      log.info('scene.endpoint.reconciled', {
        instanceId: idString(instanceId),
        sequence: nextSequence,
        sceneBroke,
        playerViewpointAtEnd: endpointAdjudication.playerViewpointAtEnd,
        primaryOnly: witnessOnlyNames.slice(0, 12),
        endpointOnly: endpointOnlyNames.slice(0, 12),
        endpointPresent: endpointPresenceNames.slice(0, 12),
      })
    }
  }
  // A label that resolved to NO card AND is generic — an article-led role tag
  // ("the son") or an all-lowercase common noun ("guard") — is the player under a
  // role title or scene-dressing, not a trackable person. Drop it. An unresolved
  // CAPITALIZED proper name (a genuine new walk-on) is kept.
  const isGenericLabel = (raw: string): boolean => {
    const t = String(raw || '').trim()
    if (!t) return true
    if (/^(?:the|a|an)\s+/i.test(t)) return true
    if (!/[A-ZÀ-Þ]/.test(t)) return true
    return false
  }
  // Family-role NPCs are often introduced before they have proper-name cards,
  // especially GM premises like "your father / mother / twin sister". The
  // metadata model may surface them as lowercase labels ("sister", "father").
  // Those are generic-looking, but they are real scene participants and must
  // seed codex extraction. Keep child/self-facing labels out so the player does
  // not become a separate "Son" / "Child" card. TITLED role NPCs (butler,
  // captain, king, queen, prince, princess, lord, lady) are premise-backed in
  // the same way — the narration names the role, the character has no proper
  // name yet — so they are kept too. This list mirrors the
  // FAMILY_ROLE_WORDS set in scripts/presence-codex-gap-audit.ts and the
  // _familyRoleWords set in play_cubit.dart so the backend presence filter,
  // the audit, and the client miss-detector agree on what a "premise-backed
  // role NPC" is.
  const trackableFamilyLabels = new Set([
    'father',
    'mother',
    'mom',
    'dad',
    'parent',
    'parents',
    'sister',
    'brother',
    'sibling',
    'twin sister',
    'twin brother',
    'twin',
    'wife',
    'husband',
    'spouse',
    'partner',
    'fiancee',
    'fiance',
    'girlfriend',
    'boyfriend',
    'cousin',
    'aunt',
    'uncle',
    'grandmother',
    'grandfather',
    'grandma',
    'grandpa',
    'butler',
    'captain',
    'king',
    'queen',
    'prince',
    'princess',
    'lord',
    'lady',
  ])
  const familyPresenceLabel = (raw: string): string | null => {
    const n = articleStrip(normalizeEntityName(String(raw || '')))
      .replace(/^(?:my|your|his|her|their|our)\s+/, '')
      .trim()
    if (!trackableFamilyLabels.has(n)) return null
    return n
      .split(' ')
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
      .join(' ')
  }
  // ── TRAVELLING-WITH party (open-world limit #2) ──────────────────────────────
  // Companions who explicitly joined the player PERSIST across a scene break, unlike
  // co-located locals which reset. Opt-in + entity-bounded: a join counts only for a
  // real character (a known card or someone present this turn), never the player/
  // protagonist; cleared by an EXPLICIT parting (distinct from a mere scene-exit). An
  // empty set ⇒ identical to prior behaviour, so a solo player is unaffected.
  // Only the player can change the persistent travel roster. Narrator prose can
  // describe a quote, memory, or story-within-a-story that resembles a departure.
  const partyDepartures =
    confirmedWorldAction?.kind === 'travel' ? [] : detectCompanionDepartures(parsedPlayerInput.raw)
  const partyDepartedKeys = new Set(partyDepartures.map((d) => presenceKeyOf(d.name)).filter(Boolean))
  // "I ride back alone" names nobody, so no departure signal fires — but it is an
  // explicit statement that the party is empty. Without this the companion stays
  // in `travelling_with`, and travel-party membership skips scene-state
  // corroboration, so she is silently carried into every later scene.
  const soloTravel = !isContinuation && detectSoloTravel(parsedPlayerInput.raw)
  const partyRosterKeys = new Set<string>()
  for (const c of characterCodex as any[]) {
    const ck = presenceKeyOf(c.canonical_name)
    if (ck) partyRosterKeys.add(ck)
    for (const a of c.aliases || []) {
      const ak = presenceKeyOf(a)
      if (ak) partyRosterKeys.add(ak)
    }
  }
  const partyPresentKeys = new Set((parsed.present_characters || []).map((n) => presenceKeyOf(n)).filter(Boolean))
  const partyProtagKey = (() => {
    const p = (characterCodex as any[]).find((c) => c.is_protagonist)
    return p ? presenceKeyOf(p.canonical_name) : null
  })()
  // Party membership now carries PROVENANCE (world-authority), so the §5 companion
  // brief can tier it: who put them in the party, and how confident we are.
  type PartyMember = {
    name: string
    source: WorldFactSource
    confidence: number
  }
  const partyByKey = new Map<string, PartyMember>()
  // Carry forward the prior party, minus anyone who explicitly parted this turn.
  // Preserve each member's stored provenance; a legacy row without one predates
  // tracking → trusted as narrator/canon (the same legacy-trust default the tier
  // helper uses), never silently demoted.
  const explicitTravelParty =
    confirmedWorldAction?.kind === 'travel'
      ? new Set(confirmedWorldAction.companions.map((name) => presenceKeyOf(name)).filter(Boolean))
      : null
  const priorPartyKeys = new Set(
    (session.travelling_with || []).map((member: { name: string }) => presenceKeyOf(member.name)).filter(Boolean),
  )
  for (const m of session.travelling_with || []) {
    const k = presenceKeyOf(m.name)
    if (soloTravel) continue
    if (!k || partyDepartedKeys.has(k) || (explicitTravelParty && !explicitTravelParty.has(k))) continue
    const source = isWorldFactSource((m as { source?: unknown }).source)
      ? ((m as { source?: WorldFactSource }).source as WorldFactSource)
      : 'narrator'
    const confidence =
      typeof (m as { confidence?: unknown }).confidence === 'number'
        ? (m as { confidence: number }).confidence
        : confidenceFor(source)
    partyByKey.set(k, { name: m.name, source, confidence })
  }
  // Add explicit joiners — gated to real, non-protagonist characters — TAGGED by the
  // authority of the player's own narration ("I bring Mara").
  // Ledger accounting (FP/FN measurement): fresh joins committed this turn carry
  // their confidence; carry-forward and source-upgrades are not fresh detections.
  const freshPartyJoinConfidences: number[] = []
  const uncorroboratedPartyJoins: string[] = []
  // A companion enrols for the WHOLE RUN, so a fresh join is the most expensive
  // false positive in the presence system: until this turn a phrase match on the
  // player's own text was enough, and the enrolled person then rode along
  // through every later scene. A free-form join must now be corroborated by the
  // same evidence everyone else answers to — the endpoint judge citing them at
  // this turn's endpoint, or the entity judge showing them acting in the prose.
  // The structured travel control is exempt: that is the player operating the
  // product, not a model reading their prose.
  const endpointPresentKeys = new Set(endpointPresenceNames.map((n) => presenceKeyOf(n)).filter(Boolean))
  const joinCorroborated = (k: string, name: string): boolean =>
    endpointPresentKeys.has(k) || independentlyCorroboratedPeople.has(normalizeEntityName(name))
  const addJoins = (names: string[], source: WorldFactSource, requireCorroboration: boolean) => {
    for (const n of names) {
      const k = presenceKeyOf(n)
      if (!k || partyDepartedKeys.has(k)) continue
      if (playerPresenceKey && k === playerPresenceKey) continue
      if (partyProtagKey && k === partyProtagKey) continue
      if (!partyRosterKeys.has(k) && !partyPresentKeys.has(k)) continue
      if (requireCorroboration && !partyByKey.has(k) && !joinCorroborated(k, n)) {
        uncorroboratedPartyJoins.push(n)
        continue
      }
      const prev = partyByKey.get(k)
      if (prev && SOURCE_RANK[prev.source] <= SOURCE_RANK[source]) continue
      const confidence = confidenceFor(source)
      if (!prev) freshPartyJoinConfidences.push(confidence)
      partyByKey.set(k, { name: presenceDisplayOf(n), source, confidence })
    }
  }
  const playerJoinNames =
    confirmedWorldAction?.kind === 'travel'
      ? confirmedWorldAction.companions
      : detectCompanionJoins(parsedPlayerInput.raw)
  const partyJoinsDetected = new Set(playerJoinNames.map(presenceKeyOf).filter(Boolean)).size
  addJoins(playerJoinNames, 'player_narration', confirmedWorldAction?.kind !== 'travel')
  if (uncorroboratedPartyJoins.length > 0) {
    log.info('party.uncorroborated_join_refused', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      names: uncorroboratedPartyJoins,
    })
  }
  if (partyProtagKey) partyByKey.delete(partyProtagKey)
  // ── PARTY DECAY ─────────────────────────────────────────────────────────
  //
  // A companion used to be enrolled until an explicit parting phrase fired. If
  // that phrase never came — and in free prose it usually does not — they rode
  // along for the rest of the run no matter what the narration said. Scoping the
  // privilege to the scene break (above) stopped them overriding the prose; it
  // did not give them a way to LEAVE.
  //
  // So absence decays membership. On a scene break, a companion the endpoint
  // judge does not place with the player and the prose does not show acting has
  // missed this scene. Two consecutive misses and they are no longer travelling
  // with you. Any single appearance resets it, so a quiet companion is safe.
  const priorPartyMisses = new Map(
    ((session.travelling_with || []) as Array<{ name?: string; misses?: number }>)
      .map((m) => [presenceKeyOf(String(m.name || '')), Number(m.misses) || 0] as const)
      .filter(([key]) => key),
  )
  const partyMisses = new Map<string, number>()
  if (sceneBroke && endpointAdjudication.available) {
    for (const [key, member] of partyByKey) {
      const seen = endpointPresentKeys.has(key) || independentlyCorroboratedPeople.has(normalizeEntityName(member.name))
      const { misses, drop } = decidePartyDecay({ seenThisScene: seen, priorMisses: priorPartyMisses.get(key) || 0 })
      partyMisses.set(key, misses)
      if (drop) {
        partyByKey.delete(key)
        log.info('party.decayed', {
          instanceId: idString(instanceId),
          sequence: nextSequence,
          name: member.name,
          misses,
        })
      }
    }
  } else {
    for (const key of partyByKey.keys()) partyMisses.set(key, priorPartyMisses.get(key) || 0)
  }
  const partyMembers = [...partyByKey.values()].slice(0, 6)
  const partyNames = partyMembers.map((m) => m.name)
  const partyProvByName = new Map(partyMembers.map((m) => [normalizeEntityName(m.name), m]))

  const blockedUngroundedPresence: string[] = []
  const heldUncorroboratedPresence: string[] = []
  parsed.present_characters = (() => {
    // Phase 1: on a continuation, new admits come from the endpoint judge we
    // already pay for. Prior cast still carries (quiet people stay). Scene-break
    // is still the endpoint cast. Witness present_characters is the outage
    // fallback only — mixing it in on the happy path was the Isolde/Lyra class.
    const candidates = mergePresenceCandidates({
      sceneBroke,
      endpointAvailable: endpointAdjudication.available,
      endpointPresent: endpointPresenceNames,
      priorPresent,
      witnessPresent: parsed.present_characters || [],
      partyNames,
    })
    const departed = new Set((parsed.characters_departed || []).map((n) => presenceKeyOf(n)).filter(Boolean))
    const out: string[] = []
    const seen = new Set<string>()
    for (const name of candidates) {
      const key = presenceKeyOf(name)
      if (!key || seen.has(key) || departed.has(key)) continue
      if (playerPresenceKey && key === playerPresenceKey) continue
      // A player-authored transition (free-form or the travel control) is
      // authoritative about who did *not* automatically come along. The witness
      // can still introduce a new local in the destination, and explicit
      // travelling companions remain below, but stale names from the room left
      // behind cannot survive merely because the model mentioned them in a cutaway.
      if (playerForcesFreshCast && priorPresenceKeys.has(key) && !partyByKey.has(key)) continue
      // A known city, room, landmark, etc. is never a member of the scene cast.
      // Bias toward the location meaning on a collision; an actual character with
      // that unusual name needs an explicit card and can be resolved deliberately.
      if (knownPlacePresenceKeys.has(normalizeEntityName(name))) continue
      // A structured solo/smaller-party journey is authoritative: companions the
      // player deliberately left behind cannot leak into the destination merely
      // because the witness repeated a name from the previous scene.
      if (explicitTravelParty && priorPartyKeys.has(key) && !explicitTravelParty.has(key)) continue
      const familyLabel = !presenceIsKnown(name) ? familyPresenceLabel(name) : null
      if (!presenceIsKnown(name) && isGenericLabel(name) && !familyLabel) continue
      // An unknown participant is useful immediately as a witnessed scene fact,
      // but only when prose independently shows person-specific grammar. This
      // keeps automatic discovery (speech/action/body-language) while holding a
      // capitalization-only metadata guess out of travel, codex, and graph state.
      if (!presenceIsKnown(name) && !familyLabel && !independentlyCorroboratedPeople.has(normalizeEntityName(name))) {
        heldUncorroboratedPresence.push(name)
        continue
      }
      // A grounded-world metaphor ("the ghost in the doorway") is prose about
      // an existing person, not an unknown scene participant. Do not let a
      // witness result turn it into a durable character/entity. Carded beings
      // and supernatural-capable premises are allowed by the shared classifier.
      if (
        !presenceIsKnown(name) &&
        classifyChoiceGrounding(name, choiceGroundingContext).some((issue) => issue.type === 'ungrounded_being')
      ) {
        blockedUngroundedPresence.push(name)
        continue
      }
      seen.add(key)
      out.push(familyLabel || presenceDisplayOf(name))
      if (out.length >= 12) break
    }
    return out
  })()
  if (blockedUngroundedPresence.length > 0) {
    log.warn('presence.ungrounded_being_blocked', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      labels: blockedUngroundedPresence,
    })
  }
  if (heldUncorroboratedPresence.length > 0) {
    log.info('presence.uncorroborated_held', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      labels: heldUncorroboratedPresence,
    })
  }
  if (session.is_sentient) {
    const aiName =
      (characterCodex as any[]).find((c) => c.is_protagonist)?.canonical_name || session.protagonist?.name || null
    if (aiName && !parsed.present_characters.some((n) => presenceKeyOf(n) === presenceKeyOf(aiName))) {
      parsed.present_characters = [aiName, ...parsed.present_characters].slice(0, 12)
    }
  }
  if (blockedLifeStateKeys.size) {
    parsed.present_characters = parsed.present_characters.filter((name) => !blockedLifeStateKeys.has(normalizeEntityName(name)))
  }

  // ── SCENE STATE ─────────────────────────────────────────────────────────
  // Fold this turn into the authoritative model of the present moment. The cast
  // is a closed set: carrying someone forward is free, but ADMITTING someone new
  // requires justification. Previously that bar applied only to names with no
  // codex card, so an existing character could be teleported into any room by a
  // single hallucinated metadata field and then carried there indefinitely.
  //
  // The bar for a carded newcomer is deliberately the weakest sound one: the
  // prose has to mention them at all. A character the narration never names did
  // not walk into the room this turn.
  const proseCorroborated = (() => {
    const text = ` ${rawNarrative.toLowerCase().replace(/[^a-z0-9\s'-]+/g, ' ').replace(/\s+/g, ' ')} `
    const corroborated = new Set<string>(independentlyCorroboratedPeople)
    for (const name of independentlyCorroboratedPeople) corroborated.add(sceneIdentityKey(name))
    // Endpoint (a)∧(b)∧(c) is the corroboration for anyone the judge admitted.
    // Scene-break seq 38 paid for `Tomas hasn't moved` and the verb-list then
    // recorded `uncorroborated_arrival`. Continuations now use the same seed so
    // a verified arrival is not asked to also beat ACTION_VERBS adjacency.
    if (endpointAdjudication.available && endpointAdjudication.playerViewpointAtEnd) {
      const seeded: string[] = []
      for (const verdict of endpointAdjudication.citationVerdicts) {
        if (!verdict.a || !verdict.b || !verdict.c) continue
        const presenceKey = normalizeEntityName(verdict.name)
        const identityKey = sceneIdentityKey(verdict.name)
        if (presenceKey) corroborated.add(presenceKey)
        if (identityKey) corroborated.add(identityKey)
        seeded.push(verdict.name)
      }
      if (seeded.length > 0) {
        log.info('presence.endpoint_corroborated', {
          instanceId: idString(instanceId),
          sequence: nextSequence,
          labels: seeded.slice(0, 12),
        })
      }
    }
    // Being NAMED is not being PRESENT. An earlier version accepted any
    // occurrence of the name, and a passing reference to something a character
    // had said a day's ride away ("the rations Bram had noted") put him at the
    // top of a ruined watchtower, where carry-forward kept him for the rest of
    // the scene. Require the prose to show the person actually participating —
    // speaking, acting, being addressed — using the same evidence patterns the
    // trackable-mention gate uses, so the two can never disagree.
    const mentioned = (surface: string): boolean => {
      const phrase = String(surface || '').trim()
      if (normalizeEntityName(phrase).length < 3) return false
      // Structural shape first (any sentence where this person is the subject),
      // then the ACTION half of the pattern list. The IDENTITY half is not
      // consulted here: an appositive, a title-name or a possessive kinship
      // phrase proves who somebody is, never that they are in the room, and
      // running it over a whole passage is how "Mara, my sister, had been gone
      // for years" corroborated Mara's arrival. openingCast keeps the full
      // grammar — the authored seed has no judge to delegate identity to.
      if (showsParticipationInPassage(phrase, rawNarrative)) return true
      if (hasSceneParticipationGrammar(phrase, rawNarrative, { evidence: 'action' })) return true
      // Prose names a titled cast member bare ("Ardren" for Lord Ardren), so
      // test the distinctive tokens too — still against scene-participation
      // grammar, never against a bare occurrence.
      for (const token of phrase.split(/\s+/)) {
        const normalized = normalizeEntityName(token)
        if (normalized.length < 3 || PRESENCE_TITLE_WORDS.has(normalized)) continue
        if (showsParticipationInPassage(token, rawNarrative)) return true
        if (hasSceneParticipationGrammar(token, rawNarrative, { evidence: 'action' })) return true
      }
      return false
    }
    for (const name of parsed.present_characters || []) {
      const presenceKey = normalizeEntityName(name)
      if (!presenceKey || corroborated.has(presenceKey)) continue
      const card = (characterCodex as any[]).find(
        (c) =>
          normalizeEntityName(c?.canonical_name || '') === presenceKey ||
          (c?.aliases || []).some((a: string) => normalizeEntityName(a) === presenceKey),
      )
      const surfaces = card
        ? ([card.canonical_name, ...(card.aliases || [])].filter(Boolean) as string[])
        : [name]
      // Scene membership is keyed title-insensitively ("Crown Prince Doran" and
      // "Doran" are one man), so the corroboration set must answer to the SAME
      // key or every titled character is refused entry to their own scene.
      if (surfaces.some(mentioned)) {
        corroborated.add(presenceKey)
        corroborated.add(sceneIdentityKey(name))
      }
    }
    return corroborated
  })()

  // The player is never a member of their own scene cast. The existing presence
  // filter keys off the protagonist CARD, which does not exist on the opening
  // turns — so name the persona/protagonist directly rather than relying on a
  // card that may not have been minted yet.
  const sceneExcludedKeys = (() => {
    const keys = new Set<string>()
    for (const raw of [
      choiceProtagonist?.name,
      ...(choiceProtagonist?.aliases || []),
      session.persona_snapshot?.name,
      session.protagonist?.name,
      ...(session.is_sentient ? [] : [(characterCodex as any[]).find((c) => c?.is_protagonist)?.canonical_name]),
    ]) {
      const full = normalizeEntityName(String(raw || ''))
      if (!full) continue
      keys.add(full)
      // The prose calls the protagonist "Aurelian" while the persona is
      // "Aurelian Marek", so a whole-name comparison never matches and the
      // player ends up listed as a member of their own scene.
      for (const token of full.split(' ')) {
        if (token.length >= 3 && !PRESENCE_TITLE_WORDS.has(token)) keys.add(token)
      }
    }
    return keys
  })()

  const verifiedPhysicalCloses = (() => {
    const haystack = ` ${`${rawNarrative} ${parsedPlayerInput.raw}`
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')} `
    const kept: string[] = []
    for (const close of parsed.physical_state_closed || []) {
      const needle = String(close?.evidence || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      // Too short to be a real citation, or simply not in the text.
      if (needle.split(' ').filter((w) => w.length > 2).length < 2) continue
      if (!haystack.includes(` ${needle} `) && !haystack.includes(needle)) {
        log.info('scene_state.close_rejected', {
          instanceId: idString(instanceId),
          sequence: nextSequence,
          statement: close?.statement,
          evidence: close?.evidence,
        })
        continue
      }
      kept.push(String(close.statement))
    }
    return kept
  })()

  // True while the only prose behind us is the AUTHORED OPENING, so the room has
  // never been furnished by a generated turn.
  const openingScene =
    !packet.sceneState ||
    (packet.sceneState.cast.length === 0 &&
      recentEvents.filter((e: any) => String(e?.data?.ai_response || '').trim()).length <= 1)

  // The AUTHORED OPENING furnishes the room, and it is the one piece of prose in
  // the world that is source canon rather than model output. The opening turn had
  // been trusting the extractor's report for its cast — so a character the author
  // explicitly placed in the scene ("Your sister Neva leans against the hearth")
  // was simply absent if that one cheap pass failed to list her. The closed-set
  // rule then made the omission permanent, and the scene-state block went on to
  // tell the narrator "Nobody else is present" — which is how a live run had the
  // narrator write the player's sister out of the hall she was standing in.
  //
  // Seed the opening cast from the codex cards the opening prose actually shows
  // participating. Same evidence bar as every other admission, so a character the
  // opening only NAMES in passing still has to earn their way in.
  const openingCast: Array<{ name: string }> = (() => {
    if (!openingScene) return []
    const authored = String(
      (recentEvents || []).find((event: any) => event?.data?.model_used === 'seed')?.data?.ai_response || '',
    )
    if (!authored.trim()) return []
    const out: Array<{ name: string }> = []
    for (const card of (characterCodex as any[]) || []) {
      const canonical = String(card?.canonical_name || '').trim()
      if (!canonical || card?.is_protagonist) continue
      if (sceneExcludedKeys.has(normalizeEntityName(canonical))) continue
      // The author writes a card's full name on one line and its bare form on the
      // next, so test every surface the card answers to plus its distinctive
      // tokens — "Neva" is how the opening names "Neva Vale".
      const surfaces = new Set<string>([canonical, ...((card?.aliases || []) as string[])])
      for (const surface of [...surfaces]) {
        for (const token of String(surface).split(/\s+/)) {
          if (normalizeEntityName(token).length >= 3 && !PRESENCE_TITLE_WORDS.has(normalizeEntityName(token))) {
            surfaces.add(token)
          }
        }
      }
      if ([...surfaces].some((surface) => hasSceneParticipationGrammar(surface, authored))) {
        out.push({ name: canonical })
      }
    }
    return out
  })()

  const sceneDerivation = deriveNextSceneState({
    prior: packet.sceneState,
    sequence: nextSequence,
    sceneBroke,
    place: locationAnchor
      ? { entity_id: (locationAnchor as any).entity_id ?? null, name: (locationAnchor as any).name || '' }
      : null,
    reportedPresent: [
      ...(parsed.present_characters || [])
        .filter((name) => !sceneExcludedKeys.has(normalizeEntityName(name)))
        .map((name) => ({ name })),
      ...openingCast,
    ],
    departed: parsed.characters_departed || [],
    corroborated: proseCorroborated,
    travelParty: partyNames,
    physicalOpened: (parsed.physical_state_opened || []).map((fact) => ({
      kind: fact.kind,
      statement: fact.statement,
      actors: fact.actors || [],
      since_sequence: nextSequence,
    })),
    // A close is honored only when its excerpt is really in the text. Asked
    // "which of these ended?", a small model echoes the whole list back — on a
    // live run it closed a collar grip on the very turn the player wrote "I hold
    // him tighter". Requiring a citation is the same machine-checked discipline
    // this codebase already applies to location and bond evidence.
    physicalClosed: verifiedPhysicalCloses,
    protagonistNames: [...sceneExcludedKeys],
    // The authored opening furnishes the room; nothing else has yet.
    openingScene,
  })
  const sceneState = sceneDerivation.state
  log.info('scene_state.derived', {
    instanceId: idString(instanceId),
    sequence: nextSequence,
    broke: sceneBroke,
    cast: sceneState.cast.map((c) => c.name),
    physIn: (packet.sceneState?.physical || []).map((f) => f.statement),
    physOpened: (parsed.physical_state_opened || []).map((f) => f.statement),
    physClosed: verifiedPhysicalCloses,
    physOut: sceneState.physical.map((f) => f.statement),
  })
  // The scene roster is now the authority, so presence follows it rather than
  // the other way round — one list, one writer, no second opinion for the UI.
  parsed.present_characters = sceneState.cast.map((member) => member.name)
  if (sceneDerivation.contradictions.length > 0) {
    log.warn('scene_state.contradictions', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      contradictions: sceneDerivation.contradictions,
    })
    for (const contradiction of sceneDerivation.contradictions.slice(0, 4)) {
      void recordAnomaly({
        instanceId: instanceOid,
        playerId: playerOid,
        eventId: null,
        sequence: nextSequence,
        type: 'scene_contradiction',
        severity: 'warn',
        details: `${contradiction.kind}: ${contradiction.details}`,
      })
    }
  }

  // WITNESS → ENTITY-STUB tier: every present person the scene just showed who
  // isn't already a codex card gets a lightweight stub entity before the turn is
  // released. Codex extraction remains async below, but stubs must exist before
  // the next turn can start so kinship/choice/memory graph reads do not race.
  const knownCardNames = new Set<string>()
  for (const c of (characterCodex as any[]) || []) {
    if (!c?.canonical_name) continue
    knownCardNames.add(normalizeEntityName(c.canonical_name))
    for (const a of (c.aliases || []) as string[]) {
      const n = normalizeEntityName(a)
      if (n) knownCardNames.add(n)
    }
  }
  if (session.is_sentient) {
    if (session.persona_snapshot?.name) {
      knownCardNames.add(normalizeEntityName(session.persona_snapshot.name))
    }
    const selfIntro = detectSelfIntroName(parsedPlayerInput.raw)
    if (selfIntro) knownCardNames.add(normalizeEntityName(selfIntro))
  }
  const presenceGapExcludes: string[] = []
  if (session.is_sentient && session.persona_snapshot?.name) {
    presenceGapExcludes.push(session.persona_snapshot.name)
  }
  const selfIntroForGap = session.is_sentient ? detectSelfIntroName(parsedPlayerInput.raw) : null
  if (selfIntroForGap) presenceGapExcludes.push(selfIntroForGap)
  // Prose refers to a titled cast member by their bare name ("Ardren" for Lord
  // Ardren, "Holt" for Bram Holt). The gap classifier compares on exact
  // normalized names, so it reported those as untracked strangers on EVERY
  // turn — logging a false anomaly each time and, worse, minting a `bram` stub
  // entity beside the real `bram holt` card. That is the same identity split
  // that froze a whole playthrough, arriving by a different door. Exclude every
  // distinctive token of anyone already in the scene or on a card.
  for (const name of [...sceneState.cast.map((m) => m.name), ...knownCardNames]) {
    const normalized = normalizeEntityName(String(name || ''))
    if (!normalized) continue
    presenceGapExcludes.push(normalized)
    for (const token of normalized.split(' ')) {
      if (token.length >= 3 && !PRESENCE_TITLE_WORDS.has(token)) presenceGapExcludes.push(token)
    }
  }
  // Backend-OWNED trackable mentions: classify the turn's presence/codex gaps into
  // confidence tiers. Only CONFIRMED (a person-grammar signal: speech/action verb,
  // address, appositive, title, or possessive-kinship) joins present_characters and
  // mints stubs — see isActionableMention. Probable/mentioned_only are NOT actionable:
  // candidates are keyed on capitalization alone, so a repeated capitalized adverb
  // ("Downstairs") would otherwise be stubbed as a person. The signal gate kills that
  // class without a stop-word denylist. Off TTFT — prose already streamed.
  const classifiedMentions = classifyPresenceCodexGaps(rawNarrative, {
    present: parsed.present_characters,
    codex: [...knownCardNames],
    exclude: [...presenceGapExcludes, ...knownPlacePresenceKeys],
  })
  const adjudicatedCandidateKeys = new Set(entityCandidates.map((candidate) => normalizeEntityName(candidate.key)))
  const actionableMentions = classifiedMentions
    .filter(isActionableMention)
    // The late gap backstop is allowed to discover a candidate only once. If
    // the semantic judge already examined it, never let this second path undo a
    // not_person/uncertain verdict and mint the very stub the gate rejected.
    .filter((mention) =>
      !entityAdjudication.available ||
      !adjudicatedCandidateKeys.has(normalizeEntityName(mention.key)) ||
      independentlyCorroboratedPeople.has(normalizeEntityName(mention.key)),
    )
  // Never offer the player a "track this person" underline for someone already
  // standing in the room. The gap classifier compares on a plain normalization,
  // so it reports the bare surname of a titled cast member as an untracked
  // stranger; the cast's own identity key is what settles who is already here.
  const sceneCastKeys = new Set(sceneState.cast.map((member) => sceneIdentityKey(member.name)))
  const trackableMentions = actionableMentions
    .filter((m) => {
      const k = sceneIdentityKey(m.display)
      return !!k && !sceneCastKeys.has(k) && !sceneExcludedKeys.has(k)
    })
    .map((m) => ({
      key: m.key,
      display: m.display,
      tier: m.tier,
      evidence: m.evidence,
    }))
  const presentGaps = actionableMentions
    // Do not let the late walk-on promotion path undo endpoint verification on
    // a boundary. It is allowed only when the same evidence witness placed the
    // person with the player at the end of the prose.
    .filter((mention) => !sceneBroke || !endpointAdjudication.available || endpointPresenceKeys.has(presenceKeyOf(mention.display)))
  if (presentGaps.length) {
    // Admit late walk-ons THROUGH scene state, never alongside it. This used to
    // push straight onto present_characters after the cast was already closed,
    // and it keyed on a plain normalization — so "Ardren" and "Holt" were
    // appended next to "Lord Ardren" and "Bram Holt" and the same two men stood
    // in the room four times. A second writer to presence is the exact problem
    // scene state exists to remove; these are corroborated arrivals by
    // construction (isActionableMention requires person-grammar in the prose),
    // so they join the cast under the cast's own identity key.
    const presentSeen = new Set(sceneState.cast.map((member) => sceneIdentityKey(member.name)))
    for (const gap of presentGaps) {
      if (sceneState.cast.length >= 12) break
      const gapKey = sceneIdentityKey(gap.display)
      if (!gap.key || !gapKey || presentSeen.has(gapKey)) continue
      if (sceneExcludedKeys.has(gapKey)) continue
      presentSeen.add(gapKey)
      sceneState.cast.push({
        entity_id: null,
        name: gap.display,
        since_sequence: nextSequence,
        source: 'arrival',
      })
    }
    parsed.present_characters = sceneState.cast.map((member) => member.name)
    log.info('presence.gaps.stubbed.live', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      gaps: presentGaps.map((g) => `${g.key}:${g.tier}`).slice(0, 8),
      mentioned_only: classifiedMentions
        .filter((m) => m.tier === 'mentioned_only')
        .map((m) => m.key)
        .slice(0, 8),
    })
  }
  // Witness-tier provenance: confidence per stub from the presence tier (confirmed
  // > probable), plus this turn's event + place, so a stub can later wake by name,
  // kin edge, or returning to where it was seen (see entity stub lifecycle, §5).
  const eventId = new ObjectId()
  const stubConfidenceByName = new Map<string, number>()
  for (const m of classifiedMentions) {
    if (m.tier === 'confirmed') stubConfidenceByName.set(m.key, 0.9)
    else if (m.tier === 'probable') stubConfidenceByName.set(m.key, 0.6)
  }
  const stubResult = await entityGraphService
    .ensureSceneParticipantStubs({
      instanceId,
      playerId,
      sequence: nextSequence,
      presentNames: parsed.present_characters,
      knownCardNames,
      sourceEventId: eventId,
      locationEntityId: locationAnchor?.entity_id ?? null,
      confidenceByName: stubConfidenceByName,
    })
    .catch((err) => {
      console.warn('scene participant stubs skipped:', (err as Error).message)
      return { ensured: [] as string[], promoted: [] as string[] }
    })
  if (stubResult.ensured.length) {
    log.info('scene.participant.stubs', {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      ensured: stubResult.ensured,
    })
  }
  entityGraphService
    .archiveStaleStubs({ instanceId, sequence: nextSequence })
    .then((res) => {
      if (res.archived > 0 || res.anchored > 0 || res.dormant > 0) {
        log.info('scene.participant.stubs.reconciled', {
          instanceId: idString(instanceId),
          sequence: nextSequence,
          archived: res.archived,
          anchored: res.anchored,
          dormant: res.dormant,
        })
      }
    })
    .catch((err) => {
      console.warn('stale stub archival skipped:', (err as Error).message)
    })

  const timeAnchor = await timeService.anchorForNextEvent({
    instanceId,
    templateId: String(session.template_id),
    previous: currentTimeAnchor || session.current_time_anchor || null,
    previousEventId,
    sequence: nextSequence,
    realTime: eventCreatedAt,
    timeAdvancedLabel: effectiveTimeAdvance,
    eventTimeLabel: effectiveTimeAdvance || undefined,
    timelineId: session.active_timeline_id || currentTimeAnchor?.timeline_id || null,
  })

  // Off the TTFT path (the prose already streamed): for a borderline turn, ask
  // the cheap intent judge whether the PLAYER expressed sexual intent in clean
  // language the lexicon missed. This does NOT change the turn that just streamed;
  // it persists `nsfw_intent` so scoreScene's momentum routes the NEXT turn to the
  // explicit model. Gated + fail-safe: classifyBorderlineIntent returns 'sfw' when
  // disabled or on any error. Scene momentum and the Ardent preference can select
  // a model for THIS turn, but neither is proof that this particular turn should
  // perpetuate NSFW routing.
  const judgedNsfwIntent = borderlineForIntent ? (await classifyBorderlineIntent(classifyText)) === 'nsfw' : false
  const nsfwIntent = judgedNsfwIntent || currentTurnScore >= 3
  const nsfwIntentSource: 'direct_explicit' | 'intent_judge' | undefined = judgedNsfwIntent
    ? 'intent_judge'
    : currentTurnScore >= 3
      ? 'direct_explicit'
      : undefined

  // Ledger this turn's location changes (anchor + containment + state + enduring
  // facts), authority-tagged, so the place graph is a rebuildable projection like
  // codex_deltas/relation_assertions. Containment/state/facts are witness-derived →
  // narrator authority; the ANCHOR (the move) carries the real move provenance, so a
  // player-narrated relocation the witness under-flagged is still ledgered (and
  // outranks a narrator one on rebuild).
  const locationDeltas: import('../../src/models/world-event.model').LocationDeltaDoc[] = []
  if (locationAnchor?.name && (viewpointMoved || sceneEstablishedLocation)) {
    locationDeltas.push({
      type: 'location_anchor',
      name: locationAnchor.name,
      source: locationSource,
      confidence: locationConfidence,
      sequence: nextSequence,
    })
  }
  if (approvedContainmentHint) {
    locationDeltas.push({
      type: 'containment',
      name: approvedContainmentHint,
      source: 'narrator',
      confidence: 0.9,
      sequence: nextSequence,
    })
  }
  for (const s of parsed.location_state_changes || []) {
    locationDeltas.push({
      type: 'location_state',
      name: s,
      source: 'narrator',
      confidence: 0.9,
      sequence: nextSequence,
    })
  }
  for (const f of parsed.location_permanent_facts || []) {
    locationDeltas.push({
      type: 'location_fact',
      name: f,
      source: 'narrator',
      confidence: 0.9,
      sequence: nextSequence,
    })
  }

  // The stream has conclusively ended. Persist the sidecar on THIS player turn
  // if it was eligible; waiting here can only defer back-office completion, not
  // first token, visible prose, choices, or a completed response. The extractor
  // itself fails closed to [], so this cannot fail the canonical event.
  const interactionSignals = interactionSignalPromise
    ? await interactionSignalPromise
    : []

  const event = {
    _id: eventId,
    instance_id: instanceOid,
    player_id: playerOid,
    sequence: nextSequence,
    type:
      timeAdvanceLabel && !confirmedWorldAction
        ? 'calendar_tick'
        : isTravel
          ? 'travel'
          : parsed.scene_tag === 'intimate'
            ? 'intimate'
            : 'narration',
    data: {
      player_input: storedPlayerInput,
      player_spoken_input: storedPlayerSpokenInput,
      player_narration_facts: storedPlayerNarrationFacts,
      ...(interactionSignals.length ? { interaction_signals: interactionSignals } : {}),
      ...(characterLifecycleDeltas.length ? { character_lifecycle_deltas: characterLifecycleDeltas } : {}),
      ...(confirmedWorldAction ? { world_action: confirmedWorldAction } : {}),
      ai_response: parsed.narrative,
      beat_ledger: parsed.beat_ledger,
      choices: parsed.choices,
      milestone: parsed.milestone,
      present_characters: parsed.present_characters,
      // The authoritative present moment. Stored on the event so it rewinds for
      // free — deleting turns restores the previous snapshot with no repair.
      scene_state: sceneState,
      trackable_mentions: trackableMentions,
      ...(locationDeltas.length ? { location_deltas: locationDeltas } : {}),
      ...(effectiveTimeAdvance ? { time_advanced: effectiveTimeAdvance } : {}),
      ...(effectiveTimeAdvance && timeSource
        ? {
            time_delta: {
              label: effectiveTimeAdvance,
              source: timeSource,
              confidence: timeConfidence,
              sequence: nextSequence,
            },
          }
        : {}),
      ...(isTravel && currentLocation && resolvedLocation
        ? { travel: { from: currentLocation.name, to: resolvedLocation.name } }
        : {}),
      ...(fateThread ? { fate_thread: fateThread } : {}),
      replay_variants: [
        {
          id: `base_${Date.now()}`,
          narrative: parsed.narrative,
          model_used: modelId,
          created_at: new Date(),
          source: 'base',
          choices: parsed.choices,
          present_characters: parsed.present_characters,
          beat_ledger: parsed.beat_ledger,
          retrieval_profile: {
            lore_top_k: session.max_lore_results || 10,
            memory_top_k: session.max_context_memories || 25,
            recent_event_window: 6,
          },
        },
      ],
      selected_replay_index: 0,
      state_mutations: parsed.state_mutations,
      flag_mutations: parsed.flag_mutations,
      model_used: modelId,
      ...(modelId !== requestedModelId ? { requested_model: requestedModelId } : {}),
      ...(fallbackAttempts.length ? { fallback_attempts: fallbackAttempts } : {}),
      tokens_in: countTokens(JSON.stringify(prompt.messages)),
      tokens_out: countTokens(parsed.narrative),
      prose_hygiene_issues: proseHygieneIssues,
      codex_projection_status: 'pending' as const,
    },
    is_user_edited: false,
    edit_history: [],
    scene_tag: parsed.scene_tag,
    ...(nsfwIntent ? { nsfw_intent: true, nsfw_intent_source: nsfwIntentSource } : {}),
    time_anchor: timeAnchor,
    location_anchor: locationAnchor,
    created_at: eventCreatedAt,
  }

  await mongoColl.events().insertOne(event)
  // Materialize only after the event is durable; the ledger remains source of
  // truth and rewind/replay reconstructs this projection from surviving rows.
  await characterCodexService.applyLifecycleDeltas({
    instanceId,
    deltas: characterLifecycleDeltas,
  }).catch((err) => {
    log.warn('character.lifecycle_projection_failed', { instanceId, error: (err as Error).message })
  })
  const eventIdStr = idString(event._id)
  try {
  await stagePostProcess({
    instanceId,
    playerId,
    eventId: eventIdStr,
    kind: 'memory_curation',
    payload: {
      instanceId, playerId, eventId: eventIdStr,
      playerInput: parsedPlayerInput.raw,
      playerSpokenInput: parsedPlayerInput.spoken,
      playerNarrationFacts: parsedPlayerInput.narrationFacts,
      aiResponse: rawNarrative,
      precedingAiResponse: recentEvents[recentEvents.length - 1]?.data?.ai_response || null,
      sceneTag: parsed.scene_tag,
      isSentient: !!session.is_sentient,
      playerPersonaName: session.persona_snapshot?.name || null,
      protagonistName: (characterCodex as any[]).find((c) => c.is_protagonist)?.canonical_name || session.protagonist?.name || null,
    },
  })
  await stagePostProcess({
    instanceId,
    playerId,
    eventId: eventIdStr,
    kind: 'character_projection',
    payload: { instanceId, playerId, eventId: eventIdStr },
  })
  } catch (err) {
    // The canonical event is already durable. Never turn an outbox outage into
    // a player-visible tail failure; the periodic repair worker will reconcile it.
    console.error('post-process outbox staging failed:', (err as Error).message)
  }

  // Refresh the materialized location_stats projection for the place this turn was
  // anchored to — AFTER the event is inserted, so its event_count / last_seen_sequence
  // include this turn (resolving the anchor earlier happens before the insert).
  // Fire-and-forget: projection maintenance never blocks or fails the player's turn.
  if (locationAnchor?.entity_id) {
    void locationService.refreshLocationStat(idString(instanceId), idString(locationAnchor.entity_id))
    // Canon Brief (positions): stamp every present character's last-known location
    // to here, so a later "go find X" / "where is X" resolves. Off the response path.
    void entityGraphService.recordCharacterLocations({
      instanceId: idString(instanceId),
      names: parsed.present_characters || [],
      locationEntityId: idString(locationAnchor.entity_id),
      sequence: nextSequence,
    })
  }

  const backedState = positiveLocationStateFromInput(
    parsedPlayerInput.raw,
    locationAnchor?.name || currentLocation?.name || null,
  )
  if (backedState.length > 0) {
    const existing = new Set((parsed.location_state_changes || []).map((s) => s.toLowerCase()))
    parsed.location_state_changes = [
      ...(parsed.location_state_changes || []),
      ...backedState.filter((s) => !existing.has(s.toLowerCase())),
    ].slice(0, 6)
  }

  // Record what changed about the current place this turn onto its location
  // entity (mutable state + enduring canon, both event-sourced for rewind/edit
  // pruning). Fire-and-forget — it feeds FUTURE turns, not this response.
  if (
    // A provisional anchor is not a map node, so it has no place to hang canon
    // facts on. They are simply not recorded until the place is promoted.
    locationAnchor?.entity_id &&
    ((parsed.location_state_changes?.length || 0) > 0 || (parsed.location_permanent_facts?.length || 0) > 0)
  ) {
    entityGraphService
      .applyLocationFacts({
        instanceId,
        locationEntityId: locationAnchor.entity_id,
        sequence: nextSequence,
        eventId: event._id,
        state: parsed.location_state_changes,
        facts: parsed.location_permanent_facts,
      })
      .catch((err) => console.warn('applyLocationFacts failed:', (err as Error).message))
  }

  // Non-blocking observability log: which model handled this turn + NSFW path.
  // Fire-and-forget — never let logging affect the player's turn.
  mongoColl
    .generationLogs()
    .insertOne({
      _id: new ObjectId(),
      instance_id: instanceOid,
      player_id: playerOid,
      sequence: nextSequence,
      is_nsfw_capable: !!session.is_nsfw_capable,
      user_nsfw_enabled: !!userNsfwEnabled,
      scene_classification: sceneClassification,
      nsfw_path: isNsfwTurn,
      model_used: modelId,
      ...(modelId !== requestedModelId ? { requested_model: requestedModelId } : {}),
      ...(fallbackAttempts.length ? { fallback_attempts: fallbackAttempts } : {}),
      metadata_model: AI_MODELS.metadata,
      tokens_in: event.data.tokens_in,
      tokens_out: event.data.tokens_out,
      llm_calls: snapshotLLMUsage(),
      prose_hygiene_issues: proseHygieneIssues,
      latency_ms: latencyMs,
      ttft_ms: ttftMs,
      queue_wait_ms: queueWaitMs,
      context_latency_ms: contextLatencyMs,
      end_to_end_ttft_ms: endToEndTtftMs,
      created_at: new Date(),
    })
    .catch((err) => console.warn('generation_log insert failed:', (err as Error).message))

  mongoColl
    .extractorRaw()
    .insertOne({
      _id: new ObjectId(),
      instance_id: instanceOid,
      player_id: playerOid,
      event_id: event._id,
      sequence: nextSequence,
      stages: extractorRaw.stages,
      ...(endpointAdjudication.citationVerdicts.length
        ? { citation_verdicts: endpointAdjudication.citationVerdicts }
        : {}),
      created_at: new Date(),
    })
    .catch((err) => console.warn('extractor_raw insert failed:', (err as Error).message))

  const sceneTag = parsed.scene_tag
  const currentScene = session.current_scene
  const sameScene = currentScene.tag === sceneTag
  const rawTurnCount = sameScene ? currentScene.turn_count + 1 : 1
  // Summarize a scene in NON-OVERLAPPING blocks: once a same-type scene reaches
  // the block size, fold those turns into one recap and RESET the counter — so
  // we don't re-summarize the trailing window on every subsequent turn (which
  // previously burned an LLM call per turn and piled up overlapping rows).
  const shouldSummarize = sameScene && rawTurnCount >= SCENE_SUMMARY_BLOCK
  const newTurnCount = shouldSummarize ? 0 : rawTurnCount

  // Resolve the travelling-with party to entity-bounded rows (drop any name that
  // doesn't map to a real character entity), to persist on the instance. A departed
  // companion with a stated destination that matches a KNOWN place updates their
  // position (no off-screen minting — fog-of-war), so "where is X" stays truthful.
  let travellingWith: Array<{
    entity_id: import('mongodb').ObjectId
    name: string
    source: WorldFactSource
    confidence: number
    misses: number
  }> = []
  if (partyNames.length) {
    const partyNorms = partyNames.map((n) => normalizeEntityName(n))
    const partyEntities = (await mongoColl
      .entities()
      .find(
        {
          instance_id: instanceOid,
          type: { $in: ['character', 'protagonist'] },
          name_normalized: { $in: partyNorms },
        },
        { projection: { _id: 1, canonical_name: 1, name_normalized: 1 } },
      )
      .toArray()
      .catch(() => [])) as Array<{
      _id: import('mongodb').ObjectId
      canonical_name?: string
      name_normalized?: string
    }>
    const byNorm = new Map(partyEntities.map((e) => [e.name_normalized || '', e]))
    for (const n of partyNames) {
      const e = byNorm.get(normalizeEntityName(n))
      if (e?._id) {
        const prov = partyProvByName.get(normalizeEntityName(n))
        const source = prov?.source ?? 'narrator'
        travellingWith.push({
          entity_id: e._id,
          name: e.canonical_name || n,
          source,
          confidence: prov?.confidence ?? confidenceFor(source),
          misses: partyMisses.get(presenceKeyOf(n)) || 0,
        })
      }
    }
  }
  for (const d of partyDepartures) {
    if (!d.destination) continue
    const place = (await mongoColl
      .entities()
      .findOne(
        {
          instance_id: instanceOid,
          type: 'location',
          name_normalized: normalizeEntityName(d.destination),
        },
        { projection: { _id: 1 } },
      )
      .catch(() => null)) as { _id: import('mongodb').ObjectId } | null
    if (place?._id) {
      void mongoColl.entities().updateMany(
        {
          instance_id: instanceOid,
          type: { $in: ['character', 'protagonist'] },
          name_normalized: normalizeEntityName(d.name),
        },
        {
          $set: {
            last_location_entity_id: place._id,
            last_location_sequence: nextSequence,
            updated_at: new Date(),
          },
        } as never,
      )
    }
  }

  const instanceUpdate: Record<string, unknown> = {
    $set: {
      world_state: newWorldState,
      active_flags: newFlags,
      current_scene: {
        tag: sceneTag,
        turn_count: newTurnCount,
        summary_pending: shouldSummarize,
      },
      current_time_anchor: timeAnchor,
      active_timeline_id: timeAnchor.timeline_id,
      default_calendar_id: timeAnchor.story_calendar?.calendar_id,
      current_location: locationAnchor,
      travelling_with: travellingWith,
      'meta.last_active_at': new Date(),
      updated_at: new Date(),
      ...(fateThread ? { 'meta.last_fate_seed_sequence': nextSequence } : {}),
    },
    $inc: {
      'meta.total_events': 1,
      'meta.total_tokens_consumed': event.data.tokens_in + event.data.tokens_out,
    },
  }
  if (parsed.milestone) {
    instanceUpdate.$push = {
      'meta.milestones': {
        $each: [{ label: parsed.milestone, sequence: nextSequence, at: new Date() }],
        $slice: -50,
      },
    }
  }
  await mongoColl.worldInstances().updateOne({ _id: instanceOid }, instanceUpdate as never)

  const updatedSession = {
    ...session,
    world_state: newWorldState,
    active_flags: newFlags,
    current_scene: {
      tag: sceneTag,
      turn_count: newTurnCount,
      summary_pending: shouldSummarize,
    },
    current_time_anchor: timeAnchor,
    active_timeline_id: timeAnchor.timeline_id,
    default_calendar_id: timeAnchor.story_calendar?.calendar_id
      ? idString(timeAnchor.story_calendar.calendar_id)
      : session.default_calendar_id,
    current_location: locationAnchor
      ? {
          ...locationAnchor,
          entity_id: idString(locationAnchor.entity_id),
        }
      : null,
    // Cleared by a repair or by any turn the anchor agrees with the cursor, so a
    // one-off bad read can never accumulate toward a repair on its own.
    location_drift: driftRepair ? null : nextDrift,
    // JSON-safe (entity_id as string) — the party read only uses the name, but keep
    // the id so a future consumer can resolve without a lookup.
    travelling_with: travellingWith.map((m) => ({
      entity_id: idString(m.entity_id),
      name: m.name,
      misses: m.misses,
      source: m.source,
      confidence: m.confidence,
    })),
  }
  await redis.set(`session:${instanceId}`, JSON.stringify(updatedSession), 'EX', 3600)

  await releaseGenerationLock(redis, lockKey, String(job.id))

  await redis.publish(
    `user:${playerId}:events`,
    JSON.stringify({
      type: 'generation_complete',
      instanceId,
      event: {
        id: eventIdStr,
        sequence: event.sequence,
        player_input: event.data.player_input,
        narrative: parsed.narrative,
        scene_tag: parsed.scene_tag,
        emotional_tone: parsed.emotional_tone,
        model_used: event.data.model_used,
        choices: parsed.choices,
        milestone: parsed.milestone,
        present_characters: parsed.present_characters,
        scene_state: sceneState,
        trackable_mentions: trackableMentions,
        time_advanced: timeAdvanceLabel || null,
        time_anchor: timeAnchor,
        location_anchor: locationAnchor
          ? {
              ...locationAnchor,
              entity_id: idString(locationAnchor.entity_id),
            }
          : null,
        fate_thread: fateThread || null,
        event_type: event.type,
        state_diff: {
          world_state: newWorldState,
          active_flags: newFlags,
        },
      },
    }),
  )

  if (parsed.milestone) {
    await redis.publish(
      `user:${playerId}:events`,
      JSON.stringify({
        type: 'milestone_unlocked',
        instanceId,
        milestone: { label: parsed.milestone, sequence: nextSequence },
      }),
    )
  }
  // Best-effort immediate dispatch; the recurring dispatcher repairs a crash or
  // Redis outage without holding the completed player turn open.
  void dispatchPostProcessOutbox().catch(() => {})

  // Self-building character codex: extract NPC deltas from this turn, persist
  // canonical cards, then push an update to the live client.
  ;(async () => {
    try {
      const claimed = await mongoColl.events().updateOne(
        {
          _id: event._id,
          'data.codex_deltas': { $exists: false },
          'data.codex_projection_claimed_at': { $exists: false },
        },
        {
          $set: {
            'data.codex_projection_claimed_at': new Date(),
            'data.codex_projection_status': 'processing',
          },
        },
      )
      if (claimed.modifiedCount !== 1) return
      // Repeated figures the entity/memory graph already corroborates may earn a
      // codex card on recurrence — off-screen, and named or not. This is
      // intentionally a small, proven set, not a free pass for every mention.
      //
      // Unnamed figures are held to a HIGHER bar than named ones. A name is a
      // signal a person matters, so a label carries none and must show its own
      // evidence: the story has to have recorded them DOING or RECEIVING
      // something (a memory naming them as subject or object) more than once,
      // not merely mentioned them in passing. So a rider the player duels across
      // three turns earns a card, while "the crowd" said three times does not.
      const promotableCandidates = (await mongoColl
        .entities()
        .find(
          {
            instance_id: instanceOid,
            type: 'character',
            mention_count: { $gte: 3 },
            character_id: { $exists: false },
          },
          { projection: { _id: 1, canonical_name: 1 } },
        )
        .toArray()) as Array<{ _id: ObjectId; canonical_name?: string }>

      const unnamedIds = new Set(
        promotableCandidates
          .filter((e) => looksLikeUnnamedLabel(String(e.canonical_name || '')))
          .map((e) => idString(e._id)),
      )
      const unnamedCandidates = promotableCandidates.filter((e) => unnamedIds.has(idString(e._id)))
      // One scoped count for the unnamed ones only; the named path is unchanged
      // and costs nothing extra.
      const involvedEntityIds = new Set<string>()
      if (unnamedCandidates.length) {
        const ids = unnamedCandidates.map((e) => e._id)
        const involvementByEntity = new Map<string, number>()
        const memRefs = await mongoColl
          .memories()
          .find(
            {
              instance_id: instanceOid,
              $or: [{ subject_entity_ids: { $in: ids } }, { object_entity_ids: { $in: ids } }],
            },
            { projection: { subject_entity_ids: 1, object_entity_ids: 1 } },
          )
          .limit(200)
          .toArray()
        for (const m of memRefs as any[]) {
          for (const id of [...(m.subject_entity_ids || []), ...(m.object_entity_ids || [])]) {
            const key = idString(id)
            involvementByEntity.set(key, (involvementByEntity.get(key) || 0) + 1)
          }
        }
        for (const [key, count] of involvementByEntity) {
          if (count >= 2) involvedEntityIds.add(key)
        }
      }

      const promotableRecurringPeople = promotableCandidates
        .filter((e) =>
          unnamedIds.has(idString(e._id)) ? involvedEntityIds.has(idString(e._id)) : true,
        )
        .map((entity) => String(entity.canonical_name || '').trim())
        .filter(Boolean)
        .slice(0, 12)
      const deltas = await extractCharacterCodexDeltas({
        playerInput: parsedPlayerInput.raw,
        aiResponse: rawNarrative,
        sequence: nextSequence,
        existing: (characterCodex || []).map((c: any) => ({
          canonical_name: c.canonical_name,
          aliases: c.aliases || [],
          // The prompt renders "(identity kind: role_label)" so the model knows a
          // card is a PLACEHOLDER still waiting for a name — it was never sent,
          // so that clause has been dead and label→name promotion was a coin flip.
          identity_kind: c.identity_kind,
          identity_scope: c.identity_scope,
          last_seen_sequence: c.last_seen_sequence,
          former_labels: c.former_labels || [],
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
        seedPrompt: session.seed_prompt,
        isSentient: session.is_sentient,
        protagonistName: (characterCodex as any[]).find((c) => c.is_protagonist)?.canonical_name,
        playerPersonaName: session.persona_snapshot?.name,
        presentCast: parsed.present_characters,
        knownLocations: knownPlaces,
        promotableRecurringPeople,
      })
      // Sentient worlds: the player is the persona TALKING TO the world's main
      // character — they are not part of the cast. Drop any delta that would
      // card them, no matter what the extractor produced. The player's identity
      // is the UNION of: the authored persona name, the existing player entity's
      // canonical name + aliases (learned on prior turns), and any name the
      // player introduces for THEMSELVES THIS turn ("I'm Kael", "call me Alex").
      // The last one is the gap that minted Alex/Swapnil/Kael cards: sentient
      // worlds often start with no persona name, so the only signal that "Kael"
      // is the player is their own self-introduction — which must card nothing.
      if (session.is_sentient) {
        const playerNames = new Set<string>()
        const addName = (n: string | null | undefined) => {
          const norm = normalizePersonaName(n || '')
          if (norm) playerNames.add(norm)
        }
        addName(session.persona_snapshot?.name)
        let selfIntroName: string | null = null
        try {
          const playerEntity = await mongoColl
            .entities()
            .findOne({ instance_id: instanceOid, type: 'player' }, { projection: { canonical_name: 1, aliases: 1 } })
          if (playerEntity) {
            // "The Player" / "player" are generic sentinels, not a real name a
            // card could collide with — skip them so they don't over-match.
            for (const n of [playerEntity.canonical_name, ...(playerEntity.aliases || [])]) {
              const norm = normalizePersonaName(n || '')
              if (norm && norm !== 'the player' && norm !== 'player') playerNames.add(norm)
            }
          }
          selfIntroName = detectSelfIntroName(parsedPlayerInput.raw)
          if (selfIntroName) addName(selfIntroName)
        } catch (err) {
          console.warn('player self-name resolution skipped:', (err as Error).message)
        }

        if (playerNames.size > 0) {
          const refersToPlayer = (d: (typeof deltas)[number]) =>
            [d.name, d.resolved_name, ...(d.aliases || [])]
              .map((n) => normalizePersonaName(n || ''))
              .some((n) => n && playerNames.has(n))
          for (let i = deltas.length - 1; i >= 0; i--) {
            if (refersToPlayer(deltas[i])) deltas.splice(i, 1)
          }
        }

        // Persist a freshly-introduced player name onto the player entity so the
        // guard still catches it on later turns where the player doesn't restate
        // it (the extractor would otherwise re-mint the card the moment the main
        // character addresses them by name).
        if (selfIntroName) {
          const norm = normalizePersonaName(selfIntroName)
          if (norm && norm !== 'the player' && norm !== 'player') {
            // AWAIT (not fire-and-forget): the per-instance turn lock serializes
            // turns, so persisting the player's self-intro alias BEFORE this turn
            // releases its lock guarantees the next turn's guard reads it. A
            // fire-and-forget write raced the following extractions — "I'm
            // Swapnil" at seq 2 still let seq 6 mint a "Swapnil" codex card
            // because the alias hadn't landed when seq 6's guard read the entity.
            try {
              await mongoColl.entities().updateOne(
                { instance_id: instanceOid, type: 'player' },
                {
                  $addToSet: { aliases: norm },
                  $set: { updated_at: new Date() },
                },
              )
            } catch (err) {
              console.warn('player self-name persist skipped:', (err as Error).message)
            }
          }
        }

      }

      // GM-world protagonist is the player's OWN character; relationship meters
      // toward the player are nonsense there (a character has no stance toward
      // themself). Enforce what the extractor prompt asks for. Sentient worlds
      // keep protagonist meters — the persona genuinely has a stance.
      if (!session.is_sentient) {
        for (const d of deltas) {
          if (d.is_protagonist) delete d.relationship_deltas
        }
      }

      // A reveal candidate must still surface if the smaller extraction model
      // returned no codex delta. In that case the existing roster is enough to
      // validate a proposal; no candidate can mint an identity by itself.
      const codex = deltas.length > 0
        ? await characterCodexService.applyDeltas({
            instanceId,
            playerId,
            sequence: nextSequence,
            deltas,
          })
        : characterCodex

      // Ledger the applied deltas on the event so the codex is an exact
      // rebuildable projection (rewind replays these — no stale facts).
      if (deltas.length > 0) {
        await mongoColl.events().updateOne({ _id: event._id }, { $set: { 'data.codex_deltas': deltas } })
      }

      // Entity graph: keep card↔entity links 1:1 and project this turn's
      // relationship meters onto typed edges. Best-effort — graph failures
      // never break the codex pipeline.
      try {
        const entityMap = await entityGraphService.syncCodexEntities({
          instanceId,
          playerId,
          sequence: nextSequence,
          cards: codex,
        })
        const touchedCards = codex.filter((c) => c.last_seen_sequence === nextSequence && c.relationship)
        if (touchedCards.length > 0) {
          await entityGraphService.syncRelationshipEdges({
            instanceId,
            playerId,
            sequence: nextSequence,
            eventId: event._id,
            cards: touchedCards,
            entitiesByCardName: entityMap,
            playerName: session.persona_snapshot?.name,
          })
        }

        // Kinship graph: typed relation ties asserted this turn → graph edges
        // (extract → Stage-1 hygiene → Stage-2 epithet resolver → persist). Post
        // stream, off TTFT. Self anchor = protagonist card (GM) or player (sentient).
        // Structural kinship is too consequential to infer from narration. A line
        // such as "my sister in spirit" or a story-within-a-story must never create
        // a family edge. Only an explicit player-authored fact or correction can
        // establish/retcon one; narrator and character claims stay prose until the
        // player confirms them through an authored narration/correction.
        const deterministicAssertions = extractKinshipAssertions({
          corrections: parsedPlayerInput.corrections,
          narrationFacts: parsedPlayerInput.narrationFacts,
          claims: [],
          prose: undefined,
        })
        // Narrator prose may suggest a literal family tie, but never establishes
        // one. Store a quarantined, evidence-backed review candidate instead.
        // This is intentionally after the stream and outside relationAssertions:
        // candidates affect neither canon nor the next prompt until the player
        // explicitly accepts one.
        try {
          const proposals = detectNarratedRelationCandidates(rawNarrative)
          if (proposals.length > 0) {
            const protagCard = codex.find((c) => c.is_protagonist)
            let playerEntityId: string | null = null
            if (!session.is_sentient && protagCard) {
              const protagEntity = entityMap.get(protagCard.name_normalized)
              playerEntityId = protagEntity?._id ? idString(protagEntity._id) : null
            } else {
              const player = await entityGraphService.ensurePlayerEntity({
                instanceId,
                playerId,
                name: session.persona_snapshot?.name,
                sequence: nextSequence,
              })
              playerEntityId = idString(player._id)
            }
            if (playerEntityId) {
              for (const proposal of proposals) {
                // A review candidate is only useful for an identity the world
                // already knows. Never mint an entity from prose that merely
                // *resembles* a relationship assertion; that turned ordinary
                // narration into garbage candidates such as "on the far".
                const known = entityMap.get(normalizeEntityName(proposal.characterName))
                if (!known?._id) continue
                const characterEntityId = idString(known._id)
                await relationCandidateService.propose({
                  instanceId,
                  playerId,
                  characterName: proposal.characterName,
                  characterEntityId,
                  playerEntityId,
                  relation: proposal.relation,
                  relationKind: proposal.relationKind,
                  evidence: proposal.evidence,
                  sourceEventId: event._id,
                  sequence: nextSequence,
                })
              }
            }
          }
        } catch (err) {
          console.warn('relation candidate proposal skipped:', (err as Error).message)
        }

        // Identity/twist review lane. The detector is intentionally only a
        // candidate producer: it must resolve every endpoint to the existing
        // card/entity roster, quote narration evidence, and never changes canon
        // without an explicit player confirmation in the Chronicle controls.
        try {
          const revisions = detectCanonRevisionCandidates(rawNarrative, codex)
          if (revisions.length > 0) {
            const protagCard = codex.find((card) => card.is_protagonist)
            let playerEntityId: string | null = null
            if (!session.is_sentient && protagCard) {
              const protagEntity = entityMap.get(protagCard.name_normalized)
              playerEntityId = protagEntity?._id ? idString(protagEntity._id) : null
            } else {
              const player = await entityGraphService.ensurePlayerEntity({
                instanceId,
                playerId,
                name: session.persona_snapshot?.name,
                sequence: nextSequence,
              })
              playerEntityId = idString(player._id)
            }
            if (playerEntityId) {
              for (const revision of revisions) {
                const primary = codex.find((card) => card.canonical_name === revision.characterName)
                const primaryEntity = primary ? entityMap.get(primary.name_normalized) : null
                if (!primary || !primaryEntity?._id) continue
                const counterpart = revision.kind === 'identity_merge'
                  ? codex.find((card) => card.canonical_name === revision.counterpartCharacterName)
                  : undefined
                const counterpartEntity = counterpart ? entityMap.get(counterpart.name_normalized) : undefined
                if (revision.kind === 'identity_merge' && !counterpartEntity?._id) continue
                await relationCandidateService.propose({
                  instanceId,
                  playerId,
                  characterName: primary.canonical_name,
                  characterEntityId: idString(primaryEntity._id),
                  playerEntityId,
                  kind: revision.kind,
                  relation: revision.kind === 'kinship_revision' ? revision.relation : 'identity',
                  evidence: revision.evidence,
                  sourceEventId: event._id,
                  sequence: nextSequence,
                  ...(revision.kind === 'kinship_revision'
                    ? { replacesRelation: revision.relation }
                    : { proposedName: revision.proposedName }),
                  ...(counterpartEntity?._id
                    ? {
                        counterpartEntityId: idString(counterpartEntity._id),
                        counterpartCharacterName: counterpart?.canonical_name,
                      }
                    : {}),
                })
              }
            }
          }
        } catch (err) {
          console.warn('canon revision candidate proposal skipped:', (err as Error).message)
        }
        const explicitRelationship =
          confirmedWorldAction?.kind === 'relationship'
            ? (() => {
                const mapped = surfaceToKind(confirmedWorldAction.relation)
                if (!mapped) return []
                const source = confirmedWorldAction.correction
                  ? ('player_correction' as const)
                  : ('player_narration' as const)
                const assertions: RelationAssertion[] = [
                  {
                    from: confirmedWorldAction.character,
                    to: 'player',
                    kind: mapped.kind,
                    label: confirmedWorldAction.relation,
                    gender: mapped.gender,
                    modifier: mapped.modifier,
                    polarity: 'assert' as const,
                    source,
                  },
                ]
                // A correction must name what it replaces. Close that prior kind
                // first, preserving historical provenance. Sibling labels share one
                // structural kind, so "sister" → "brother" is a label correction on
                // the same edge and intentionally needs no sever.
                const replacesRelation = confirmedWorldAction.replacesRelation
                const replaced = replacesRelation ? surfaceToKind(replacesRelation) : null
                if (replaced && replaced.kind !== mapped.kind) {
                  assertions.unshift({
                    from: confirmedWorldAction.character,
                    to: 'player',
                    kind: replaced.kind,
                    label: replacesRelation,
                    gender: replaced.gender,
                    modifier: replaced.modifier,
                    polarity: 'sever' as const,
                    source,
                  })
                }
                return assertions
              })()
            : []
        // STEP 0, SELF-HEALING. Premise kinship ("Your sister Neva Vale") is seeded
        // once, from the authored premise — but the only two callers were instance
        // creation for SENTIENT worlds and the protagonist-onboarding endpoint. A GM
        // world whose player never completes that onboarding (the app treats the call
        // as best-effort and lets the protagonist card "seed emergently on the next
        // turn") therefore never seeded kinship at all, and nothing ever retried.
        //
        // That is why a 15-turn playthrough of a world whose premise literally says
        // "their sister Neva Vale" produced zero kinship edges: the extractor is told
        // not to re-list ties that already exist, and the tie was established before
        // turn 1 — so no turn ever claimed it and no seed ever ran. Retry here, the
        // moment a protagonist card exists. Idempotent (`meta.kinship_seeded`) and
        // off the TTFT path.
        if (codex.some((c) => c.is_protagonist)) {
          await kinshipGraphService
            .seedPremiseKinship({ instanceId, playerId })
            .then((res) => {
              if (res.seeded > 0) {
                log.info('kinship.premise_seeded_late', {
                  instanceId: idString(instanceId),
                  sequence: nextSequence,
                  seeded: res.seeded,
                  notes: res.notes.slice(0, 4),
                })
              }
            })
            .catch(() => undefined)
        }
        const relationAssertions = mergeRelationAssertions([], [...deterministicAssertions, ...explicitRelationship])
        // Committed kinship edge count, hoisted for the FP/FN signal ledger below.
        let kinWritten = 0
        // TRANSITION channel — death/disownment/divorce/reveal evolving an EXISTING
        // tie. Deterministic, off TTFT. Applied even when no new tie is asserted
        // (e.g. "my father died" carries no assertion, only a transition).
        const lifecycleTransitions = extractLifecycleTransitions({
          corrections: parsedPlayerInput.corrections,
          narrationFacts: parsedPlayerInput.narrationFacts,
          claims: [],
          prose: undefined,
        })
        if (relationAssertions.length > 0 || lifecycleTransitions.length > 0) {
          const protagCard = codex.find((c) => c.is_protagonist)
          let selfAnchorId: string | null = null
          if (!session.is_sentient && protagCard) {
            const ent = entityMap.get(protagCard.name_normalized)
            selfAnchorId = ent?._id ? idString(ent._id) : null
          } else {
            const player = await entityGraphService.ensurePlayerEntity({
              instanceId,
              playerId,
              name: session.persona_snapshot?.name,
              sequence: nextSequence,
            })
            selfAnchorId = idString(player._id)
          }
          const kin = await kinshipGraphService.applyRelationAssertions({
            instanceId,
            sequence: nextSequence,
            eventId: event._id,
            assertions: relationAssertions,
            cards: codex,
            entitiesByCardName: entityMap,
            selfAnchorId,
            sceneText: rawNarrative,
            // Stub uncarded endpoints (e.g. a just-named "Mara" the codex didn't
            // card yet) so the typed tie is written against a stub entity now;
            // it promotes when the card lands. Closes the "edge disappears
            // because the endpoint has no card" gap.
            ensureStub: (name: string) =>
              entityGraphService
                .ensureStubEntity({
                  instanceId,
                  playerId,
                  sequence: nextSequence,
                  name,
                })
                .then((id) => id),
            transitions: lifecycleTransitions,
          })
          kinWritten = kin.written
          if (kin.written > 0) {
            log.info('kinship.graph.updated', {
              instanceId: idString(instanceId),
              sequence: nextSequence,
              edges: kin.written,
              notes: kin.notes.slice(0, 6),
            })
          }
        }

        // Projection anomaly logging (§12): compare the prose against what the
        // projection recorded and persist any inconsistencies fire-and-forget for
        // a debug/admin surface. Never affects the turn. `knownCardNames` is the
        // PRE-turn card set, so deltas naming an absent person are "new this turn".
        let missCandidates = 0 // FN ground-truth for the signal ledger below.
        try {
          const newCardNames = deltas
            .map((d) => d.resolved_name || d.name)
            .filter((n) => n && !knownCardNames.has(normalizeEntityName(n)))
          const findings = detectProjectionAnomalies({
            prose: rawNarrative,
            presentNames: parsed.present_characters,
            codexNames: [...knownCardNames],
            stubNames: stubResult.ensured,
            hadRelationAssertion: relationAssertions.length > 0,
            droppedChoices: audited.dropped,
            locationAnchorName: locationAnchor?.name ?? null,
            witnessLocationName: parsed.current_location ?? null,
            newCardNames,
            // The same distinctive-token surfaces the live gap path excludes, so
            // the anomaly log and the presence gate agree on who is tracked.
            excludeNames: presenceGapExcludes,
          })
          // FN candidates = "miss" findings (prose named a person/kin/place the
          // projection didn't record). Drift findings (ungrounded choice, card with
          // no prose anchor) are not recall misses, so they don't count here.
          const MISS_TYPES = new Set(['prose_person_untracked', 'kinship_phrase_no_edge', 'location_phrase_no_anchor'])
          missCandidates = findings.filter((f) => MISS_TYPES.has(f.type)).length
          if (findings.length) {
            await mongoColl.projectionAnomalies().insertMany(
              findings.map((f) => ({
                _id: new ObjectId(),
                instance_id: instanceOid,
                player_id: playerOid,
                event_id: event._id,
                sequence: nextSequence,
                type: f.type,
                severity: f.severity,
                details: f.details,
                created_at: new Date(),
                resolved_at: null,
              })),
            )
            log.info('projection.anomalies', {
              instanceId: idString(instanceId),
              sequence: nextSequence,
              count: findings.length,
              types: findings.map((f) => f.type),
            })
          }
        } catch (err) {
          console.warn('projection anomaly logging skipped:', (err as Error).message)
        }

        // FP/FN signal ledger: one compact row per turn recording detected-vs-
        // committed for every instrumented detector, the tier mix of what committed,
        // plus the recall (miss_candidates) + precision (player_corrected) ground
        // truths. Fire-and-forget; aggregations tune enrichment against this data.
        try {
          const verdicts = endpointAdjudication.citationVerdicts
          const castKeys = new Set((parsed.present_characters || []).map((n) => presenceKeyOf(n)).filter(Boolean))
          let canon = 0
          let hint = 0
          let hidden = 0
          let endpointCommitted = 0
          for (const verdict of verdicts) {
            if (verdict.a && verdict.b && verdict.c) canon++
            else if (verdict.a) hint++
            else hidden++
            if (citationAdmitsToPresent(verdict) && castKeys.has(presenceKeyOf(verdict.name))) endpointCommitted++
          }
          const ledger = buildSignalLedger({
            movement: {
              // `detected` is every CLAIM that the viewpoint moved this turn,
              // from any of the four arbiters — not just the structured travel
              // control and the witness's booleans. Instrumenting only two of
              // them made the channel unreadable: a cursor move admitted by the
              // citation stack committed with nothing recorded as detected.
              detected:
                confirmedWorldAction?.kind === 'travel' ||
                parsed.player_travel_confirmed === true ||
                parsed.viewpoint_moved === true ||
                locationDecision.transitionCorroborated ||
                !!locationDecision.sceneAnchor,
              committed: !!locationAnchor?.name && viewpointMoved,
              source: moveSource,
              confidence: moveConfidence,
            },
            time: {
              detected: !!(witnessTimeLabel || playerTimeLabel || timeAdvanceLabel),
              committed: !!effectiveTimeAdvance,
              source: timeSource ?? undefined,
              confidence: timeSource ? timeConfidence : undefined,
            },
            party: {
              detected: partyJoinsDetected,
              committedConfidences: freshPartyJoinConfidences,
            },
            kinship: {
              detected: relationAssertions.length,
              committed: kinWritten,
            },
            presence: {
              detected: verdicts.length,
              committed: endpointCommitted,
              ...(verdicts.length
                ? { by_tier: { canon, hint, hidden } }
                : {}),
            },
            playerCorrected: parsedPlayerInput.corrections.length > 0,
            missCandidates,
          })
          await mongoColl.signalLedger().insertOne({
            _id: new ObjectId(),
            instance_id: instanceOid,
            player_id: playerOid,
            event_id: event._id,
            sequence: nextSequence,
            player_corrected: ledger.player_corrected,
            miss_candidates: ledger.miss_candidates,
            signals: ledger.signals,
            created_at: new Date(),
          })
        } catch (err) {
          console.warn('signal ledger logging skipped:', (err as Error).message)
        }
      } catch (err) {
        console.warn('entity graph sync failed:', (err as Error).message)
      }

      // Memory-vector supersession: when a status was retired this turn, evict
      // the stale memory vectors so RAG can't resurface the now-false fact.
      const retiredFacts = deltas.flatMap((d) => d.retire_state || [])
      if (retiredFacts.length > 0) {
        memorySupersessionService
          .supersedeMemories({
            instanceId,
            retiredFacts,
            beforeDate: new Date(genStart),
            eventId: idString(event._id),
          })
          .catch((err) => console.warn('memory supersession failed:', (err as Error).message))
      }

      // Async fact-cap compaction: distill any character whose permanent-fact
      // list has grown large, so long-lived characters stay bounded + accurate
      // over thousands of turns without losing recent or important facts.
      for (const c of codex) {
        if ((c.immutable_facts?.length || 0) >= 24) {
          compactImmutableFacts(c.canonical_name, c.immutable_facts, 16)
            .then((compacted) => {
              if (compacted && compacted.length) {
                return characterCodexService.setImmutableFacts(idString(c._id), compacted)
              }
            })
            .catch(() => {})
        }
      }

      await redis.publish(
        `user:${playerId}:events`,
        JSON.stringify({
          type: 'character_codex_updated',
          instanceId,
          focused_character_id: session.focus_character_id || null,
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
      await mongoColl.events().updateOne(
        { _id: event._id },
        {
          $set: { 'data.codex_projection_status': 'completed', 'data.codex_projection_completed_at': new Date() },
          $unset: { 'data.codex_projection_claimed_at': '' },
        },
      )
    } catch (err) {
      await mongoColl.events().updateOne(
        { _id: event._id },
        { $unset: { 'data.codex_projection_claimed_at': '' }, $set: { 'data.codex_projection_status': 'pending', 'data.codex_projection_error': (err as Error).message } },
      ).catch(() => {})
      // A silent console.warn was the whole visibility budget for a failure that
      // freezes the world. It now leaves a durable, queryable trace.
      await recordAnomaly({
        instanceId: instanceOid,
        playerId: playerOid,
        eventId: event._id,
        sequence: nextSequence,
        type: 'projection_failed',
        severity: 'error',
        details: `inline codex projection: ${(err as Error).message}`,
      })
      log.warn('projection.codex_failed', {
        instanceId: idString(instanceId),
        sequence: nextSequence,
        reason: (err as Error).message,
      })
    }
  })()

  if (shouldSummarize) {
    const startSequence = nextSequence - (SCENE_SUMMARY_BLOCK - 1)
    const endSequence = nextSequence
    log.info('scene_summary.queued', {
      instanceId,
      sceneTag,
      startSequence,
      endSequence,
    })
    await stagePostProcess({
      instanceId,
      playerId,
      eventId: eventIdStr,
      kind: 'scene_summary',
      payload: { instanceId, sceneTag, startSequence, endSequence },
    })
  }

  if (nextSequence > 0 && nextSequence % 500 === 0) {
    await stagePostProcess({
      instanceId,
      playerId,
      eventId: eventIdStr,
      kind: 'projection_checkpoint',
      payload: { instanceId },
    })
  }

  void dispatchPostProcessOutbox().catch(() => {})

  return { eventId: eventIdStr, sequence: nextSequence }
}
