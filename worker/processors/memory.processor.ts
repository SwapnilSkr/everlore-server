import { groupPlayerLine, groupLineText, groupSpeaker, GROUP_ACTION_RULE } from '../../src/services/group-chat/actions'
import { curateGroupBonds } from '../../src/services/group-chat/bonds'
import { GROUP_CURATION_SCHEMA, filterGroupAtomAudiences, closeGroupThreads, groupMemoryTextKey, missedDetailAtoms, dropAdultWriterClaims, refileSpokenFacts, clearEverydayAdultMarks, uncoveredAdultEvents, adultRetryAtoms, adultLineAtoms } from '../../src/services/group-chat/curation'
import { loadGroupMembers } from '../../src/services/group-chat/instance'
import { allowedGroupMemories, deriveGroupAudience, groupMemoryMayMerge, withGroupMemoryLease, loadGroupBatch, groupMessages, groupEventsLive, advanceGroupWatermark, type GroupMemoryBatch } from '../../src/services/group-chat/memory'
import { log } from '../../src/utils/logger'
import { runBackgroundLLMTrace } from '../../src/services/llm-trace.service'
import { ObjectId } from 'mongodb'
import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { vectorStore, type VectorScope } from '../../src/services/vector-store'
import { embed, callLLM, AI_MODELS } from '../../src/ai'
import { randomUUID } from 'crypto'
import { getRedisClient } from '../../src/config/redis'
import { idString, parseObjectId } from '../../src/utils/mongo-id'
import { liveInstanceExists } from '../../src/utils/live-instance'
import { entityGraphService, normalizeEntityName } from '../../src/services/entity-graph.service'
import { locationService } from '../../src/services/location.service'
import type { EntityDoc, EntityType } from '../../src/models/entity.model'
import type { TimeAnchorDoc } from '../../src/models/time.model'
import type { LocationAnchorDoc } from '../../src/models/location.model'

const ATOM_CLASSIFICATION_RULES = `- Rate importance 1-5 (5 = critical plot point or vow, 1 = minor detail).
- Classify type: relationship, promise, lore, observation, emotion, secret.
- subjects = who acts/feels in the atom; objects = who/what is affected. Use canonical roster names where possible; use "player" for the player.`

const ATOM_IDENTITY_RULE = `- NEVER invent, extend, or merge a name. Use each person's name EXACTLY as it appears in the text or roster. Do not attach a surname, title, or epithet from one character to another who lacks one (if the player is "Kade" and a different character is "Mara Chen", never write "Kade Chen"). Keep distinct people distinct — never fuse two characters because their names share a fragment, and never give one character another's codename/alias unless the text explicitly equates them.`

const ATOM_METADATA_RULES = `- Set unresolved_thread true for genuinely open hooks: an unkept promise, an unanswered question, an unresolved conflict, a debt, a threat still looming, an appointment or instruction that has not yet been carried out (meet at a place, go at first light, deliver or burn a note, wait for someone). Mundane ongoing states are not threads. A type of "promise" is always a thread until a later turn pays it off.
- Top-level "entities": classify EVERY name used in any atom's subjects/objects with its kind: character, location, faction, item, quest, or other. Use "character" for people (including "player").
- Flag is_nsfw if explicit content is referenced.
- retrieval_terms: 3-6 short, lowercase alternate ways a LATER turn might refer to this fact — synonyms, the roles/objects/places involved, and the gist in different words — so the memory is still found when the future turn is worded differently from the atom. Example: atom "Mira forgave the player after the ash-bridge betrayal" → ["forgiveness", "betrayal at the ash bridge", "mira's trust", "making amends", "broken promise"]. Keep each a short phrase, not a sentence. Return [] only if truly none apply.`

const THREAD_CLOSURE_RULES = `Rules for resolved threads:
- You will be shown LIVE RELATED FACTS, each with an id (T1, T2, ...). These include flagged open threads AND earlier facts this turn is talking about (appointments, warnings, notes, meetings, instructions). They are still retrieved as if they were current.
- For EACH listed fact, decide whether THIS exchange settles, completes, or contradicts it. Settled means the thing it was waiting for actually happens: the meeting occurs, the note is burned, the appointment is kept, the order is given, the demand is met, the promise is kept or broken. Put those ids in "closed_thread_ids".
- Settling is about the EVENT, not the mood. A character who is still angry, suspicious, or unsatisfied AFTER getting what they demanded has still had the demand met — close it. If a new demand replaces it, that is a NEW thread, which you record as a memory atom with unresolved_thread true.
- Be decisive. A fact you leave open is handed to the storyteller on every future turn as live plot, so a meeting already held or a note already burned will be restaged as if it had not happened.
- "resolved_threads" is for a payoff you can describe but that matches no listed id — use the explicit names involved (e.g. "the player's promise to return Mira's locket"). Otherwise return an empty array.`

