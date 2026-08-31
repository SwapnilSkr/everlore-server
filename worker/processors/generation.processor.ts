import { ObjectId } from 'mongodb'
import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { getRedisClient } from '../../src/config/redis'
import { callLLMStreamWithFallback, AI_MODELS, narrationTemperature } from '../../src/ai'
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
import { extractCharacterCodexDeltas } from '../lib/character-codex-extractor'
import { compactImmutableFacts } from '../lib/codex-compactor'
import { classifyPresenceCodexGaps, isActionableMention } from '../lib/presence-gap-detector'
import {
  adjudicateEntityCandidates,
  adjudicatedPersonKeys,
  entityAdjudicationCandidates,
  filterAdjudicatedPresence,
} from '../lib/entity-adjudicator'
import { adjudicateSceneEndpoint } from '../lib/scene-endpoint-adjudicator'
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
} from '../lib/movement-signal'
import { auditChoices } from '../lib/choice-grounding-audit'
import { classifyChoiceGrounding, computeGroundingContext } from '../lib/choice-grounding'
import { detectProjectionAnomalies } from '../lib/projection-anomaly-detector'
import { buildSignalLedger } from '../lib/signal-ledger'
import { detectNarratedTimeSkip } from '../lib/time-skip-signal'
import { detectCompanionJoins, detectCompanionDepartures } from '../lib/party-signal'
import { type WorldFactSource, SOURCE_RANK, confidenceFor, isWorldFactSource } from '../../src/utils/world-authority'
import { memorySupersessionService } from '../../src/services/memory-supersession.service'
import { relationCandidateService } from '../../src/services/relation-candidate.service'
import { timeService } from '../../src/services/time.service'
import { replayProcessor } from './replay.processor'
import { log } from '../../src/utils/logger'
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

