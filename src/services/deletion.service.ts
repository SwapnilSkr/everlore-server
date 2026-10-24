import { purgeCardPortraits, purgeMedia, purgeTemplatePortraits } from './media/deletion'
import { detectSpokenLines } from './media/detection'
import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import { vectorStore } from './vector-store'
import { removeQueuedJobsForInstance } from '../queues'
import { characterCodexService } from './character-codex.service'
import { extractOpeningPlace } from './opening-place.service'
import { kinshipGraphService } from './kinship-graph.service'
import { isDefaultCoverUrl } from '../constants/default-cover'
import { storageService } from './storage.service'
import { telemetryService } from './telemetry/ingest.service'
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
const entities = () => mongoColl.entities()
const entityEdges = () => mongoColl.entityEdges()
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
      throw new HttpError(404, 'That world is not yours to unmake.')
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
    if (!template) throw new HttpError(404, 'That world could not be found.')

    const tidStr = idString(tid)
    // Find all instances created from this template
    const instances = await worldInstances()
      .find({ template_id: tid }, { projection: { _id: 1 } })
      .toArray()
    for (const instance of instances) {
      await this.deleteInstanceById(instance._id)
    }

    await deadLetterJobs().deleteMany({
      $or: [
        { 'data.templateId': tidStr },
        { 'data.template_id': tidStr },
      ],
    })

    // Delete the lore vectors from Pinecone
    try {
      await vectorStore.deleteScope({ kind: 'lore', templateId: tidStr })
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
    await purgeTemplatePortraits(tid)

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
      throw new HttpError(404, 'That story is not yours to begin again.')
    }
    const template = await worldTemplates().findOne({ _id: instance.template_id })
    if (!template) throw new HttpError(404, 'That world could not be found.')

    // Preserve the player's authored/onboarded identity across a full reset:
    // the protagonist is who you ARE, not emergent story canon, so a reset
    // should replay the same character rather than orphan them. Captured before
    // the codex is purged; re-seeded in step 3.
    const priorProtagonist = await characters().findOne({ instance_id: iid, is_protagonist: true })

    // 1. Purge all play data through the same path used by both deletions.
    await this.purgeInstancePayload(iid, iidStr)

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
          travelling_with: [],
          current_time_anchor: initialTimeAnchor,
          active_timeline_id: initialTimeAnchor.timeline_id,
          default_calendar_id: initialTimeAnchor.story_calendar?.calendar_id,
          'meta.total_events': 0,
          'meta.total_memories': 0,
          'meta.total_tokens_consumed': 0,
          'meta.last_active_at': new Date(),
          // Clear the seed guard so premise kinship re-seeds for the reused instance.
          'meta.kinship_seeded': false,
          updated_at: new Date(),
        },
        $unset: { seed_relation_assertions: '', manual_relation_assertions: '', manual_lifecycle_transitions: '', manual_identity_revisions: '' },
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

    // Re-seed premise kinship: the reset purged the graph + cleared meta.kinship_seeded
    // above, so the authored family is laid down fresh for the reused instance.
    if (await characters().findOne({ instance_id: iid, is_protagonist: true })) {
      await kinshipGraphService
        .seedPremiseKinship({ instanceId: iidStr, playerId })
        .catch(() => undefined)
    }

    // 4. Re-seed the opening line so the chat reopens with the greeting.
    if (template.opening_line && template.opening_line.trim().length > 0) {
      // A reset re-opens the world, so it must re-read the authored opening's
      // place too. This block and the one in instance.service are the same
      // ceremony written twice; keep them in step.
      const [openingTimeAnchor, openingPlace] = await Promise.all([
        timeService.anchorForNextEvent({
          instanceId: iidStr,
          templateId: idString(template._id),
          previous: initialTimeAnchor,
          sequence: 1,
          eventTimeLabel: 'Opening scene',
        }),
        extractOpeningPlace({ openingLine: template.opening_line.trim(), instanceId: iidStr }),
      ])
      await events().insertOne({
        _id: new ObjectId(),
        instance_id: iid,
        player_id: pid,
        sequence: 1,
        type: 'narration',
        data: {
          player_input: '',
          ai_response: template.opening_line.trim(),
          spoken_lines: detectSpokenLines(template.opening_line.trim()),
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
        ...(openingPlace ? { location_anchor: openingPlace } : {}),
        created_at: new Date(),
      } as unknown as WorldEventDoc)
      await worldInstances().updateOne(
        { _id: iid },
        {
          $set: {
            current_time_anchor: openingTimeAnchor,
            active_timeline_id: openingTimeAnchor.timeline_id,
            default_calendar_id: openingTimeAnchor.story_calendar?.calendar_id,
            current_location: openingPlace,
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
      throw new HttpError(404, 'That story is not yours to end.')
    }

    return this.deleteInstanceById(iid)
  },

  /** Admin/internal instance purge without owner checks. */
  async deleteInstanceById(instanceId: string | ObjectId): Promise<{ deleted: boolean }> {
    const iid = typeof instanceId === 'string' ? parseObjectId(instanceId) : instanceId
    const instance = await worldInstances().findOne({ _id: iid })
    if (!instance) throw new HttpError(404, 'That story could not be found.')

    const iidStr = idString(iid)
    const redis = getRedisClient()
    // Workers check the live save before starting. Remove it before draining
    // queued work so a job picked up during the drain will no-op.
    await worldInstances().deleteOne({ _id: iid })
    await removeQueuedJobsForInstance(iidStr).catch((err) => {
      console.warn(`Failed to drain queued jobs for instance ${iidStr}:`, (err as Error).message)
    })

    await this.purgeInstancePayload(iid, iidStr)
    // An already-running worker may have finished while the first pass ran.
    await this.purgeInstancePayload(iid, iidStr)

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

  /** The one payload list shared by reset, save deletion and template deletion. */
  async purgeInstancePayload(instanceId: ObjectId, instanceIdStr: string): Promise<void> {
    await events().deleteMany({ instance_id: instanceId })
    await purgeMedia({ instance_id: instanceId })
    await purgeCardPortraits(instanceId)
    await this.deleteInstanceData(instanceId, instanceIdStr)
    await Promise.all([
      memories().deleteMany({ instance_id: instanceId }),
      sceneSummaries().deleteMany({ instance_id: instanceId }),
      mongoColl.chapterSummaries().deleteMany({ instance_id: instanceId }),
      mongoColl.arcSummaries().deleteMany({ instance_id: instanceId }),
      characters().deleteMany({ instance_id: instanceId }),
      entities().deleteMany({ instance_id: instanceId }),
      entityEdges().deleteMany({ instance_id: instanceId }),
      mongoColl.storyCalendars().deleteMany({ instance_id: instanceId }),
      mongoColl.timelineBranches().deleteMany({ instance_id: instanceId }),
      mongoColl.locationStats().deleteMany({ instance_id: instanceId }),
      mongoColl.placeCandidates().deleteMany({ instance_id: instanceId }),
      mongoColl.generationLogs().deleteMany({ instance_id: instanceId }),
      mongoColl.extractorRaw().deleteMany({ instance_id: instanceId }),
      mongoColl.projectionAnomalies().deleteMany({ instance_id: instanceId }),
      mongoColl.signalLedger().deleteMany({ instance_id: instanceId }),
      mongoColl.relationCandidates().deleteMany({ instance_id: instanceId }),
      mongoColl.postProcessOutbox().deleteMany({ instance_id: instanceId }),
      mongoColl.projectionCheckpoints().deleteMany({ instance_id: instanceId }),
      mongoColl.projectionCheckpointChunks().deleteMany({ instance_id: instanceId }),
    ])
  },

  /**
   * Helper method to delete all Pinecone vectors for an instance.
   * This is called internally by both deleteTemplate and deleteInstance.
   */
  async deleteInstanceData(instanceId: ObjectId, instanceIdStr: string): Promise<void> {
    // These scopes are independent. Failure is logged but does not block
    // the authoritative Mongo deletion, matching the existing cleanup policy.
    await Promise.all([
      vectorStore.deleteScope({ kind: 'mem', instanceId: instanceIdStr }).catch((err) => {
        console.warn(`Failed to delete memory vectors for instance ${instanceIdStr}:`, (err as Error).message)
      }),
      vectorStore.deleteScope({ kind: 'sum', instanceId: instanceIdStr }).catch((err) => {
        console.warn(`Failed to delete summary vectors for instance ${instanceIdStr}:`, (err as Error).message)
      }),
    ])
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

    await purgeMedia({ player_id: pid })
    // Telemetry carries the only other rows keyed by player: events, sessions
    // and error samples. Error groups and per-day counters hold counts rather
    // than people and stay; an install shared with another account just loses
    // this id (analytics.md §6).
    await telemetryService.purgeUser(userId)
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
