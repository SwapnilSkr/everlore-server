import { ObjectId } from 'mongodb'
import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { getRedisClient } from '../../src/config/redis'
import { callLLMStream, AI_MODELS } from '../../src/ai'
import { NSFW_MODE, buildModeDirective, modeReminderLabel } from '../../src/utils/chat-modes'
import {
  buildStyleBlock,
  buildLengthDirective,
  lengthMaxTokens,
  buildStyleReminder,
} from '../../src/utils/narrative-styles'
import {
  buildNarrationToneDirective,
  buildNarrationToneReminder,
  narrationToneLabel,
} from '../../src/utils/narration-tones'
import { countTokens } from '../../src/utils/token-counter'
import { idString, parseObjectId } from '../../src/utils/mongo-id'
import { generationLockKey } from '../../src/utils/generation-lock'
import { classifyScene } from '../lib/nsfw-classifier'
import { timeService } from '../../src/services/time.service'
import { buildSideChatPacket } from '../../src/services/context-packet.service'
import { getMemoryCurationQueue, QUEUE_RETENTION } from '../../src/queues'
import { extractCharacterCodexDeltas } from '../lib/character-codex-extractor'
import { projectSideChatDeltas } from '../lib/side-chat-privacy'
import { resolveSideChatReachability, reachabilityFraming } from '../lib/side-chat-reachability'
import { characterCodexService } from '../../src/services/character-codex.service'
import { entityGraphService } from '../../src/services/entity-graph.service'
import type { CharacterProfileDoc } from '../../src/models/character-profile.model'
import type { WorldEventDoc } from '../../src/models/world-event.model'

/** Conversation continuity window: prior turns with THIS character only. */
const SIDE_CHAT_RECENT_TURNS = 8

function characterSheet(card: CharacterProfileDoc): string {
  const lines: string[] = [`Name: ${card.canonical_name}`]
  if (card.role) lines.push(`Role: ${card.role}`)
  if (card.persona) lines.push(`Persona: ${card.persona}`)
  if (card.appearance) lines.push(`Appearance: ${card.appearance}`)
  if (card.immutable_facts?.length)
    lines.push(`Established facts:\n${card.immutable_facts.map((f) => `- ${f}`).join('\n')}`)
  if (card.mutable_state?.length) lines.push(`Current state:\n${card.mutable_state.map((s) => `- ${s}`).join('\n')}`)
  if (card.disposition_to_player) lines.push(`Disposition toward the player: ${card.disposition_to_player}`)
  if (card.hidden_thought) lines.push(`Private inner thought: ${card.hidden_thought}`)
  if (card.relationship) {
    const r = card.relationship
    lines.push(
      `Relationship meters toward the player (0-100): trust ${r.trust}, affection ${r.affection}, fear ${r.fear}, rivalry ${r.rivalry}`,
    )
  }
  return lines.join('\n')
}

/**
 * One private side-chat turn: the player talks directly WITH one side character,
 * off to the side of the main narration. The turn lands in the SAME event
 * ledger and sequence counter as main turns (rewind/time anchors stay exact)
 * but is excluded from main-narration context, scene summaries, and the Play
 * feed. Story time does not advance — a side chat is a beat, not a day.
 */
