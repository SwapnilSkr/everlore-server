import { mongoColl } from '../config/mongo'
import type { CharacterProfileDoc } from '../models/character-profile.model'
import type { WorldEventDoc } from '../models/world-event.model'
import { queryRag } from '../providers/rag.provider'
import { rankCodexForInjection } from './character-codex.service'
import { entityGraphService } from './entity-graph.service'
import { timeService } from './time.service'
import { idString, parseObjectId } from '../utils/mongo-id'
import { EVENT_WINDOWS } from '../utils/event-window'
import type { TimeAnchorDoc } from '../models/time.model'

/** Injected codex size (recency-ranked top-K before pinning). */
const CODEX_INJECT_LIMIT = 16
/** Candidate pool the ranking selects from. */
const CODEX_POOL_LIMIT = 40
/** Cards pinned because RETRIEVED MEMORIES are about them (indirect mentions). */
const MEMORY_PIN_LIMIT = 3

/**
 * Everything one turn's prompt is assembled from, gathered in ONE place and in
 * the RIGHT order: retrieval runs first, so the codex can include characters
 * the retrieved memories are about — not just characters the ranking or the
 * player's literal words selected. Each section is bounded here (counts) and
 * again in the prompt builder (tokens).
 */
export interface ContextPacket {
  /** Last raw turns, oldest first (continuity window). */
  recentEvents: WorldEventDoc[]
  /** Latest non-stale scene summary ending before the recent window. */
  sceneSummary: string | null
  /** Ranked + pinned cards: [input mentions, memory-driven pins, ranked top-K]. */
  characterCodex: CharacterProfileDoc[]
  /** Entity ids the player named this turn (drives neighborhood retrieval). */
  mentionedEntityIds: string[]
  loreTexts: string[]
  memoryTexts: string[]
  openThreads: string[]
  /** Entity ids linked to retrieved memories (provenance of the memory pins). */
  retrievedEntityIds: string[]
  /** Sequence of the latest existing event (0 on a fresh world). */
  currentSequence: number
  currentTimeAnchor: TimeAnchorDoc | null
  timeContext: string | null
}

/** The session fields the packet builder reads (subset of the cached session). */
interface PacketSession {
  template_id: string
  is_sentient?: boolean
  protagonist?: { name?: string; persona?: string; appearance?: string } | null
  max_lore_results?: number
  max_context_memories?: number
  current_time_anchor?: TimeAnchorDoc | null
}

/**
 * Build the context packet for one generated turn. Runs in the WORKER (not at
 * dispatch) so retrieval results can shape codex selection — the
 * codex-after-RAG ordering the memory architecture calls for.
 */