const EXTRACTION_PROMPT = `You are the memory curator for a long-running narrative world. Given one exchange between a player and the world, extract 0-3 memory atoms worth keeping long-term, and detect whether this turn resolved any previously open thread.

Rules for memory atoms:
- Only extract facts that would still matter 10+ turns from now.
- Each atom must be ONE self-contained sentence (or two short ones) that makes sense with no other context: resolve every pronoun to an explicit name from the character roster, and name places/objects explicitly.
- Prefer emotionally instructive memories over flat facts. Weak: "Mira forgave the player." Strong: "Mira chose to forgive the player after the ash-bridge betrayal, but her trust remains fragile; honesty now matters deeply to her." Capture the cause AND the lasting effect.
${ATOM_CLASSIFICATION_RULES}
- RESOLVE BACK-REFERENCES using the "Preceding narration" below: when the player's input points at something just said ("stuff like that", "what you said", "things like that", "that", "such things"), resolve it to the ACTUAL content from the preceding narration before writing the atom — never store the vague pointer. Worked example: preceding narration said "Never trust your enemies." and the player says "my father used to say stuff like that" → atom: 'The player's father used to say things like "never trust your enemies."' with subject "father" (or his name if known). ATTRIBUTE a quote, saying, belief, or trait to the PERSON it belongs to (here the father), so it becomes a memory ABOUT that person — list them in subjects so it attaches to their card/entity. Only do this when the player actually attributes it to someone; otherwise treat it as a normal observation.
${ATOM_IDENTITY_RULE}
${ATOM_METADATA_RULES}
- If nothing is worth remembering, return an empty array.
- Treat "Player canonical narration facts" as events that DEFINITELY happened.

${THREAD_CLOSURE_RULES}

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
  "resolved_threads": ["string"],
  "closed_thread_ids": ["T1"]
}`

