import { randomUUID } from 'crypto'
import { coll } from '../config/mongo'
import { getPineconeIndex } from '../config/pinecone'
import { embed } from '../utils/embedding'
import { idString, parseObjectId } from '../utils/mongo-id'

export const memoryService = {
  async getEvents(instanceId: string, playerId: string, opts: any) {
    const skip = ((opts.page || 1) - 1) * (opts.limit || 50)
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const filter: any = { instance_id: iid, player_id: pid }
    if (opts.type) filter.type = opts.type

    const events = await coll('events')
      .find(filter)
      .sort({ sequence: -1 })
      .skip(skip)
      .limit(opts.limit || 50)
      .toArray()

    const total = await coll('events').countDocuments(filter)
    return { events: events.reverse(), total, page: opts.page || 1 }
  },

  async getMemories(instanceId: string, playerId: string, opts: any) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const filter: any = { instance_id: iid, player_id: pid }
    if (!opts.includeArchived) filter.is_archived = false

    return coll('memories')
      .find(filter)
      .sort({ importance: -1, updated_at: -1 })
      .toArray()
  },

  async editMemory(memoryId: string, playerId: string, updates: any) {
    const mid = parseObjectId(memoryId)
    const pid = parseObjectId(playerId)

    const memory = await coll('memories').findOne({
      _id: mid,
      player_id: pid,
    })
    if (!memory) throw new Error('Memory not found')

    const updateFields: any = { updated_at: new Date() }
    if (updates.text) updateFields.text = updates.text
    if (updates.type) updateFields.type = updates.type
    if (updates.importance !== undefined) updateFields.importance = updates.importance

    await coll('memories').updateOne({ _id: mid }, { $set: updateFields })

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
        await coll('memories').updateOne(
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

    const memory = await coll('memories').findOne({
      _id: mid,
      player_id: pid,
    })
    if (!memory) throw new Error('Memory not found')

    if (memory.pinecone_id) {
      const index = getPineconeIndex()
      const ns = idString(memory.instance_id)
      await index.namespace(`mem_${ns}`).deleteOne(memory.pinecone_id)
    }

    await coll('memories').deleteOne({ _id: mid })
    await coll('world_instances').updateOne(
      { _id: memory.instance_id },
      { $inc: { 'meta.total_memories': -1 } },
    )

    return { success: true }
  },

  async editEvent(eventId: string, playerId: string, updates: any) {
    const eid = parseObjectId(eventId)
    const pid = parseObjectId(playerId)

    const event = await coll('events').findOne({
      _id: eid,
      player_id: pid,
    })
    if (!event) throw new Error('Event not found')

    await coll('events').updateOne(
      { _id: eid },
      {
        $push: {
          edit_history: {
            previous_data: event.data,
            edited_at: new Date(),
          },
        } as any,
        $set: {
          'data.ai_response': updates.ai_response ?? event.data.ai_response,
          'data.player_input': updates.player_input ?? event.data.player_input,
          is_user_edited: true,
          updated_at: new Date(),
        },
      },
    )

    return { success: true }
  },
}
