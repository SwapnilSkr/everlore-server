import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { getPineconeIndex } from '../../src/config/pinecone'
import { embed } from '../../src/ai'
import { idString, parseObjectId } from '../../src/utils/mongo-id'
import { QUEUE_RETENTION } from '../../src/queues'
import { log } from '../../src/utils/logger'

const SCENE_SUMMARY_BLOCK = 12
const STUCK_SUMMARY_MS = 10 * 60 * 1000

export async function maintenanceProcessor(job: Job) {
  const { task } = job.data
  switch (task) {
    case 'importance_decay': {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

      const staleMemories = await mongoColl.memories()
        .find({
          importance: { $lt: 3 },
          last_accessed_at: { $lt: thirtyDaysAgo },
          is_archived: false,
        })
        .toArray()

      for (const mem of staleMemories) {
        if (mem.pinecone_id) {
          try {
            const index = getPineconeIndex()
            const ns = idString(mem.instance_id)
            await index.namespace(`mem_${ns}`).deleteOne({ id: mem.pinecone_id })
          } catch (err) {
            console.warn(`Failed to delete Pinecone vector ${mem.pinecone_id}:`, (err as Error).message)
          }
        }

        await mongoColl.memories().updateOne(
          { _id: mem._id },
          {
            $set: {
              is_archived: true,
              pinecone_id: null,
              updated_at: new Date(),
            },
          },
        )
      }

      return { archived: staleMemories.length }
    }

    case 'dedup_memories': {
      const { instanceId } = job.data as { instanceId: string }
      const instanceOid = parseObjectId(instanceId)
      const memories = await mongoColl.memories()
        .find({ instance_id: instanceOid, is_archived: false })
        .toArray()

      if (memories.length < 2) return { merged: 0 }

      const embeddings = new Map<string, number[]>()
      for (const mem of memories) {
        embeddings.set(idString(mem._id), await embed(mem.text))
      }

      const processed = new Set<string>()
      const merged: any[] = []

      for (let i = 0; i < memories.length; i++) {
        const idI = idString(memories[i]._id)
        if (processed.has(idI)) continue

        for (let j = i + 1; j < memories.length; j++) {
          const idJ = idString(memories[j]._id)
          if (processed.has(idJ)) continue

          const sim = cosineSimilarity(
            embeddings.get(idI)!,
            embeddings.get(idJ)!,
          )

          if (sim > 0.95) {
            const keeper = memories[i].importance >= memories[j].importance
              ? memories[i] : memories[j]
            const discard = keeper === memories[i] ? memories[j] : memories[i]

            const mergedSources = [
              ...new Set([
                ...keeper.source_event_ids,
                ...discard.source_event_ids,
              ]),
            ]

            // Near-duplicates may differ in enrichment: keep the union of
            // entity refs and stay unresolved if either copy still is.
            const mergedFields: Record<string, unknown> = {
              source_event_ids: mergedSources,
              subjects: [...new Set([...(keeper.subjects || []), ...(discard.subjects || [])])],
              objects: [...new Set([...(keeper.objects || []), ...(discard.objects || [])])],
            }
            if (keeper.unresolved_thread || discard.unresolved_thread) {
              mergedFields.unresolved_thread = true
              mergedFields.resolved_at = null
            }

            await mongoColl.memories().updateOne(
              { _id: keeper._id },
              { $set: mergedFields },
            )

            if (discard.pinecone_id) {
              try {
                const index = getPineconeIndex()
                await index.namespace(`mem_${instanceId}`).deleteOne({ id: discard.pinecone_id })
              } catch {
                // Best effort
              }
            }

            await mongoColl.memories().updateOne(
              { _id: discard._id },
              { $set: { is_archived: true, pinecone_id: null } },
            )

            processed.add(idString(discard._id))
            merged.push({ kept: keeper._id, discarded: discard._id, similarity: sim })
          }
        }
      }

      return { merged: merged.length }
    }

    case 'schedule_dedups': {
      const instances = await mongoColl.worldInstances()
        .find({ 'meta.total_memories': { $gt: 20 }, 'meta.is_archived': { $ne: true } })
        .project({ _id: 1 })
        .toArray()

      const { getMaintenanceQueue } = await import('../../src/queues')
      const queue = getMaintenanceQueue()

      for (const inst of instances) {
        await queue.add('dedup', {
          task: 'dedup_memories',
          instanceId: idString(inst._id),
        }, {
          priority: 20,
          removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
          removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
        })
      }

      return { scheduled: instances.length }
    }

    case 'repair_scene_summaries': {
      const stuckBefore = new Date(Date.now() - STUCK_SUMMARY_MS)
      const instances = await mongoColl.worldInstances()
        .find({
          'current_scene.summary_pending': true,
          updated_at: { $lt: stuckBefore },
          'meta.is_archived': { $ne: true },
        })
        .project({ _id: 1, current_scene: 1 })
        .limit(100)
        .toArray()

      const { getSceneSummaryQueue } = await import('../../src/queues')
      const queue = getSceneSummaryQueue()
      let scheduled = 0

      for (const inst of instances) {
        const latest = await mongoColl.events().findOne(
          { instance_id: inst._id },
          { sort: { sequence: -1 }, projection: { sequence: 1, scene_tag: 1 } },
        )
        if (!latest || typeof latest.sequence !== 'number') continue

        const endSequence = latest.sequence
        const startSequence = Math.max(1, endSequence - (SCENE_SUMMARY_BLOCK - 1))
        const sceneTag =
          typeof inst.current_scene?.tag === 'string'
            ? inst.current_scene.tag
            : latest.scene_tag || 'dialogue'

        const existing = await mongoColl.sceneSummaries().findOne({
          instance_id: inst._id,
          'event_range.end_sequence': endSequence,
        })
        if (existing) {
          await mongoColl.worldInstances().updateOne(
            { _id: inst._id },
            { $set: { 'current_scene.summary_pending': false } },
          )
          continue
        }

        log.warn('scene_summary.repair_queued', {
          instanceId: idString(inst._id),
          sceneTag,
          startSequence,
          endSequence,
        })
        await queue.add('summarize', {
          instanceId: idString(inst._id),
          sceneTag,
          startSequence,
          endSequence,
        }, {
          priority: 15,
          removeOnComplete: QUEUE_RETENTION.sceneSummary.removeOnComplete,
          removeOnFail: QUEUE_RETENTION.sceneSummary.removeOnFail,
        })
        scheduled++
      }

      return { scanned: instances.length, scheduled }
    }

    default:
      return { error: `Unknown maintenance task: ${task}` }
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}