export async function sideChatProcessor(job: Job) {
  const { instanceId, playerId, characterId, userMessage, session, userNsfwEnabled } = job.data
  const redis = getRedisClient()
  const channel = `user:${playerId}:events`
  // TTL is kept alive by the worker-level heartbeat; we release on completion below.
  const lockKey = generationLockKey(playerId, instanceId)
  const instanceOid = parseObjectId(instanceId)
  const playerOid = parseObjectId(playerId)

  try {
    const card = (await mongoColl.characters().findOne({
      _id: parseObjectId(characterId),
      instance_id: instanceOid,
    })) as CharacterProfileDoc | null
    if (!card) throw new Error('Character not found')
    // The protagonist IS the main conversation (sentient worlds) or the
    // player's own character (GM worlds) — side chats are for everyone else.
    if (card.is_protagonist) throw new Error('Side chats are for side characters')

    // The packet pins the active side character: their card is the canon
    // sheet, and retrieval is scoped to what THEY can know (shared-history
    // memories + open threads involving them).
    const [packet, recentChats] = await Promise.all([
      buildSideChatPacket({ instanceId, session, card }),
      mongoColl
        .events()
        .find({
          instance_id: instanceOid,
          type: 'side_chat',
          'side_chat.character_id': card._id,
        })
        .sort({ sequence: -1 })
        .limit(SIDE_CHAT_RECENT_TURNS)
        .toArray() as Promise<WorldEventDoc[]>,
    ])
    recentChats.reverse()
    const nextSequence = packet.currentSequence + 1
    const { currentTimeAnchor, timeContext, currentLocation } = packet

    // REACHABILITY (§10): decide HOW this character is reachable from the world
    // state so we (a) hard-block a chat with someone dead/permanently gone and
    // (b) frame the conversation correctly (in person vs. remote vs. distant).
    // Uses the recent MAIN scene (present_characters) + the character's card state.
    const recentMain = (await mongoColl
      .events()
      .find(
        { instance_id: instanceOid, type: { $ne: 'side_chat' } },
        { projection: { sequence: 1, 'data.present_characters': 1 } },
      )
      .sort({ sequence: -1 })
      .limit(6)
      .toArray()) as WorldEventDoc[]
    const latestPresent = recentMain[0]?.data?.present_characters || []
    const recentPresent = recentMain.flatMap((e) => e.data?.present_characters || [])
    const worldText = [session.seed_prompt, session.global_lore].filter(Boolean).join('\n')
    const reachability = resolveSideChatReachability({
      characterNames: [card.canonical_name, ...(card.aliases || [])],
      latestPresent,
      recentPresent,
      cardState: card.mutable_state || [],
      worldText,
      lastSeenSequence: card.last_seen_sequence,
      currentSequence: packet.currentSequence,
    })
    if (!reachability.allowed) {
      // Surfaced to the client as a normal side-chat error with a clear reason
      // (e.g. the character has died) — no turn is generated or persisted.
      throw new Error(reachability.reason || `${card.canonical_name} is not reachable`)
    }
    // The player's own entity (read-only) for the participants list — best-effort.
    const playerEntityDoc = await mongoColl
      .entities()
      .findOne({ instance_id: instanceOid, type: 'player' }, { projection: { _id: 1 } })
    const playerEntityId = playerEntityDoc?._id || null

    // NSFW routing parity with main turns: world capability AND player opt-in.
    let modelId = session.model_preferences?.narration_sfw || AI_MODELS.narrationSfw
    const sceneClassification =
      session.is_nsfw_capable && userNsfwEnabled
        ? session.mode === NSFW_MODE
          ? 'nsfw'
          : classifyScene(userMessage, recentChats)
        : 'sfw'
    if (sceneClassification === 'nsfw') {
      modelId = session.model_preferences?.narration_nsfw || AI_MODELS.narrationNsfw
    }

    const personaName = session.persona_snapshot?.name || 'the player'
    const systemContent = `You are roleplaying as ${card.canonical_name}, one character from an ongoing story, in a PRIVATE one-on-one conversation with ${personaName}. This conversation happens off to the side of the main story narration.

CHARACTER SHEET (canon — never contradict it):
${characterSheet(card)}
${timeContext ? `\n${timeContext}` : ''}${currentLocation ? `\nCurrent place in the story: ${currentLocation.name}.` : ''}
${
  packet.memoryTexts.length
    ? `\nWHAT ${card.canonical_name.toUpperCase()} REMEMBERS (shared history — speak from these naturally, never recite them):\n${packet.memoryTexts.map((t) => `- ${t}`).join('\n')}`
    : ''
}${
      packet.openThreads.length
        ? `\nUNRESOLVED MATTERS involving ${card.canonical_name} (may color their mood; do not force them into the conversation):\n${packet.openThreads.map((t) => `- ${t}`).join('\n')}`
        : ''
    }

REACHABILITY: ${reachabilityFraming(reachability.mode, card.canonical_name, currentLocation?.name) || `${card.canonical_name} is available to talk.`}

RULES:
- Respond ONLY as ${card.canonical_name}: their voice, knowledge, mood, and agenda. Stay true to the disposition and relationship meters above.
- Honor the REACHABILITY note above: never describe ${card.canonical_name} as physically present when they are reached remotely or across a distance.
- ${card.canonical_name} only knows what they have personally witnessed, been told, or could plausibly infer. They are not a narrator and have no out-of-character knowledge.
- Never speak, act, or decide for ${personaName}.
- This is an intimate, conversational register — dialogue first, with brief physical beats. No scene-setting paragraphs, no plot advancement, no new locations or characters.
- Spoken words go in double quotes; actions, expressions, and beats go in single-asterisk italics. No text outside those two forms.
${buildStyleBlock(session.narrative_style, session.style_notes)}
${buildNarrationToneDirective(session.narration_tone, instanceId)}
${buildModeDirective(session.mode)}
${buildLengthDirective(session.message_length)}`

    const messages: Array<{
      role: 'system' | 'user' | 'assistant'
      content: string
    }> = [{ role: 'system', content: systemContent }]
    for (const ev of recentChats) {
      if (ev.data?.player_input) messages.push({ role: 'user', content: ev.data.player_input })
      if (ev.data?.ai_response) messages.push({ role: 'assistant', content: ev.data.ai_response })
    }
    // Unlike main narration, side chat needs a small transcript to preserve
    // conversational continuity. Put the live controls AFTER it so a player
    // change is authoritative over the transcript's earlier prose habits.
    const styleReminder = buildStyleReminder(
      session.narrative_style,
      modeReminderLabel(session.mode),
      session.message_length,
      narrationToneLabel(session.narration_tone),
    )
    messages.push({
      role: 'system',
      content: `ACTIVE WRITING SETTINGS (override the earlier chat transcript's writing habits):
${styleReminder || 'Follow the active voice, tone, mode, and reply length above.'}
${buildNarrationToneReminder(session.narration_tone)}
The earlier private-chat messages are continuity only. Preserve their facts and emotional consequences, but do not imitate their wording, register, pacing, or formatting when it conflicts with the active settings.`,
    })
    messages.push({ role: 'user', content: userMessage })

    const genStart = Date.now()
    const reply = await callLLMStream(
      {
        model: modelId,
        messages,
        temperature: 0.75,
        maxTokens: lengthMaxTokens(session.message_length),
        sessionId: instanceId,
      },
      (chunk) => {
        redis.publish(
          channel,
          JSON.stringify({
            type: 'side_chat_delta',
            instanceId,
            characterId: idString(card._id),
            delta: chunk,
          }),
        )
      },
    )
    const narrative = reply.trim()

    const eventCreatedAt = new Date()
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
    })

    const event = {
      _id: new ObjectId(),
      instance_id: instanceOid,
      player_id: playerOid,
      sequence: nextSequence,
      type: 'side_chat',
      side_chat: {
        character_id: card._id,
        character_entity_id: card.entity_id || null,
        character_name: card.canonical_name,
        mode: reachability.mode,
        // A 1:1 side chat is private — the main narrator did not witness it (the
        // codex/memory privacy gates below depend on this). participants are the
        // entity ids in the room; mainline_effect stays false for an ordinary beat.
        visibility_scope: 'private' as const,
        participants: [...(card.entity_id ? [card.entity_id] : []), ...(playerEntityId ? [playerEntityId] : [])],
        mainline_effect: false,
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
      scene_tag: 'side_chat',
      time_anchor: timeAnchor,
      location_anchor: currentLocation,
      created_at: eventCreatedAt,
    }
    await mongoColl.events().insertOne(event as never)

    // Side chats advance the sequence/time cursor but never the scene, world
    // state, flags, or location — the main story is exactly where it was left.
    await mongoColl.worldInstances().updateOne(
      { _id: instanceOid },
      {
        $set: {
          current_time_anchor: timeAnchor,
          'meta.last_active_at': new Date(),
          updated_at: new Date(),
        },
        $inc: {
          'meta.total_events': 1,
          'meta.total_tokens_consumed': event.data.tokens_in + event.data.tokens_out,
        },
      },
    )
    const cachedSession = await redis.get(`session:${instanceId}`)
    if (cachedSession) {
      try {
        const s = JSON.parse(cachedSession)
        s.current_time_anchor = timeAnchor
        await redis.set(`session:${instanceId}`, JSON.stringify(s), 'EX', 3600)
      } catch {
        // Cache refresh is best-effort; the next loadSession rebuilds it.
      }
    }

    // Relationship updates from the private chat (best-effort, like the main
    // path): extract codex deltas but apply ONLY the active character's — a
    // private conversation may move how THEY feel, never another card. Deltas
    // are ledgered on the event, so rewind replays them exactly; meter edges
    // re-project onto the entity graph.
    ;(async () => {
      try {
        const deltas = await extractCharacterCodexDeltas({
          playerInput: userMessage,
          aiResponse: narrative,
          existing: [
            {
              canonical_name: card.canonical_name,
              aliases: card.aliases || [],
              role: card.role,
              appearance: card.appearance,
              persona: card.persona,
              disposition_to_player: card.disposition_to_player,
              mutable_state: card.mutable_state || [],
              immutable_facts: card.immutable_facts || [],
            },
          ],
          seedPrompt: session.seed_prompt,
          isSentient: session.is_sentient,
          playerPersonaName: session.persona_snapshot?.name,
          presentCast: [card.canonical_name],
        })
        const cardNames = new Set([card.canonical_name, ...(card.aliases || [])].map((n) => n.trim().toLowerCase()))
        // PRIVACY GATE (fail-closed): a side chat is a one-on-one conversation
        // the protagonist/main narrator did NOT witness. Anything the character
        // reveals here (a secret name, a hidden plan, an inner thought) must
        // NEVER bleed into the MAIN narration prompt — the codex card is injected
        // there verbatim with NO known_by gate. projectSideChatDeltas keeps only
        // the meters/disposition (how they FEEL toward the player, which Bonds is
        // meant to evolve from side chats) and strips every narration-visible
        // content field. See worker/lib/side-chat-privacy.ts.
        const ownCardDeltas = deltas.filter((d) =>
          [d.resolved_name, d.name].some((n) => typeof n === 'string' && cardNames.has(n.trim().toLowerCase())),
        )
        const scoped = projectSideChatDeltas(ownCardDeltas)
        if (!scoped.length) return

        const codex = await characterCodexService.applyDeltas({
          instanceId,
          playerId,
          sequence: nextSequence,
          deltas: scoped,
        })
        await mongoColl.events().updateOne({ _id: event._id }, { $set: { 'data.codex_deltas': scoped } })

        const entityMap = await entityGraphService.syncCodexEntities({
          instanceId,
          playerId,
          sequence: nextSequence,
          cards: codex,
        })
        const touched = codex.filter(
          (c) => idString(c._id) === idString(card._id) && c.last_seen_sequence === nextSequence && c.relationship,
        )
        if (touched.length > 0) {
          await entityGraphService.syncRelationshipEdges({
            instanceId,
            playerId,
            sequence: nextSequence,
            eventId: event._id,
            cards: touched,
            entitiesByCardName: entityMap,
            playerName: session.persona_snapshot?.name,
          })
        }

        await redis.publish(
          channel,
          JSON.stringify({
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
              interaction_hints: c.interaction_hints || [],
              disposition_to_player: c.disposition_to_player,
              hidden_thought: c.hidden_thought,
              relationship: c.relationship || null,
              mention_count: c.mention_count,
              is_protagonist: c.is_protagonist === true,
            })),
          }),
        )

        // Tell the Chronicle projection surfaces (Bonds/Threads/Recap/Codex) to
        // refresh: a side chat just mutated relationship meters + codex via
        // applyDeltas/syncRelationshipEdges above, but those surfaces only listen
        // for this frame. Emitted ONCE per side-chat turn, after the mutations
        // land. Same channel/envelope convention as the frames above.
        await redis.publish(
          channel,
          JSON.stringify({
            type: 'world_projection_updated',
            instance_id: instanceId,
            scopes: ['bonds', 'threads', 'recap', 'codex'],
            source: 'side_chat',
          }),
        )
      } catch (err) {
        console.warn('side-chat codex update failed:', (err as Error).message)
      }
    })()

    // Scoped memory curation: atoms from this exchange are minted with
    // origin 'side_chat' + known_by participants, so main narration can
    // never retrieve them unless the protagonist was one of the knowers.
    const memoryCurationQueue = getMemoryCurationQueue()
    await memoryCurationQueue.add(
      'curate',
      {
        instanceId,
        playerId,
        eventId: idString(event._id),
        playerInput: userMessage,
        playerSpokenInput: '',
        playerNarrationFacts: [],
        aiResponse: narrative,
        sceneTag: 'side_chat',
        isSentient: !!session.is_sentient,
        playerPersonaName: session.persona_snapshot?.name || null,
        protagonistName: card.is_protagonist ? card.canonical_name : session.protagonist?.name || null,
        sideChat: {
          characterId: idString(card._id),
          characterName: card.canonical_name,
          characterEntityId: card.entity_id ? idString(card.entity_id) : null,
          isSentient: !!session.is_sentient,
        },
      },
      {
        priority: 5,
        delay: 1000,
        removeOnComplete: QUEUE_RETENTION.memoryCuration.removeOnComplete,
        removeOnFail: QUEUE_RETENTION.memoryCuration.removeOnFail,
      },
    )

    await redis.del(lockKey)
    await redis.publish(
      channel,
      JSON.stringify({
        type: 'side_chat_complete',
        instanceId,
        character: { id: idString(card._id), name: card.canonical_name },
        reachability: { mode: reachability.mode, reason: reachability.reason },
        event: {
          id: idString(event._id),
          sequence: nextSequence,
          player_input: userMessage,
          narrative,
          model_used: modelId,
          created_at: eventCreatedAt.toISOString(),
        },
      }),
    )

    const latencyMs = Date.now() - genStart
    return { eventId: idString(event._id), sequence: nextSequence, latencyMs }
  } catch (err) {
    await redis.del(lockKey)
    await redis.publish(
      channel,
      JSON.stringify({
        type: 'side_chat_error',
        instanceId,
        characterId,
        message: (err as Error).message,
      }),
    )
    throw err
  }
}