const GROUP_EXTRACTION_PROMPT = `You are the memory curator for a numbered conversation among several people. Read all supplied messages and keep each personal fact about anyone in the chat, including their family, work, health, plans and promises, as its own atom even when it looks small. There is no per-exchange atom limit. Detect whether the conversation resolves any previously open thread.

Rules for memory atoms:
- Write one self-contained sentence per fact, one fact per atom. Resolve "I" and "my" to the speaker of the cited message, "you" to the person spoken to, and words quoted from someone to the person who said them. A fact belongs to the person it is about, not to whoever mentions it; keep each person's facts separate. Name people, places and objects explicitly.
${ATOM_CLASSIFICATION_RULES}
${ATOM_IDENTITY_RULE}
${ATOM_METADATA_RULES}
- Every atom must include source_messages: a nonempty array of integer message numbers from the supplied numbered conversation. Cite only messages that establish that fact, never database ids.
- Keep exact details word for word: codes, passwords, numbers, amounts, dates, times, addresses and the names of people and places. When a message gives one, write an atom that states it exactly; never summarize it away.
- Return an empty memories array only when no message establishes any personal fact.

Rules for closing open threads:
- OPEN THREADS lists only previously stored unresolved threads. Use that list only to identify a thread to close. Atoms come only from the numbered messages, never from that list; do not copy or recite its facts as new atoms.
- Return closed_threads objects with thread_id (T1, T2, ...) and nonempty source_messages citing the numbered messages that establish the payoff. Cite only messages from events later than every event that established the thread; repeating the opening promise is not a payoff.
- Closing means a promise is kept or broken, a question answered, or an appointment completed. The memory remains stored after closure. Return [] when no later message establishes a payoff.

Respond ONLY with valid JSON matching this schema. Every field listed in required must be present in each object, including source_messages in each memory atom:
${JSON.stringify(GROUP_CURATION_SCHEMA, null, 2)}`

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
  playerInput: string
  protagonistName?: string | null
}) {
  const { extracted, isSentient, playerInput, protagonistName } = params
  if (!isSentient || !protagonistName || !hasFirstPersonPlayerFact(playerInput)) return
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
  scope: VectorScope
}): Promise<number> {
  const { instanceOid, eventOid, oldTerms, scope } = params
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
      source_event_ids: { $ne: eventOid },
      $or: clauses,
    })
    .limit(20)
    .toArray()
  if (!stale.length) return 0

  for (const memory of stale) {
    if (!memory.pinecone_id) continue
    try {
      await vectorStore.deleteIds(scope, [memory.pinecone_id])
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

/**
 * Sort the curator's two closure fields into ids and prose.
 *
 * The fields get mixed up in practice: asked for `closed_thread_ids`, the model
 * puts "T1","T2" into `resolved_threads`, which is the PROSE field. Those would
 * then be run through text search as the literal query "T1" -- matching nothing
 * at best, and something arbitrary at worst. Observed on a real turn the first
 * time this was replayed, on the turn that settled the story's oldest demand.
 *
 * Anything shaped like a thread that was actually offered is an id, whichever
 * field it arrived in. Only what is left over is prose.
 */
export function routeThreadClosures(
  extracted: { closed_thread_ids?: unknown; resolved_threads?: unknown },
  offeredIds: string[],
): { ids: string[]; prose: string[] } {
  const known = new Set(offeredIds.map((id) => id.trim().toUpperCase()))
  const asId = (value: unknown): string | null => {
    const key = String(value ?? '').trim().toUpperCase()
    return known.has(key) ? key : null
  }
  const ids = new Set<string>()
  for (const value of [...cleanNameList(extracted.closed_thread_ids, 12), ...cleanNameList(extracted.resolved_threads, 12)]) {
    const id = asId(value)
    if (id) ids.add(id)
  }
  const prose = cleanNameList(extracted.resolved_threads, 12).filter((text) => !asId(text))
  return { ids: [...ids], prose }
}

/** A promise is a thread even when the curator forgets the flag. */
export function forceUnresolvedThread(type: unknown, flagged: unknown): boolean {
  if (flagged === true) return true
  return String(type || '').trim().toLowerCase() === 'promise'
}

export type CloseableMemory = { _id: ObjectId; text: string }

/**
 * Related-to-this-turn facts first, then flagged open threads. The curator can
 * only close what it is shown; appointments stored as ordinary observations
 * never appeared in the open-thread list, so they stayed retrievable forever.
 */
export function mergeCloseableCandidates(
  related: CloseableMemory[],
  openThreads: CloseableMemory[],
  limit = 16,
): Array<{ key: string; id: ObjectId; text: string }> {
  const seen = new Set<string>()
  const out: Array<{ key: string; id: ObjectId; text: string }> = []
  for (const row of [...related, ...openThreads]) {
    const id = String(row?._id || '')
    if (!id || seen.has(id)) continue
    const text = String(row?.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    seen.add(id)
    out.push({ key: `T${out.length + 1}`, id: row._id, text })
    if (out.length >= limit) break
  }
  return out
}

export function closedMemorySetFields(at = new Date()) {
  return {
    unresolved_thread: false,
    resolved_at: at,
    is_archived: true,
    status: 'superseded' as const,
    updated_at: at,
  }
}

async function evictClosedVectors(docs: Array<{ pinecone_id?: string | null }>, scope: VectorScope) {
  if (!docs.length) return
  for (const doc of docs) {
    if (!doc.pinecone_id) continue
    try {
      await vectorStore.deleteIds(scope, [doc.pinecone_id])
    } catch (err) {
      console.warn('Closed-memory vector delete skipped:', (err as Error).message)
    }
  }
}

/** Close listed facts and take them out of RAG so they cannot be restaged. */
async function closeThreadsById(ids: ObjectId[], scope: VectorScope): Promise<number> {
  if (!ids.length) return 0
  const docs = await mongoColl
    .memories()
    .find({ _id: { $in: ids }, is_archived: false }, { projection: { pinecone_id: 1 } })
    .toArray()
  if (!docs.length) return 0
  await evictClosedVectors(docs, scope)
  const result = await mongoColl.memories().updateMany(
    { _id: { $in: docs.map((doc) => doc._id) } },
    { $set: closedMemorySetFields() },
  )
  return result.modifiedCount || 0
}

/**
 * Mark earlier open-thread memories matched by this turn's payoffs as resolved.
 *
 * The id path above is the primary one; this remains for a payoff the curator
 * describes in prose without naming a listed thread.
 */
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
        .limit(8)
        .toArray()
      // EVERY copy, not the best one. A demand restated across five turns is
      // five rows, and closing one left four standing -- which is how a live
      // save reached 48 open threads with exactly 1 ever closed. The threshold
      // still keeps a vague payoff from closing an unrelated thread.
      const paid = (match as Array<(typeof match)[0] & { score?: number }>).filter(
        (row) => (row.score ?? 0) >= 1.0,
      )
      if (!paid.length) continue
      resolved += await closeThreadsById(
        paid.map((row) => row._id),
        { kind: 'mem', instanceId: idString(instanceOid) },
      )
    } catch (err) {
      // Text index may not exist yet on older deployments — never fail the job.
      console.warn('Open-thread resolution skipped:', (err as Error).message)
      break
    }
  }
  return resolved
}

export function relatedMemoryQueries(playerInput: string, aiResponse: string): string[] {
  const input = String(playerInput || '').replace(/\s+/g, ' ').trim().slice(0, 400)
  const opening = String(aiResponse || '').replace(/\s+/g, ' ').trim().slice(0, 240)
  return [...new Set([input, opening].filter((query) => query.length >= 12))]
}

async function findRelatedLiveMemories(
  instanceOid: ObjectId,
  playerInput: string,
  aiResponse: string,
  limit = 8,
): Promise<CloseableMemory[]> {
  const queries = relatedMemoryQueries(playerInput, aiResponse)
  if (!queries.length) return []
  const found = new Map<string, CloseableMemory>()
  for (const query of queries) {
    try {
      const rows = await mongoColl
        .memories()
        .find(
          {
            instance_id: instanceOid,
            is_archived: false,
            $text: { $search: query },
          },
          { projection: { text: 1, score: { $meta: 'textScore' } } },
        )
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit * 2)
        .toArray()
      for (const row of rows as Array<(typeof rows)[0] & { score?: number }>) {
        if ((row.score ?? 0) < 1.0) continue
        const text = String(row.text || '').trim()
        if (!text) continue
        const id = String(row._id)
        if (!found.has(id)) found.set(id, { _id: row._id, text })
        if (found.size >= limit) return [...found.values()]
      }
    } catch (err) {
      console.warn('Related-memory search skipped:', (err as Error).message)
      break
    }
  }
  return [...found.values()]
}

