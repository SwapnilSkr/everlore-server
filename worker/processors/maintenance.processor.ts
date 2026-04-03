import { Job } from 'bullmq'
import { getDb } from '../../src/config/mongo'
import { getPineconeIndex } from '../../src/config/pinecone'
import { embed } from '../../src/utils/embedding'

export async function maintenanceProcessor(job: Job) {
  const { task } = job.data
  const db = getDb()

  switch (task) {
    case 'importance_decay': {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

      const staleMemories = await db.collection('memories')
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
            await index.namespace(`mem_${mem.instance_id}`).deleteOne(mem.pinecone_id)
          } catch (err) {
            console.warn(`Failed to delete Pinecone vector ${mem.pinecone_id}:`, (err as Error).message)
          }
        }

        await db.collection('memories').updateOne(
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
      const { instanceId } = job.data
      const memories = await db.collection('memories')
        .find({ instance_id: instanceId, is_archived: false })
        .toArray()

      if (memories.length < 2) return { merged: 0 }

      const embeddings = new Map<string, number[]>()
      for (const mem of memories) {
        embeddings.set(mem._id, await embed(mem.text))
      }

      const processed = new Set<string>()
      const merged: any[] = []

      for (let i = 0; i < memories.length; i++) {
        if (processed.has(memories[i]._id)) continue

        for (let j = i + 1; j < memories.length; j++) {
          if (processed.has(memories[j]._id)) continue

          const sim = cosineSimilarity(
            embeddings.get(memories[i]._id)!,
            embeddings.get(memories[j]._id)!,
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

            await db.collection('memories').updateOne(
              { _id: keeper._id },
              { $set: { source_event_ids: mergedSources } },
            )

            if (discard.pinecone_id) {
              try {
                const index = getPineconeIndex()
                await index.namespace(`mem_${instanceId}`).deleteOne(discard.pinecone_id)
              } catch {
                // Best effort
              }
            }

            await db.collection('memories').updateOne(
              { _id: discard._id },
              { $set: { is_archived: true, pinecone_id: null } },
            )

            processed.add(discard._id)
            merged.push({ kept: keeper._id, discarded: discard._id, similarity: sim })
          }
        }
      }

      return { merged: merged.length }
    }

    case 'schedule_dedups': {
      // Find active instances with enough memories to warrant dedup
      const instances = await db.collection('world_instances')
        .find({ 'meta.total_memories': { $gt: 20 }, 'meta.is_archived': { $ne: true } })
        .project({ _id: 1 })
        .toArray()

      const { getMaintenanceQueue } = await import('../../src/queues')
      const queue = getMaintenanceQueue()

      for (const inst of instances) {
        await queue.add('dedup', {
          task: 'dedup_memories',
          instanceId: inst._id,
        }, { priority: 20 })
      }

      return { scheduled: instances.length }
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
