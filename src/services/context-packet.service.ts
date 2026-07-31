import { mongoColl } from '../config/mongo'
import type { CharacterProfileDoc } from '../models/character-profile.model'
import type { WorldEventDoc } from '../models/world-event.model'
import { queryRag, querySummaries } from '../providers/rag.provider'
import { rankCodexForInjection } from './character-codex.service'
import { entityGraphService } from './entity-graph.service'
import { kinshipGraphService } from './kinship-graph.service'
import { timeService } from './time.service'
import { idString, parseObjectId } from '../utils/mongo-id'
import { EVENT_WINDOWS } from '../utils/event-window'
import type { TimeAnchorDoc } from '../models/time.model'
import type { LocationAnchorDoc } from '../models/location.model'
import { type WorldFactSource, confidenceTier } from '../utils/world-authority'

/** Injected codex size (recency-ranked top-K before pinning). */
const CODEX_INJECT_LIMIT = 16
/** Candidate pool the ranking selects from. */
const CODEX_POOL_LIMIT = 40
/** Cards pinned because RETRIEVED MEMORIES are about them (indirect mentions). */
const MEMORY_PIN_LIMIT = 3
/** Position-brief recency tier (§6): a character last seen within this many
 *  sequences is asserted as canon ("was last seen in X"); a staler position is
 *  hedged to a hint so the narrator won't teleport them back to a place they
 *  likely left long ago. The recency analog of the kinship brief's confidence tier. */
const FRESH_POSITION_WINDOW = 30

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
  /** Semantically-relevant DISTANT chapter/scene summaries (long-horizon recall
   *  the recent window + injected scene summary don't already cover). */
  relevantSummaries: string[]
  /** Ranked + pinned cards: [input mentions, memory-driven pins, ranked top-K]. */
  characterCodex: CharacterProfileDoc[]
  /** Entity ids the player named this turn (drives neighborhood retrieval). */
  mentionedEntityIds: string[]
  loreTexts: string[]
  memoryTexts: string[]
  openThreads: string[]
  /** Entity ids linked to retrieved memories (provenance of the memory pins). */
  retrievedEntityIds: string[]
  /** CANON BRIEF (relationships) — compact, always-on kinship facts for the turn's
   *  active cast, incl. lifecycle state ("father (deceased)"). Surfaces the kinship
   *  graph to the NARRATOR, not just the choice guard. */
  relationshipFacts: string[]
  /** CANON BRIEF (positions) — where active-cast characters were last seen when they
   *  are NOT in the current place ("Mara was last seen in the Ash Tavern"), so a
   *  "go find X" / "where is X" turn resolves against canon. */
  positionFacts: string[]
  /** CANON BRIEF (companions) — who is travelling WITH the player right now, surfaced
   *  so the narrator keeps them present by default (they don't show in positionFacts). */
  companionFacts: string[]
  /** Sequence of the latest existing event (0 on a fresh world). */
  currentSequence: number
  currentTimeAnchor: TimeAnchorDoc | null
  timeContext: string | null
  currentLocation: LocationAnchorDoc | null
  locationContext: string | null
}

/** The session fields the packet builder reads (subset of the cached session). */
interface PacketSession {
  template_id: string
  is_sentient?: boolean
  protagonist?: { name?: string; persona?: string; appearance?: string } | null
  max_lore_results?: number
  max_context_memories?: number
  current_time_anchor?: TimeAnchorDoc | null
  current_location?: LocationAnchorDoc | null
  /** Companions explicitly travelling with the player (cache stores entity_id as a
   *  string). Surfaced to the narrator as present-by-default. */
  travelling_with?: Array<{ entity_id?: string; name: string; source?: WorldFactSource; confidence?: number }> | null
}

