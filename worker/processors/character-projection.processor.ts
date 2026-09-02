import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { parseObjectId, idString } from '../../src/utils/mongo-id'
import { instanceService } from '../../src/services/instance.service'
import { characterCodexService } from '../../src/services/character-codex.service'
import { entityGraphService } from '../../src/services/entity-graph.service'
import { extractCharacterCodexDeltas } from '../lib/character-codex-extractor'
import { getRedisClient } from '../../src/config/redis'
import { CHARACTER_PROJECTION_CLAIM_LEASE_MS } from '../lib/character-projection-lease'
import { recordAnomaly } from '../../src/utils/record-anomaly'

/** Retries before an event's projection is declared poisoned. A deterministic
 *  failure (duplicate key, malformed row) never heals, so retrying past this is
 *  pure noise that hides the real defect. */
export const CHARACTER_PROJECTION_MAX_ATTEMPTS = 4

/** Recovery path for a post-stream inline codex projection that did not finish.
 * It claims one event atomically, so retries cannot apply the same deltas twice. */
export async function characterProjectionProcessor(job: Job) {
  const { instanceId, playerId, eventId } = job.data as { instanceId: string; playerId: string; eventId: string }
  return projectCharacterEvent({ instanceId, playerId, eventId })
}

/** The recovery pass itself, callable outside the queue so the generation fence
 *  can repair the previous turn synchronously before reading its state. */
