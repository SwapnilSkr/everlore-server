import { ObjectId } from 'mongodb'
import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { getPineconeIndex } from '../../src/config/pinecone'
import { embed, callLLM, AI_MODELS } from '../../src/ai'
import { randomUUID } from 'crypto'
import { getRedisClient } from '../../src/config/redis'
import { idString, parseObjectId } from '../../src/utils/mongo-id'
import { entityGraphService, normalizeEntityName } from '../../src/services/entity-graph.service'
import { locationService } from '../../src/services/location.service'
import type { EntityDoc, EntityType } from '../../src/models/entity.model'
import type { TimeAnchorDoc } from '../../src/models/time.model'
import type { LocationAnchorDoc } from '../../src/models/location.model'

const EXTRACTION_PROMPT = `You are the memory curator for a long-running narrative world. Given one exchange between a player and the world, extract 0-3 memory atoms worth keeping long-term, and detect whether this turn resolved any previously open thread.

Rules for memory atoms:
- Only extract facts that would still matter 10+ turns from now.
- Each atom must be ONE self-contained sentence (or two short ones) that makes sense with no other context: resolve every pronoun to an explicit name from the character roster, and name places/objects explicitly.
- Prefer emotionally instructive memories over flat facts. Weak: "Mira forgave the player." Strong: "Mira chose to forgive the player after the ash-bridge betrayal, but her trust remains fragile; honesty now matters deeply to her." Capture the cause AND the lasting effect.
- Rate importance 1-5 (5 = critical plot point or vow, 1 = minor detail).
- Classify type: relationship, promise, lore, observation, emotion, secret.
- subjects = who acts/feels in the atom; objects = who/what is affected. Use canonical roster names where possible; use "player" for the player.
- NEVER invent, extend, or merge a name. Use each person's name EXACTLY as it appears in the text or roster. Do not attach a surname, title, or epithet from one character to another who lacks one (if the player is "Kade" and a different character is "Mara Chen", never write "Kade Chen"). Keep distinct people distinct — never fuse two characters because their names share a fragment, and never give one character another's codename/alias unless the text explicitly equates them.
- Set unresolved_thread true ONLY for genuinely open hooks: an unkept promise, an unanswered question, an unresolved conflict, a debt, a threat still looming. Mundane ongoing states are not threads.
- Top-level "entities": classify EVERY name used in any atom's subjects/objects with its kind: character, location, faction, item, quest, or other. Use "character" for people (including "player").
- Flag is_nsfw if explicit content is referenced.
- retrieval_terms: 3-6 short, lowercase alternate ways a LATER turn might refer to this fact — synonyms, the roles/objects/places involved, and the gist in different words — so the memory is still found when the future turn is worded differently from the atom. Example: atom "Mira forgave the player after the ash-bridge betrayal" → ["forgiveness", "betrayal at the ash bridge", "mira's trust", "making amends", "broken promise"]. Keep each a short phrase, not a sentence. Return [] only if truly none apply.
- If nothing is worth remembering, return an empty array.
- Treat "Player canonical narration facts" as events that DEFINITELY happened.

Rules for resolved threads:
- If this exchange clearly pays off, fulfills, breaks, or closes a promise/conflict/question from EARLIER in the story (not one introduced this turn), describe that earlier thread in "resolved_threads" using the explicit names involved (e.g. "the player's promise to return Mira's locket"). Otherwise return an empty array.

Respond ONLY with valid JSON matching this schema:
{
  "memories": [
    {
      "text": "string",
      "type": "string",
      "importance": number,
      "is_nsfw": boolean,
      "subjects": ["string"],
      "objects": ["string"],
      "emotional_valence": "string or null",
      "emotional_cause": "string or null",
      "emotional_effect": "string or null",
      "relationship_delta": "string or null",
      "unresolved_thread": boolean,
      "retrieval_terms": ["string"]
    }
  ],
  "entities": [
    { "name": "string", "kind": "character|location|faction|item|quest|other" }
  ],
  "resolved_threads": ["string"]
}`

function cleanShortText(value: unknown, max = 300): string | undefined {
  if (typeof value !== 'string') return undefined
  const t = value.replace(/\s+/g, ' ').trim()
  if (!t || /^(null|none|n\/a)$/i.test(t)) return undefined
  return t.slice(0, max)
}

function cleanNameList(value: unknown, max = 6): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean)
    .slice(0, max)
    .map((v) => v.slice(0, 80))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function uniqCorrections(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = raw.replace(/\s+/g, ' ').trim()
    if (!value || value.length < 2) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value.slice(0, 80))
    if (out.length >= 4) break
  }
  return out
}

