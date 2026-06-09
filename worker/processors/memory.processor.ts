import { ObjectId } from 'mongodb'
import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { getPineconeIndex } from '../../src/config/pinecone'
import { embed, callLLM, AI_MODELS } from '../../src/ai'
import { randomUUID } from 'crypto'
import { getRedisClient } from '../../src/config/redis'
import { idString, parseObjectId } from '../../src/utils/mongo-id'

const EXTRACTION_PROMPT = `You are the memory curator for a long-running narrative world. Given one exchange between a player and the world, extract 0-3 memory atoms worth keeping long-term, and detect whether this turn resolved any previously open thread.

Rules for memory atoms:
- Only extract facts that would still matter 10+ turns from now.
- Each atom must be ONE self-contained sentence (or two short ones) that makes sense with no other context: resolve every pronoun to an explicit name from the character roster, and name places/objects explicitly.
- Prefer emotionally instructive memories over flat facts. Weak: "Mira forgave the player." Strong: "Mira chose to forgive the player after the ash-bridge betrayal, but her trust remains fragile; honesty now matters deeply to her." Capture the cause AND the lasting effect.
- Rate importance 1-5 (5 = critical plot point or vow, 1 = minor detail).
- Classify type: relationship, promise, lore, observation, emotion, secret.
- subjects = who acts/feels in the atom; objects = who/what is affected. Use canonical roster names where possible; use "player" for the player.
- Set unresolved_thread true ONLY for genuinely open hooks: an unkept promise, an unanswered question, an unresolved conflict, a debt, a threat still looming. Mundane ongoing states are not threads.
- Flag is_nsfw if explicit content is referenced.
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
      "unresolved_thread": boolean
    }
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
  } = job.data
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

  const result = await callLLM({
    model: AI_MODELS.memoryCuration,
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      {
        role: 'user',
        content: `Scene type: ${sceneTag}

Character roster (canonical names for resolution):
${rosterLines}

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

  // Close earlier open threads this turn paid off — even when no new atom was
  // worth storing (a quiet fulfillment is still a resolution).
  const resolvedThreads = cleanNameList(extracted.resolved_threads, 3)
  const threadsResolved = resolvedThreads.length
    ? await resolveOpenThreads(instanceOid, resolvedThreads)
    : 0

  if (!extracted.memories || extracted.memories.length === 0) {
    return { memoriesCreated: 0, threadsResolved }
  }

  const index = getPineconeIndex()
  const namespace = index.namespace(`mem_${instanceId}`)
  const newMemories: any[] = []

  for (const mem of extracted.memories) {
    const text = cleanShortText(mem.text, 600)
    if (!text) continue
    const memId = new ObjectId()
    const vecId = randomUUID()
    const memIdStr = idString(memId)

    const subjects = cleanNameList(mem.subjects)
    const objects = cleanNameList(mem.objects)
    const unresolvedThread = mem.unresolved_thread === true

    const embedding = await embed(text)

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
      subjects,
      objects,
      ...enrichment,
      unresolved_thread: unresolvedThread,
      resolved_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    }
    await mongoColl.memories().insertOne(memoryDoc)
    newMemories.push(memoryDoc)
  }

  await mongoColl.worldInstances().updateOne(
    { _id: instanceOid },
    { $inc: { 'meta.total_memories': newMemories.length } },
  )

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