export async function projectCharacterEvent(params: {
  instanceId: string
  playerId: string
  eventId: string
}) {
  const { instanceId, playerId, eventId } = params
  const iid = parseObjectId(instanceId)
  const eid = parseObjectId(eventId)
  const event = await mongoColl.events().findOne({ _id: eid, instance_id: iid })
  if (!event) return { skipped: 'event_missing' }
  if (event.data.codex_deltas) return { skipped: 'already_projected' }

  const staleBefore = new Date(Date.now() - CHARACTER_PROJECTION_CLAIM_LEASE_MS)
  const claim = await mongoColl.events().updateOne(
    {
      _id: eid,
      'data.codex_deltas': { $exists: false },
      $or: [
        { 'data.codex_projection_claimed_at': { $exists: false } },
        { 'data.codex_projection_claimed_at': { $lt: staleBefore } },
      ],
    },
    { $set: { 'data.codex_projection_claimed_at': new Date(), 'data.codex_projection_status': 'processing' } },
  )
  if (claim.modifiedCount !== 1) {
    // A normal projection may still be applying this event. Lock contention is
    // expected here, not a failed post-processing attempt. A stale claim stays
    // eligible for the next repair sweep; an already-completed event is simply
    // idempotent work.
    const latest = await mongoColl.events().findOne(
      { _id: eid },
      { projection: { 'data.codex_deltas': 1, 'data.codex_projection_status': 1, 'data.codex_projection_claimed_at': 1 } },
    )
    if (latest?.data.codex_deltas || latest?.data.codex_projection_status === 'completed') {
      return { skipped: 'already_projected' }
    }
    const claimedAt = latest?.data.codex_projection_claimed_at
    if (claimedAt && new Date(claimedAt).getTime() >= staleBefore.getTime()) {
      return { skipped: 'claimed_by_active_worker' }
    }
    throw new Error('Unable to claim character projection for recovery')
  }

  try {
    const session = await instanceService.loadSession(instanceId, playerId)
    const cards = await mongoColl.characters().find({ instance_id: iid }).toArray()
    const deltas = await extractCharacterCodexDeltas({
      playerInput: event.data.player_input,
      aiResponse: event.data.ai_response,
      existing: cards.map((c) => ({
        canonical_name: c.canonical_name, aliases: c.aliases || [], role: c.role,
        appearance: c.appearance, persona: c.persona,
        disposition_to_player: c.disposition_to_player, relationship: c.relationship,
        relationship_moments: c.relationship_moments || [], relationship_state: c.relationship_state,
        relationship_facts: c.relationship_facts || [], mutable_state: c.mutable_state || [],
        immutable_facts: c.immutable_facts || [],
      })),
      seedPrompt: session.seed_prompt,
      isSentient: session.is_sentient,
      protagonistName: cards.find((c) => c.is_protagonist)?.canonical_name || session.protagonist?.name,
      playerPersonaName: session.persona_snapshot?.name,
      presentCast: event.data.present_characters || [],
    })
    if (!session.is_sentient) {
      for (const delta of deltas) if (delta.is_protagonist) delete delta.relationship_deltas
    }
    const codex = deltas.length
      ? await characterCodexService.applyDeltas({ instanceId, playerId, sequence: event.sequence, deltas })
      : cards

    // Ledger the deltas BEFORE the derived graph work. The deltas ARE the story
    // state; the entity graph is an index over it. This used to run last, so a
    // graph failure discarded a perfectly good extraction and left the turn
    // permanently unprojected — the world frozen mid-scene while play continued.
    await mongoColl.events().updateOne(
      { _id: eid },
      {
        $set: { 'data.codex_deltas': deltas, 'data.codex_projection_status': 'completed', 'data.codex_projection_completed_at': new Date() },
        $unset: { 'data.codex_projection_claimed_at': '', 'data.codex_projection_error': '', 'data.codex_projection_attempts': '' },
      },
    )

    // Best-effort, matching the inline path: a graph failure is logged and
    // repaired later, never allowed to un-project a completed turn.
    try {
      const entities = await entityGraphService.syncCodexEntities({ instanceId, playerId, sequence: event.sequence, cards: codex })
      const touched = codex.filter((c) => c.last_seen_sequence === event.sequence && c.relationship)
      if (touched.length) {
        await entityGraphService.syncRelationshipEdges({
          instanceId, playerId, sequence: event.sequence, eventId: event._id,
          cards: touched, entitiesByCardName: entities, playerName: session.persona_snapshot?.name,
        })
      }
    } catch (err) {
      await recordAnomaly({
        instanceId, playerId, eventId: eid, sequence: event.sequence,
        type: 'projection_failed', severity: 'warn',
        details: `entity graph sync (repair path): ${(err as Error).message}`,
      })
    }
    await getRedisClient().publish(`user:${playerId}:events`, JSON.stringify({
      type: 'character_codex_updated', instanceId,
      focused_character_id: session.focus_character_id || null,
      characters: codex.map((c) => ({ id: idString(c._id), canonical_name: c.canonical_name, aliases: c.aliases, role: c.role, appearance: c.appearance, persona: c.persona, immutable_facts: c.immutable_facts, mutable_state: c.mutable_state, interaction_hints: c.interaction_hints || [], disposition_to_player: c.disposition_to_player, hidden_thought: c.hidden_thought, relationship: c.relationship || null, relationship_state: c.relationship_state || null, mention_count: c.mention_count, is_protagonist: c.is_protagonist === true })),
    }))
    return { projected: true, deltas: deltas.length }
  } catch (err) {
    // Poison pill. A collision or malformed row fails IDENTICALLY on every
    // retry, so an unbounded 'pending' means the sweeper re-queues the same
    // doomed job forever while the turn stays unprojected and silent. After a
    // bounded number of attempts the event is marked 'failed' — the sweeper
    // skips it, and it becomes a visible thing to repair rather than a loop.
    const attempts = (Number(event.data.codex_projection_attempts) || 0) + 1
    const poisoned = attempts >= CHARACTER_PROJECTION_MAX_ATTEMPTS
    await mongoColl.events().updateOne(
      { _id: eid },
      {
        $set: {
          'data.codex_projection_status': poisoned ? 'failed' : 'pending',
          'data.codex_projection_error': (err as Error).message,
          'data.codex_projection_attempts': attempts,
        },
        $unset: { 'data.codex_projection_claimed_at': '' },
      },
    )
    await recordAnomaly({
      instanceId, playerId, eventId: eid, sequence: event.sequence,
      type: 'projection_failed',
      severity: poisoned ? 'error' : 'warn',
      details: `${poisoned ? 'POISONED' : 'attempt'} ${attempts}/${CHARACTER_PROJECTION_MAX_ATTEMPTS}: ${(err as Error).message}`,
    })
    throw err
  }
}
