import { coll } from '../config/mongo'
import { getPineconeIndex } from '../config/pinecone'
import { embed } from '../utils/embedding'
import { generateId } from '../utils/id'

export const memoryService = {
  async getEvents(instanceId: string, playerId: string, opts: any) {
    const skip = ((opts.page || 1) - 1) * (opts.limit || 50)
    const filter: any = { instance_id: instanceId, player_id: playerId }
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
    const filter: any = { instance_id: instanceId, player_id: playerId }
    if (!opts.includeArchived) filter.is_archived = false

    return coll('memories')
      .find(filter)
      .sort({ importance: -1, updated_at: -1 })
      .toArray()
  },

  async editMemory(memoryId: string, playerId: string, updates: any) {
    const memory = await coll('memories').findOne({
      _id: memoryId,
      player_id: playerId,
    })
    if (!memory) throw new Error('Memory not found')

    const updateFields: any = { updated_at: new Date() }
    if (updates.text) updateFields.text = updates.text
    if (updates.type) updateFields.type = updates.type
    if (updates.importance !== undefined) updateFields.importance = updates.importance

    await coll('memories').updateOne({ _id: memoryId }, { $set: updateFields })

    // Re-embed if text changed
    if (updates.text) {
      const newEmbedding = await embed(updates.text)
      const index = getPineconeIndex()
      const namespace = index.namespace(`mem_${memory.instance_id}`)

      if (memory.pinecone_id) {
        // Update existing vector
        await namespace.upsert({
          records: [{
            id: memory.pinecone_id,
            values: newEmbedding,
            metadata: {
              text: updates.text,
              type: updates.type || memory.type,
              importance: updates.importance ?? memory.importance,
              is_nsfw: memory.is_nsfw,
              mongo_id: memoryId,
              created_at: memory.created_at.toISOString(),
            },
          }],
        })
      } else {
        // Re-embed archived memory
        const newVecId = generateId('vec')
        await namespace.upsert({
          records: [{
            id: newVecId,
            values: newEmbedding,
            metadata: {
              text: updates.text,
              type: updates.type || memory.type,
              importance: updates.importance ?? memory.importance,
              is_nsfw: memory.is_nsfw,
              mongo_id: memoryId,
              created_at: memory.created_at.toISOString(),
            },
          }],
        })
        await coll('memories').updateOne(
          { _id: memoryId },
          { $set: { pinecone_id: newVecId, is_archived: false } },
        )
      }
    }

    return { success: true }
  },

  async deleteMemory(memoryId: string, playerId: string) {
    const memory = await coll('memories').findOne({
      _id: memoryId,
      player_id: playerId,
    })
    if (!memory) throw new Error('Memory not found')

    if (memory.pinecone_id) {
      const index = getPineconeIndex()
      await index.namespace(`mem_${memory.instance_id}`).deleteOne(memory.pinecone_id)
    }

    await coll('memories').deleteOne({ _id: memoryId })
    await coll('world_instances').updateOne(
      { _id: memory.instance_id },
      { $inc: { 'meta.total_memories': -1 } },
    )

    return { success: true }
  },

  async editEvent(eventId: string, playerId: string, updates: any) {
    const event = await coll('events').findOne({
      _id: eventId,
      player_id: playerId,
    })
    if (!event) throw new Error('Event not found')

    await coll('events').updateOne(
      { _id: eventId },
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
