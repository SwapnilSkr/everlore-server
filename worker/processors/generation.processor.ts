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
import { extractKinshipAssertions, mergeRelationAssertions } from "../lib/kinship-pattern-extractor";
import {
  applyStateMutations,
  applyFlagMutations,
} from "../../src/utils/state-mutator";
import { countTokens } from "../../src/utils/token-counter";
import { repairProseHygiene } from "../../src/utils/prose-hygiene";
import { idString, parseObjectId } from "../../src/utils/mongo-id";
import { generationLockKey } from "../../src/utils/generation-lock";
import { scoreScene, classifyBorderlineIntent } from "../lib/nsfw-classifier";
import { type GenerationOutput } from "../lib/structured-output";
import { extractSceneMetadata } from "../lib/metadata-extractor";
import { extractCharacterCodexDeltas } from "../lib/character-codex-extractor";
import { compactImmutableFacts } from "../lib/codex-compactor";
import { detectPresenceCodexGapsDetailed } from "../lib/presence-gap-detector";
import { characterCodexService } from "../../src/services/character-codex.service";
import { kinshipGraphService } from "../../src/services/kinship-graph.service";
import { entityGraphService, isVagueLocationLabel, normalizeEntityName } from "../../src/services/entity-graph.service";
import { detectNarratedMovement, resolvePossessiveRoomName } from "../lib/movement-signal";
import { groundChoices } from "../lib/choice-grounding";
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

/** Normalize a persona/character name for identity comparison. */
function normalizePersonaName(value: string): string {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministically pull the name the PLAYER introduces for THEMSELVES from
 * their first-person input ("I'm Kael", "my name is Swapnil", "call me Alex",
 * "I am Lena"). Sentient worlds frequently start with no authored persona name,
 * so the player names themselves in chat — and that name must NOT become a codex
 * card alongside the existing "The Player" entity (the dual-identity bug). Only a
 * proper-cased name (1-3 tokens) is accepted, so an "I am tired" never matches.
 */
export function detectSelfIntroName(input: string): string | null {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  // Capture a Proper-Cased name (1-3 tokens) immediately after a first-person
  // self-introduction trigger. The trigger match is case-insensitive; the
  // captured name must still be Proper-Cased (enforced post-capture) so "I am
  // tired" never matches but "I am Lena" does.
  const proper = `([A-Za-z][A-Za-z'’-]+(?:\\s+[A-Za-z'’-]+){0,2})`;
  const patterns = [
    new RegExp(`\\b(?:my name is|call me|i am called|they call me|name['’]s)\\s+${proper}`, "i"),
    new RegExp(`\\b(?:i am|i['’]m|im)\\s+${proper}`, "i"),
  ];
  // Frequent first-person continuations that look like a name but aren't.
  const STOP = new Set([
    "sorry", "here", "fine", "okay", "ok", "good", "ready", "back", "afraid",
    "sure", "glad", "happy", "tired", "done", "not", "the", "a", "an", "going",
    "trying", "looking", "just", "still", "so", "really", "very",
  ]);
  for (const re of patterns) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const name = m[1].trim();
    const firstToken = name.split(/\s+/)[0] || "";
    // The first token must be capitalized in the ORIGINAL text — a real name.
    if (!/^[A-Z]/.test(firstToken)) continue;
    if (STOP.has(name.toLowerCase()) || STOP.has(firstToken.toLowerCase())) continue;
    return name;
  }
  return null;
}