function normalizeLocationAnchor(raw: any): LocationAnchorDoc | null {
  if (!raw?.entity_id || !raw.name) return null
  try {
    return {
      entity_id: typeof raw.entity_id === 'string' ? parseObjectId(raw.entity_id) : raw.entity_id,
      name: raw.name,
      name_normalized: raw.name_normalized || entityGraphService.normalizeEntityName(raw.name),
    }
  } catch {
    return null
  }
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

  const recentEvents = await mongoColl
    .events()
    .find({ instance_id: iid })
    .sort({ sequence: -1 })
    .limit(EVENT_WINDOWS.promptRecentEvents)
    .toArray() as WorldEventDoc[]
  recentEvents.reverse()
  const currentSequence = recentEvents[recentEvents.length - 1]?.sequence || 0

  // These reads are independent of entity resolution and RAG. Start them now
  // and await each only at its first real consumer below; keeping them off the
  // serial first-token path noticeably reduces cold-turn latency.
  const summaryDocPromise = mongoColl.sceneSummaries().findOne(
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
  const timeContextPromise = timeService.timelineContext(instanceId, currentTimeAnchor)
  const currentLocation =
    normalizeLocationAnchor(session.current_location) ||
    normalizeLocationAnchor(recentEvents[recentEvents.length - 1]?.location_anchor) ||
    null
  // Prose-facing line only — no entity id, which the narration model could
  // echo into the story. Code consumers read packet.currentLocation instead.
  // Enriched with the containment ANCESTRY (owner-scoped identity, so "Marcus's
  // penthouse, within Downtown" can't be confused with another penthouse) and the
  // place's canon facts + current condition.
  const locationContextPromise: Promise<string | null> = !currentLocation
    ? Promise.resolve(null)
    : Promise.all([
        entityGraphService
          .placeAncestry(instanceId, idString(currentLocation.entity_id))
          .catch(() => [] as string[]),
        mongoColl
          .entities()
          .findOne(
            { _id: currentLocation.entity_id, instance_id: iid, type: 'location' },
            { projection: { location_state: 1, location_facts: 1 } },
          )
          .catch(() => null) as Promise<{ location_state?: Array<{ text: string }>; location_facts?: Array<{ text: string }> } | null>,
      ]).then(([ancestry, placeEntity]) => {
        let context = `Current place: ${currentLocation.name}.`
        if (ancestry.length) context += ` (within ${ancestry.join(', ')})`
        const facts = (placeEntity?.location_facts || []).slice(-3).map((f) => f.text)
        const state = (placeEntity?.location_state || []).slice(-3).map((f) => f.text)
        if (facts.length) context += `\nAbout this place: ${facts.join(' ')}`
        if (state.length) context += `\nCurrent condition: ${state.join(' ')}`
        return context
      })

  const codexPoolPromise = mongoColl
    .characters()
    .find({ instance_id: iid })
    .sort({ is_protagonist: -1, mention_count: -1, updated_at: -1 })
    .limit(CODEX_POOL_LIMIT)
    .toArray() as Promise<CharacterProfileDoc[]>

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

    // Wake long-dormant uncarded characters that THIS turn's cues make relevant —
    // named in the input, tied by a kin/relationship edge to someone present, or
    // tied to the current place — so a character last seen thousands of turns ago
    // resurfaces exactly when it matters (not injected wholesale). Woken stub ids
    // join the RAG entity neighbourhood below so their memories are retrievable.
    try {
      const nameCues = (userMessage.match(/\b[A-Z][a-zà-ÿ'’-]+\b/g) || []).slice(0, 16)
      const woken = await entityGraphService.wakeStubsByCues({
        instanceId,
        names: nameCues,
        presentEntityIds: mentionedEntityIds,
        locationEntityId: currentLocation?.entity_id ? idString(currentLocation.entity_id) : null,
      })
      if (woken.entityIds.length) {
        mentionedEntityIds = [...new Set([...mentionedEntityIds, ...woken.entityIds])]
      }
    } catch (err) {
      console.warn('Context packet: stub wake skipped:', (err as Error).message)
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

  // Long-horizon recall runs CONCURRENTLY with the main RAG query so it adds no
  // extra serial latency to TTFT. Skipped on a continue (no query to match).
  const summariesPromise: Promise<Awaited<ReturnType<typeof querySummaries>>> =
    !isContinuation && ragQueryText.trim()
      ? querySummaries(instanceId, ragQueryText, 3).catch((err) => {
          console.warn('Context packet: summary retrieval skipped:', (err as Error).message)
          return []
        })
      : Promise.resolve([])

  try {
    const rag = await queryRag(
      String(session.template_id),
      instanceId,
      ragQueryText,
      session.max_lore_results || 10,
      session.max_context_memories || 25,
      mentionedEntityIds,
      currentTimeAnchor?.timeline_id || 'main',
      currentLocation?.entity_id ? idString(currentLocation.entity_id) : null,
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

  // ── 2b. Long-horizon recall: exclude anything the recent raw window or the
  //    injected scene summary already covers so we don't double-narrate.
  const summaryDoc = await summaryDocPromise
  const earliestRecent = recentEvents[0]?.sequence ?? currentSequence
  const injectedEnd = summaryDoc?.event_range?.end_sequence ?? -1
  const relevantSummaries = (await summariesPromise)
    .filter((h) => h.endSequence < earliestRecent && h.endSequence !== injectedEnd)
    .map((h) => h.text)

  // ── 3. Codex selection (AFTER retrieval, so memories can shape it) ──
  const codexPool = await codexPoolPromise
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

  // ── 4. Canon brief (relationships): kinship facts for the active cast, surfaced
  //    to the narrator. ACTIVE = protagonist + injected codex + mentioned + memory-
  //    linked entities. One indexed graph read; skipped via KINSHIP_GRAPH_READS=off.
  //    CONSUMPTION-TIERED: kinshipBrief now grades each edge by confidence
  //    (world-authority.confidenceTier) — high → asserted as canon, medium → soft
  //    "possibly/unconfirmed" hint, low → dropped. This is the blast-radius control:
  //    a wrong low-confidence tie degrades to a hint instead of a hard line.
  //    The position brief (§6) applies the same tier vocabulary via a RECENCY signal;
  //    the companion brief (§5) via the membership confidence now carried on
  //    travelling_with (tagged in generation.processor by the authority of the join
  //    text — player narration outranks narrator prose).
  const relationshipFactsPromise: Promise<string[]> = process.env.KINSHIP_GRAPH_READS === 'off'
    ? Promise.resolve([])
    : (() => {
    const selfEntityId =
      (characterCodex.find((c) => c.is_protagonist)?.entity_id &&
        idString(characterCodex.find((c) => c.is_protagonist)!.entity_id!)) ||
      null
    const activeEntityIds = [
      ...(selfEntityId ? [selfEntityId] : []),
      ...characterCodex.map((c) => (c.entity_id ? idString(c.entity_id) : '')).filter(Boolean),
      ...mentionedEntityIds,
      ...retrievedEntityIds,
    ]
    return kinshipGraphService
      .kinshipBrief(instanceId, activeEntityIds, selfEntityId)
      .catch((err) => {
        console.warn('Context packet: kinship brief skipped:', (err as Error).message)
        return []
      })
    })()

  // ── 5. Canon brief (companions): who is travelling WITH the player (from the prior
  //    turn's persisted party). Surfaced as present-by-default, and excluded from the
  //    "elsewhere" position lines below so they're never reported as off-screen.
  const party = (session.travelling_with || []).filter((m) => m && m.name)
  // partyNameKeys still covers the WHOLE party (any tier) so §6 never double-reports
  // a companion as "elsewhere". CONSUMPTION-TIERED by membership confidence: a strong
  // (player/narrator) join is asserted as present; a low-confidence one — once a weak
  // detection path exists — is hedged; hidden-tier members drop out. Legacy rows carry
  // no confidence → confidenceTier defaults them to canon, so today's behavior is
  // unchanged until party-signal starts emitting weaker tiers.
  const partyNameKeys = new Set(party.map((m) => m.name.trim().toLowerCase()))
  const canonParty = party.filter((m) => confidenceTier(m.confidence) === 'canon')
  const hintParty = party.filter((m) => confidenceTier(m.confidence) === 'hint')
  const companionFacts: string[] = []
  if (canonParty.length > 0) {
    companionFacts.push(
      `Travelling with you right now: ${canonParty.map((m) => m.name).join(', ')}. Keep them present in the scene by default — do not drop or forget them across a move or a time skip unless the story shows them parting.`,
    )
  }
  if (hintParty.length > 0) {
    companionFacts.push(
      `Possibly still travelling with you (unconfirmed): ${hintParty.map((m) => m.name).join(', ')}.`,
    )
  }

  // ── 6. Canon brief (positions): where active-cast characters were last seen, for
  //    those who aren't in the current place — powers "go find X" / "where is X".
  const codexEntityIds = characterCodex
    .map((c) => (c.entity_id ? idString(c.entity_id) : ''))
    .filter(Boolean)
  const positionFactsPromise: Promise<string[]> = codexEntityIds.length === 0
    ? Promise.resolve([])
    : entityGraphService
      .characterPositions({
        instanceId,
        entityIds: codexEntityIds,
        currentLocationId: currentLocation?.entity_id ? idString(currentLocation.entity_id) : null,
      })
      // A companion travelling WITH the player is never "elsewhere".
      .then((rows) =>
        rows
          .filter((r) => !partyNameKeys.has(r.name.trim().toLowerCase()))
          .map((r) => {
            // Recency tiering (the §6 analog of §4's confidence tiering): a fresh
            // position is canon; a stale one degrades to a hedged hint.
            const age = currentSequence - (r.sequence || 0)
            return age <= FRESH_POSITION_WINDOW
              ? `${r.name} was last seen in ${r.place}.`
              : `${r.name} was last seen in ${r.place}, though that was a while ago — they may have moved since.`
          }),
      )
      .catch((err) => {
        console.warn('Context packet: character positions skipped:', (err as Error).message)
        return []
      })

  const [relationshipFacts, positionFacts, timeContext, locationContext] =
    await Promise.all([
      relationshipFactsPromise,
      positionFactsPromise,
      timeContextPromise,
      locationContextPromise,
    ])

  return {
    recentEvents,
    sceneSummary: summaryDoc?.summary_text || null,
    relevantSummaries,
    characterCodex,
    mentionedEntityIds,
    loreTexts,
    memoryTexts,
    openThreads,
    retrievedEntityIds,
    relationshipFacts,
    positionFacts,
    companionFacts,
    currentSequence,
    currentTimeAnchor,
    timeContext,
    currentLocation,
    locationContext,
  }
}
