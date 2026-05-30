import { randomUUID } from 'crypto'
import { mongoColl } from '../config/mongo'
import { getPineconeIndex } from '../config/pinecone'
import { getRedisClient } from '../config/redis'
import { getMemoryCurationQueue } from '../queues'
import { embed } from '../utils/embedding'
import { idString, parseObjectId } from '../utils/mongo-id'
import { applyStateMutations, applyFlagMutations } from '../utils/state-mutator'

const events = () => mongoColl.events()
const memories = () => mongoColl.memories()
const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()
const sceneSummaries = () => mongoColl.sceneSummaries()
const characters = () => mongoColl.characters()

export const memoryService = {
  async getEvents(instanceId: string, playerId: string, opts: any) {
    const skip = ((opts.page || 1) - 1) * (opts.limit || 50)
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const filter: Record<string, unknown> = { instance_id: iid, player_id: pid }
    if (opts.type) filter.type = opts.type

    const evs = await events()
      .find(filter)
      .sort({ sequence: -1 })
      .skip(skip)
      .limit(opts.limit || 50)
      .toArray()

    const total = await events().countDocuments(filter)
    return { events: evs.reverse(), total, page: opts.page || 1 }
  },

  async getMemories(instanceId: string, playerId: string, opts: any) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const filter: Record<string, unknown> = { instance_id: iid, player_id: pid }
    if (!opts.includeArchived) filter.is_archived = false

    return memories()
      .find(filter)
      .sort({ importance: -1, updated_at: -1 })
      .toArray()
  },

  async editMemory(memoryId: string, playerId: string, updates: any) {
    const mid = parseObjectId(memoryId)
    const pid = parseObjectId(playerId)

    const memory = await memories().findOne({
      _id: mid,
      player_id: pid,
    })
    if (!memory) throw new Error('Memory not found')

    const updateFields: Record<string, unknown> = { updated_at: new Date() }
    if (updates.text) updateFields.text = updates.text
    if (updates.type) updateFields.type = updates.type
    if (updates.importance !== undefined) updateFields.importance = updates.importance

    await memories().updateOne({ _id: mid }, { $set: updateFields })

    if (updates.text) {
      const newEmbedding = await embed(updates.text)
      const index = getPineconeIndex()
      const ns = idString(memory.instance_id)
      const namespace = index.namespace(`mem_${ns}`)

      if (memory.pinecone_id) {
        await namespace.upsert({
          records: [{
            id: memory.pinecone_id,
            values: newEmbedding,
            metadata: {
              text: updates.text,
              type: updates.type || memory.type,
              importance: updates.importance ?? memory.importance,
              is_nsfw: memory.is_nsfw,
              mongo_id: idString(mid),
              created_at: memory.created_at.toISOString(),
            },
          }],
        })
      } else {
        const newVecId = randomUUID()
        await namespace.upsert({
          records: [{
            id: newVecId,
            values: newEmbedding,
            metadata: {
              text: updates.text,
              type: updates.type || memory.type,
              importance: updates.importance ?? memory.importance,
              is_nsfw: memory.is_nsfw,
              mongo_id: idString(mid),
              created_at: memory.created_at.toISOString(),
            },
          }],
        })
        await memories().updateOne(
          { _id: mid },
          { $set: { pinecone_id: newVecId, is_archived: false } },
        )
      }
    }

    return { success: true }
  },

  async deleteMemory(memoryId: string, playerId: string) {
    const mid = parseObjectId(memoryId)
    const pid = parseObjectId(playerId)

    const memory = await memories().findOne({
      _id: mid,
      player_id: pid,
    })
    if (!memory) throw new Error('Memory not found')

    if (memory.pinecone_id) {
      const index = getPineconeIndex()
      const ns = idString(memory.instance_id)
      await index.namespace(`mem_${ns}`).deleteOne({ id: memory.pinecone_id })
    }

    await memories().deleteOne({ _id: mid })
    await worldInstances().updateOne(
      { _id: memory.instance_id },
      { $inc: { 'meta.total_memories': -1 } },
    )

    return { success: true }
  },

  /**
   * Rewind a playthrough to a chosen turn: removes the event at [sequence] and
   * every event after it, then rolls everything back to that point —
   *  - deletes memories sourced from the removed turns (+ their Pinecone vectors,
   *    so they can't resurface via RAG),
   *  - deletes scene summaries covering the removed range,
   *  - recomputes world_state / active_flags by replaying the surviving turns
   *    from the template defaults (stats are stored as deltas, not snapshots),
   *  - recomputes the current scene + meta counts,
   *  - busts the cached session so the next turn rebuilds from fresh state.
   */
  async rewindToSequence(instanceId: string, playerId: string, sequence: number) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)

    const instance = await worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new Error('Instance not found')

    const template = await worldTemplates().findOne({ _id: instance.template_id })
    if (!template) throw new Error('Template not found')

    // Events being removed: the chosen turn and everything after it.
    const doomed = await events()
      .find({ instance_id: iid, sequence: { $gte: sequence } }, { projection: { _id: 1 } })
      .toArray()
    const doomedIds = doomed.map((e) => e._id)

    // 1. Memories sourced from removed turns → delete docs + Pinecone vectors.
    let deletedMemories = 0
    if (doomedIds.length > 0) {
      const mems = await memories()
        .find({ instance_id: iid, source_event_ids: { $in: doomedIds } })
        .toArray()
      if (mems.length > 0) {
        const ns = getPineconeIndex().namespace(`mem_${instanceId}`)
        for (const m of mems) {
          if (!m.pinecone_id) continue
          try {
            await ns.deleteOne({ id: m.pinecone_id })
          } catch (err) {
            console.warn('Rewind: failed to delete vector', m.pinecone_id, (err as Error).message)
          }
        }
        await memories().deleteMany({ _id: { $in: mems.map((m) => m._id) } })
        deletedMemories = mems.length
      }
    }

    // 2. Scene summaries covering the removed range.
    await sceneSummaries().deleteMany({
      instance_id: iid,
      'event_range.end_sequence': { $gte: sequence },
    })

    // 3. The events themselves.
    await events().deleteMany({ instance_id: iid, sequence: { $gte: sequence } })

    // 3b. Character codex may contain facts from removed turns; reset it so
    // canon is rebuilt from future play instead of keeping contradictions.
    await characters().deleteMany({ instance_id: iid })

    // 4. Replay survivors from template defaults to rebuild state.
    const statLimits: Record<string, { min: number; max: number }> = {}
    let worldState: Record<string, number> = {}
    for (const [key, def] of Object.entries(template.base_stats_template)) {
      worldState[key] = def.default
      statLimits[key] = { min: def.min, max: def.max }
    }
    let activeFlags: Record<string, unknown> = {}
    for (const [key, def] of Object.entries(template.flag_definitions || {})) {
      activeFlags[key] = def.default
    }

    const survivors = await events().find({ instance_id: iid }).sort({ sequence: 1 }).toArray()
    for (const ev of survivors) {
      worldState = applyStateMutations(worldState, ev.data?.state_mutations || {}, statLimits)
      activeFlags = applyFlagMutations(activeFlags, ev.data?.flag_mutations || {})
    }

    // 5. Current scene from the tail of survivors.
    const last = survivors[survivors.length - 1]
    const sceneTag = last?.scene_tag || 'dialogue'
    let turnCount = 0
    for (let i = survivors.length - 1; i >= 0; i--) {
      if (survivors[i].scene_tag === sceneTag) turnCount++
      else break
    }

    // 6. Persist rolled-back instance state.
    await worldInstances().updateOne(
      { _id: iid },
      {
        $set: {
          world_state: worldState,
          active_flags: activeFlags,
          current_scene: { tag: sceneTag, turn_count: turnCount, summary_pending: false },
          focus_character_id: null,
          'meta.total_events': survivors.length,
          'meta.total_memories': Math.max(0, (instance.meta?.total_memories || 0) - deletedMemories),
          updated_at: new Date(),
        },
      },
    )

    // 7. Drop the cached session so the next generation uses fresh state.
    await getRedisClient().del(`session:${instanceId}`)

    return { success: true, deletedEvents: doomedIds.length, deletedMemories }
  },

  async editEvent(eventId: string, playerId: string, updates: any) {
    const eid = parseObjectId(eventId)
    const pid = parseObjectId(playerId)

    const event = await events().findOne({
      _id: eid,
      player_id: pid,
    })
    if (!event) throw new Error('Event not found')

    const nextAiResponse = updates.ai_response ?? event.data.ai_response
    const nextPlayerInput = updates.player_input ?? event.data.player_input
    const aiChanged =
      typeof updates.ai_response === 'string' &&
      updates.ai_response !== event.data.ai_response
    const playerChanged =
      typeof updates.player_input === 'string' &&
      updates.player_input !== event.data.player_input
    const contentChanged = aiChanged || playerChanged

    await events().updateOne(
      { _id: eid },
      {
        $push: {
          edit_history: {
            previous_data: event.data,
            edited_at: new Date(),
          },
        },
        $set: {
          'data.ai_response': nextAiResponse,
          'data.player_input': nextPlayerInput,
          is_user_edited: true,
          updated_at: new Date(),
        },
      } as import('mongodb').UpdateFilter<import('../models/world-event.model').WorldEventDoc>,
    )

    let deletedMemories = 0

    if (contentChanged) {
      // Memories derived from this event become stale after edits. Remove both
      // Mongo docs and Pinecone vectors, then re-run curation on the edited text.
      const staleMemories = await memories()
        .find({ instance_id: event.instance_id, source_event_ids: eid })
        .toArray()

      if (staleMemories.length > 0) {
        const ns = getPineconeIndex().namespace(`mem_${idString(event.instance_id)}`)
        for (const m of staleMemories) {
          if (!m.pinecone_id) continue
          try {
            await ns.deleteOne({ id: m.pinecone_id })
          } catch (err) {
            console.warn('Edit event: failed to delete vector', m.pinecone_id, (err as Error).message)
          }
        }

        await memories().deleteMany({ _id: { $in: staleMemories.map((m) => m._id) } })
        deletedMemories = staleMemories.length
        await worldInstances().updateOne(
          { _id: event.instance_id },
          { $inc: { 'meta.total_memories': -deletedMemories } },
        )
      }

      const memoryCurationQueue = getMemoryCurationQueue()
      await memoryCurationQueue.add(
        'curate',
        {
          instanceId: idString(event.instance_id),
          playerId,
          eventId: idString(event._id),
          playerInput: nextPlayerInput || '',
          aiResponse: nextAiResponse || '',
          sceneTag: event.scene_tag || 'dialogue',
        },
        { priority: 5, delay: 500 },
      )
    }

    return {
      success: true,
      memories_deleted: deletedMemories,
      recuration_queued: contentChanged,
    }
  },
}