function positiveLocationStateFromInput(input: string, placeName?: string | null): string[] {
  const text = String(input || "").toLowerCase();
  if (!text) return [];
  const place = placeName || "the current place";
  if (/\b(sanctify|sanctifies|sanctified|consecrate|consecrates|consecrated|bless|blessed)\b/.test(text)) {
    return [`${place} has been sanctified`];
  }
  if (/\b(heal|heals|healed|restore|restores|restored|renew|renews|renewed|repair|repairs|repaired)\b/.test(text)) {
    return [`${place} has been restored`];
  }
  if (/\b(cleanse|cleanses|cleansed|purify|purifies|purified)\b/.test(text)) {
    return [`${place} has been cleansed`];
  }
  if (/\b(seal|seals|sealed)\b/.test(text)) {
    return [`${place} has been sealed`];
  }
  return [];
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
    ? {
        raw: "",
        spoken: "",
        narrationFacts: [] as string[],
        corrections: [] as string[],
        claims: [] as string[],
        actionFacts: [] as string[],
        fragments: [],
      }
    : parsePlayerInput(userMessage);

  const promptUserMessage = isContinuation
    ? "[The player waits and observes. Continue the current beat naturally without asking what they do. Prefer a quiet reaction, consequence, or small atmospheric progression. Do not introduce a new complication, location, character, danger, romance escalation, or major plot turn unless it was already clearly set up by recent events. Because this is an autonomous continuation, do not open with the active character's name; begin with pronoun, action, body language, speech, or setting instead.]"
    : parsedPlayerInput.spoken || "[No spoken dialogue from player this turn.]";
  const storedPlayerInput = isContinuation ? "" : userMessage;
  const classifyText = isContinuation ? "" : userMessage;

  const redis = getRedisClient();
  // The turn lock's TTL is kept alive by the worker-level heartbeat (see
  // worker/index.ts); we only need to release it explicitly on success below.
  const lockKey = generationLockKey(playerId, instanceId);
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

  // 'Ardent' chat mode is the structured NSFW on-ramp and the PRIMARY intent
  // signal: when the world allows it and the player opted in, it forces the
  // explicit path. Otherwise THIS turn routes on the deterministic lexicon score
  // alone — pure regex/string work, no network — so NOTHING is added to TTFT.
  // Clean-language intent the word list misses (score 1–2) can't be judged here
  // without an LLM call, and that call would sit on the critical path before the
  // first token. Instead we flag the turn as borderline and run the intent check
  // AFTER the stream (see `nsfwIntent` below), persisting a signal that arms the
  // NEXT turn's momentum. Cost: a one-turn lag on the first clean escalation —
  // the irreducible floor under a zero-TTFT constraint.
  const modeWantsNsfw = session.mode === NSFW_MODE;
  let sceneClassification: "sfw" | "nsfw" = "sfw";
  let borderlineForIntent = false;
  if (session.is_nsfw_capable && userNsfwEnabled) {
    if (modeWantsNsfw) {
      sceneClassification = "nsfw";
    } else {
      const scored = scoreScene(classifyText, recentEvents);
      sceneClassification = scored.decision;
      borderlineForIntent =
        scored.decision === "sfw" && scored.score >= 1 && scored.score <= 2;
    }
  }
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

  await redis.publish(
    channel,
    JSON.stringify({
      type: "generation_stream_end",
      instanceId,
      narrative: prose.trim(),
    }),
  );

  // RAW witness prose: what the model actually generated (and what the player
  // saw stream by). All world-state extractors (metadata, choice grounding,
  // codex, kinship, memory) witness THIS, not the hygiene-repaired prose, so
  // canonical-name anchors the model produced are never erased before
  // extraction. The hygiene pass below is COSMETIC — it only shapes the
  // persisted/displayed transcript (data.ai_response +
  // generation_complete.narrative), never what the extractors read.
  const rawNarrative = prose.trim();

  const characterNames = (characterCodex || []).map(
    (c: any) => c.canonical_name,
  );
  const previousOpeningName = openingCharacterName(recentEvents || [], characterNames);
  const repairedProse = await repairProseHygiene({
    narrative: rawNarrative,
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
    rawNarrative,
    Object.keys(session.world_state || {}),
    Object.keys(session.active_flags || {}),
    {
      isSentient: session.is_sentient,
      currentLocationName: currentLocation?.name || null,
      priorPresent,
      protagonist: choiceProtagonist,
      roster: choiceRoster,
      knownPlaces,
      // The world premise/lore, so the extractor can tell a LITERAL ghost (a real
      // spirit in a horror/fantasy world) from a FIGURATIVE one (a metaphor for an
      // overlooked person in a grounded drama) instead of reifying the metaphor
      // into a "ask her about the ghost" choice.
      worldContext: [session.seed_prompt, session.global_lore]
        .filter(Boolean)
        .join("\n"),
    },
  );
  const parsed: GenerationOutput = { narrative: finalNarrative, ...meta };
  const proseHygieneIssues = repairedProse.issues;

  // Closed-check backstop on the choices: the metadata model is *told* never to
  // invent characters, but nothing enforced it — a small model would fabricate a
  // relative the cast doesn't have ("Encourage my brother" when the player has
  // only a sister) and the bad choice reached the player. Drop any choice that
  // references a kinship relation no codex card carries. Pure string work, off
  // the TTFT path (the prose already streamed) → zero added latency. Every kin
  // the cast DOES have is whitelisted, so a valid "confront my sister" survives.
  const castVocab = (characterCodex as any[]).flatMap((c) => [
    c?.canonical_name,
    c?.name_normalized,
    c?.role,
    ...((c?.aliases as string[]) || []),
  ]);
  // Authoritative source: the kinship GRAPH as it stood after PRIOR turns (a cheap
  // pre-turn READ — the graph for THIS turn is written later on the tail). Gives
  // the player's actual relatives' labels, perspective-correct. GM worlds anchor on
  // the protagonist card's entity; sentient/empty fall back to cast+prose. Flag
  // KINSHIP_GRAPH_READS=off disables consumption (write path keeps shadowing).
  let graphLabels: string[] = [];
  if (process.env.KINSHIP_GRAPH_READS !== "off" && !session.is_sentient) {
    const selfReadId = protagonistCard?.entity_id ? idString(protagonistCard.entity_id) : null;
    if (selfReadId) {
      const summary = await kinshipGraphService
        .kinSummary(idString(instanceId), selfReadId)
        .catch(() => ({ kinds: new Set(), labelsByKind: {} as Record<string, string[]> }));
      graphLabels = Object.values(summary.labelsByKind).flat() as string[];
    }
  }
  // Pass the grounded narrator prose so a relative introduced THIS turn (not yet
  // in the pre-turn codex) isn't mistaken for a fabrication; and the world
  // premise/lore so a SUPERNATURAL being only survives when the world establishes
  // it as real (otherwise "Ask her about the ghost" for a metaphorical ghost in a
  // grounded drama is dropped — the prompt rule alone is unreliable on the small
  // model). Real ghosts in a horror world: their premise names them or they're carded.
  const worldText = [session.seed_prompt, session.global_lore]
    .filter(Boolean)
    .join("\n");
  const groundedChoices = groundChoices(
    parsed.choices || [],
    castVocab,
    rawNarrative,
    graphLabels,
    worldText,
    { protagonist: choiceProtagonist, isSentient: !!session.is_sentient },
  );
  if (groundedChoices.dropped.length) {
    log.warn("choice-grounding dropped ungrounded choices", {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      dropped: groundedChoices.dropped.map((d) => ({
        term: d.term,
        label: d.choice.label,
      })),
    });
  }
  parsed.choices = groundedChoices.choices;

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
  // Resolve every presence name to a CANONICAL identity before set ops, using the
  // SAME registry the codex resolves with (normalizeEntityName over each card's
  // canonical_name + aliases). Without this, "the captain" and "Bram" are two
  // different lowercased strings — so a carried alias is dropped or double-counted.
  // Unknown walk-ons (no matching card) fall back to their normalized string, so
  // they are de-duped/departed correctly but never dropped.
  // presenceKeyOf → canonical IDENTITY key (for set ops); presenceDisplayOf →
  // the card's canonical SPELLING (for the surfaced label), so a carried alias
  // shows as "Bram", not whichever string happened to appear first. Unknown
  // walk-ons fall back to their own normalized key / original string.
  // normalizeEntityName does NOT strip leading articles, so "the father" never
  // matched the "father" card and leaked as a phantom present-character; and a
  // model-confabulated alias like "Sister Thompson" (Sister + surname, not a
  // real alias) split off as its own ghost. So beyond canonical/normalized/alias
  // keys we also index the ARTICLE-STRIPPED form ("the father" → "father") and a
  // conflict-safe FIRST TOKEN ("Sister Thompson"/"Mara Thompson" → the Sister
  // card) — the latter only when that token maps unambiguously to a single card.
  const articleStrip = (s: string) => s.replace(/^(?:the|a|an)\s+/, "").trim();
  const { presenceKeyOf, presenceDisplayOf, presenceIsKnown } = (() => {
    const byName = new Map<string, string>();
    const displayByKey = new Map<string, string>();
    const knownKeys = new Set<string>();
    // First-token → card, with collision detection: a token shared by two cards
    // (e.g. a common surname) is ambiguous and must NOT resolve to either.
    const firstTokenMap = new Map<string, string>();
    const ambiguousTokens = new Set<string>();
    const addAlias = (raw: string, canonKey: string) => {
      const k = normalizeEntityName(String(raw || ""));
      if (!k) return;
      byName.set(k, canonKey);
      const stripped = articleStrip(k);
      if (stripped && stripped !== k) byName.set(stripped, canonKey);
      const tok = stripped.split(" ")[0];
      if (tok) {
        const prior = firstTokenMap.get(tok);
        if (prior && prior !== canonKey) ambiguousTokens.add(tok);
        else firstTokenMap.set(tok, canonKey);
      }
    };
    for (const c of characterCodex as any[]) {
      const canon = c?.canonical_name;
      if (!canon) continue;
      const canonKey = normalizeEntityName(String(canon));
      if (!canonKey) continue;
      knownKeys.add(canonKey);
      displayByKey.set(canonKey, String(canon));
      addAlias(String(canon), canonKey);
      if (c?.name_normalized) addAlias(String(c.name_normalized), canonKey);
      for (const a of (c?.aliases || []) as string[]) addAlias(String(a || ""), canonKey);
    }
    for (const tok of ambiguousTokens) firstTokenMap.delete(tok);
    const keyOf = (name: string): string => {
      const n = normalizeEntityName(String(name || ""));
      const stripped = articleStrip(n);
      return (
        byName.get(n) ||
        byName.get(stripped) ||
        firstTokenMap.get(stripped.split(" ")[0]) ||
        stripped ||
        n
      );
    };
    return {
      presenceKeyOf: keyOf,
      presenceDisplayOf: (name: string): string =>
        displayByKey.get(keyOf(name)) || name,
      presenceIsKnown: (name: string): boolean => knownKeys.has(keyOf(name)),
    };
  })();
  // The player must never appear in their own scene's present-cast. In a GM world
  // the player IS the is_protagonist card, so exclude that identity; in a sentient
  // world the is_protagonist card is the AI the player talks to (an "other") and
  // is force-added below, so it stays.
  const playerPresenceKey =
    !session.is_sentient && protagonistCard?.canonical_name
      ? presenceKeyOf(String(protagonistCard.canonical_name))
      : null;
  // A label that resolved to NO card AND is generic — an article-led role tag
  // ("the son") or an all-lowercase common noun ("guard") — is the player under a
  // role title or scene-dressing, not a trackable person. Drop it. An unresolved
  // CAPITALIZED proper name (a genuine new walk-on) is kept.
  const isGenericLabel = (raw: string): boolean => {
    const t = String(raw || "").trim();
    if (!t) return true;
    if (/^(?:the|a|an)\s+/i.test(t)) return true;
    if (!/[A-ZÀ-Þ]/.test(t)) return true;
    return false;
  };
  // Family-role NPCs are often introduced before they have proper-name cards,
  // especially GM premises like "your father / mother / twin sister". The
  // metadata model may surface them as lowercase labels ("sister", "father").
  // Those are generic-looking, but they are real scene participants and must
  // seed codex extraction. Keep child/self-facing labels out so the player does
  // not become a separate "Son" / "Child" card. TITLED role NPCs (butler,
  // captain, king, queen, prince, princess, lord, lady) are premise-backed in
  // the same way — the narration names the role, the character has no proper
  // name yet — so they are kept too. This list mirrors the
  // FAMILY_ROLE_WORDS set in scripts/presence-codex-gap-audit.ts and the
  // _familyRoleWords set in play_cubit.dart so the backend presence filter,
  // the audit, and the client miss-detector agree on what a "premise-backed
  // role NPC" is.
  const trackableFamilyLabels = new Set([
    "father",
    "mother",
    "mom",
    "dad",
    "parent",
    "parents",
    "sister",
    "brother",
    "sibling",
    "twin sister",
    "twin brother",
    "twin",
    "wife",
    "husband",
    "spouse",
    "partner",
    "fiancee",
    "fiance",
    "girlfriend",
    "boyfriend",
    "cousin",
    "aunt",
    "uncle",
    "grandmother",
    "grandfather",
    "grandma",
    "grandpa",
    "butler",
    "captain",
    "king",
    "queen",
    "prince",
    "princess",
    "lord",
    "lady",
  ]);
  const familyPresenceLabel = (raw: string): string | null => {
    const n = articleStrip(normalizeEntityName(String(raw || "")))
      .replace(/^(?:my|your|his|her|their|our)\s+/, "")
      .trim();
    if (!trackableFamilyLabels.has(n)) return null;
    return n
      .split(" ")
      .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
      .join(" ");
  };
  parsed.present_characters = (() => {
    const candidates = sceneBroke
      ? (parsed.present_characters || [])
      : [...priorPresent, ...(parsed.present_characters || [])];
    const departed = new Set(
      (parsed.characters_departed || [])
        .map((n) => presenceKeyOf(n))
        .filter(Boolean),
    );
    const out: string[] = [];
    const seen = new Set<string>();
    for (const name of candidates) {
      const key = presenceKeyOf(name);
      if (!key || seen.has(key) || departed.has(key)) continue;
      if (playerPresenceKey && key === playerPresenceKey) continue;
      const familyLabel = !presenceIsKnown(name) ? familyPresenceLabel(name) : null;
      if (!presenceIsKnown(name) && isGenericLabel(name) && !familyLabel) continue;
      seen.add(key);
      out.push(familyLabel || presenceDisplayOf(name));
      if (out.length >= 12) break;
    }
    return out;
  })();
  if (session.is_sentient) {
    const aiName =
      (characterCodex as any[]).find((c) => c.is_protagonist)?.canonical_name ||
      session.protagonist?.name ||
      null;
    if (aiName && !parsed.present_characters.some((n) => presenceKeyOf(n) === presenceKeyOf(aiName))) {
      parsed.present_characters = [aiName, ...parsed.present_characters].slice(0, 12);
    }
  }

  // WITNESS → ENTITY-STUB tier: every present person the scene just showed who
  // isn't already a codex card gets a lightweight stub entity before the turn is
  // released. Codex extraction remains async below, but stubs must exist before
  // the next turn can start so kinship/choice/memory graph reads do not race.
  const knownCardNames = new Set<string>();
  for (const c of (characterCodex as any[]) || []) {
    if (!c?.canonical_name) continue;
    knownCardNames.add(normalizeEntityName(c.canonical_name));
    for (const a of (c.aliases || []) as string[]) {
      const n = normalizeEntityName(a);
      if (n) knownCardNames.add(n);
    }
  }
  if (session.is_sentient) {
    if (session.persona_snapshot?.name) {
      knownCardNames.add(normalizeEntityName(session.persona_snapshot.name));
    }
    const selfIntro = detectSelfIntroName(parsedPlayerInput.raw);
    if (selfIntro) knownCardNames.add(normalizeEntityName(selfIntro));
  }
  const presenceGapExcludes: string[] = [];
  if (session.is_sentient && session.persona_snapshot?.name) {
    presenceGapExcludes.push(session.persona_snapshot.name);
  }
  const selfIntroForGap = session.is_sentient ? detectSelfIntroName(parsedPlayerInput.raw) : null;
  if (selfIntroForGap) presenceGapExcludes.push(selfIntroForGap);
  const visiblePresenceGaps = detectPresenceCodexGapsDetailed(rawNarrative, {
    present: parsed.present_characters,
    codex: [...knownCardNames],
    exclude: presenceGapExcludes,
  });
  if (visiblePresenceGaps.length) {
    const presentSeen = new Set(parsed.present_characters.map((n) => normalizeEntityName(n)));
    for (const gap of visiblePresenceGaps) {
      if (parsed.present_characters.length >= 12) break;
      if (!gap.key || presentSeen.has(gap.key)) continue;
      presentSeen.add(gap.key);
      parsed.present_characters.push(gap.display);
    }
    log.info("presence.gaps.stubbed.live", {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      gaps: visiblePresenceGaps.map((g) => g.key).slice(0, 8),
    });
  }
  const stubResult = await entityGraphService
    .ensureSceneParticipantStubs({
      instanceId,
      playerId,
      sequence: nextSequence,
      presentNames: parsed.present_characters,
      knownCardNames,
    })
    .catch((err) => {
      console.warn("scene participant stubs skipped:", (err as Error).message);
      return { ensured: [] as string[], promoted: [] as string[] };
    });
  if (stubResult.ensured.length) {
    log.info("scene.participant.stubs", {
      instanceId: idString(instanceId),
      sequence: nextSequence,
      ensured: stubResult.ensured,
    });
  }
  entityGraphService
    .archiveStaleStubs({ instanceId, sequence: nextSequence })
    .then((res) => {
      if (res.archived > 0) {
        log.info("scene.participant.stubs.archived", {
          instanceId: idString(instanceId),
          sequence: nextSequence,
          archived: res.archived,
        });
      }
    })
    .catch((err) => {
      console.warn("stale stub archival skipped:", (err as Error).message);
    });

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

  // Off the TTFT path (the prose already streamed): for a borderline turn, ask
  // the cheap intent judge whether the PLAYER expressed sexual intent in clean
  // language the lexicon missed. This does NOT change the turn that just streamed;
  // it persists `nsfw_intent` so scoreScene's momentum routes the NEXT turn to the
  // explicit model. Gated + fail-safe: classifyBorderlineIntent returns 'sfw' when
  // disabled or on any error. An already-explicit turn arms momentum directly.
  const nsfwIntent = borderlineForIntent
    ? (await classifyBorderlineIntent(classifyText)) === "nsfw"
    : sceneClassification === "nsfw";

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
    ...(nsfwIntent ? { nsfw_intent: true } : {}),
    time_anchor: timeAnchor,
    location_anchor: locationAnchor,
    created_at: eventCreatedAt,
  };

  await mongoColl.events().insertOne(event);

  const backedState = positiveLocationStateFromInput(
    parsedPlayerInput.raw,
    locationAnchor?.name || currentLocation?.name || null,
  );
  if (backedState.length > 0) {
    const existing = new Set((parsed.location_state_changes || []).map((s) => s.toLowerCase()));
    parsed.location_state_changes = [
      ...(parsed.location_state_changes || []),
      ...backedState.filter((s) => !existing.has(s.toLowerCase())),
    ].slice(0, 6);
  }

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
        aiResponse: rawNarrative,
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
      // card them, no matter what the extractor produced. The player's identity
      // is the UNION of: the authored persona name, the existing player entity's
      // canonical name + aliases (learned on prior turns), and any name the
      // player introduces for THEMSELVES THIS turn ("I'm Kael", "call me Alex").
      // The last one is the gap that minted Alex/Swapnil/Kael cards: sentient
      // worlds often start with no persona name, so the only signal that "Kael"
      // is the player is their own self-introduction — which must card nothing.
      if (session.is_sentient) {
        const playerNames = new Set<string>();
        const addName = (n: string | null | undefined) => {
          const norm = normalizePersonaName(n || "");
          if (norm) playerNames.add(norm);
        };
        addName(session.persona_snapshot?.name);
        let selfIntroName: string | null = null;
        try {
          const playerEntity = await mongoColl
            .entities()
            .findOne(
              { instance_id: instanceOid, type: "player" },
              { projection: { canonical_name: 1, aliases: 1 } },
            );
          if (playerEntity) {
            // "The Player" / "player" are generic sentinels, not a real name a
            // card could collide with — skip them so they don't over-match.
            for (const n of [playerEntity.canonical_name, ...(playerEntity.aliases || [])]) {
              const norm = normalizePersonaName(n || "");
              if (norm && norm !== "the player" && norm !== "player") playerNames.add(norm);
            }
          }
          selfIntroName = detectSelfIntroName(parsedPlayerInput.raw);
          if (selfIntroName) addName(selfIntroName);
        } catch (err) {
          console.warn("player self-name resolution skipped:", (err as Error).message);
        }

        if (playerNames.size > 0) {
          const refersToPlayer = (d: (typeof deltas)[number]) =>
            [d.name, d.resolved_name, ...(d.aliases || [])]
              .map((n) => normalizePersonaName(n || ""))
              .some((n) => n && playerNames.has(n));
          for (let i = deltas.length - 1; i >= 0; i--) {
            if (refersToPlayer(deltas[i])) deltas.splice(i, 1);
          }
        }

        // Persist a freshly-introduced player name onto the player entity so the
        // guard still catches it on later turns where the player doesn't restate
        // it (the extractor would otherwise re-mint the card the moment the main
        // character addresses them by name).
        if (selfIntroName) {
          const norm = normalizePersonaName(selfIntroName);
          if (norm && norm !== "the player" && norm !== "player") {
            // AWAIT (not fire-and-forget): the per-instance turn lock serializes
            // turns, so persisting the player's self-intro alias BEFORE this turn
            // releases its lock guarantees the next turn's guard reads it. A
            // fire-and-forget write raced the following extractions — "I'm
            // Swapnil" at seq 2 still let seq 6 mint a "Swapnil" codex card
            // because the alias hadn't landed when seq 6's guard read the entity.
            try {
              await mongoColl
                .entities()
                .updateOne(
                  { instance_id: instanceOid, type: "player" },
                  { $addToSet: { aliases: norm }, $set: { updated_at: new Date() } },
                );
            } catch (err) {
              console.warn("player self-name persist skipped:", (err as Error).message);
            }
          }
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

        // Kinship graph: typed relation ties asserted this turn → graph edges
        // (extract → Stage-1 hygiene → Stage-2 epithet resolver → persist). Post
        // stream, off TTFT. Self anchor = protagonist card (GM) or player (sentient).
        // Merge the LLM's relation assertions with a deterministic pass over the
        // player's own input + prose, so a clearly-stated tie carries the RIGHT
        // authority (a player_correction can retcon, a claim stays soft) even when
        // the LLM missed it or could only stamp 'narrator'. Authority-aware: the
        // stronger source wins a collision. Off TTFT (post-stream tail).
        const deterministicAssertions = extractKinshipAssertions({
          corrections: parsedPlayerInput.corrections,
          narrationFacts: parsedPlayerInput.narrationFacts,
          claims: parsedPlayerInput.claims,
          prose: rawNarrative,
        });
        const relationAssertions = mergeRelationAssertions(
          deltas.flatMap((d) => d.relation_assertions || []),
          deterministicAssertions,
        );
        if (relationAssertions.length > 0) {
          const protagCard = codex.find((c) => c.is_protagonist);
          let selfAnchorId: string | null = null;
          if (!session.is_sentient && protagCard) {
            const ent = entityMap.get(protagCard.name_normalized);
            selfAnchorId = ent?._id ? idString(ent._id) : null;
          } else {
            const player = await entityGraphService.ensurePlayerEntity({
              instanceId,
              playerId,
              name: session.persona_snapshot?.name,
              sequence: nextSequence,
            });
            selfAnchorId = idString(player._id);
          }
          const kin = await kinshipGraphService.applyRelationAssertions({
            instanceId,
            sequence: nextSequence,
            eventId: event._id,
            assertions: relationAssertions,
            cards: codex,
            entitiesByCardName: entityMap,
            selfAnchorId,
            sceneText: rawNarrative,
            // Stub uncarded endpoints (e.g. a just-named "Mara" the codex didn't
            // card yet) so the typed tie is written against a stub entity now;
            // it promotes when the card lands. Closes the "edge disappears
            // because the endpoint has no card" gap.
            ensureStub: (name: string) =>
              entityGraphService.ensureStubEntity({
                instanceId,
                playerId,
                sequence: nextSequence,
                name,
              }).then((id) => id),
          });
          if (kin.written > 0) {
            log.info("kinship.graph.updated", {
              instanceId: idString(instanceId),
              sequence: nextSequence,
              edges: kin.written,
              notes: kin.notes.slice(0, 6),
            });
          }
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
            eventId: idString(event._id),
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
      aiResponse: rawNarrative,
      sceneTag: parsed.scene_tag,
      isSentient: !!session.is_sentient,
      playerPersonaName: session.persona_snapshot?.name || null,
      protagonistName: (characterCodex as any[]).find((c) => c.is_protagonist)?.canonical_name || session.protagonist?.name || null,
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
