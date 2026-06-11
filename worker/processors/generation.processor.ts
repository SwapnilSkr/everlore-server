import { ObjectId } from "mongodb";
import { Job } from "bullmq";
import { mongoColl } from "../../src/config/mongo";
import { getRedisClient } from "../../src/config/redis";
import { callLLMStream, AI_MODELS } from "../../src/ai";
import { buildContextPacket } from "../../src/services/context-packet.service";
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
import { entityGraphService, isVagueLocationLabel } from "../../src/services/entity-graph.service";
import { detectNarratedMovement, resolvePossessiveRoomName } from "../lib/movement-signal";
import { detectNarratedTimeSkip } from "../lib/time-skip-signal";
import { memorySupersessionService } from "../../src/services/memory-supersession.service";
import { timeService } from "../../src/services/time.service";
import {
  getMemoryCurationQueue,
  getSceneSummaryQueue,
  QUEUE_RETENTION,
} from "../../src/queues";
import { replayProcessor } from "./replay.processor";
import { sideChatProcessor } from "./side-chat.processor";
import { log } from "../../src/utils/logger";

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
/** Human labels for calendar-tick spans (keys arrive from the client). */
const TIME_ADVANCE_LABELS: Record<string, string> = {
  hours: "several hours",
  day: "a day",
  days: "several days",
  season: "a season",
};
/** Min turns between fate-seeded tick beats — keeps old promises from nagging. */
const FATE_SEED_COOLDOWN_TURNS = 8;

