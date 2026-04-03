import { Job } from 'bullmq'
import { getDb } from '../../src/config/mongo'
import { getRedisClient } from '../../src/config/redis'
import { getPineconeIndex } from '../../src/config/pinecone'
import { embed } from '../../src/utils/embedding'
import { buildPrompt } from '../../src/utils/prompt-builder'
import { applyStateMutations, applyFlagMutations } from '../../src/utils/state-mutator'
import { countTokens } from '../../src/utils/token-counter'
import { generateId } from '../../src/utils/id'
import { callLLM } from '../lib/llm-client'
import { classifyScene } from '../lib/nsfw-classifier'
import { enforceSchema } from '../lib/structured-output'
import { getMemoryCurationQueue, getSceneSummaryQueue } from '../../src/queues'

const MAX_CONTEXT_TOKENS = 6000

const GENERATION_SCHEMA = {
  type: 'object' as const,
  properties: {
    narrative: { type: 'string' as const, description: 'The narrative response text' },
    state_mutations: {
      type: 'object' as const,
      additionalProperties: {
        type: 'object' as const,
        properties: {
          op: { type: 'string' as const, enum: ['add', 'subtract', 'set'] },
          value: { type: 'number' as const },
        },
        required: ['op', 'value'],
      },
    },
    flag_mutations: {
      type: 'object' as const,
      additionalProperties: {
        type: 'object' as const,
        properties: {
          op: { type: 'string' as const, enum: ['set', 'increment', 'decrement'] },
          value: {},
        },
      },
    },
    scene_tag: {
      type: 'string' as const,
      enum: ['dialogue', 'combat', 'intimate', 'exploration', 'existential', 'cosmic', 'mundane'],
    },
    emotional_tone: { type: 'string' as const },
  },
  required: ['narrative', 'state_mutations', 'flag_mutations', 'scene_tag'] as const,
}

