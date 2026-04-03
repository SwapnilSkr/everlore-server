import { Job } from 'bullmq'
import { coll } from '../../src/config/mongo'
import { getPineconeIndex } from '../../src/config/pinecone'
import { embed } from '../../src/utils/embedding'
import { generateId } from '../../src/utils/id'
import { callLLM } from '../lib/llm-client'
import { getRedisClient } from '../../src/config/redis'

const EXTRACTION_PROMPT = `You are a memory curator for a narrative engine. Given the following exchange between a player and a world, extract 0-3 important facts that should be remembered long-term.

Rules:
- Only extract facts that would matter 10+ turns from now.
- Each fact must be a self-contained sentence.
- Rate importance 1-5 (5 = critical plot point, 1 = minor detail).
- Classify type: relationship, promise, lore, observation, emotion, secret.
- Flag if NSFW content is referenced.
- If nothing is worth remembering, return an empty array.

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
}`

export async function memoryProcessor(job: Job) {
  const { instanceId, playerId, eventId, playerInput, aiResponse, sceneTag } = job.data
  const redis = getRedisClient()

  const result = await callLLM({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      {
        role: 'user',
        content: `Scene type: ${sceneTag}\n\nPlayer: ${playerInput}\n\nWorld: ${aiResponse}`,
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
    const memId = generateId('mem')
    const vecId = generateId('vec')

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
          mongo_id: memId,
          created_at: new Date().toISOString(),
        },
      }],
    })

    const memoryDoc = {
      _id: memId,
      instance_id: instanceId,
      player_id: playerId,
      text: mem.text,
      type: mem.type,
      importance: mem.importance,
      is_nsfw: mem.is_nsfw || false,
      source_event_ids: [eventId],
      pinecone_id: vecId,
      access_count: 0,
      last_accessed_at: new Date(),
      is_archived: false,
      created_at: new Date(),
      updated_at: new Date(),
    }
    await coll('memories').insertOne(memoryDoc)
    newMemories.push(memoryDoc)
  }

  // Update instance meta
  await coll('world_instances').updateOne(
    { _id: instanceId },
    { $inc: { 'meta.total_memories': newMemories.length } },
  )

  // Notify client
  await redis.publish(`user:${playerId}:events`, JSON.stringify({
    type: 'memories_curated',
    instanceId,
    memories: newMemories.map((m) => ({
      id: m._id,
      text: m.text,
      type: m.type,
      importance: m.importance,
    })),
  }))

  return { memoriesCreated: newMemories.length }
}
