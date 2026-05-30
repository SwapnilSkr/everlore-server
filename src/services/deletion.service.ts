import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import { deletePineconeNamespace } from './pinecone-cleanup.service'
import { idString, parseObjectId } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'

const worldTemplates = () => mongoColl.worldTemplates()
const worldInstances = () => mongoColl.worldInstances()
const events = () => mongoColl.events()
const memories = () => mongoColl.memories()
const sceneSummaries = () => mongoColl.sceneSummaries()

export const deletionService = {
  /**
   * Deletes a template and ALL associated data:
   * - All instances created from this template
   * - All events from those instances
   * - All memories from those instances (MongoDB + Pinecone vectors)
   * - All scene summaries from those instances
   * - The lore vectors in Pinecone (lore_{templateId})
   * - The template itself
   */
  async deleteTemplate(templateId: string, creatorId: string): Promise<{ deleted: boolean }> {
    const tid = parseObjectId(templateId)
    const cid = parseObjectId(creatorId)
    
    // Verify template exists and belongs to creator
    const template = await worldTemplates().findOne({
      _id: tid,
      creator_id: cid,
    })
    
    if (!template) {
      throw new HttpError(404, 'Template not found or you do not have permission to delete it')
    }
    
    const tidStr = idString(tid)
    const redis = getRedisClient()
    
    // Find all instances created from this template
    const instances = await worldInstances()
      .find({ template_id: tid })
      .project({ _id: 1 })
      .toArray()
    
    const instanceIds = instances.map(i => i._id)
    
    // Delete all associated data for each instance
    for (const instance of instances) {
      const iidStr = idString(instance._id)
      await this.deleteInstanceData(instance._id, iidStr)
    }
    
    // Delete all events for these instances
    if (instanceIds.length > 0) {
      await events().deleteMany({ instance_id: { $in: instanceIds } })
    }
    
    // Delete all memories for these instances
    if (instanceIds.length > 0) {
      await memories().deleteMany({ instance_id: { $in: instanceIds } })
    }
    
    // Delete all scene summaries for these instances
    if (instanceIds.length > 0) {
      await sceneSummaries().deleteMany({ instance_id: { $in: instanceIds } })
    }
    
    // Delete all instances
    await worldInstances().deleteMany({ template_id: tid })
    
    // Delete the lore vectors from Pinecone
    try {
      await deletePineconeNamespace(`lore_${tidStr}`)
    } catch (err) {
      console.warn(`Failed to delete lore vectors for template ${tidStr}:`, (err as Error).message)
      // Continue with deletion even if Pinecone cleanup fails
    }
    
    // Clear any cached sessions for deleted instances
    for (const instance of instances) {
      await redis.del(`session:${idString(instance._id)}`)
    }
    
    // Delete the template
    await worldTemplates().deleteOne({ _id: tid })
    
    return { deleted: true }
  },

  /**
   * Deletes an instance and ALL associated data:
   * - All events
   * - All memories (MongoDB + Pinecone vectors)
   * - All scene summaries
   * - The instance itself
   * - Redis session cache
   */
  async deleteInstance(instanceId: string, playerId: string): Promise<{ deleted: boolean }> {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    
    // Verify instance exists and belongs to player
    const instance = await worldInstances().findOne({
      _id: iid,
      player_id: pid,
    })
    
    if (!instance) {
      throw new HttpError(404, 'Instance not found or you do not have permission to delete it')
    }
    
    const iidStr = idString(iid)
    const redis = getRedisClient()
    
    // Delete all associated data
    await this.deleteInstanceData(iid, iidStr)
    
    // Delete events
    await events().deleteMany({ instance_id: iid })
    
    // Delete memories
    await memories().deleteMany({ instance_id: iid })
    
    // Delete scene summaries
    await sceneSummaries().deleteMany({ instance_id: iid })
    
    // Delete the instance
    await worldInstances().deleteOne({ _id: iid })
    
    // Clear Redis session cache
    await redis.del(`session:${iidStr}`)
    
    return { deleted: true }
  },

  /**
   * Helper method to delete all Pinecone vectors for an instance.
   * This is called internally by both deleteTemplate and deleteInstance.
   */
  async deleteInstanceData(instanceId: ObjectId, instanceIdStr: string): Promise<void> {
    // Delete the memory namespace from Pinecone
    try {
      await deletePineconeNamespace(`mem_${instanceIdStr}`)
    } catch (err) {
      console.warn(`Failed to delete memory vectors for instance ${instanceIdStr}:`, (err as Error).message)
      // Continue with deletion even if Pinecone cleanup fails
    }
  },
}