export async function generationProcessor(job: Job) {
  // Replay turns reuse the generation queue/worker but follow a distinct path:
  // they stream an alternative for an existing event instead of appending one.
  if (job.data?.mode === "replay") {
    return replayProcessor(job);
  }
  // Side chats also share the generation queue/worker: a private conversation
  // with one side character, appended to the same ledger as its own event type.
  if (job.data?.mode === "side_chat") {
    return sideChatProcessor(job);
  }

  const {
    instanceId,
    playerId,
    userMessage,
    isContinuation = false,
    timeAdvance,
    session,
    userNsfwEnabled,
  } = job.data;

  // A continue with a time span becomes a calendar tick: story time advances.
  const timeAdvanceLabel: string | undefined =
    isContinuation && timeAdvance ? TIME_ADVANCE_LABELS[String(timeAdvance)] : undefined;

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

  const redis = getRedisClient();
  const lockKey = `lock:gen:${playerId}:${instanceId}`;
  await redis.expire(lockKey, 240);
  const instanceOid = parseObjectId(instanceId);
  const playerOid = parseObjectId(playerId);

  // Explicit context packet, assembled here in the worker so RETRIEVAL RUNS
  // BEFORE CODEX SELECTION: cards pin both for names in the player's input and
  // for characters the retrieved memories are about (indirect references).
  const packet = await buildContextPacket({
    instanceId,
    playerId,
    session,
    userMessage,
    isContinuation,
  });
  const {
    recentEvents,
    characterCodex,
    loreTexts,
    memoryTexts,
    openThreads,
    currentTimeAnchor,
    timeContext,
    currentLocation,
    locationContext,
  } = packet;
  const activeSummary = packet.sceneSummary;
  const nextSequence = packet.currentSequence + 1;

  // Fate seeding: on a calendar tick, the highest-importance open thread may
  // come due — but only past the cooldown, so the world doesn't feel like a
  // debt collector opening every time skip with an old promise.
  let fateThread: string | undefined;
  if (timeAdvanceLabel && openThreads.length > 0) {
    try {
      const inst = await mongoColl.worldInstances().findOne(
        { _id: instanceOid },
        { projection: { "meta.last_fate_seed_sequence": 1 } },
      );
      const lastSeed = inst?.meta?.last_fate_seed_sequence || 0;
      if (nextSequence - lastSeed >= FATE_SEED_COOLDOWN_TURNS) {
        fateThread = openThreads[0];
      }
    } catch {
      // Seeding is an enhancement; the tick proceeds without it.
    }
  }

  const tickDirective = timeAdvanceLabel
    ? `[TIME ADVANCES: ${timeAdvanceLabel} pass(es) in the story. Narrate this span as a flowing interlude, then land on a concrete new beat.
- Show what changed across the span: characters pursued their own lives, recent events settled into consequences, the world moved without the player.
- Stay grounded in established canon, current world state, and active flags. Do not invent major new characters, locations, or lore.
- End IN SCENE on a specific moment — an arrival, an encounter, a discovery, a change — that naturally invites the player's next move. Do not ask the player what they do.${
        fateThread
          ? `\n- During this span, an unresolved matter comes due. Weave its consequence into the new beat naturally and concretely (do not resolve it on the player's behalf): ${fateThread}`
          : ""
      }]`
    : undefined;

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
    openThreads,
    sceneSummary: activeSummary,
    relevantSummaries: packet.relevantSummaries,
    recentEvents,
    userMessage: tickDirective ?? promptUserMessage,
    userSpokenInput: parsedPlayerInput.spoken,
    userNarrationFacts: parsedPlayerInput.narrationFacts,
    isContinuation,
    maxTokens: MAX_CONTEXT_TOKENS,
    narrationPov: session.narration_pov,
    chatMode: session.mode,
    narrativeStyle: session.narrative_style,
    styleNotes: session.style_notes,
    playerPersona: session.persona_snapshot || null,
    messageLength: session.message_length,
    characterCodex,
    timeContext,
    locationContext,
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
    playerAddressMode: session.is_sentient ? "you" : session.narration_pov === "first" ? "you" : "role",
    previousOpeningNames: previousOpeningName ? [previousOpeningName] : [],
    avoidOpeningNames: characterNames,
    model: modelId,
  });
  const finalNarrative = repairedProse.narrative;

  // Anchor choice generation to the player's identity so the choice viewpoint
  // can't drift. GM worlds: the protagonist card IS the player's character.
  // Sentient worlds: the player is the persona talking to the locked character.
  const protagonistCard = (characterCodex as any[]).find((c) => c.is_protagonist);
  const choiceProtagonist = session.is_sentient
    ? session.persona_snapshot?.name
      ? { name: session.persona_snapshot.name, aliases: [] }
      : null
    : protagonistCard
      ? { name: protagonistCard.canonical_name, aliases: protagonistCard.aliases || [] }
      : session.persona_snapshot?.name
        ? { name: session.persona_snapshot.name, aliases: [] }
        : null;
  // Known cast for name normalization: the selected codex minus the PLAYER, so
  // present_characters + choice references come back as canonical names the app
  // can match exactly (instead of whatever alias/role the prose used). In GM
  // worlds the player IS the is_protagonist card, so drop it; in sentient worlds
  // the player is the (un-carded) persona and the is_protagonist card is the AI
  // character the player talks to — very much an "other", so keep it.
  const choiceRoster = (characterCodex as any[])
    .filter((c) => c.canonical_name && (session.is_sentient || !c.is_protagonist))
    .map((c) => ({ name: c.canonical_name as string, aliases: (c.aliases || []) as string[] }));
  // Presence persists across a continuous scene: seed the extractor with whoever
  // was present at the end of the most recent main-story turn, so a character
  // still in the room but not named this passage isn't dropped to "elsewhere".
  const priorPresent: string[] = (() => {
    for (let i = (recentEvents as any[]).length - 1; i >= 0; i--) {
      const pc = (recentEvents as any[])[i]?.data?.present_characters;
      if (Array.isArray(pc)) return pc.filter((n) => typeof n === "string");
    }
    return [];
  })();
  // Known places so a RETURN reuses a location's canonical name instead of
  // minting a near-duplicate entity (which would split the Places journal).
  const knownPlaces = await entityGraphService
    .listKnownLocations(instanceId, 30)
    .catch(() => [] as { name: string; aliases: string[] }[]);
  const meta = await extractSceneMetadata(
    finalNarrative,
    Object.keys(session.world_state || {}),
    Object.keys(session.active_flags || {}),
    {
      isSentient: session.is_sentient,
      currentLocationName: currentLocation?.name || null,
      priorPresent,
      protagonist: choiceProtagonist,
      roster: choiceRoster,
      knownPlaces,
    },
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
  const eventCreatedAt = new Date();
  const previousEventId = recentEvents.length
    ? (recentEvents[recentEvents.length - 1] as any)._id
    : null;
  // The location cursor FOLLOWS the model's current_location. The tightened F1
  // rule means current_location reports only a place the viewpoint physically
  // occupies (never a merely-mentioned/planned venue), so trusting it here both
  // stops the old phantom (a discussed "great room" no longer lands as the
  // location) AND lets a real return update the cursor — even when the model
  // under-reports viewpoint_moved on a "came back inside" turn (it does), which
  // a cursor-side movement gate would wrongly strand at the place they left.
  // Deterministic backstops under the witness (the small model under-reports both
  // movement and the NAME of a personal space). The player's own narrated action is
  // the most reliable movement signal; their possessive cue ("my room") is the most
  // reliable owner-scoped name. See worker/lib/movement-signal.ts. The EFFECT is
  // gated on an actual place change below, so a broad read can't fabricate a move.
  const narratedMove = !isContinuation && detectNarratedMovement(parsedPlayerInput.raw);
  const cursorName = currentLocation?.name || null;
  const normEq = (a: string | null, b: string | null) =>
    !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  // Name override: when the player retreats to their OWN space and the model
  // returned a vague label / nothing / just the place they were already in, give
  // it a specific owner-scoped name so the cartographer mints a DISTINCT room
  // instead of collapsing onto the cursor ("the room" → the dining room).
  let placeName = parsed.current_location;
  let placeMovement = parsed.movement;
  const possessiveRoom = narratedMove
    ? resolvePossessiveRoomName(parsedPlayerInput.raw, choiceProtagonist?.name || null)
    : null;
  if (
    possessiveRoom &&
    (!placeName || isVagueLocationLabel(placeName) || normEq(placeName, cursorName))
  ) {
    placeName = possessiveRoom;
    // A personal room reached from the current place is a sibling under the same
    // container (dining room → mansion ← bedroom), so place it laterally unless the
    // model already gave a more specific movement.
    if (!placeMovement || placeMovement === "none") placeMovement = "lateral";
  }
  // Corroborate the move flag: trust an explicit narrated relocation the model
  // under-flagged, but ONLY when the resolved name is a real, different place — so
  // an ambiguous "going to" auxiliary on a stay-put turn can't reset the scene.
  const nameChanged =
    !!placeName && !isVagueLocationLabel(placeName) && !normEq(placeName, cursorName);
  const viewpointMoved =
    parsed.viewpoint_moved === true || (narratedMove && nameChanged);
  const resolvedLocation = placeName
    ? await entityGraphService.placeLocation({
        instanceId,
        playerId,
        sequence: nextSequence,
        name: placeName,
        containmentHint: parsed.containment_hint,
        movement: placeMovement,
        viewpointMoved,
        cursorEntityId: currentLocation?.entity_id ?? null,
      }).catch((err) => {
        console.warn("location anchor resolution failed:", (err as Error).message);
        return null;
      })
    : null;
  const locationAnchor = resolvedLocation || currentLocation || null;

  // The travel EVENT/marker stays conservative: it needs the model's explicit
  // movement assertion AND a real change of established place, so a stray label
  // can't fabricate a journey (the user's original phantom-travel complaint). A
  // genuine relocation the model doesn't flag still updates the cursor above —
  // it just isn't surfaced as a dated "Traveled X→Y" marker.
  const isTravel =
    !isContinuation &&
    viewpointMoved &&
    !!currentLocation &&
    !!resolvedLocation &&
    idString(resolvedLocation.entity_id) !== idString(currentLocation.entity_id);

  // Narrated time skips advance the calendar on any turn (travel, "weeks
  // passed"), not just the explicit wait/continue tick. The continuation tick's
  // label still wins when present. Deterministic backstop: the extractor reads only
  // the AI prose, so a skip the player wrote ("Weeks pass.") that the narrator
  // didn't restate is lost — recover it from the player's own input (the time twin
  // of the movement backstop). A model-reported time_elapsed still wins.
  const narratedTimeLabel = !isContinuation
    ? parsed.time_elapsed || detectNarratedTimeSkip(parsedPlayerInput.raw) || undefined
    : undefined;
  const effectiveTimeAdvance = timeAdvanceLabel || narratedTimeLabel;

  // Presence carry-forward (deterministic — not left to the model): a continuous
  // scene keeps everyone who was here, minus anyone the model says explicitly
  // left this turn. A scene break — the viewpoint physically moved, or in-world
  // time skipped — starts presence fresh from whoever this passage shows. This
  // stops a present-but-unnamed character (e.g. a quiet sibling at the table)
  // from flickering to "elsewhere" just because one reply didn't name them.
  // A scene break starts presence fresh. Beyond the model's move flag and a time
  // skip, treat ANY change of the resolved location ENTITY as a break — if the
  // cursor genuinely moved to a different place, whoever was in the old room does
  // NOT carry into the new one (the "parents followed me into my bedroom" class).
  const placeEntityChanged =
    !!resolvedLocation &&
    !!currentLocation &&
    idString(resolvedLocation.entity_id) !== idString(currentLocation.entity_id);
  const sceneBroke = viewpointMoved || !!narratedTimeLabel || placeEntityChanged;
  parsed.present_characters = (() => {
    const thisTurn = parsed.present_characters || [];
    if (sceneBroke) return thisTurn.slice(0, 12);
    const departed = new Set(
      (parsed.characters_departed || []).map((n) => n.trim().toLowerCase()),
    );
    const out: string[] = [];
    const seen = new Set<string>();
    for (const name of [...priorPresent, ...thisTurn]) {
      const key = (name || "").trim().toLowerCase();
      if (!key || seen.has(key) || departed.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (out.length >= 12) break;
    }
    return out;
  })();

  const timeAnchor = await timeService.anchorForNextEvent({
    instanceId,
    templateId: String(session.template_id),
    previous: currentTimeAnchor || session.current_time_anchor || null,
    previousEventId,
    sequence: nextSequence,
    realTime: eventCreatedAt,
    timeAdvancedLabel: effectiveTimeAdvance,
    eventTimeLabel: effectiveTimeAdvance || undefined,
    timelineId: session.active_timeline_id || currentTimeAnchor?.timeline_id || null,
  });

  const event = {
    _id: new ObjectId(),
    instance_id: instanceOid,
    player_id: playerOid,
    sequence: nextSequence,
    type: timeAdvanceLabel
      ? "calendar_tick"
      : isTravel
        ? "travel"
        : parsed.scene_tag === "intimate"
          ? "intimate"
          : "narration",
    data: {
      player_input: storedPlayerInput,
      player_spoken_input: parsedPlayerInput.spoken,
      player_narration_facts: parsedPlayerInput.narrationFacts,
      ai_response: parsed.narrative,
      choices: parsed.choices,
      milestone: parsed.milestone,
      present_characters: parsed.present_characters,
      ...(effectiveTimeAdvance ? { time_advanced: effectiveTimeAdvance } : {}),
      ...(isTravel && currentLocation && resolvedLocation
        ? { travel: { from: currentLocation.name, to: resolvedLocation.name } }
        : {}),
      ...(fateThread ? { fate_thread: fateThread } : {}),
      replay_variants: [
        {
          id: `base_${Date.now()}`,
          narrative: parsed.narrative,
          model_used: modelId,
          created_at: new Date(),
          source: "base",
          choices: parsed.choices,
          present_characters: parsed.present_characters,
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
    time_anchor: timeAnchor,
    location_anchor: locationAnchor,
    created_at: eventCreatedAt,
  };

  await mongoColl.events().insertOne(event);

  // Record what changed about the current place this turn onto its location
  // entity (mutable state + enduring canon, both event-sourced for rewind/edit
  // pruning). Fire-and-forget — it feeds FUTURE turns, not this response.
  if (
    locationAnchor &&
    ((parsed.location_state_changes?.length || 0) > 0 ||
      (parsed.location_permanent_facts?.length || 0) > 0)
  ) {
    entityGraphService
      .applyLocationFacts({
        instanceId,
        locationEntityId: locationAnchor.entity_id,
        sequence: nextSequence,
        eventId: event._id,
        state: parsed.location_state_changes,
        facts: parsed.location_permanent_facts,
      })
      .catch((err) =>
        console.warn("applyLocationFacts failed:", (err as Error).message),
      );
  }

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

  const instanceUpdate: Record<string, unknown> = {
    $set: {
      world_state: newWorldState,
      active_flags: newFlags,
      current_scene: {
        tag: sceneTag,
        turn_count: newTurnCount,
        summary_pending: shouldSummarize,
      },
      current_time_anchor: timeAnchor,
      active_timeline_id: timeAnchor.timeline_id,
      default_calendar_id: timeAnchor.story_calendar?.calendar_id,
      current_location: locationAnchor,
      "meta.last_active_at": new Date(),
      updated_at: new Date(),
      ...(fateThread ? { "meta.last_fate_seed_sequence": nextSequence } : {}),
    },
    $inc: {
      "meta.total_events": 1,
      "meta.total_tokens_consumed":
        event.data.tokens_in + event.data.tokens_out,
    },
  };
  if (parsed.milestone) {
    instanceUpdate.$push = {
      "meta.milestones": {
        $each: [{ label: parsed.milestone, sequence: nextSequence, at: new Date() }],
        $slice: -50,
      },
    };
  }
  await mongoColl.worldInstances().updateOne({ _id: instanceOid }, instanceUpdate as never);

  const updatedSession = {
    ...session,
    world_state: newWorldState,
    active_flags: newFlags,
    current_scene: {
      tag: sceneTag,
      turn_count: newTurnCount,
      summary_pending: shouldSummarize,
    },
    current_time_anchor: timeAnchor,
    active_timeline_id: timeAnchor.timeline_id,
    default_calendar_id: timeAnchor.story_calendar?.calendar_id
      ? idString(timeAnchor.story_calendar.calendar_id)
      : session.default_calendar_id,
    current_location: locationAnchor
      ? {
          ...locationAnchor,
          entity_id: idString(locationAnchor.entity_id),
        }
      : null,
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
        choices: parsed.choices,
        milestone: parsed.milestone,
        present_characters: parsed.present_characters,
        time_advanced: timeAdvanceLabel || null,
        time_anchor: timeAnchor,
        location_anchor: locationAnchor
          ? {
              ...locationAnchor,
              entity_id: idString(locationAnchor.entity_id),
            }
          : null,
        fate_thread: fateThread || null,
        event_type: event.type,
        state_diff: {
          world_state: newWorldState,
          active_flags: newFlags,
        },
      },
    }),
  );

  if (parsed.milestone) {
    await redis.publish(
      `user:${playerId}:events`,
      JSON.stringify({
        type: "milestone_unlocked",
        instanceId,
        milestone: { label: parsed.milestone, sequence: nextSequence },
      }),
    );
  }

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
        playerPersonaName: session.persona_snapshot?.name,
        presentCast: parsed.present_characters,
      });
      if (!deltas.length) return;

      // Sentient worlds: the player is the persona TALKING TO the world's main
      // character — they are not part of the cast. Drop any delta that would
      // card them, no matter what the extractor produced.
      const personaName = (session.persona_snapshot?.name || "").trim().toLowerCase();
      if (session.is_sentient && personaName) {
        const refersToPlayer = (d: (typeof deltas)[number]) =>
          [d.name, d.resolved_name, ...(d.aliases || [])].some(
            (n) => (n || "").trim().toLowerCase() === personaName,
          );
        for (let i = deltas.length - 1; i >= 0; i--) {
          if (refersToPlayer(deltas[i])) deltas.splice(i, 1);
        }
        if (!deltas.length) return;
      }

      // GM-world protagonist is the player's OWN character; relationship meters
      // toward the player are nonsense there (a character has no stance toward
      // themself). Enforce what the extractor prompt asks for. Sentient worlds
      // keep protagonist meters — the persona genuinely has a stance.
      if (!session.is_sentient) {
        for (const d of deltas) {
          if (d.is_protagonist) delete d.relationship_deltas;
        }
      }

      const codex = await characterCodexService.applyDeltas({
        instanceId,
        playerId,
        sequence: nextSequence,
        deltas,
      });

      // Ledger the applied deltas on the event so the codex is an exact
      // rebuildable projection (rewind replays these — no stale facts).
      await mongoColl
        .events()
        .updateOne({ _id: event._id }, { $set: { "data.codex_deltas": deltas } });

      // Entity graph: keep card↔entity links 1:1 and project this turn's
      // relationship meters onto typed edges. Best-effort — graph failures
      // never break the codex pipeline.
      try {
        const entityMap = await entityGraphService.syncCodexEntities({
          instanceId,
          playerId,
          sequence: nextSequence,
          cards: codex,
        });
        const touchedCards = codex.filter(
          (c) => c.last_seen_sequence === nextSequence && c.relationship,
        );
        if (touchedCards.length > 0) {
          await entityGraphService.syncRelationshipEdges({
            instanceId,
            playerId,
            sequence: nextSequence,
            eventId: event._id,
            cards: touchedCards,
            entitiesByCardName: entityMap,
            playerName: session.persona_snapshot?.name,
          });
        }
      } catch (err) {
        console.warn("entity graph sync failed:", (err as Error).message);
      }

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
            relationship: c.relationship || null,
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
