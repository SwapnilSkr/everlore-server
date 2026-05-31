import { ObjectId } from 'mongodb'
import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { getPineconeIndex } from '../../src/config/pinecone'
import { embed, callLLM, AI_MODELS } from '../../src/ai'
import { randomUUID } from 'crypto'
import { getRedisClient } from '../../src/config/redis'
import { idString, parseObjectId } from '../../src/utils/mongo-id'

const EXTRACTION_PROMPT = `You are a memory curator for a narrative engine. Given the following exchange between a player and a world, extract 0-3 important facts that should be remembered long-term.

Rules:
- Only extract facts that would matter 10+ turns from now.
- Each fact must be a self-contained sentence.
- Rate importance 1-5 (5 = critical plot point, 1 = minor detail).
- Classify type: relationship, promise, lore, observation, emotion, secret.
- Flag if NSFW content is referenced.
- If nothing is worth remembering, return an empty array.
- Treat "Player canonical narration facts" as events that DEFINITELY happened.

Respond ONLY with valid JSON matching this schema:
{
  "memories": [
    {
      "text": "string",
      "type": "string",
      "importance": number,
      "is_nsfw": boolean
    }
  ]
}
}`

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

  const result = await callLLM({
    model: AI_MODELS.memoryCuration,
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      {
        role: 'user',
        content: `Scene type: ${sceneTag}

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
    maxTokens: 500,
    responseFormat: { type: 'json_object' },
  })

  let extracted: any
  try {
    extracted = JSON.parse(result)
  } catch {
    console.warn('Memory extraction returned invalid JSON:', result)
    return { memoriesCreated: 0 }
  }

  if (!extracted.memories || extracted.memories.length === 0) {
    return { memoriesCreated: 0 }
  }

  const index = getPineconeIndex()
  const namespace = index.namespace(`mem_${instanceId}`)
  const newMemories: any[] = []

  for (const mem of extracted.memories) {
    const memId = new ObjectId()
    const vecId = randomUUID()
    const memIdStr = idString(memId)

    const embedding = await embed(mem.text)

    await namespace.upsert({
      records: [{
        id: vecId,
        values: embedding,
        metadata: {
          text: mem.text,
          type: mem.type,
          importance: mem.importance,
          is_nsfw: mem.is_nsfw || false,
          mongo_id: memIdStr,
          created_at: new Date().toISOString(),
        },
      }],
    })

    const memoryDoc = {
      _id: memId,
      instance_id: instanceOid,
      player_id: playerOid,
      text: mem.text,
      type: mem.type,
      importance: mem.importance,
      is_nsfw: mem.is_nsfw || false,
      source_event_ids: [eventOid],
      pinecone_id: vecId,
      access_count: 0,
      last_accessed_at: new Date(),
      is_archived: false,
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

  return { memoriesCreated: newMemories.length }
}