/**
 * Deterministic correction detector for common player phrasing:
 * "Mira, not Mara", "my sister's name is Mira, not Mara", "actually Mira not Mara".
 * Returns the OLD term(s) after "not", which should be retired from active memory
 * atoms if this turn also curates a correcting atom.
 */
function extractExplicitCorrections(input: string): string[] {
  const text = String(input || '').replace(/\s+/g, ' ').trim()
  if (!text) return []
  const oldTerms: string[] = []
  const proper = `[A-Z][A-Za-z0-9'’-]*(?:\\s+[A-Z][A-Za-z0-9'’-]*){0,3}`
  for (const match of text.matchAll(new RegExp(`\\bnot\\s+(${proper})\\b`, 'g'))) {
    oldTerms.push(match[1])
  }
  for (const match of text.matchAll(new RegExp(`\\b(?:actually|it is|it's|its)\\s+${proper}\\s*,?\\s+not\\s+(${proper})\\b`, 'gi'))) {
    oldTerms.push(match[1])
  }
  return uniqCorrections(oldTerms)
}

function hasFirstPersonPlayerFact(input: string): boolean {
  const t = String(input || '').toLowerCase()
  return /\b(my|mine|i am|i'm|i have|i've|call me|my name is|remember that i)\b/.test(t)
}

function normalizePlayerFactAttribution(params: {
  extracted: any
  isSentient?: boolean
  sideChat?: unknown
  playerInput: string
  protagonistName?: string | null
}) {
  const { extracted, isSentient, sideChat, playerInput, protagonistName } = params
  if (!isSentient || sideChat || !protagonistName || !hasFirstPersonPlayerFact(playerInput)) return
  const protagNorm = normalizeEntityName(protagonistName)
  if (!protagNorm || !Array.isArray(extracted.memories)) return
  const protagRe = new RegExp(`\\b${escapeRegExp(protagonistName)}\\b`, 'gi')
  for (const mem of extracted.memories) {
    const names = [
      ...cleanNameList(mem.subjects),
      ...cleanNameList(mem.objects),
    ].map(normalizeEntityName)
    if (!names.includes(protagNorm)) continue
    mem.subjects = cleanNameList(mem.subjects).map((n) =>
      normalizeEntityName(n) === protagNorm ? 'player' : n,
    )
    mem.objects = cleanNameList(mem.objects).map((n) =>
      normalizeEntityName(n) === protagNorm ? 'player' : n,
    )
    if (typeof mem.text === 'string') {
      mem.text = mem.text.replace(protagRe, 'the player')
    }
  }
}

async function supersedeExplicitCorrections(params: {
  instanceOid: ObjectId
  eventOid: ObjectId
  oldTerms: string[]
  namespaceName: string
}): Promise<number> {
  const { instanceOid, eventOid, oldTerms, namespaceName } = params
  if (!oldTerms.length) return 0
  const clauses = oldTerms.map((term) => {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i')
    return { $or: [{ text: re }, { subjects: re }, { objects: re }] }
  })
  const stale = await mongoColl
    .memories()
    .find({
      instance_id: instanceOid,
      is_archived: false,
      origin: { $ne: 'side_chat' },
      source_event_ids: { $ne: eventOid },
      $or: clauses,
    })
    .limit(20)
    .toArray()
  if (!stale.length) return 0

  const namespace = getPineconeIndex().namespace(namespaceName)
  for (const memory of stale) {
    if (!memory.pinecone_id) continue
    try {
      await namespace.deleteOne({ id: memory.pinecone_id })
    } catch (err) {
      console.warn('Correction vector delete skipped:', (err as Error).message)
    }
  }

  const result = await mongoColl.memories().updateMany(
    { _id: { $in: stale.map((m) => m._id) } },
    {
      $set: { is_archived: true, status: 'superseded', updated_at: new Date() },
      $addToSet: { superseded_by_event_ids: eventOid },
    },
  )
  return result.modifiedCount || 0
}