export async function buildContextPacket(params: {
  instanceId: string
  playerId: string
  session: PacketSession
  userMessage: string
  isContinuation: boolean
}): Promise<ContextPacket> {
  const { instanceId, playerId, session, userMessage, isContinuation } = params
  const iid = parseObjectId(instanceId)

  const recentEvents = (await mongoColl
    .events()
    .find({ instance_id: iid })
    .sort({ sequence: -1 })
    .limit(EVENT_WINDOWS.promptRecentEvents)
    .toArray()) as WorldEventDoc[]
  recentEvents.reverse()
  const currentSequence = recentEvents.length
    ? recentEvents[recentEvents.length - 1].sequence
    : 0

  const summaryDoc = await mongoColl.sceneSummaries().findOne(
    {
      instance_id: iid,
      'event_range.end_sequence': { $lt: recentEvents[0]?.sequence || 0 },
      // Stale = a source event inside the range was edited; the rebuild job
      // will restore it. Until then the prompt skips the contradicted recap.
      status: { $ne: 'stale' },
    },
    { sort: { 'event_range.end_sequence': -1 } },
  )
  const currentTimeAnchor =
    session.current_time_anchor ||
    recentEvents[recentEvents.length - 1]?.time_anchor ||
    null
  const timeContext = await timeService.timelineContext(instanceId, currentTimeAnchor)

  // ── 1. Direct mentions: entities + dormant codex cards named in the input ──
  // (On a continue turn the player says nothing — nothing to resolve.)
  let mentionedEntityIds: string[] = []
  let mentionPinnedCards: CharacterProfileDoc[] = []
  if (!isContinuation && userMessage) {
    try {
      const resolved = await entityGraphService.findMentionedCharacterCards(
        instanceId,
        userMessage,
        [], // codex not selected yet; dedup happens at assembly below
      )
      mentionedEntityIds = resolved.mentionedEntityIds
      mentionPinnedCards = resolved.cards
    } catch (err) {
      console.warn('Context packet: mention resolution skipped:', (err as Error).message)
    }
  }

  // ── 2. Retrieval (vector + keyword + entity neighborhood + open threads) ──
  const ragQueryText = isContinuation
    ? String(recentEvents[recentEvents.length - 1]?.data?.ai_response || '') ||
      'Continue the current scene.'
    : userMessage
  let loreTexts: string[] = []
  let memoryTexts: string[] = []
  let openThreads: string[] = []
  let retrievedEntityIds: string[] = []
  try {
    const rag = await queryRag(
      String(session.template_id),
      instanceId,
      ragQueryText,
      session.max_lore_results || 10,
      session.max_context_memories || 25,
      mentionedEntityIds,
      currentTimeAnchor?.timeline_id || 'main',
    )
    loreTexts = rag.loreTexts
    memoryTexts = rag.memoryTexts
    openThreads = rag.openThreads
    retrievedEntityIds = rag.retrievedEntityIds
  } catch (err) {
    console.warn(
      'RAG query failed, proceeding without retrieved memories:',
      (err as Error).message,
    )
  }

  // ── 3. Codex selection (AFTER retrieval, so memories can shape it) ──
  const codexPool = (await mongoColl
    .characters()
    .find({ instance_id: iid })
    .sort({ is_protagonist: -1, mention_count: -1, updated_at: -1 })
    .limit(CODEX_POOL_LIMIT)
    .toArray()) as CharacterProfileDoc[]
  const ranked = rankCodexForInjection(codexPool, currentSequence, CODEX_INJECT_LIMIT)

  // Memory-driven pins: characters the RETRIEVED memories are about but whom
  // neither the ranking nor the player's literal words selected. Closes the
  // indirect-reference gap ("the woman from the ash bridge" retrieves Mira's
  // memories — now her card rides along too).
  const alreadyIncluded = new Set(
    [...ranked, ...mentionPinnedCards].map((c) => (c._id ? idString(c._id) : '')),
  )
  let memoryPinnedCards: CharacterProfileDoc[] = []
  const indirectEntityIds = retrievedEntityIds.filter((id) => !mentionedEntityIds.includes(id))
  if (indirectEntityIds.length > 0) {
    try {
      memoryPinnedCards = await entityGraphService.characterCardsForEntities(
        instanceId,
        indirectEntityIds,
        [...alreadyIncluded],
        MEMORY_PIN_LIMIT,
      )
    } catch (err) {
      console.warn('Context packet: memory-driven pinning skipped:', (err as Error).message)
    }
  }

  // Assembly order = prompt priority: direct mentions first (the player is
  // asking about them NOW), then memory pins, then the ranked set. The codex
  // token budget trims from the tail, so pins are protected.
  const seen = new Set<string>()
  const characterCodex: CharacterProfileDoc[] = []
  for (const card of [...mentionPinnedCards, ...memoryPinnedCards, ...ranked]) {
    const key = card._id ? idString(card._id) : card.canonical_name
    if (seen.has(key)) continue
    seen.add(key)
    characterCodex.push(card)
  }

  // Sentient worlds always speak AS the protagonist: if the emergent codex
  // hasn't carded them yet (fresh world), synthesize their card from the
  // template-seeded session identity.
  const protagonistName = session.protagonist?.name
  if (
    session.is_sentient &&
    protagonistName &&
    !characterCodex.some((c) => c.is_protagonist || c.canonical_name === protagonistName)
  ) {
    characterCodex.unshift({
      canonical_name: protagonistName,
      persona: session.protagonist?.persona,
      appearance: session.protagonist?.appearance,
      immutable_facts: [],
      mutable_state: [],
      mention_count: 0,
      last_seen_sequence: currentSequence,
      is_protagonist: true,
    } as unknown as CharacterProfileDoc)
  }

  return {
    recentEvents,
    sceneSummary: summaryDoc?.summary_text || null,
    characterCodex,
    mentionedEntityIds,
    loreTexts,
    memoryTexts,
    openThreads,
    retrievedEntityIds,
    currentSequence,
    currentTimeAnchor,
    timeContext,
  }
}