export async function generationProcessor(job: Job) {
  const {
    instanceId, playerId, userMessage,
    session, recentEvents, activeSummary,
  } = job.data

  const redis = getRedisClient()
  const db = getDb()

  // STEP 1: Embed user message for RAG query
  let loreTexts: string[] = []
  let memoryTexts: string[] = []

  try {
    const queryEmbedding = await embed(userMessage)
    const index = getPineconeIndex()

    // Query lore and memory in parallel
    const [loreResults, memoryResults] = await Promise.all([
      index.namespace(`lore_${session.template_id}`).query({
        vector: queryEmbedding,
        topK: session.max_lore_results || 10,
        includeMetadata: true,
      }),
      index.namespace(`mem_${instanceId}`).query({
        vector: queryEmbedding,
        topK: session.max_context_memories || 25,
        includeMetadata: true,
      }),
    ])

    loreTexts = (loreResults.matches || []).map((m) => (m.metadata as any)?.text || '')
    memoryTexts = (memoryResults.matches || []).map((m) => (m.metadata as any)?.text || '')

    // Update access counts
    const mongoIds = (memoryResults.matches || [])
      .map((m) => (m.metadata as any)?.mongo_id)
      .filter(Boolean)
    if (mongoIds.length > 0) {
      await db.collection('memories').updateMany(
        { _id: { $in: mongoIds } },
        { $inc: { access_count: 1 }, $set: { last_accessed_at: new Date() } },
      )
    }
  } catch (err) {
    console.warn('RAG query failed, proceeding without retrieved memories:', (err as Error).message)
  }

  // STEP 2: Assemble prompt
  const prompt = buildPrompt({
    seedPrompt: session.seed_prompt,
    isSentient: session.is_sentient,
    worldState: session.world_state,
    activeFlags: session.active_flags,
    globalLore: session.global_lore,
    retrievedLore: loreTexts,
    retrievedMemories: memoryTexts,
    sceneSummary: activeSummary,
    recentEvents,
    userMessage,
    maxTokens: MAX_CONTEXT_TOKENS,
  })

  // STEP 3: Route model
  let modelId = session.model_preferences?.narration_sfw || 'gpt-4o'

  if (session.is_nsfw_capable) {
    const sceneClass = classifyScene(userMessage, recentEvents)
    if (sceneClass === 'nsfw') {
      modelId = session.model_preferences?.narration_nsfw || modelId
    }
  }

  // STEP 4: Call LLM
  const rawResponse = await callLLM({
    model: modelId,
    messages: prompt.messages,
    temperature: 0.85,
    maxTokens: 800,
    responseSchema: GENERATION_SCHEMA,
  })

  const parsed = enforceSchema(rawResponse)

  // STEP 5: Apply mutations
  const newWorldState = applyStateMutations(session.world_state, parsed.state_mutations)
  const newFlags = applyFlagMutations(session.active_flags, parsed.flag_mutations)

  // STEP 6: Get next sequence number
  const lastEvent = await db.collection('events').findOne(
    { instance_id: instanceId },
    { sort: { sequence: -1 }, projection: { sequence: 1 } },
  )
  const nextSequence = (lastEvent?.sequence || 0) + 1

  // STEP 7: Persist event
  const event = {
    _id: generateId('evt'),
    instance_id: instanceId,
    player_id: playerId,
    sequence: nextSequence,
    type: parsed.scene_tag === 'intimate' ? 'intimate' : 'narration',
    data: {
      player_input: userMessage,
      ai_response: parsed.narrative,
      state_mutations: parsed.state_mutations,
      flag_mutations: parsed.flag_mutations,
      model_used: modelId,
      tokens_in: countTokens(JSON.stringify(prompt.messages)),
      tokens_out: countTokens(parsed.narrative),
    },
    is_user_edited: false,
    edit_history: [],
    scene_tag: parsed.scene_tag,
    created_at: new Date(),
  }

  await db.collection('events').insertOne(event)

  // STEP 8: Update world instance
  const sceneTag = parsed.scene_tag
  const currentScene = session.current_scene
  const sameScene = currentScene.tag === sceneTag
  const newTurnCount = sameScene ? currentScene.turn_count + 1 : 1

  await db.collection('world_instances').updateOne(
    { _id: instanceId },
    {
      $set: {
        world_state: newWorldState,
        active_flags: newFlags,
        current_scene: {
          tag: sceneTag,
          turn_count: newTurnCount,
          summary_pending: newTurnCount >= 12,
        },
        'meta.last_active_at': new Date(),
        updated_at: new Date(),
      },
      $inc: {
        'meta.total_events': 1,
        'meta.total_tokens_consumed': event.data.tokens_in + event.data.tokens_out,
      },
    },
  )

  // Update Redis session cache
  const updatedSession = {
    ...session,
    world_state: newWorldState,
    active_flags: newFlags,
    current_scene: {
      tag: sceneTag,
      turn_count: newTurnCount,
      summary_pending: newTurnCount >= 12,
    },
  }
  await redis.set(`session:${instanceId}`, JSON.stringify(updatedSession), 'EX', 3600)

  // STEP 9: Release lock and notify client
  await redis.del(`lock:gen:${playerId}:${instanceId}`)

  await redis.publish(`user:${playerId}:events`, JSON.stringify({
    type: 'generation_complete',
    instanceId,
    event: {
      id: event._id,
      sequence: event.sequence,
      narrative: parsed.narrative,
      scene_tag: parsed.scene_tag,
      emotional_tone: parsed.emotional_tone,
      state_diff: {
        world_state: newWorldState,
        active_flags: newFlags,
      },
    },
  }))

  // STEP 10: Queue follow-up jobs
  const memoryCurationQueue = getMemoryCurationQueue()
  await memoryCurationQueue.add('curate', {
    instanceId,
    playerId,
    eventId: event._id,
    playerInput: userMessage,
    aiResponse: parsed.narrative,
    sceneTag: parsed.scene_tag,
  }, { priority: 5, delay: 1000 })

  if (newTurnCount >= 12 && sameScene) {
    const sceneSummaryQueue = getSceneSummaryQueue()
    await sceneSummaryQueue.add('summarize', {
      instanceId,
      sceneTag,
      startSequence: nextSequence - 11,
      endSequence: nextSequence,
    }, { priority: 10, delay: 5000 })
  }

  return { eventId: event._id, sequence: nextSequence }
}