/** Shared request builder lets the no-write replay harness exercise precisely
 * the same memory-curation prompt as the queued production worker. */
export function buildMemoryCurationRequest(params: {
  sceneTag: string; roster: Array<{ canonical_name: string; aliases?: string[]; is_protagonist?: boolean }>
  isSentient?: boolean; protagonistName?: string | null; playerPersonaName?: string | null
  precedingAiResponse?: string | null; playerInput: string; playerSpokenInput?: string
  playerNarrationFacts?: string[]; aiResponse: string
  /** The debts the world still owes, so the curator can say which this turn paid. */
  openThreads?: Array<{ id: string; text: string }>
  group?: GroupMemoryBatch
}) {
  const rosterLines = params.roster.length
    ? params.roster.map((c) => {
        const aliases = (c.aliases || []).filter(Boolean)
        return `- ${c.canonical_name}${c.is_protagonist ? ' (protagonist)' : ''}${aliases.length ? ` (aka ${aliases.join(', ')})` : ''}`
      }).join('\n')
    : '- (no known characters yet)'
  const identityContext = params.isSentient
    ? `\nIdentity boundary:\n- This is a sentient/character conversation. The protagonist/main character${params.protagonistName ? ` is "${params.protagonistName}"` : ''}; the human player${params.playerPersonaName ? ` may be called "${params.playerPersonaName}"` : ''} is separate.\n- Any fact in Player input using "I", "me", or "my" belongs to the player. Use subject "player" for those facts, NEVER the protagonist/main character.\n- The narration speaks to/for the player ("you"/first person). A first-person sensation, feeling, or perception in the NARRATION ("a shiver runs through me", "my heart races", "I notice…") is the PLAYER's — use subject "player", NEVER attribute it to the main character. The main character is the subject only when the prose shows THEM acting or feeling by their own name.\n- Player-mentioned off-screen relatives or possessions are facts about the player, not new present characters.\n`
    : `\nIdentity boundary:\n- This is a GM world: the player speaks as the protagonist. Use "player" for the player's own first-person facts in memory subjects unless a specific other character acted.\n`
  if (params.group) {
    return {
      purpose: 'memory_curation', model: AI_MODELS.memoryCuration, temperature: 0.3, maxTokens: 4000,
      responseFormat: { type: 'json_schema', json_schema: { name: 'group_memories', strict: true } },
      responseSchema: GROUP_CURATION_SCHEMA,
      messages: [
        { role: 'system' as const, content: GROUP_EXTRACTION_PROMPT },
        { role: 'user' as const, content: `Scene type: ${params.sceneTag}\n\nCharacter roster:\n${rosterLines}\n\nIdentity boundary:\nThis is a group conversation. The human player is "${params.group.player}"; use "player" for this person's subjects and objects. All other speakers are separate people. "I", "me", and "my" belong to the speaker of THAT numbered message. Resolve relatives and possessions to that speaker, never to another member or a GM protagonist. Name every person explicitly in atom text, subjects and objects.\n\nOPEN THREADS:\n${params.openThreads?.map(thread => `${thread.id}: ${thread.text}`).join('\n') || '(none)'}${params.group.messages.some(message => message.player_action) ? `\n\n${GROUP_ACTION_RULE}` : ''}\n\nNumbered messages (speaker and text):\n${params.group.messages.map(message => `${message.number}. ${JSON.stringify({ speaker: message.name, text: message.player_action ? groupLineText(groupPlayerLine(message.name, message.text, true)) : message.text })}`).join('\n')}` },
      ],
    }
  }
  return {
    purpose: 'memory_curation',
    model: AI_MODELS.memoryCuration, temperature: 0.3, maxTokens: 900,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system' as const, content: EXTRACTION_PROMPT },
      { role: 'user' as const, content: `Scene type: ${params.sceneTag}\n\nCharacter roster (canonical names for resolution):\n${rosterLines}\n${identityContext}\n${params.precedingAiResponse ? `Preceding narration (the line(s) just before this turn — use ONLY to resolve back-references like "stuff like that"; do not re-extract its events as new memories):\n${String(params.precedingAiResponse).slice(0, 700)}\n` : ''}\nPlayer (raw input): ${params.playerInput}\nPlayer spoken dialogue: ${params.playerSpokenInput || '(none)'}\nPlayer canonical narration facts:\n${Array.isArray(params.playerNarrationFacts) && params.playerNarrationFacts.length ? params.playerNarrationFacts.map((f) => `- ${f}`).join('\n') : '- (none)'}\n\nLIVE RELATED FACTS (still retrieved as current — decide which, if any, THIS exchange settles):\n${params.openThreads && params.openThreads.length ? params.openThreads.map((t) => `${t.id}: ${t.text}`).join('\n') : '(none)'}\n\nWorld: ${params.aiResponse}` },
    ],
  }
}

