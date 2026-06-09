import { ObjectId } from "mongodb";
import { Job } from "bullmq";
import { mongoColl } from "../../src/config/mongo";
import { getRedisClient } from "../../src/config/redis";
import { getPineconeIndex } from "../../src/config/pinecone";
import { embed, callLLMStream, AI_MODELS } from "../../src/ai";
import { buildPrompt } from "../../src/utils/prompt-builder";
import { lengthMaxTokens } from "../../src/utils/narrative-styles";
import { NSFW_MODE } from "../../src/utils/chat-modes";
import { parsePlayerInput } from "../../src/utils/player-input-parser";
import {
  applyStateMutations,
  applyFlagMutations,
} from "../../src/utils/state-mutator";
import { countTokens } from "../../src/utils/token-counter";
import { repairProseHygiene } from "../../src/utils/prose-hygiene";
import { idString, parseObjectId } from "../../src/utils/mongo-id";
import { classifyScene } from "../lib/nsfw-classifier";
import { type GenerationOutput } from "../lib/structured-output";
import { extractSceneMetadata } from "../lib/metadata-extractor";
import { extractCharacterCodexDeltas } from "../lib/character-codex-extractor";
import { compactImmutableFacts } from "../lib/codex-compactor";
import { characterCodexService } from "../../src/services/character-codex.service";
import { memorySupersessionService } from "../../src/services/memory-supersession.service";
import {
  getMemoryCurationQueue,
  getSceneSummaryQueue,
  QUEUE_RETENTION,
} from "../../src/queues";
import { replayProcessor } from "./replay.processor";
import { log } from "../../src/utils/logger";

type RagVectorMatch = {
  metadata?: {
    text?: unknown;
    mongo_id?: unknown;
  };
};

function ragText(match: RagVectorMatch): string {
  return typeof match.metadata?.text === "string" ? match.metadata.text : "";
}