export async function generationProcessor(job: Job) {
  // Replay turns reuse the generation queue/worker but follow a distinct path:
  // they stream an alternative for an existing event instead of appending one.
  if (job.data?.mode === 'replay') {
    return replayProcessor(job)
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

  // Started during context assembly, never awaited before buildPrompt/stream.
  // If it settles in the existing context window, the current narrator can use
  // it; otherwise it becomes continuity for the next turn after this prose has
  // safely streamed. It can never reject or replace a visible response.
  let interactionSignalPromise: Promise<PlayerInteractionSignalDoc[]> | null = null
  let settledInteractionSignals: PlayerInteractionSignalDoc[] = []
  let interactionSignalSettled = false

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
  const knownPlaces = await entityGraphService
    .listKnownLocations(instanceId, 30)
    .catch(() => [] as { name: string; aliases: string[] }[])
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
  })
  const metaPromise = extractSceneMetadata(
    rawNarrative,
    statDescriptors(session.stat_definitions || session.world_state),
    Object.keys(session.active_flags || {}),
    {
      isSentient: session.is_sentient,
      currentLocationName: currentLocation?.name || null,
      priorPresent,
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
  })
  const deathExtractionPromise = extractCharacterDeaths({
    prose: rawNarrative,
    candidates: characterCodex as any[],
    sequence: nextSequence,
  })
  // All post-stream checks run together. None is allowed to alter visible prose
  // or delay the narrator's first token.
  const [meta, entityAdjudication, characterLifecycleDeltas, endpointAdjudication] = await Promise.all([
    metaPromise,
    entityAdjudicationPromise,
    deathExtractionPromise,
    endpointAdjudicationPromise,
  ])
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
  const validWitnessDestination = isSafeWitnessLocationCandidate(parsed.player_destination, locationCandidateOptions)
  const evidenceSourceText = parsed.location_evidence_source === 'player'
    ? parsedPlayerInput.raw
    : parsed.location_evidence_source === 'narrative'
      ? rawNarrative
      : ''
  const hasValidWitnessEvidence =
    (parsed.location_evidence_source === 'player' || parsed.location_evidence_source === 'narrative') &&
    hasGroundedWitnessLocationEvidence(parsed.location_evidence, evidenceSourceText)

  // A typed travel command is an explicit product action and may proceed on its
  // own. Every free-form player turn, however, requires the LLM witness to say
  // both "this is travel" and "this is the exact player excerpt that proves it".
  const actionDestination = confirmedWorldAction?.kind === 'travel' &&
    isSafeWitnessLocationCandidate(confirmedWorldAction.destination, locationCandidateOptions)
      ? confirmedWorldAction.destination
      : null
  const witnessedDestination =
    !confirmedWorldAction &&
    !isContinuation &&
    parsed.player_travel_confirmed === true &&
    parsed.viewpoint_moved === true &&
    parsed.location_evidence_source === 'player' &&
    hasValidWitnessEvidence &&
    validWitnessDestination
      ? parsed.player_destination
      : null
  const witnessedMovementDetected =
    !isContinuation && parsed.player_travel_confirmed === true && parsed.viewpoint_moved === true
  const placeName = actionDestination || witnessedDestination ||
    (!currentLocation && parsed.location_evidence_source === 'narrative' && hasValidWitnessEvidence && validWitnessLocation
      ? parsed.current_location
      : null)
  const viewpointMoved = !!actionDestination || !!witnessedDestination
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
  const sceneEstablishedLocation =
    !currentLocation && !viewpointMoved && !!placeName &&
    parsed.location_evidence_source === 'narrative' && hasValidWitnessEvidence
  const locationSource: WorldFactSource = viewpointMoved ? moveSource : 'narrator'
  const locationConfidence = viewpointMoved ? moveConfidence : 0.98
  const resolvedLocation =
    (viewpointMoved || sceneEstablishedLocation) && placeName
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
  const locationAnchor = resolvedLocation || currentLocation || null

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
  const narratedTimeLabel = !isContinuation ? playerTimeLabel : undefined
  const effectiveTimeAdvance = timeAdvanceLabel || actionTimeAdvanceLabel || narratedTimeLabel
  // Provenance of the time advance (world-authority), for the rebuildable time_delta:
  // continuation ticks and accepted player-narrated skips are player-authored.
  let timeSource: WorldFactSource | null = null
  let timeConfidence = 0
  if (effectiveTimeAdvance) {
    if (timeAdvanceLabel || actionTimeAdvanceLabel || playerTimeLabel) {
      timeSource = 'player_narration'
      timeConfidence = confidenceFor('player_narration')
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
  if (sceneBroke && endpointAdjudication.available) {
    const witnessOnlyNames = (parsed.present_characters || []).filter((name) => !endpointPresenceKeys.has(presenceKeyOf(name)))
    if (witnessOnlyNames.length || !endpointAdjudication.playerViewpointAtEnd) {
      // Operational signal, not player-visible state. This makes future witness
      // drift diagnosable from one turn rather than requiring a screenshot and
      // manual reconstruction of which cast carried across a boundary.
      log.info('scene.endpoint.reconciled', {
        instanceId: idString(instanceId),
        sequence: nextSequence,
        playerViewpointAtEnd: endpointAdjudication.playerViewpointAtEnd,
        primaryOnly: witnessOnlyNames.slice(0, 12),
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
  const addJoins = (names: string[], source: WorldFactSource) => {
    for (const n of names) {
      const k = presenceKeyOf(n)
      if (!k || partyDepartedKeys.has(k)) continue
      if (playerPresenceKey && k === playerPresenceKey) continue
      if (partyProtagKey && k === partyProtagKey) continue
      if (!partyRosterKeys.has(k) && !partyPresentKeys.has(k)) continue
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
  addJoins(playerJoinNames, 'player_narration')
  if (partyProtagKey) partyByKey.delete(partyProtagKey)
  const partyMembers = [...partyByKey.values()].slice(0, 6)
  const partyNames = partyMembers.map((m) => m.name)
  const partyProvByName = new Map(partyMembers.map((m) => [normalizeEntityName(m.name), m]))

  const blockedUngroundedPresence: string[] = []
  const heldUncorroboratedPresence: string[] = []
  parsed.present_characters = (() => {
    // On a boundary the endpoint judge becomes the authoritative cast when it
    // is available. A known old name cannot survive just because the first
    // witness saw it earlier in the prose or an NPC-only cutaway. If the judge
    // is temporarily unavailable, retain the existing witness-only fallback so
    // an auxiliary model outage never erases a valid live scene.
    const candidates = sceneBroke
      ? [
          ...(endpointAdjudication.available ? endpointPresenceNames : (parsed.present_characters || [])),
          ...partyNames,
        ]
      : [...priorPresent, ...(parsed.present_characters || [])]
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
  const trackableMentions = actionableMentions.map((m) => ({
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
    const presentSeen = new Set(parsed.present_characters.map((n) => normalizeEntityName(n)))
    for (const gap of presentGaps) {
      if (parsed.present_characters.length >= 12) break
      if (!gap.key || presentSeen.has(gap.key)) continue
      presentSeen.add(gap.key)
      parsed.present_characters.push(gap.display)
    }
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
    locationAnchor &&
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
      prose_hygiene_issues: proseHygieneIssues,
      latency_ms: latencyMs,
      ttft_ms: ttftMs,
      queue_wait_ms: queueWaitMs,
      context_latency_ms: contextLatencyMs,
      end_to_end_ttft_ms: endToEndTtftMs,
      created_at: new Date(),
    })
    .catch((err) => console.warn('generation_log insert failed:', (err as Error).message))

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
    // JSON-safe (entity_id as string) — the party read only uses the name, but keep
    // the id so a future consumer can resolve without a lookup.
    travelling_with: travellingWith.map((m) => ({
      entity_id: idString(m.entity_id),
      name: m.name,
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
      // Repeated named figures that the entity/memory graph already corroborates
      // may earn a codex card off-screen. This is intentionally a small, proven
      // set—not a free pass for every capitalized mention.
      const promotableOffscreenPeople = (await mongoColl
        .entities()
        .find(
          {
            instance_id: instanceOid,
            type: 'character',
            mention_count: { $gte: 3 },
            character_id: { $exists: false },
          },
          { projection: { canonical_name: 1 } },
        )
        .toArray())
        .map((entity: any) => String(entity.canonical_name || '').trim())
        .filter(Boolean)
        .slice(0, 12)
      const deltas = await extractCharacterCodexDeltas({
        playerInput: parsedPlayerInput.raw,
        aiResponse: rawNarrative,
        existing: (characterCodex || []).map((c: any) => ({
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
        seedPrompt: session.seed_prompt,
        isSentient: session.is_sentient,
        protagonistName: (characterCodex as any[]).find((c) => c.is_protagonist)?.canonical_name,
        playerPersonaName: session.persona_snapshot?.name,
        presentCast: parsed.present_characters,
        knownLocations: knownPlaces,
        promotableOffscreenPeople,
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
            newCardNames,
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
          const presenceTiers = { confirmed: 0, probable: 0, mentioned: 0 }
          for (const m of trackableMentions) {
            if (m.tier === 'confirmed') presenceTiers.confirmed++
            else if (m.tier === 'probable') presenceTiers.probable++
            else presenceTiers.mentioned++
          }
          const ledger = buildSignalLedger({
            movement: {
              detected: witnessedMovementDetected || !!actionDestination,
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
            presence: presenceTiers,
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
      console.warn('character codex update failed:', (err as Error).message)
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
