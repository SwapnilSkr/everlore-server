import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { getPineconeIndex } from '../../src/config/pinecone'
import { embedBatch } from '../../src/ai'
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

      // Reuse the vectors already stored in Pinecone instead of re-embedding
      // every memory (previously one embedding API call PER memory — the
      // dominant cost of this job at scale). Fetch by id in batches; the
      // stored vector is identical to a fresh embed of the same text, so dedup
      // decisions are unchanged. Only memories missing a vector fall back to a
      // single batched embed.
      const embeddings = new Map<string, number[]>()
      const dedupNs = getPineconeIndex().namespace(`mem_${instanceId}`)
      const withVec = memories.filter((m) => m.pinecone_id)
      for (let i = 0; i < withVec.length; i += 200) {
        const batch = withVec.slice(i, i + 200)
        try {
          const res = await dedupNs.fetch({ ids: batch.map((m) => m.pinecone_id as string) })
          for (const m of batch) {
            const values = res.records?.[m.pinecone_id as string]?.values
            if (values) embeddings.set(idString(m._id), values)
          }
        } catch (err) {
          console.warn('dedup: pinecone fetch failed, will re-embed batch:', (err as Error).message)
        }
      }
      const missing = memories.filter((m) => !embeddings.has(idString(m._id)))
      if (missing.length > 0) {
        const vecs = await embedBatch(missing.map((m) => m.text))
        missing.forEach((m, i) => embeddings.set(idString(m._id), vecs[i]))
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

    case 'repair_entity_graph': {
      // Per-instance graph repair: prune edges whose source events were
      // removed outside the rewind path, and backfill/relink card↔entity 1:1
      // links (also serves as the lazy migration for pre-graph worlds).
      const { instanceId } = job.data as { instanceId: string }
      const instanceOid = parseObjectId(instanceId)
      const { entityGraphService } = await import('../../src/services/entity-graph.service')

      const edges = await mongoColl.entityEdges()
        .find({ instance_id: instanceOid }, { projection: { source_event_ids: 1 } })
        .toArray()
      const referenced = [...new Set(edges.flatMap((e) => e.source_event_ids || []).map(idString))]
      let prunedEdges = 0
      if (referenced.length > 0) {
        const existing = await mongoColl.events()
          .find(
            { instance_id: instanceOid, _id: { $in: referenced.map((id) => parseObjectId(id)) } },
            { projection: { _id: 1 } },
          )
          .toArray()
        const alive = new Set(existing.map((e) => idString(e._id)))
        const dead = referenced.filter((id) => !alive.has(id))
        if (dead.length > 0) {
          prunedEdges = await entityGraphService.removeEventProvenance(
            instanceId,
            dead.map((id) => parseObjectId(id)),
          )
        }
      }

      const instance = await mongoColl.worldInstances().findOne(
        { _id: instanceOid },
        { projection: { player_id: 1 } },
      )
      let linkedCards = 0
      if (instance) {
        const cards = await mongoColl.characters().find({ instance_id: instanceOid }).toArray()
        if (cards.length > 0) {
          const latest = await mongoColl.events().findOne(
            { instance_id: instanceOid },
            { sort: { sequence: -1 }, projection: { sequence: 1 } },
          )
          await entityGraphService.syncCodexEntities({
            instanceId,
            playerId: idString(instance.player_id),
            sequence: latest?.sequence || 0,
            cards,
          })
          linkedCards = cards.length
        }
      }
      return { prunedEdges, linkedCards }
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
