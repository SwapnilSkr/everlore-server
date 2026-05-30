import { ObjectId } from 'mongodb'
import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { env } from '../../src/config/env'
import { getRedisClient } from '../../src/config/redis'
import { getPineconeIndex } from '../../src/config/pinecone'
import { embed } from '../../src/utils/embedding'
import { buildPrompt } from '../../src/utils/prompt-builder'
import { applyStateMutations, applyFlagMutations } from '../../src/utils/state-mutator'
import { countTokens } from '../../src/utils/token-counter'
import { idString, parseObjectId } from '../../src/utils/mongo-id'
import { callLLMStream } from '../lib/llm-client'
import { classifyScene } from '../lib/nsfw-classifier'
import { type GenerationOutput } from '../lib/structured-output'
import { extractSceneMetadata } from '../lib/metadata-extractor'
import { extractCharacterCodexDeltas } from '../lib/character-codex-extractor'
import { characterCodexService } from '../../src/services/character-codex.service'
import { getMemoryCurationQueue, getSceneSummaryQueue } from '../../src/queues'

const MAX_CONTEXT_TOKENS = 6000

export async function generationProcessor(job: Job) {
  const {
    instanceId, playerId, userMessage,
    isContinuation = false,
    session, userNsfwEnabled, recentEvents, activeSummary,
    characterCodex = [],
  } = job.data

  // On a "continue" turn the player says nothing — the world advances on its
  // own. We feed the model a directive (but store no player input on the event).
  const promptUserMessage = isContinuation
    ? '[The player waits and observes. Continue the story, advancing events naturally without asking the player what they do.]'
    : userMessage
  const storedPlayerInput = isContinuation ? '' : userMessage
  const classifyText = isContinuation ? '' : userMessage
  const ragQueryText = isContinuation
    ? (recentEvents?.[recentEvents.length - 1]?.data?.ai_response as string) || 'Continue the current scene.'
    : userMessage

  const redis = getRedisClient()
  const instanceOid = parseObjectId(instanceId)
  const playerOid = parseObjectId(playerId)

  let loreTexts: string[] = []
  let memoryTexts: string[] = []

  try {
    const queryEmbedding = await embed(ragQueryText)
    const index = getPineconeIndex()

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

    const mongoIds = (memoryResults.matches || [])
      .map((m) => (m.metadata as any)?.mongo_id)
      .filter(Boolean)
      .map((id: string) => parseObjectId(String(id)))
    if (mongoIds.length > 0) {
      await mongoColl.memories().updateMany(
        { _id: { $in: mongoIds } },
        { $inc: { access_count: 1 }, $set: { last_accessed_at: new Date() } },
      )
    }
  } catch (err) {
    console.warn('RAG query failed, proceeding without retrieved memories:', (err as Error).message)
  }

  // Decide routing first so the prompt asks for the right output shape.
  // NSFW routing requires BOTH the world being mature-capable AND the player
  // having opted in via their account preference. Either alone keeps it SFW.
  let modelId = session.model_preferences?.narration_sfw || env.NARRATION_SFW_MODEL
  let isNsfwTurn = false

  // An explicitly erotic tone forces the NSFW path (when the world allows it and
  // the player has opted in); otherwise fall back to the keyword classifier.
  const toneWantsNsfw = /erotic|explicit|sexual|nsfw/i.test(session.tone || '')
  const sceneClassification =
    session.is_nsfw_capable && userNsfwEnabled
      ? toneWantsNsfw
        ? 'nsfw'
        : classifyScene(classifyText, recentEvents)
      : 'sfw'
  if (sceneClassification === 'nsfw') {
    modelId = session.model_preferences?.narration_nsfw || env.NARRATION_NSFW_MODEL
    isNsfwTurn = true
  }

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
    userMessage: promptUserMessage,
    maxTokens: MAX_CONTEXT_TOKENS,
    narrationPov: session.narration_pov,
    tone: session.tone,
    characterCodex,
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
  })

  // Stream the narrative token-by-token so the player sees words within ~1s
  // instead of waiting for the full completion. Deltas ride the same Redis
  // pub/sub channel that the API forwards to the player's WebSocket.
  const channel = `user:${playerId}:events`
  const genStart = Date.now()
  const prose = await callLLMStream(
    {
      model: modelId,
      messages: prompt.messages,
      temperature: 0.85,
      maxTokens: 800,
    },
    (chunk) => {
      redis.publish(
        channel,
        JSON.stringify({ type: 'generation_delta', instanceId, delta: chunk }),
      )
    },
  )
  const latencyMs = Date.now() - genStart

  const meta = await extractSceneMetadata(
    prose.trim(),
    Object.keys(session.world_state || {}),
    Object.keys(session.active_flags || {}),
  )
  const parsed: GenerationOutput = { narrative: prose.trim(), ...meta }

  const newWorldState = applyStateMutations(session.world_state, parsed.state_mutations)
  const newFlags = applyFlagMutations(session.active_flags, parsed.flag_mutations)

  const lastEvent = await mongoColl.events().findOne(
    { instance_id: instanceOid },
    { sort: { sequence: -1 }, projection: { sequence: 1 } },
  )
  const nextSequence = (lastEvent?.sequence || 0) + 1

  const event = {
    _id: new ObjectId(),
    instance_id: instanceOid,
    player_id: playerOid,
    sequence: nextSequence,
    type: parsed.scene_tag === 'intimate' ? 'intimate' : 'narration',
    data: {
      player_input: storedPlayerInput,
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

  await mongoColl.events().insertOne(event)

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
      metadata_model: 'gpt-4o-mini',
      tokens_in: event.data.tokens_in,
      tokens_out: event.data.tokens_out,
      latency_ms: latencyMs,
      created_at: new Date(),
    })
    .catch((err) => console.warn('generation_log insert failed:', (err as Error).message))

  const sceneTag = parsed.scene_tag
  const currentScene = session.current_scene
  const sameScene = currentScene.tag === sceneTag
  const newTurnCount = sameScene ? currentScene.turn_count + 1 : 1

  await mongoColl.worldInstances().updateOne(
    { _id: instanceOid },
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

  await redis.del(`lock:gen:${playerId}:${instanceId}`)

  const eventIdStr = idString(event._id)

  await redis.publish(`user:${playerId}:events`, JSON.stringify({
    type: 'generation_complete',
    instanceId,
    event: {
      id: eventIdStr,
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

  // Self-building character codex: extract NPC deltas from this turn, persist
  // canonical cards, then push an update to the live client.
  ;(async () => {
    try {
      const deltas = await extractCharacterCodexDeltas({
        playerInput: storedPlayerInput,
        aiResponse: parsed.narrative,
        existing: (characterCodex || []).map((c: any) => ({
          canonical_name: c.canonical_name,
          aliases: c.aliases || [],
          role: c.role,
          appearance: c.appearance,
          persona: c.persona,
          disposition_to_player: c.disposition_to_player,
        })),
      })
      if (!deltas.length) return

      const codex = await characterCodexService.applyDeltas({
        instanceId,
        playerId,
        sequence: nextSequence,
        deltas,
      })

      await redis.publish(`user:${playerId}:events`, JSON.stringify({
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
          disposition_to_player: c.disposition_to_player,
          hidden_thought: c.hidden_thought,
          mention_count: c.mention_count,
        })),
      }))
    } catch (err) {
      console.warn('character codex update failed:', (err as Error).message)
    }
  })()

  const memoryCurationQueue = getMemoryCurationQueue()
  await memoryCurationQueue.add('curate', {
    instanceId,
    playerId,
    eventId: eventIdStr,
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

  return { eventId: eventIdStr, sequence: nextSequence }
}
