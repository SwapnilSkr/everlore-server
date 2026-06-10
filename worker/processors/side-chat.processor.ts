import { ObjectId } from "mongodb";
import { Job } from "bullmq";
import { mongoColl } from "../../src/config/mongo";
import { getRedisClient } from "../../src/config/redis";
import { callLLMStream, AI_MODELS } from "../../src/ai";
import { NSFW_MODE } from "../../src/utils/chat-modes";
import {
  buildStyleBlock,
  buildLengthDirective,
  lengthMaxTokens,
} from "../../src/utils/narrative-styles";
import { countTokens } from "../../src/utils/token-counter";
import { idString, parseObjectId } from "../../src/utils/mongo-id";
import { classifyScene } from "../lib/nsfw-classifier";
import { timeService } from "../../src/services/time.service";
import { buildSideChatPacket } from "../../src/services/context-packet.service";
import type { CharacterProfileDoc } from "../../src/models/character-profile.model";
import type { WorldEventDoc } from "../../src/models/world-event.model";

/** Conversation continuity window: prior turns with THIS character only. */
const SIDE_CHAT_RECENT_TURNS = 8;

function characterSheet(card: CharacterProfileDoc): string {
  const lines: string[] = [`Name: ${card.canonical_name}`];
  if (card.role) lines.push(`Role: ${card.role}`);
  if (card.persona) lines.push(`Persona: ${card.persona}`);
  if (card.appearance) lines.push(`Appearance: ${card.appearance}`);
  if (card.immutable_facts?.length)
    lines.push(`Established facts:\n${card.immutable_facts.map((f) => `- ${f}`).join("\n")}`);
  if (card.mutable_state?.length)
    lines.push(`Current state:\n${card.mutable_state.map((s) => `- ${s}`).join("\n")}`);
  if (card.disposition_to_player)
    lines.push(`Disposition toward the player: ${card.disposition_to_player}`);
  if (card.hidden_thought) lines.push(`Private inner thought: ${card.hidden_thought}`);
  if (card.relationship) {
    const r = card.relationship;
    lines.push(
      `Relationship meters toward the player (0-100): trust ${r.trust}, affection ${r.affection}, fear ${r.fear}, rivalry ${r.rivalry}`,
    );
  }
  return lines.join("\n");
}

/**
 * One private side-chat turn: the player talks directly WITH one side character,
 * off to the side of the main narration. The turn lands in the SAME event
 * ledger and sequence counter as main turns (rewind/time anchors stay exact)
 * but is excluded from main-narration context, scene summaries, and the Play
 * feed. Story time does not advance — a side chat is a beat, not a day.
 */
