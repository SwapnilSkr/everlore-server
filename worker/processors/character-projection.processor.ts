import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { parseObjectId, idString } from '../../src/utils/mongo-id'
import { liveInstanceExists } from '../../src/utils/live-instance'
import { instanceService } from '../../src/services/instance.service'
import { characterCodexService } from '../../src/services/character-codex.service'
import { entityGraphService } from '../../src/services/entity-graph.service'
import { extractCharacterCodexDeltas } from '../lib/character-codex-extractor'
import { getRedisClient } from '../../src/config/redis'
import { CharacterProjectionTiming, withCharacterProjection } from '../lib/character-projection-lease'
import { recordAnomaly } from '../../src/utils/record-anomaly'

export { CHARACTER_PROJECTION_MAX_ATTEMPTS } from '../lib/character-projection-lease'

/** Recovery path for a post-stream inline codex projection that did not finish.
 * It claims one event atomically, so retries cannot apply the same deltas twice. */
export async function characterProjectionProcessor(job: Job) {
  const { instanceId, playerId, eventId } = job.data as { instanceId: string; playerId: string; eventId: string }
  const result = await projectCharacterEvent({ instanceId, playerId, eventId })
  // A crash may leave a live lease at the recovery job's first delivery. Retry
  // rather than acknowledging the only durable safety net as successful work.
  if ('skipped' in result && result.skipped === 'claimed_by_active_worker') {
    throw new Error('Character projection still claimed; retry after lease expiry')
  }
  return result
}

/** Recovery and the generation tail share ownership and predecessor ordering. */
export async function projectCharacterEvent(params: {
  instanceId: string
  playerId: string
  eventId: string
}) {
  const { instanceId, playerId, eventId } = params
  const iid = parseObjectId(instanceId)
  const eid = parseObjectId(eventId)
  const timing = new CharacterProjectionTiming()
  if (!(await timing.step('instance_exists_read', () => liveInstanceExists(iid)))) return { skipped: 'instance_deleted' }
  return withCharacterProjection(params, projectCharacterEvent, async (event, assertOwned, timing) => {
    const session = await timing.step('session_read', () => instanceService.loadSession(instanceId, playerId))
    const cards = await timing.step('cards_read', () => mongoColl.characters().find({ instance_id: iid }).toArray())
    const deltas = event.data.codex_deltas ?? await timing.extract((onRaw) => extractCharacterCodexDeltas({
      onRaw,
      sequence: event.sequence,
      playerInput: event.data.player_input,
      aiResponse: event.data.ai_response,
      existing: cards.map((c) => ({
        canonical_name: c.canonical_name, aliases: c.aliases || [], role: c.role,
        identity_kind: c.identity_kind, identity_scope: c.identity_scope,
        last_seen_sequence: c.last_seen_sequence, former_labels: c.former_labels || [],
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
    }))
    if (!session.is_sentient) {
      for (const delta of deltas) if (delta.is_protagonist) delete delta.relationship_deltas
    }
    await assertOwned()
    const codex = !event.data.codex_deltas && deltas.length
      ? await timing.step('apply_deltas', () => characterCodexService.applyDeltas({ instanceId, playerId, sequence: event.sequence, deltas, prose: event.data.ai_response }))
      : cards

    // Ledger the deltas BEFORE the derived graph work. The deltas ARE the story
    // state; the entity graph is an index over it. This used to run last, so a
    // graph failure discarded a perfectly good extraction and left the turn
    // permanently unprojected — the world frozen mid-scene while play continued.
    if (!event.data.codex_deltas) await timing.step('deltas_ledger_write', () => mongoColl.events().updateOne(
      { _id: eid },
      {
        $set: { 'data.codex_deltas': deltas },
      },
    ))

    // Best-effort, matching the inline path: a graph failure is logged and
    // repaired later, never allowed to un-project a completed turn.
    try {
      const entities = await timing.step('entity_graph_sync', () => entityGraphService.syncCodexEntities({ instanceId, playerId, sequence: event.sequence, cards: codex }))
      const touched = codex.filter((c) => c.last_seen_sequence === event.sequence && c.relationship)
      if (touched.length) {
        await timing.step('relationship_sync', () => entityGraphService.syncRelationshipEdges({
          instanceId, playerId, sequence: event.sequence, eventId: event._id,
          cards: touched, entitiesByCardName: entities, playerName: session.persona_snapshot?.name,
        }))
      }
    } catch (err) {
      await timing.step('graph_anomaly_write', () => recordAnomaly({
        instanceId, playerId, eventId: eid, sequence: event.sequence,
        type: 'projection_failed', severity: 'warn',
        details: `entity graph sync (repair path): ${(err as Error).message}`,
      }))
    }
    const lifecycle = event.data.character_lifecycle_deltas
    if (lifecycle?.length) await timing.step('lifecycle_reprojection', () => characterCodexService.applyLifecycleDeltas({ instanceId, deltas: lifecycle }))
    await timing.step('codex_publish', () => getRedisClient().publish(`user:${playerId}:events`, JSON.stringify({
      type: 'character_codex_updated', instanceId,
      focused_character_id: session.focus_character_id || null,
      characters: codex.map((c) => ({ id: idString(c._id), canonical_name: c.canonical_name, aliases: c.aliases, role: c.role, appearance: c.appearance, persona: c.persona, immutable_facts: c.immutable_facts, mutable_state: c.mutable_state, interaction_hints: c.interaction_hints || [], disposition_to_player: c.disposition_to_player, hidden_thought: c.hidden_thought, relationship: c.relationship || null, relationship_state: c.relationship_state || null, mention_count: c.mention_count, is_protagonist: c.is_protagonist === true })),
    })))
    return { projected: true, deltas: deltas.length }
  }, timing)
}