export async function memoryProcessor(job: Job) {
  return runBackgroundLLMTrace({ instance_id: job.data.instanceId, player_id: job.data.playerId,
    event_id: job.data.eventId }, () => job.data.groupMemory ? withGroupMemoryLease(job.data.instanceId, 'memory', () => groupMemoryWork(job)) : memoryWork(job))
}
async function groupMemoryWork(job: Job) {
  const batch = await loadGroupBatch(parseObjectId(job.data.instanceId), parseObjectId(job.data.eventId), 'curated_through_sequence')
  if (!batch) return { skipped: 'group_batch_obsolete' }
  const members = await loadGroupMembers(batch.instance)
  const messages = batch.events.flatMap(event => groupMessages([event], batch.instance.group_context!.player, members, batch.thread)
    .map(line => ({ ...line, name: groupSpeaker(line), eventId: event._id, adult: event.type === 'intimate', number: 0 })))
    .map((line, index) => ({ ...line, number: index + 1 }))
  const group: GroupMemoryBatch = { player: batch.instance.group_context!.player, messages, events: batch.events, through: batch.through, overlap: batch.overlap, ...(batch.thread === undefined ? {} : { thread: batch.thread }) }
  try {
    const result = await memoryWork(job, group)
    const freshEvents = batch.events.slice(batch.overlap)
    const freshMessages = messages.filter(line => freshEvents.some(event => event._id.equals(line.eventId))).map((line, index) => ({ ...line, number: index + 1 }))
    await curateGroupBonds(batch.instance, { ...group, events: freshEvents, messages: freshMessages }, members)
    await advanceGroupWatermark(batch.events, 'curated_through_sequence')
    log.info('group.memory_batch', { instanceId: job.data.instanceId, events: batch.events.length, messages: messages.length,
      through: batch.through, curator_calls: 1, success: true, ...result })
    return result
  } catch (error) {
    log.warn('group.memory_batch', { instanceId: job.data.instanceId, events: batch.events.length, messages: messages.length,
      through: batch.through, success: false })
    throw error
  }
}
async function memoryWork(job: Job, group?: GroupMemoryBatch) {
  const {
    instanceId,
    playerId,
    eventId,
    playerInput,
    playerSpokenInput = '',
    playerNarrationFacts = [],
    aiResponse,
    precedingAiResponse = null,
    sceneTag,
    isSentient = false,
    playerPersonaName = null,
    protagonistName = null,
  } = job.data as {
    instanceId: string
    playerId: string
    eventId: string
    playerInput: string
    playerSpokenInput?: string
    playerNarrationFacts?: string[]
    aiResponse: string
    /** The PRIOR turn's narration — context for resolving back-references in this
     *  turn's input ("stuff like that" → what was just said). */
    precedingAiResponse?: string | null
    sceneTag: string
    isSentient?: boolean
    playerPersonaName?: string | null
    protagonistName?: string | null
  }
  const redis = getRedisClient()
  const instanceOid = parseObjectId(instanceId)
  const playerOid = parseObjectId(playerId)
  const eventOid = parseObjectId(eventId)
  if (!(await liveInstanceExists(instanceOid))) {
    return { skipped: 'instance_deleted' }
  }

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

  // THE CURATOR COULD NOT SEE WHAT IT WAS ASKED TO CLOSE.
  //
  // It has always been told to report which earlier thread this turn paid off,
  // and it was never shown the threads. It sees one exchange and no story, so
  // it was being asked to recall a debt it had no access to. On a live 84-turn
  // save it named a payoff ONCE: 48 threads open, 1 ever closed.
  //
  // A later save showed the other half: appointments stored as ordinary
  // observations ("meet at the yard at first light", "burn the note") were
  // never flagged as threads, so they never entered this list. RAG kept
  // retrieving them as live plot and the narrator restaged them.
  //
  // Related live facts for THIS turn are shown first. The ids make closure
  // exact: the curator returns T3, and T3 closes and leaves retrieval.
  const scope = { kind: 'mem' as const, instanceId }
  const [threadCandidates, relatedLive] = await Promise.all([
    mongoColl
      .memories()
      .find(
        { instance_id: instanceOid, unresolved_thread: true, is_archived: false },
        { projection: { text: 1, importance: 1, updated_at: 1, ...(group ? { source_event_ids: 1, private_to: 1, is_nsfw: 1 } : {}) } },
      )
      .sort({ updated_at: -1 })
      .limit(12)
      .toArray(),
    group ? Promise.resolve([]) : findRelatedLiveMemories(instanceOid, playerInput || '', aiResponse || ''),
  ])
  const openThreadDocs = group ? await allowedGroupMemories(instanceOid, threadCandidates, group.thread, true, true) : threadCandidates
  const closeable = mergeCloseableCandidates(
    relatedLive,
    openThreadDocs.map((doc) => ({ _id: doc._id, text: String(doc.text || '') })),
  )
  const openThreadById = new Map(closeable.map((row) => [row.key, row.id]))
  const openThreads = closeable.map((row) => ({ id: row.key, text: row.text }))

  const result = await callLLM(buildMemoryCurationRequest({
    sceneTag, roster, isSentient, protagonistName, playerPersonaName,
    precedingAiResponse, playerInput, playerSpokenInput, playerNarrationFacts, aiResponse,
    openThreads, group,
  }))

  let extracted: any
  try {
    extracted = JSON.parse(result)
  } catch {
    if (group) throw new Error('Group curator returned invalid JSON')
    console.warn('Memory extraction returned invalid JSON:', result)
    return { memoriesCreated: 0 }
  }
  let invalidCitations = 0, invalidAtoms = 0, invalidAudiences = 0, duplicates = 0, adultClaims = 0, refiled = 0, marksCleared = 0, adultRetryFacts = 0, adultLinesKept = 0
  if (group) {
    if (!extracted || !Array.isArray(extracted.memories)) throw new Error('Group curator returned empty memories')
    const adultBatch = uncoveredAdultEvents(group, []).uncovered.size > 0
    if (!extracted.memories.length && !extracted.closed_threads?.length && !adultBatch) throw new Error('Group curator returned empty memories')
    const cleanAtoms = (raws: unknown[]) => {
      const shaped = raws.slice(0, 20).filter((raw: unknown) => {
        if (!raw || typeof raw !== 'object') { invalidAtoms++; return false }
        const atom = raw as Record<string, unknown>
        if (!Array.isArray(atom.source_messages) || !atom.source_messages.length ||
          atom.source_messages.some(number => !Number.isInteger(number) || Number(number) < 1 || Number(number) > group.messages.length)) {
          invalidCitations++; return false
        }
        if ('private_to' in atom || 'dm_with' in atom) { invalidAtoms++; return false }
        if (typeof atom.text !== 'string' || !atom.text.trim() || atom.text.length > 600 ||
          typeof atom.type !== 'string' || !['relationship', 'promise', 'lore', 'observation', 'emotion', 'secret'].includes(atom.type) ||
          !Number.isInteger(atom.importance) || Number(atom.importance) < 1 || Number(atom.importance) > 5 ||
          typeof atom.is_nsfw !== 'boolean' || typeof atom.unresolved_thread !== 'boolean' ||
          !Array.isArray(atom.subjects) || !atom.subjects.length || !Array.isArray(atom.objects) ||
          [...atom.subjects, ...atom.objects].some(name => typeof name !== 'string' || !name.trim() || name.length > 80) ||
          (atom.retrieval_terms !== undefined && (!Array.isArray(atom.retrieval_terms) || atom.retrieval_terms.some(term => typeof term !== 'string'))) ||
          ['emotional_valence', 'emotional_cause', 'emotional_effect', 'relationship_delta'].some(key => atom[key] != null && typeof atom[key] !== 'string')) {
          invalidAtoms++; return false
        }
        return true
      })
      const audiences = filterGroupAtomAudiences(group, shaped as Array<{ source_messages: number[] }>)
      invalidAudiences += audiences.invalidAudiences
      const marks = clearEverydayAdultMarks(group, audiences.memories as Array<{ text: string; is_nsfw?: unknown; source_messages: number[] }>)
      marksCleared += marks.cleared
      const claims = dropAdultWriterClaims(group, marks.memories)
      adultClaims += claims.adultClaims
      const spoken = refileSpokenFacts(group, claims.memories as Array<{ text: string; is_nsfw?: unknown; subjects: string[]; objects: string[]; source_messages: number[] }>)
      refiled += spoken.refiled
      return spoken.memories
    }
    extracted.memories = cleanAtoms(extracted.memories)
    const gap = uncoveredAdultEvents(group, extracted.memories)
    if (gap.short) {
      // A failed second try only means the last resort below; the first answer still counts.
      try {
        const again = JSON.parse(await callLLM(buildMemoryCurationRequest({
          sceneTag, roster, isSentient, protagonistName, playerPersonaName,
          precedingAiResponse, playerInput, playerSpokenInput, playerNarrationFacts, aiResponse,
          openThreads: [], group,
        })))
        const facts = adultRetryAtoms(extracted.memories, cleanAtoms(Array.isArray(again?.memories) ? again.memories : []))
        adultRetryFacts = facts.length
        extracted.memories.push(...facts)
      } catch (error) {
        log.warn('group.memory_adult_retry', { instanceId, error: (error as Error).message })
      }
      if (!adultRetryFacts) {
        const lines = adultLineAtoms(group, gap.uncovered)
        adultLinesKept = lines.length
        extracted.memories.push(...lines)
      }
    }
    const stored = await mongoColl.memories().find({ instance_id: instanceOid, is_archived: false },
      { projection: { text: 1, private_to: 1 } }).toArray()
    const missedDetails = missedDetailAtoms(group, extracted.memories, stored.filter(memory => memory.private_to === undefined || memory.private_to === group.thread).map(memory => memory.text))
    extracted.memories.push(...missedDetails)
    // Canonicalize only exact, case-insensitive player names after shape/citation validation.
    for (const atom of extracted.memories as Array<{ subjects: string[]; objects: string[] }>) {
      const canonical = (name: string) => name.toLowerCase() === group.player.toLowerCase() ? 'player' : name
      atom.subjects = atom.subjects.map(canonical)
      atom.objects = atom.objects.map(canonical)
    }
    log.info('group.memory_validation', { instanceId, invalidCitations, invalidAtoms, invalidAudiences, missedDetails: missedDetails.length, adultClaims, refiled, marksCleared, adultRetryFacts, adultLinesKept, accepted: extracted.memories.length })
    if (!extracted.memories.length && !extracted.closed_threads?.length && !adultClaims) throw new Error('Group curator returned no valid atoms')
    if (!await groupEventsLive(group.events)) throw new Error('Group memory source events changed')
  } else normalizePlayerFactAttribution({ extracted, isSentient, playerInput, protagonistName })

  // Close earlier facts this turn paid off — even when no new atom was worth
  // storing (a quiet fulfillment is still a resolution). Closed facts leave
  // retrieval so they cannot be restaged as current plot.
  const groupClosures = group ? await closeGroupThreads({ instanceId: instanceOid, group,
    threads: closeable.map(row => openThreadDocs.find(doc => doc._id.equals(row.id))!), closures: extracted.closed_threads }) : undefined
  const routed = group ? { ids: [], prose: [] } : routeThreadClosures(extracted, [...openThreadById.keys()])
  const closedIds = routed.ids.map((id) => openThreadById.get(id)).filter((id): id is ObjectId => !!id)
  const resolvedThreads = routed.prose.slice(0, 3)
  const threadsResolved = groupClosures ? groupClosures.closuresAccepted :
    (await closeThreadsById(closedIds, scope)) +
    (resolvedThreads.length ? await resolveOpenThreads(instanceOid, resolvedThreads) : 0)
  if (threadsResolved > 0) {
    console.log(`[memory] closed ${threadsResolved} open thread(s) on event ${idString(eventOid)}`)
  }

  if (!extracted.memories || extracted.memories.length === 0) {
    return { memoriesCreated: 0, threadsResolved, ...(group ? { invalidCitations, invalidAtoms, invalidAudiences, duplicates, ...groupClosures } : {}) }
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
        const type = rosterTypes.get(normalized) || extractedKinds.get(normalized) || 'concept'
        // A memory curator sees descriptive prose, not an authoritative movement
        // action. It must never mint a new place from a phrase such as "father's
        // study" after the player deliberately travelled to "Parent's room".
        // Visited locations are created only by the generation location seam;
        // memories already retain that event's location anchor for retrieval.
        if (type === 'location') continue
        mentions.push({
          name,
          type,
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
    if (group && entityMap && playerEntity) entityMap.set('player', playerEntity)
    entitySequence = sequence
  } catch (err) {
    console.warn('Memory entity resolution skipped:', (err as Error).message)
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

  const newMemories: any[] = []

  const liveGroupTexts = group ? new Set((await mongoColl.memories().find({ instance_id: instanceOid, is_archived: false },
    { projection: { text: 1, private_to: 1 } }).toArray()).map(memory => groupMemoryTextKey(memory.text, memory.private_to))) : undefined
  for (const mem of extracted.memories) {
    const text = cleanShortText(mem.text, 600)
    if (!text) continue
    const sourceMessages = group ? (mem.source_messages as number[]).map(number => group.messages[number - 1]) : []
    const sourceEventIds = group ? [...new Map(sourceMessages.map(message => [String(message.eventId), message.eventId])).values()] : [eventOid]
    const audience = group ? deriveGroupAudience(group.events.filter(event => sourceEventIds.some(id => id.equals(event._id)))) : undefined
    if (audience && !audience.valid) { invalidAudiences++; continue }
    const privateTo = audience?.privateTo
    const memId = new ObjectId()
    if (group) {
      const duplicate = liveGroupTexts!.has(groupMemoryTextKey(text, privateTo))
      if (duplicate) { duplicates++; continue }
    }
    const vecId = group ? `group_${idString(memId)}` : randomUUID()
    const memIdStr = idString(memId)

    const subjects = cleanNameList(mem.subjects)
    const objects = cleanNameList(mem.objects)
    const subjectEntityIds = entityIdsFor(subjects)
    const objectEntityIds = entityIdsFor(objects)
    const unresolvedThread = forceUnresolvedThread(mem.type, mem.unresolved_thread)

    // Alternate phrasings the curator emitted: embed them WITH the atom so a future
    // turn worded differently still lands close in vector space, and store them as
    // search_terms (indexed for keyword recall). The displayed `text` stays clean.
    const retrievalTerms = cleanNameList(mem.retrieval_terms, 8).map((t) => t.toLowerCase())
    const embedInput = retrievalTerms.length ? `${text}\n${retrievalTerms.join(', ')}` : text
    const embedding = await embed(embedInput)
    if (group) {
      const candidates = (await mongoColl.memories().find({ instance_id: instanceOid,
        source_event_ids: { $in: sourceEventIds }, is_archived: false,
      }).limit(50).toArray()).filter(candidate => groupMemoryMayMerge(candidate, { subjects, objects, source_event_ids: sourceEventIds, private_to: privateTo }))
      const ids = candidates.flatMap(candidate => candidate.pinecone_id ? [candidate.pinecone_id] : [])
      if (ids.length) {
        const stored = await vectorStore.fetch(scope, ids)
        if (ids.some(id => {
          const values = stored.records?.[id]?.values
          if (!values || values.length !== embedding.length) return false
          let dot = 0, left = 0, right = 0
          for (let i = 0; i < values.length; i++) { dot += values[i] * embedding[i]; left += values[i] ** 2; right += embedding[i] ** 2 }
          return left > 0 && right > 0 && dot / (Math.sqrt(left) * Math.sqrt(right)) > 0.95
        })) { duplicates++; continue }
      }
    }

    const vectorMetadata: Record<string, string | number | boolean | string[]> = {
      text,
      type: mem.type,
      importance: mem.importance,
      is_nsfw: mem.is_nsfw || sourceMessages.some(message => message.adult) || false,
      mongo_id: memIdStr,
      unresolved_thread: unresolvedThread,
      created_at: new Date().toISOString(),
    }
    if (subjects.length > 0) vectorMetadata.subjects = subjects
    if (eventTimeAnchor?.timeline_id) vectorMetadata.timeline_id = eventTimeAnchor.timeline_id
    if (eventTimeAnchor?.sequence) vectorMetadata.sequence = eventTimeAnchor.sequence
    if (eventLocationAnchor?.entity_id) vectorMetadata.location_entity_id = idString(eventLocationAnchor.entity_id)
    if (eventLocationAnchor?.name) vectorMetadata.location_name = eventLocationAnchor.name

    await vectorStore.upsert(scope, [{
      id: vecId,
      values: embedding,
      metadata: vectorMetadata,
    }])

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
      is_nsfw: mem.is_nsfw || sourceMessages.some(message => message.adult) || false,
      ...(group && mem.is_nsfw === true ? { explicit_fact: true } : {}),
      ...(privateTo === undefined ? {} : { private_to: privateTo }),
      source_event_ids: sourceEventIds,
      pinecone_id: vecId,
      access_count: 0,
      last_accessed_at: new Date(),
      is_archived: false,
      status: 'active' as const,
      subjects,
      objects,
      ...(retrievalTerms.length ? { search_terms: retrievalTerms.join(', ') } : {}),
      ...(subjectEntityIds.length ? { subject_entity_ids: subjectEntityIds } : {}),
      ...(objectEntityIds.length ? { object_entity_ids: objectEntityIds } : {}),
      ...(eventTimeAnchor ? { time_anchor: eventTimeAnchor, timeline_id: eventTimeAnchor.timeline_id } : {}),
      ...(eventLocationAnchor
        ? {
            location_anchor: eventLocationAnchor,
            location_entity_id: eventLocationAnchor.entity_id ?? undefined,
            location_name: eventLocationAnchor.name,
          }
        : {}),
      ...enrichment,
      unresolved_thread: unresolvedThread,
      resolved_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    }
    if (group && !await groupEventsLive(group.events)) {
      await vectorStore.deleteIds(scope, [vecId])
      throw new Error('Group memory source events changed')
    }
    try {
      await mongoColl.memories().insertOne(memoryDoc)
    } catch (error) {
      if (group) await vectorStore.deleteIds(scope, [vecId])
      throw error
    }
    if (group && !await groupEventsLive(group.events)) {
      await mongoColl.memories().deleteOne({ _id: memId })
      await vectorStore.deleteIds(scope, [vecId])
      throw new Error('Group memory source events changed')
    }
    liveGroupTexts?.add(groupMemoryTextKey(text, privateTo))
    newMemories.push(memoryDoc)

    // Relationship atoms also become graph edges (subject → object) so the
    // graph can answer "what stands between these two" without re-reading
    // memory text. Provenance = this event; rewind/edit prunes it.
    // A graph edge has no audience, so a private fact never becomes one: its text
    // would land in a record everyone can read.
    if (
      privateTo === undefined &&
      mem.type === 'relationship' &&
      subjectEntityIds.length > 0 &&
      objectEntityIds.length > 0 &&
      !subjectEntityIds[0].equals(objectEntityIds[0])
    ) {
      try {
        for (const sourceEventId of sourceEventIds) await entityGraphService.upsertNarrativeEdge({
          instanceId,
          sourceEntityId: subjectEntityIds[0],
          targetEntityId: objectEntityIds[0],
          type: 'relationship',
          label: relationshipDelta || text,
          importance: mem.importance,
          eventId: sourceEventId,
          sequence: entitySequence,
        })
      } catch (err) {
        console.warn('Relationship edge upsert skipped:', (err as Error).message)
      }
    }
  }

  if (newMemories.length > 0) {
    const explicitOldTerms = group ? [] : extractExplicitCorrections(playerInput)
    if (explicitOldTerms.length > 0) {
      try {
        const superseded = await supersedeExplicitCorrections({
          instanceOid,
          eventOid,
          oldTerms: explicitOldTerms,
          scope,
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
  // sees both materializes the link; the repair job reconciles the race.
  if (newMemories.length > 0) {
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

  if (!group) await redis.publish(`user:${playerId}:events`, JSON.stringify({
    type: 'memories_curated',
    instanceId,
    memories: newMemories.map((m) => ({
      id: idString(m._id),
      text: m.text,
      type: m.type,
      importance: m.importance,
    })),
  }))

  return { memoriesCreated: newMemories.length, threadsResolved, ...(group ? { invalidCitations, invalidAtoms, invalidAudiences, duplicates, ...groupClosures } : {}) }
}