export async function sideChatProcessor(job: Job) {
  const { instanceId, playerId, characterId, userMessage, session, userNsfwEnabled } =
    job.data;
  const redis = getRedisClient();
  const channel = `user:${playerId}:events`;
  const lockKey = `lock:gen:${playerId}:${instanceId}`;
  await redis.expire(lockKey, 240);
  const instanceOid = parseObjectId(instanceId);
  const playerOid = parseObjectId(playerId);

  try {
    const card = (await mongoColl.characters().findOne({
      _id: parseObjectId(characterId),
      instance_id: instanceOid,
    })) as CharacterProfileDoc | null;
    if (!card) throw new Error("Character not found");
    // The protagonist IS the main conversation (sentient worlds) or the
    // player's own character (GM worlds) — side chats are for everyone else.
    if (card.is_protagonist) throw new Error("Side chats are for side characters");

    // The packet pins the active side character: their card is the canon
    // sheet, and retrieval is scoped to what THEY can know (shared-history
    // memories + open threads involving them).
    const [packet, recentChats] = await Promise.all([
      buildSideChatPacket({ instanceId, session, card }),
      mongoColl
        .events()
        .find({
          instance_id: instanceOid,
          type: "side_chat",
          "side_chat.character_id": card._id,
        })
        .sort({ sequence: -1 })
        .limit(SIDE_CHAT_RECENT_TURNS)
        .toArray() as Promise<WorldEventDoc[]>,
    ]);
    recentChats.reverse();
    const nextSequence = packet.currentSequence + 1;
    const { currentTimeAnchor, timeContext, currentLocation } = packet;

    // NSFW routing parity with main turns: world capability AND player opt-in.
    let modelId = session.model_preferences?.narration_sfw || AI_MODELS.narrationSfw;
    const sceneClassification =
      session.is_nsfw_capable && userNsfwEnabled
        ? session.mode === NSFW_MODE
          ? "nsfw"
          : classifyScene(userMessage, recentChats)
        : "sfw";
    if (sceneClassification === "nsfw") {
      modelId = session.model_preferences?.narration_nsfw || AI_MODELS.narrationNsfw;
    }

    const personaName = session.persona_snapshot?.name || "the player";
    const systemContent = `You are roleplaying as ${card.canonical_name}, one character from an ongoing story, in a PRIVATE one-on-one conversation with ${personaName}. This conversation happens off to the side of the main story narration.

CHARACTER SHEET (canon — never contradict it):
${characterSheet(card)}
${timeContext ? `\n${timeContext}` : ""}${currentLocation ? `\nCurrent place in the story: ${currentLocation.name}.` : ""}
${
  packet.memoryTexts.length
    ? `\nWHAT ${card.canonical_name.toUpperCase()} REMEMBERS (shared history — speak from these naturally, never recite them):\n${packet.memoryTexts.map((t) => `- ${t}`).join("\n")}`
    : ""
}${
  packet.openThreads.length
    ? `\nUNRESOLVED MATTERS involving ${card.canonical_name} (may color their mood; do not force them into the conversation):\n${packet.openThreads.map((t) => `- ${t}`).join("\n")}`
    : ""
}

RULES:
- Respond ONLY as ${card.canonical_name}: their voice, knowledge, mood, and agenda. Stay true to the disposition and relationship meters above.
- ${card.canonical_name} only knows what they have personally witnessed, been told, or could plausibly infer. They are not a narrator and have no out-of-character knowledge.
- Never speak, act, or decide for ${personaName}.
- This is an intimate, conversational register — dialogue first, with brief physical beats. No scene-setting paragraphs, no plot advancement, no new locations or characters.
- Spoken words go in double quotes; actions, expressions, and beats go in single-asterisk italics. No text outside those two forms.
${buildStyleBlock(session.narrative_style, session.style_notes)}
${buildLengthDirective(session.message_length)}`;

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemContent },
    ];
    for (const ev of recentChats) {
      if (ev.data?.player_input) messages.push({ role: "user", content: ev.data.player_input });
      if (ev.data?.ai_response)
        messages.push({ role: "assistant", content: ev.data.ai_response });
    }
    messages.push({ role: "user", content: userMessage });

    const genStart = Date.now();
    const reply = await callLLMStream(
      {
        model: modelId,
        messages,
        temperature: 0.75,
        maxTokens: lengthMaxTokens(session.message_length),
      },
      (chunk) => {
        redis.publish(
          channel,
          JSON.stringify({
            type: "side_chat_delta",
            instanceId,
            characterId: idString(card._id),
            delta: chunk,
          }),
        );
      },
    );
    const narrative = reply.trim();
    await redis.expire(lockKey, 240);

    const eventCreatedAt = new Date();
    // No timeAdvancedLabel → the story date is carried unchanged; only the
    // sequence/real-time cursor moves. A side chat is a beat, not a time skip.
    const timeAnchor = await timeService.anchorForNextEvent({
      instanceId,
      templateId: String(session.template_id),
      previous: currentTimeAnchor,
      previousEventId: packet.latestEventId,
      sequence: nextSequence,
      realTime: eventCreatedAt,
      timelineId: session.active_timeline_id || currentTimeAnchor?.timeline_id || null,
    });

    const event = {
      _id: new ObjectId(),
      instance_id: instanceOid,
      player_id: playerOid,
      sequence: nextSequence,
      type: "side_chat",
      side_chat: {
        character_id: card._id,
        character_entity_id: card.entity_id || null,
        character_name: card.canonical_name,
      },
      data: {
        player_input: userMessage,
        ai_response: narrative,
        state_mutations: {},
        flag_mutations: {},
        model_used: modelId,
        tokens_in: countTokens(JSON.stringify(messages)),
        tokens_out: countTokens(narrative),
      },
      is_user_edited: false,
      edit_history: [],
      scene_tag: "side_chat",
      time_anchor: timeAnchor,
      location_anchor: currentLocation,
      created_at: eventCreatedAt,
    };
    await mongoColl.events().insertOne(event as never);

    // Side chats advance the sequence/time cursor but never the scene, world
    // state, flags, or location — the main story is exactly where it was left.
    await mongoColl.worldInstances().updateOne(
      { _id: instanceOid },
      {
        $set: {
          current_time_anchor: timeAnchor,
          "meta.last_active_at": new Date(),
          updated_at: new Date(),
        },
        $inc: {
          "meta.total_events": 1,
          "meta.total_tokens_consumed": event.data.tokens_in + event.data.tokens_out,
        },
      },
    );
    const cachedSession = await redis.get(`session:${instanceId}`);
    if (cachedSession) {
      try {
        const s = JSON.parse(cachedSession);
        s.current_time_anchor = timeAnchor;
        await redis.set(`session:${instanceId}`, JSON.stringify(s), "EX", 3600);
      } catch {
        // Cache refresh is best-effort; the next loadSession rebuilds it.
      }
    }

    // Memory curation is deliberately NOT queued yet: side-chat atoms need
    // who-knows-this scoping (known_by_entity_ids) before they may exist at
    // all — an unscoped atom would leak private conversation into the main
    // narration's retrieval forever. The scoped pipeline is the next slice.

    await redis.del(lockKey);
    await redis.publish(
      channel,
      JSON.stringify({
        type: "side_chat_complete",
        instanceId,
        character: { id: idString(card._id), name: card.canonical_name },
        event: {
          id: idString(event._id),
          sequence: nextSequence,
          player_input: userMessage,
          narrative,
          model_used: modelId,
          created_at: eventCreatedAt.toISOString(),
        },
      }),
    );

    const latencyMs = Date.now() - genStart;
    return { eventId: idString(event._id), sequence: nextSequence, latencyMs };
  } catch (err) {
    await redis.del(lockKey);
    await redis.publish(
      channel,
      JSON.stringify({
        type: "side_chat_error",
        instanceId,
        characterId,
        message: (err as Error).message,
      }),
    );
    throw err;
  }
}