/** Mark earlier open-thread memories matched by this turn's payoffs as resolved. */
async function resolveOpenThreads(
  instanceOid: ObjectId,
  resolvedThreads: string[],
): Promise<number> {
  let resolved = 0
  for (const threadQuery of resolvedThreads.slice(0, 3)) {
    try {
      const match = await mongoColl
        .memories()
        .find(
          {
            instance_id: instanceOid,
            unresolved_thread: true,
            is_archived: false,
            $text: { $search: threadQuery },
          },
          { projection: { score: { $meta: 'textScore' } } },
        )
        .sort({ score: { $meta: 'textScore' } })
        .limit(1)
        .toArray()
      const best = match[0] as (typeof match)[0] & { score?: number }
      // Threshold keeps a vague payoff from closing an unrelated thread.
      if (!best || (best.score ?? 0) < 1.0) continue
      await mongoColl.memories().updateOne(
        { _id: best._id },
        {
          $set: {
            unresolved_thread: false,
            resolved_at: new Date(),
            updated_at: new Date(),
          },
        },
      )
      resolved++
    } catch (err) {
      // Text index may not exist yet on older deployments — never fail the job.
      console.warn('Open-thread resolution skipped:', (err as Error).message)
      break
    }
  }
  return resolved
}

export async function memoryProcessor(job: Job) {
  const {
    instanceId,
    playerId,
    eventId,
    playerInput,
    playerSpokenInput = '',
    playerNarrationFacts = [],
    aiResponse,
    sceneTag,
    isSentient = false,
    playerPersonaName = null,
    protagonistName = null,
    /** Present when the exchange is a PRIVATE side-character chat: atoms get
     *  origin 'side_chat' + known_by participant scoping. */
    sideChat = null,
  } = job.data as {
    instanceId: string
    playerId: string
    eventId: string
    playerInput: string
    playerSpokenInput?: string
    playerNarrationFacts?: string[]
    aiResponse: string
    sceneTag: string
    isSentient?: boolean
    playerPersonaName?: string | null
    protagonistName?: string | null
    sideChat?: {
      characterId: string
      characterName: string
      characterEntityId: string | null
      isSentient: boolean
    } | null
  }
  const redis = getRedisClient()
  const instanceOid = parseObjectId(instanceId)
  const playerOid = parseObjectId(playerId)
  const eventOid = parseObjectId(eventId)

  // Character roster grounds pronoun/entity resolution so atoms are
  // self-contained ("Mira", not "she") and subjects/objects use canonical names.
  const roster = await mongoColl
    .characters()
    .find(
      { instance_id: instanceOid },
      { projection: { canonical_name: 1, aliases: 1, is_protagonist: 1 } },
    )
    .sort({ mention_count: -1, updated_at: -1 })
    .limit(16)
    .toArray()
  const rosterLines = roster.length
    ? roster
        .map((c: any) => {
          const aliases = (c.aliases || []).filter(Boolean)
          return `- ${c.canonical_name}${c.is_protagonist ? ' (protagonist)' : ''}${aliases.length ? ` (aka ${aliases.join(', ')})` : ''}`
        })
        .join('\n')
    : '- (no known characters yet)'
  const identityContext = isSentient
    ? `\nIdentity boundary:\n- This is a sentient/character conversation. The protagonist/main character${protagonistName ? ` is "${protagonistName}"` : ''}; the human player${playerPersonaName ? ` may be called "${playerPersonaName}"` : ''} is separate.\n- Any fact in Player input using "I", "me", or "my" belongs to the player. Use subject "player" for those facts, NEVER the protagonist/main character.\n- The narration speaks to/for the player ("you"/first person). A first-person sensation, feeling, or perception in the NARRATION ("a shiver runs through me", "my heart races", "I notice…") is the PLAYER's — use subject "player", NEVER attribute it to the main character. The main character is the subject only when the prose shows THEM acting or feeling by their own name.\n- Player-mentioned off-screen relatives or possessions are facts about the player, not new present characters.\n`
    : `\nIdentity boundary:\n- This is a GM world: the player speaks as the protagonist. Use "player" for the player's own first-person facts in memory subjects unless a specific other character acted.\n`

  const result = await callLLM({
    model: AI_MODELS.memoryCuration,
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      {
        role: 'user',
        content: `Scene type: ${sceneTag}${
          sideChat
            ? `\nNOTE: This is a PRIVATE one-on-one conversation between the player and ${sideChat.characterName}, outside the main story narration. "World" below is ${sideChat.characterName} speaking. Only the two of them witnessed it.`
            : ''
        }

Character roster (canonical names for resolution):
${rosterLines}
${identityContext}

Player (raw input): ${playerInput}
Player spoken dialogue: ${playerSpokenInput || '(none)'}
Player canonical narration facts:
${Array.isArray(playerNarrationFacts) && playerNarrationFacts.length
    ? playerNarrationFacts.map((f: string) => `- ${f}`).join('\n')
    : '- (none)'}

World: ${aiResponse}`,
      },
    ],
    temperature: 0.3,
    maxTokens: 900,
    responseFormat: { type: 'json_object' },
  })

  let extracted: any
  try {
    extracted = JSON.parse(result)
  } catch {
    console.warn('Memory extraction returned invalid JSON:', result)
    return { memoriesCreated: 0 }
  }
  normalizePlayerFactAttribution({ extracted, isSentient, sideChat, playerInput, protagonistName })

  // Close earlier open threads this turn paid off — even when no new atom was
  // worth storing (a quiet fulfillment is still a resolution).
  const resolvedThreads = cleanNameList(extracted.resolved_threads, 3)
  const threadsResolved = resolvedThreads.length
    ? await resolveOpenThreads(instanceOid, resolvedThreads)
    : 0

  if (!extracted.memories || extracted.memories.length === 0) {
    return { memoriesCreated: 0, threadsResolved }
  }

  // ── Entity-graph resolution: subjects/objects → entity ids ──
  // Strings stay on the doc (back-compat + text index); ids are what the
  // neighborhood retrieval and rewind repair operate on. Graph failures must
  // never fail curation.
  let entityMap: Map<string, EntityDoc> | null = null
  let playerEntity: EntityDoc | null = null
  let entitySequence = 0
  let eventTimeAnchor: TimeAnchorDoc | null = null
  let eventLocationAnchor: LocationAnchorDoc | null = null
  try {
    const ev = await mongoColl
      .events()
      .findOne({ _id: eventOid }, { projection: { sequence: 1, time_anchor: 1, location_anchor: 1 } })
    const sequence = ev?.sequence || 0
    eventTimeAnchor = (ev as any)?.time_anchor || null
    eventLocationAnchor = (ev as any)?.location_anchor || null

    const KIND_TO_TYPE: Record<string, EntityType> = {
      character: 'character',
      location: 'location',
      faction: 'faction',
      item: 'item',
      quest: 'quest',
      other: 'concept',
    }
    const extractedKinds = new Map<string, EntityType>()
    for (const e of Array.isArray(extracted.entities) ? extracted.entities : []) {
      const name = normalizeEntityName(String(e?.name || ''))
      const type = KIND_TO_TYPE[String(e?.kind || '').toLowerCase()]
      if (name && type) extractedKinds.set(name, type)
    }
    // The codex roster outranks the LLM's kind guess for people we know.
    const rosterTypes = new Map<string, EntityType>()
    for (const c of roster) {
      const type: EntityType = (c as any).is_protagonist ? 'protagonist' : 'character'
      rosterTypes.set(normalizeEntityName(c.canonical_name), type)
      for (const a of (c as any).aliases || []) rosterTypes.set(normalizeEntityName(a), type)
    }

    const mentions: { name: string; type?: EntityType }[] = []
    const seenMentions = new Set<string>()
    for (const mem of extracted.memories) {
      for (const name of [...cleanNameList(mem.subjects), ...cleanNameList(mem.objects)]) {
        const normalized = normalizeEntityName(name)
        if (!normalized || seenMentions.has(normalized)) continue
        seenMentions.add(normalized)
        if (normalized === 'player' || normalized === 'the player') continue // singleton below
        mentions.push({
          name,
          type: rosterTypes.get(normalized) || extractedKinds.get(normalized) || 'concept',
        })
      }
    }
    playerEntity = await entityGraphService.ensurePlayerEntity({ instanceId, playerId, sequence })
    entityMap = await entityGraphService.resolveOrCreateEntities({
      instanceId,
      playerId,
      sequence,
      mentions,
    })
    entitySequence = sequence
  } catch (err) {
    console.warn('Memory entity resolution skipped:', (err as Error).message)
  }

  // Who-knows-this scope for private side-chat atoms: the player, the side
  // character, and — in GM worlds, where the player speaks AS the protagonist —
  // the protagonist too (their own conversations are protagonist knowledge,
  // which is exactly what the main-narration gate checks). Fails CLOSED: if
  // resolution comes up empty the atom is invisible everywhere rather than leaked.
  let knownByEntityIds: ObjectId[] = []
  if (sideChat) {
    try {
      if (playerEntity) knownByEntityIds.push(playerEntity._id)
      const charEntityId = sideChat.characterEntityId
        ? parseObjectId(sideChat.characterEntityId)
        : entityMap?.get(normalizeEntityName(sideChat.characterName))?._id || null
      if (charEntityId && !knownByEntityIds.some((id) => id.equals(charEntityId))) {
        knownByEntityIds.push(charEntityId)
      }
      if (!sideChat.isSentient) {
        const protagonist = await mongoColl
          .entities()
          .findOne({ instance_id: instanceOid, type: 'protagonist' }, { projection: { _id: 1 } })
        if (protagonist && !knownByEntityIds.some((id) => id.equals(protagonist._id))) {
          knownByEntityIds.push(protagonist._id)
        }
      }
    } catch (err) {
      console.warn('Side-chat known_by resolution incomplete:', (err as Error).message)
    }
  }
  const entityIdsFor = (names: string[]): ObjectId[] => {
    if (!entityMap) return []
    const out: ObjectId[] = []
    for (const name of names) {
      const e = entityMap.get(normalizeEntityName(name))
      if (e && !out.some((id) => id.equals(e._id))) out.push(e._id)
    }
    return out
  }

  const index = getPineconeIndex()
  const namespaceName = `mem_${instanceId}`
  const namespace = index.namespace(namespaceName)
  const newMemories: any[] = []

  for (const mem of extracted.memories) {
    const text = cleanShortText(mem.text, 600)
    if (!text) continue
    const memId = new ObjectId()
    const vecId = randomUUID()
    const memIdStr = idString(memId)

    const subjects = cleanNameList(mem.subjects)
    const objects = cleanNameList(mem.objects)
    const subjectEntityIds = entityIdsFor(subjects)
    const objectEntityIds = entityIdsFor(objects)
    const unresolvedThread = mem.unresolved_thread === true

    // Alternate phrasings the curator emitted: embed them WITH the atom so a future
    // turn worded differently still lands close in vector space, and store them as
    // search_terms (indexed for keyword recall). The displayed `text` stays clean.
    const retrievalTerms = cleanNameList(mem.retrieval_terms, 8).map((t) => t.toLowerCase())
    const embedInput = retrievalTerms.length ? `${text}\n${retrievalTerms.join(', ')}` : text
    const embedding = await embed(embedInput)

    const vectorMetadata: Record<string, string | number | boolean | string[]> = {
      text,
      type: mem.type,
      importance: mem.importance,
      is_nsfw: mem.is_nsfw || false,
      mongo_id: memIdStr,
      unresolved_thread: unresolvedThread,
      created_at: new Date().toISOString(),
    }
    if (subjects.length > 0) vectorMetadata.subjects = subjects
    if (sideChat) {
      vectorMetadata.origin = 'side_chat'
      vectorMetadata.known_by = knownByEntityIds.map((id) => idString(id))
    }
    if (eventTimeAnchor?.timeline_id) vectorMetadata.timeline_id = eventTimeAnchor.timeline_id
    if (eventTimeAnchor?.sequence) vectorMetadata.sequence = eventTimeAnchor.sequence
    if (eventLocationAnchor?.entity_id) vectorMetadata.location_entity_id = idString(eventLocationAnchor.entity_id)
    if (eventLocationAnchor?.name) vectorMetadata.location_name = eventLocationAnchor.name

    await namespace.upsert({
      records: [{
        id: vecId,
        values: embedding,
        metadata: vectorMetadata,
      }],
    })

    const enrichment: Record<string, unknown> = {}
    const emotionalValence = cleanShortText(mem.emotional_valence, 40)
    const emotionalCause = cleanShortText(mem.emotional_cause)
    const emotionalEffect = cleanShortText(mem.emotional_effect)
    const relationshipDelta = cleanShortText(mem.relationship_delta)
    if (emotionalValence) enrichment.emotional_valence = emotionalValence
    if (emotionalCause) enrichment.emotional_cause = emotionalCause
    if (emotionalEffect) enrichment.emotional_effect = emotionalEffect
    if (relationshipDelta) enrichment.relationship_delta = relationshipDelta

    const memoryDoc = {
      _id: memId,
      instance_id: instanceOid,
      player_id: playerOid,
      text,
      type: mem.type,
      importance: mem.importance,
      is_nsfw: mem.is_nsfw || false,
      source_event_ids: [eventOid],
      pinecone_id: vecId,
      access_count: 0,
      last_accessed_at: new Date(),
      is_archived: false,
      status: 'active' as const,
      ...(sideChat ? { origin: 'side_chat' as const, known_by_entity_ids: knownByEntityIds } : {}),
      subjects,
      objects,
      ...(retrievalTerms.length ? { search_terms: retrievalTerms.join(', ') } : {}),
      ...(subjectEntityIds.length ? { subject_entity_ids: subjectEntityIds } : {}),
      ...(objectEntityIds.length ? { object_entity_ids: objectEntityIds } : {}),
      ...(eventTimeAnchor ? { time_anchor: eventTimeAnchor, timeline_id: eventTimeAnchor.timeline_id } : {}),
      ...(eventLocationAnchor
        ? {
            location_anchor: eventLocationAnchor,
            location_entity_id: eventLocationAnchor.entity_id,
            location_name: eventLocationAnchor.name,
          }
        : {}),
      ...enrichment,
      unresolved_thread: unresolvedThread,
      resolved_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    }
    await mongoColl.memories().insertOne(memoryDoc)
    newMemories.push(memoryDoc)

    // Relationship atoms also become graph edges (subject → object) so the
    // graph can answer "what stands between these two" without re-reading
    // memory text. Provenance = this event; rewind/edit prunes it.
    if (
      mem.type === 'relationship' &&
      subjectEntityIds.length > 0 &&
      objectEntityIds.length > 0 &&
      !subjectEntityIds[0].equals(objectEntityIds[0])
    ) {
      try {
        await entityGraphService.upsertNarrativeEdge({
          instanceId,
          sourceEntityId: subjectEntityIds[0],
          targetEntityId: objectEntityIds[0],
          type: 'relationship',
          label: relationshipDelta || text,
          importance: mem.importance,
          eventId: eventOid,
          sequence: entitySequence,
        })
      } catch (err) {
        console.warn('Relationship edge upsert skipped:', (err as Error).message)
      }
    }
  }

  if (!sideChat && newMemories.length > 0) {
    const explicitOldTerms = extractExplicitCorrections(playerInput)
    if (explicitOldTerms.length > 0) {
      try {
        const superseded = await supersedeExplicitCorrections({
          instanceOid,
          eventOid,
          oldTerms: explicitOldTerms,
          namespaceName,
        })
        if (superseded > 0) {
          console.log(
            `[memory] superseded ${superseded} atom(s) via explicit correction: ${explicitOldTerms.join(', ')}`,
          )
        }
      } catch (err) {
        console.warn('Explicit correction supersession skipped:', (err as Error).message)
      }
    }
  }

  // Memory version graph (Phase 2): materialize the forward `updates_memory_ids`
  // on this turn's new atoms. The supersession seam (codex retirement) already
  // stamped the OLD atoms it archived with `superseded_by_event_ids: thisEvent`
  // (race-free single writer); here the curator — the natural owner of the new
  // correcting atoms — points them back. Whichever of {supersession, curation}
  // sees both materializes the link; the repair job reconciles the race. Only on
  // MAIN turns (a side-chat atom never supersedes a main codex fact).
  if (!sideChat && newMemories.length > 0) {
    try {
      const supersededByThisEvent = await mongoColl
        .memories()
        .find(
          { instance_id: instanceOid, superseded_by_event_ids: eventOid },
          { projection: { _id: 1 } },
        )
        .toArray()
      if (supersededByThisEvent.length > 0) {
        const oldIds = supersededByThisEvent.map((m) => m._id)
        await mongoColl.memories().updateMany(
          { _id: { $in: newMemories.map((m) => m._id) } },
          { $addToSet: { updates_memory_ids: { $each: oldIds } }, $set: { updated_at: new Date() } },
        )
      }
    } catch (err) {
      console.warn('Memory version-link materialization skipped:', (err as Error).message)
    }
  }

  await mongoColl.worldInstances().updateOne(
    { _id: instanceOid },
    { $inc: { 'meta.total_memories': newMemories.length } },
  )

  // Curation just created location-linked memories, so the memory_count for those
  // places changed — refresh the materialized location_stats projection for each
  // affected place (distinct location_entity_ids). Fire-and-forget: projection
  // maintenance must never block or fail curation.
  const touchedLocationIds = new Set(
    newMemories
      .map((m) => m.location_entity_id as ObjectId | undefined)
      .filter((id): id is ObjectId => !!id)
      .map((id) => idString(id)),
  )
  for (const locId of touchedLocationIds) {
    void locationService.refreshLocationStat(instanceId, locId)
  }

  await redis.publish(`user:${playerId}:events`, JSON.stringify({
    type: 'memories_curated',
    instanceId,
    memories: newMemories.map((m) => ({
      id: idString(m._id),
      text: m.text,
      type: m.type,
      importance: m.importance,
    })),
  }))

  return { memoriesCreated: newMemories.length, threadsResolved }
}
