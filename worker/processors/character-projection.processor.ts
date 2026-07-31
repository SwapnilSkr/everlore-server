import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { parseObjectId, idString } from '../../src/utils/mongo-id'
import { instanceService } from '../../src/services/instance.service'
import { characterCodexService } from '../../src/services/character-codex.service'
import { entityGraphService } from '../../src/services/entity-graph.service'
import { extractCharacterCodexDeltas } from '../lib/character-codex-extractor'
import { getRedisClient } from '../../src/config/redis'

/** Recovery path for a post-stream inline codex projection that did not finish.
 * It claims one event atomically, so retries cannot apply the same deltas twice. */
export async function characterProjectionProcessor(job: Job) {
  const { instanceId, playerId, eventId } = job.data as { instanceId: string; playerId: string; eventId: string }
  const iid = parseObjectId(instanceId)
  const eid = parseObjectId(eventId)
  const event = await mongoColl.events().findOne({ _id: eid, instance_id: iid })
  if (!event) return { skipped: 'event_missing' }
  if (event.data.codex_deltas) return { skipped: 'already_projected' }

  const staleBefore = new Date(Date.now() - 60_000)
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
  if (claim.modifiedCount !== 1) throw new Error('Character projection is still owned by another worker')

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
    const entities = await entityGraphService.syncCodexEntities({ instanceId, playerId, sequence: event.sequence, cards: codex })
    const touched = codex.filter((c) => c.last_seen_sequence === event.sequence && c.relationship)
    if (touched.length) {
      await entityGraphService.syncRelationshipEdges({
        instanceId, playerId, sequence: event.sequence, eventId: event._id,
        cards: touched, entitiesByCardName: entities, playerName: session.persona_snapshot?.name,
      })
    }
    await mongoColl.events().updateOne(
      { _id: eid },
      {
        $set: { 'data.codex_deltas': deltas, 'data.codex_projection_status': 'completed', 'data.codex_projection_completed_at': new Date() },
        $unset: { 'data.codex_projection_claimed_at': '', 'data.codex_projection_error': '' },
      },
    )
    await getRedisClient().publish(`user:${playerId}:events`, JSON.stringify({
      type: 'character_codex_updated', instanceId,
      focused_character_id: session.focus_character_id || null,
      characters: codex.map((c) => ({ id: idString(c._id), canonical_name: c.canonical_name, aliases: c.aliases, role: c.role, appearance: c.appearance, persona: c.persona, immutable_facts: c.immutable_facts, mutable_state: c.mutable_state, interaction_hints: c.interaction_hints || [], disposition_to_player: c.disposition_to_player, hidden_thought: c.hidden_thought, relationship: c.relationship || null, relationship_state: c.relationship_state || null, mention_count: c.mention_count, is_protagonist: c.is_protagonist === true })),
    }))
    return { projected: true, deltas: deltas.length }
  } catch (err) {
    await mongoColl.events().updateOne(
      { _id: eid },
      { $set: { 'data.codex_projection_status': 'pending', 'data.codex_projection_error': (err as Error).message }, $unset: { 'data.codex_projection_claimed_at': '' } },
    )
    throw err
  }
}
