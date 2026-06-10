import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import { deletePineconeNamespace } from './pinecone-cleanup.service'
import { characterCodexService } from './character-codex.service'
import { isDefaultCoverUrl } from '../constants/default-cover'
import { storageService } from './storage.service'
import { timeService } from './time.service'
import { idString, parseObjectId } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'
import type { WorldEventDoc } from '../models/world-event.model'

const users = () => mongoColl.users()
const worldTemplates = () => mongoColl.worldTemplates()
const worldInstances = () => mongoColl.worldInstances()
const events = () => mongoColl.events()
const memories = () => mongoColl.memories()
const sceneSummaries = () => mongoColl.sceneSummaries()
const characters = () => mongoColl.characters()
const deadLetterJobs = () => mongoColl.deadLetterJobs()

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

    return this.deleteTemplateById(tid)
  },

  /**
   * Admin/internal template purge. Deletes the template itself plus every
   * playthrough and derivative artifact created from it, regardless of owner.
   */
  async deleteTemplateById(templateId: string | ObjectId): Promise<{ deleted: boolean }> {
    const tid = typeof templateId === 'string' ? parseObjectId(templateId) : templateId
    const template = await worldTemplates().findOne({ _id: tid })
    if (!template) throw new HttpError(404, 'Template not found')

    const tidStr = idString(tid)
    const redis = getRedisClient()

    // Find all instances created from this template
    const instances = await worldInstances()
      .find({ template_id: tid }, { projection: { _id: 1, player_id: 1 } })
      .toArray()

    const instanceIds = instances.map(i => i._id)

    // Delete all associated Pinecone namespaces and volatile Redis state.
    for (const instance of instances) {
      const iidStr = idString(instance._id)
      await this.deleteInstanceData(instance._id, iidStr)
      await redis.del(`session:${iidStr}`)
      await redis.del(`lock:gen:${idString(instance.player_id)}:${iidStr}`)
      await deadLetterJobs().deleteMany({
        $or: [
          { 'data.instanceId': iidStr },
          { 'data.instance_id': iidStr },
          { 'data.templateId': tidStr },
          { 'data.template_id': tidStr },
        ],
      })
    }

    // Delete all events for these instances
    if (instanceIds.length > 0) {
      await events().deleteMany({ instance_id: { $in: instanceIds } })
    }
    
    // Delete all memories for these instances
    if (instanceIds.length > 0) {
      await memories().deleteMany({ instance_id: { $in: instanceIds } })
    }
    
    // Delete all scene + chapter summaries for these instances
    if (instanceIds.length > 0) {
      await sceneSummaries().deleteMany({ instance_id: { $in: instanceIds } })
      await mongoColl.chapterSummaries().deleteMany({ instance_id: { $in: instanceIds } })
    }

    // Delete all character codex entries for these instances
    if (instanceIds.length > 0) {
      await characters().deleteMany({ instance_id: { $in: instanceIds } })
    }

    if (instanceIds.length > 0) {
      await mongoColl.storyCalendars().deleteMany({ instance_id: { $in: instanceIds } })
      await mongoColl.timelineBranches().deleteMany({ instance_id: { $in: instanceIds } })
    }

    // Delete observability logs for these instances
    if (instanceIds.length > 0) {
      await mongoColl.generationLogs().deleteMany({ instance_id: { $in: instanceIds } })
    }

    await deadLetterJobs().deleteMany({
      $or: [
        { 'data.templateId': tidStr },
        { 'data.template_id': tidStr },
      ],
    })

    // Delete all instances
    await worldInstances().deleteMany({ template_id: tid })

    // Delete the lore vectors from Pinecone
    try {
      await deletePineconeNamespace(`lore_${tidStr}`)
    } catch (err) {
      console.warn(`Failed to delete lore vectors for template ${tidStr}:`, (err as Error).message)
      // Continue with deletion even if Pinecone cleanup fails
    }

    // Delete generated template image from S3 when it is one of our CDN assets.
    // Never delete the shared default cover — many templates may reference it.
    if (template.image_url && !isDefaultCoverUrl(template.image_url)) {
      const key = storageService.keyFromUrl(template.image_url)
      if (key) await storageService.delete(key)
    }

    // Delete the template
    await worldTemplates().deleteOne({ _id: tid })

    return { deleted: true }
  },

  /**
   * Resets an instance to its just-created state WITHOUT deleting the instance:
   * a full-history rewind. Wipes all play data (events, memories + Pinecone
   * vectors, scene summaries, emergent character codex, observability logs),
   * restores world state/flags/scene to template defaults, then re-seeds the
   * protagonist card (sentient worlds) and the opening-line event so the chat
   * reopens exactly as it did on day one.
   */
  async resetInstance(instanceId: string, playerId: string): Promise<{ reset: boolean }> {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const iidStr = idString(iid)

    const instance = await worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) {
      throw new HttpError(404, 'Instance not found or you do not have permission to reset it')
    }
    const template = await worldTemplates().findOne({ _id: instance.template_id })
    if (!template) throw new HttpError(404, 'Template not found')

    // Preserve the player's authored/onboarded identity across a full reset:
    // the protagonist is who you ARE, not emergent story canon, so a reset
    // should replay the same character rather than orphan them. Captured before
    // the codex is purged; re-seeded in step 3.
    const priorProtagonist = await characters().findOne({ instance_id: iid, is_protagonist: true })

    // 1. Purge all play data (mirrors deleteInstance, minus the instance doc).
    await this.deleteInstanceData(iid, iidStr) // Pinecone mem_ namespace
    await events().deleteMany({ instance_id: iid })
    await memories().deleteMany({ instance_id: iid })
    await sceneSummaries().deleteMany({ instance_id: iid })
    await mongoColl.chapterSummaries().deleteMany({ instance_id: iid })
    await characters().deleteMany({ instance_id: iid })
    await mongoColl.storyCalendars().deleteMany({ instance_id: iid })
    await mongoColl.timelineBranches().deleteMany({ instance_id: iid })
    await mongoColl.generationLogs().deleteMany({ instance_id: iid })

    // 2. Restore world state / flags / scene from template defaults.
    const worldState: Record<string, number> = {}
    for (const [key, def] of Object.entries(template.base_stats_template || {})) {
      worldState[key] = (def as { default: number }).default
    }
    const activeFlags: Record<string, unknown> = {}
    for (const [key, def] of Object.entries(template.flag_definitions || {})) {
      activeFlags[key] = (def as { default: unknown }).default
    }
    const initialTimeAnchor = await timeService.initialAnchor({
      instanceId: iidStr,
      templateId: idString(template._id),
      sequence: 0,
    })
    await worldInstances().updateOne(
      { _id: iid },
      {
        $set: {
          world_state: worldState,
          active_flags: activeFlags,
          current_scene: { tag: 'dialogue', turn_count: 0, summary_pending: false },
          focus_character_id: null,
          current_location: null,
          current_time_anchor: initialTimeAnchor,
          active_timeline_id: initialTimeAnchor.timeline_id,
          default_calendar_id: initialTimeAnchor.story_calendar?.calendar_id,
          'meta.total_events': 0,
          'meta.total_memories': 0,
          'meta.total_tokens_consumed': 0,
          'meta.last_active_at': new Date(),
          updated_at: new Date(),
        },
      },
    )

    // 3. Re-seed the protagonist so the chat reopens anchored to the player's
    // character — present from turn 0. Sentient worlds restore from the
    // authoritative template persona; GM worlds restore the player's own
    // onboarded character (name/persona/appearance/aliases) so a reset never
    // orphans them and re-opens identity drift. A GM world that never finished
    // onboarding has no prior card — the player simply re-onboards.
    if (template.is_sentient && template.protagonist?.name) {
      await characterCodexService.seedProtagonist({
        instanceId: iidStr,
        playerId,
        name: template.protagonist.name,
        persona: template.protagonist.persona,
        appearance: template.protagonist.appearance,
        isPlayer: false,
      })
    } else if (!template.is_sentient && priorProtagonist?.canonical_name) {
      await characterCodexService.seedProtagonist({
        instanceId: iidStr,
        playerId,
        name: priorProtagonist.canonical_name,
        persona: priorProtagonist.persona,
        appearance: priorProtagonist.appearance,
        aliases: priorProtagonist.aliases || [],
        isPlayer: true,
      })
    }

    // 4. Re-seed the opening line so the chat reopens with the greeting.
    if (template.opening_line && template.opening_line.trim().length > 0) {
      const openingTimeAnchor = await timeService.anchorForNextEvent({
        instanceId: iidStr,
        templateId: idString(template._id),
        previous: initialTimeAnchor,
        sequence: 1,
        eventTimeLabel: 'Opening scene',
      })
      await events().insertOne({
        _id: new ObjectId(),
        instance_id: iid,
        player_id: pid,
        sequence: 1,
        type: 'narration',
        data: {
          player_input: '',
          ai_response: template.opening_line.trim(),
          state_mutations: {},
          flag_mutations: {},
          model_used: 'seed',
          tokens_in: 0,
          tokens_out: 0,
        },
        is_user_edited: false,
        edit_history: [],
        scene_tag: 'dialogue',
        time_anchor: openingTimeAnchor,
        created_at: new Date(),
      } as unknown as WorldEventDoc)
      await worldInstances().updateOne(
        { _id: iid },
        {
          $set: {
            current_time_anchor: openingTimeAnchor,
            active_timeline_id: openingTimeAnchor.timeline_id,
            default_calendar_id: openingTimeAnchor.story_calendar?.calendar_id,
            current_location: null,
            'meta.total_events': 1,
          },
        },
      )
    }

    // 5. Drop the cached session so the next turn rebuilds from fresh state.
    await getRedisClient().del(`session:${iidStr}`)

    return { reset: true }
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

    return this.deleteInstanceById(iid)
  },

  /** Admin/internal instance purge without owner checks. */
  async deleteInstanceById(instanceId: string | ObjectId): Promise<{ deleted: boolean }> {
    const iid = typeof instanceId === 'string' ? parseObjectId(instanceId) : instanceId
    const instance = await worldInstances().findOne({ _id: iid })
    if (!instance) throw new HttpError(404, 'Instance not found')

    const iidStr = idString(iid)
    const redis = getRedisClient()

    // Delete all associated data
    await this.deleteInstanceData(iid, iidStr)

    // Delete events
    await events().deleteMany({ instance_id: iid })

    // Delete memories
    await memories().deleteMany({ instance_id: iid })

    // Delete scene + chapter summaries
    await sceneSummaries().deleteMany({ instance_id: iid })
    await mongoColl.chapterSummaries().deleteMany({ instance_id: iid })

    // Delete character codex entries
    await characters().deleteMany({ instance_id: iid })

    await mongoColl.storyCalendars().deleteMany({ instance_id: iid })
    await mongoColl.timelineBranches().deleteMany({ instance_id: iid })

    // Delete observability logs for this instance
    await mongoColl.generationLogs().deleteMany({ instance_id: iid })

    // Delete the instance
    await worldInstances().deleteOne({ _id: iid })

    // Clear Redis session cache
    await redis.del(`session:${iidStr}`)
    await redis.del(`lock:gen:${idString(instance.player_id)}:${iidStr}`)
    await deadLetterJobs().deleteMany({
      $or: [
        { 'data.instanceId': iidStr },
        { 'data.instance_id': iidStr },
      ],
    })

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

  /**
   * Permanently deletes the account and all owned data:
   * playthroughs (instances), created world templates, and the user document.
   */
  async deleteAccount(userId: string): Promise<{ deleted: boolean }> {
    const pid = parseObjectId(userId)
    const user = await users().findOne({ _id: pid })
    if (!user) {
      throw new HttpError(404, 'User not found')
    }

    const instances = await worldInstances()
      .find({ player_id: pid })
      .project({ _id: 1 })
      .toArray()

    for (const instance of instances) {
      await this.deleteInstance(idString(instance._id), userId)
    }

    const templates = await worldTemplates()
      .find({ creator_id: pid })
      .project({ _id: 1 })
      .toArray()

    for (const template of templates) {
      await this.deleteTemplate(idString(template._id), userId)
    }

    await deadLetterJobs().deleteMany({
      $or: [
        { 'data.playerId': userId },
        { 'data.player_id': userId },
        { 'data.userId': userId },
        { 'data.user_id': userId },
      ],
    })

    const result = await users().deleteOne({ _id: pid })
    if (result.deletedCount === 0) {
      throw new HttpError(404, 'User not found')
    }

    return { deleted: true }
  },
}