function ragMongoId(match: RagVectorMatch): string | null {
  const id = match.metadata?.mongo_id;
  return id ? String(id) : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function openingCharacterName(events: any[], names: string[]): string | null {
  const last = [...(events || [])]
    .reverse()
    .find((event) => String(event.data?.ai_response || "").trim());
  const text = String(last?.data?.ai_response || "")
    .trim()
    .replace(/^[\s*_]+/, "");
  for (const name of names) {
    if (!name) continue;
    const re = new RegExp(`^${escapeRegExp(name)}(?:\\b|'s\\b)`, "i");
    if (re.test(text)) return name;
  }
  return null;
}

const MAX_CONTEXT_TOKENS = 6000;
/** Turns of one continuous scene that fold into a single recap (non-overlapping). */
const SCENE_SUMMARY_BLOCK = 12;

export async function generationProcessor(job: Job) {
  // Replay turns reuse the generation queue/worker but follow a distinct path:
  // they stream an alternative for an existing event instead of appending one.
  if (job.data?.mode === "replay") {
    return replayProcessor(job);
  }

  const {
    instanceId,
    playerId,
    userMessage,
    isContinuation = false,
    session,
    userNsfwEnabled,
    recentEvents,
    activeSummary,
    characterCodex = [],
  } = job.data;

  // On a "continue" turn the player says nothing — the world advances on its
  // own. We feed the model a directive (but store no player input on the event).
  const parsedPlayerInput = isContinuation
    ? { raw: "", spoken: "", narrationFacts: [] as string[] }
    : parsePlayerInput(userMessage);

  const promptUserMessage = isContinuation
    ? "[The player waits and observes. Continue the current beat naturally without asking what they do. Prefer a quiet reaction, consequence, or small atmospheric progression. Do not introduce a new complication, location, character, danger, romance escalation, or major plot turn unless it was already clearly set up by recent events. Because this is an autonomous continuation, do not open with the active character's name; begin with pronoun, action, body language, speech, or setting instead.]"
    : parsedPlayerInput.spoken || "[No spoken dialogue from player this turn.]";
  const storedPlayerInput = isContinuation ? "" : userMessage;
  const classifyText = isContinuation ? "" : userMessage;
  const ragQueryText = isContinuation
    ? (recentEvents?.[recentEvents.length - 1]?.data?.ai_response as string) ||
      "Continue the current scene."
    : userMessage;

  const redis = getRedisClient();
  const lockKey = `lock:gen:${playerId}:${instanceId}`;
  await redis.expire(lockKey, 240);
  const instanceOid = parseObjectId(instanceId);
  const playerOid = parseObjectId(playerId);

  let loreTexts: string[] = [];
  let memoryTexts: string[] = [];

  try {
    const queryEmbedding = await embed(ragQueryText);
    const index = getPineconeIndex();

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
    ]);

    loreTexts = (loreResults.matches || []).map((m: RagVectorMatch) =>
      ragText(m),
    );
    memoryTexts = (memoryResults.matches || []).map((m: RagVectorMatch) =>
      ragText(m),
    );

    const mongoIds = (memoryResults.matches || [])
      .map((m: RagVectorMatch) => ragMongoId(m))
      .filter((id): id is string => id !== null)
      .map((id) => parseObjectId(id));
    if (mongoIds.length > 0) {
      await mongoColl
        .memories()
        .updateMany(
          { _id: { $in: mongoIds } },
          { $inc: { access_count: 1 }, $set: { last_accessed_at: new Date() } },
        );
    }
  } catch (err) {
    console.warn(
      "RAG query failed, proceeding without retrieved memories:",
      (err as Error).message,
    );
  }

  // Decide routing first so the prompt asks for the right output shape.
  // NSFW routing requires BOTH the world being mature-capable AND the player
  // having opted in via their account preference. Either alone keeps it SFW.
  let modelId =
    session.model_preferences?.narration_sfw || AI_MODELS.narrationSfw;
  let isNsfwTurn = false;

  // 'Ardent' chat mode is the structured NSFW on-ramp: when the world allows it
  // and the player opted in, it forces the explicit path. Otherwise the weighted
  // lexicon classifier decides automatically.
  const modeWantsNsfw = session.mode === NSFW_MODE;
  const sceneClassification =
    session.is_nsfw_capable && userNsfwEnabled
      ? modeWantsNsfw
        ? "nsfw"
        : classifyScene(classifyText, recentEvents)
      : "sfw";
  if (sceneClassification === "nsfw") {
    modelId =
      session.model_preferences?.narration_nsfw || AI_MODELS.narrationNsfw;
    isNsfwTurn = true;
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
    userSpokenInput: parsedPlayerInput.spoken,
    userNarrationFacts: parsedPlayerInput.narrationFacts,
    isContinuation,
    maxTokens: MAX_CONTEXT_TOKENS,
    narrationPov: session.narration_pov,
    chatMode: session.mode,
    narrativeStyle: session.narrative_style,
    styleNotes: session.style_notes,
    messageLength: session.message_length,
    characterCodex,
    focusCharacterName: (() => {
      const focusedId = session.focus_character_id;
      if (!focusedId) return undefined;
      const focused = (characterCodex as any[]).find(
        (c) => idString(c._id) === focusedId,
      );
      return focused?.canonical_name;
    })(),
    // Always request plain prose: it lets us stream tokens to the player as they
    // arrive (low TTFT), and uncensored models can't do the JSON envelope anyway.
    // Structured fields (stats/flags/scene tag) are derived in a cheap pass below.
    proseOnly: true,
  });

  // Stream the narrative token-by-token so the player sees words within ~1s
  // instead of waiting for the full completion. Deltas ride the same Redis
  // pub/sub channel that the API forwards to the player's WebSocket.
  const channel = `user:${playerId}:events`;
  const genStart = Date.now();
  let ttftMs = 0;
  const prose = await callLLMStream(
    {
      model: modelId,
      messages: prompt.messages,
      temperature: 0.72,
      maxTokens: lengthMaxTokens(session.message_length),
    },
    (chunk) => {
      // First streamed delta = the latency the player actually feels.
      if (ttftMs === 0) ttftMs = Date.now() - genStart;
      redis.publish(
        channel,
        JSON.stringify({ type: "generation_delta", instanceId, delta: chunk }),
      );
    },
  );
  const latencyMs = Date.now() - genStart;
  await redis.expire(lockKey, 240);

  await redis.publish(
    channel,
    JSON.stringify({
      type: "generation_stream_end",
      instanceId,
      narrative: prose.trim(),
    }),
  );

  const characterNames = (characterCodex || []).map(
    (c: any) => c.canonical_name,
  );
  const previousOpeningName = openingCharacterName(recentEvents || [], characterNames);
  const repairedProse = await repairProseHygiene({
    narrative: prose.trim(),
    characterNames,
    messageLength: session.message_length,
    previousOpeningNames: previousOpeningName ? [previousOpeningName] : [],
    avoidOpeningNames: characterNames,
    model: modelId,
  });
  const finalNarrative = repairedProse.narrative;

  const meta = await extractSceneMetadata(
    finalNarrative,
    Object.keys(session.world_state || {}),
    Object.keys(session.active_flags || {}),
  );
  const parsed: GenerationOutput = { narrative: finalNarrative, ...meta };
  const proseHygieneIssues = repairedProse.issues;

  const newWorldState = applyStateMutations(
    session.world_state,
    parsed.state_mutations,
  );
  const newFlags = applyFlagMutations(
    session.active_flags,
    parsed.flag_mutations,
  );

  const lastEvent = await mongoColl
    .events()
    .findOne(
      { instance_id: instanceOid },
      { sort: { sequence: -1 }, projection: { sequence: 1 } },
    );
  const nextSequence = (lastEvent?.sequence || 0) + 1;

  const event = {
    _id: new ObjectId(),
    instance_id: instanceOid,
    player_id: playerOid,
    sequence: nextSequence,
    type: parsed.scene_tag === "intimate" ? "intimate" : "narration",
    data: {
      player_input: storedPlayerInput,
      player_spoken_input: parsedPlayerInput.spoken,
      player_narration_facts: parsedPlayerInput.narrationFacts,
      ai_response: parsed.narrative,
      replay_variants: [
        {
          id: `base_${Date.now()}`,
          narrative: parsed.narrative,
          model_used: modelId,
          created_at: new Date(),
          source: "base",
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
      tokens_in: countTokens(JSON.stringify(prompt.messages)),
      tokens_out: countTokens(parsed.narrative),
      prose_hygiene_issues: proseHygieneIssues,
    },
    is_user_edited: false,
    edit_history: [],
    scene_tag: parsed.scene_tag,
    created_at: new Date(),
  };

  await mongoColl.events().insertOne(event);

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
      metadata_model: AI_MODELS.metadata,
      tokens_in: event.data.tokens_in,
      tokens_out: event.data.tokens_out,
      prose_hygiene_issues: proseHygieneIssues,
      latency_ms: latencyMs,
      ttft_ms: ttftMs,
      created_at: new Date(),
    })
    .catch((err) =>
      console.warn("generation_log insert failed:", (err as Error).message),
    );

  const sceneTag = parsed.scene_tag;
  const currentScene = session.current_scene;
  const sameScene = currentScene.tag === sceneTag;
  const rawTurnCount = sameScene ? currentScene.turn_count + 1 : 1;
  // Summarize a scene in NON-OVERLAPPING blocks: once a same-type scene reaches
  // the block size, fold those turns into one recap and RESET the counter — so
  // we don't re-summarize the trailing window on every subsequent turn (which
  // previously burned an LLM call per turn and piled up overlapping rows).
  const shouldSummarize = sameScene && rawTurnCount >= SCENE_SUMMARY_BLOCK;
  const newTurnCount = shouldSummarize ? 0 : rawTurnCount;

  await mongoColl.worldInstances().updateOne(
    { _id: instanceOid },
    {
      $set: {
        world_state: newWorldState,
        active_flags: newFlags,
        current_scene: {
          tag: sceneTag,
          turn_count: newTurnCount,
          summary_pending: shouldSummarize,
        },
        "meta.last_active_at": new Date(),
        updated_at: new Date(),
      },
      $inc: {
        "meta.total_events": 1,
        "meta.total_tokens_consumed":
          event.data.tokens_in + event.data.tokens_out,
      },
    },
  );

  const updatedSession = {
    ...session,
    world_state: newWorldState,
    active_flags: newFlags,
    current_scene: {
      tag: sceneTag,
      turn_count: newTurnCount,
      summary_pending: shouldSummarize,
    },
  };
  await redis.set(
    `session:${instanceId}`,
    JSON.stringify(updatedSession),
    "EX",
    3600,
  );

  await redis.del(lockKey);

  const eventIdStr = idString(event._id);

  await redis.publish(
    `user:${playerId}:events`,
    JSON.stringify({
      type: "generation_complete",
      instanceId,
      event: {
        id: eventIdStr,
        sequence: event.sequence,
        narrative: parsed.narrative,
        scene_tag: parsed.scene_tag,
        emotional_tone: parsed.emotional_tone,
        model_used: event.data.model_used,
        state_diff: {
          world_state: newWorldState,
          active_flags: newFlags,
        },
      },
    }),
  );

  // Self-building character codex: extract NPC deltas from this turn, persist
  // canonical cards, then push an update to the live client.
  (async () => {
    try {
      const deltas = await extractCharacterCodexDeltas({
        playerInput: parsedPlayerInput.raw,
        aiResponse: parsed.narrative,
        existing: (characterCodex || []).map((c: any) => ({
          canonical_name: c.canonical_name,
          aliases: c.aliases || [],
          role: c.role,
          appearance: c.appearance,
          persona: c.persona,
          disposition_to_player: c.disposition_to_player,
          mutable_state: c.mutable_state || [],
          immutable_facts: c.immutable_facts || [],
        })),
        seedPrompt: session.seed_prompt,
        isSentient: session.is_sentient,
        protagonistName: (characterCodex as any[]).find((c) => c.is_protagonist)
          ?.canonical_name,
      });
      if (!deltas.length) return;

      const codex = await characterCodexService.applyDeltas({
        instanceId,
        playerId,
        sequence: nextSequence,
        deltas,
      });

      // Memory-vector supersession: when a status was retired this turn, evict
      // the stale memory vectors so RAG can't resurface the now-false fact.
      const retiredFacts = deltas.flatMap((d) => d.retire_state || []);
      if (retiredFacts.length > 0) {
        memorySupersessionService
          .supersedeMemories({
            instanceId,
            retiredFacts,
            beforeDate: new Date(genStart),
          })
          .catch((err) =>
            console.warn("memory supersession failed:", (err as Error).message),
          );
      }

      // Async fact-cap compaction: distill any character whose permanent-fact
      // list has grown large, so long-lived characters stay bounded + accurate
      // over thousands of turns without losing recent or important facts.
      for (const c of codex) {
        if ((c.immutable_facts?.length || 0) >= 24) {
          compactImmutableFacts(c.canonical_name, c.immutable_facts, 16)
            .then((compacted) => {
              if (compacted && compacted.length) {
                return characterCodexService.setImmutableFacts(
                  idString(c._id),
                  compacted,
                );
              }
            })
            .catch(() => {});
        }
      }

      await redis.publish(
        `user:${playerId}:events`,
        JSON.stringify({
          type: "character_codex_updated",
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
            is_protagonist: c.is_protagonist === true,
          })),
        }),
      );
    } catch (err) {
      console.warn("character codex update failed:", (err as Error).message);
    }
  })();

  const memoryCurationQueue = getMemoryCurationQueue();
  await memoryCurationQueue.add(
    "curate",
    {
      instanceId,
      playerId,
      eventId: eventIdStr,
      playerInput: parsedPlayerInput.raw,
      playerSpokenInput: parsedPlayerInput.spoken,
      playerNarrationFacts: parsedPlayerInput.narrationFacts,
      aiResponse: parsed.narrative,
      sceneTag: parsed.scene_tag,
    },
    {
      priority: 5,
      delay: 1000,
      removeOnComplete: QUEUE_RETENTION.memoryCuration.removeOnComplete,
      removeOnFail: QUEUE_RETENTION.memoryCuration.removeOnFail,
    },
  );

  if (shouldSummarize) {
    const sceneSummaryQueue = getSceneSummaryQueue();
    const startSequence = nextSequence - (SCENE_SUMMARY_BLOCK - 1);
    const endSequence = nextSequence;
    log.info("scene_summary.queued", {
      instanceId,
      sceneTag,
      startSequence,
      endSequence,
    });
    await sceneSummaryQueue.add(
      "summarize",
      {
        instanceId,
        sceneTag,
        startSequence,
        endSequence,
      },
      {
        priority: 10,
        delay: 5000,
        removeOnComplete: QUEUE_RETENTION.sceneSummary.removeOnComplete,
        removeOnFail: QUEUE_RETENTION.sceneSummary.removeOnFail,
      },
    );
  }

  return { eventId: eventIdStr, sequence: nextSequence };
}
