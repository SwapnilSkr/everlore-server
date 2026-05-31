import { getPineconeIndex } from '../config/pinecone'
import { embed } from '../ai'
import { mongoColl } from '../config/mongo'
import { parseObjectId } from '../utils/mongo-id'
import { deletePineconeVector } from './pinecone-cleanup.service'

/**
 * Cosine-similarity floor for treating a retrieved memory as "the same fact" as
 * a now-retired status. High on purpose: a false negative just leaves the codex
 * to override (status quo), but a false positive would erase a still-valid
 * memory — so we bias toward precision.
 */
const SUPERSEDE_THRESHOLD = 0.82
const TOP_K = 5

/**
 * Memory-vector supersession. When the codex retires a current-status item
 * (e.g. "engaged to Lord X" after the engagement breaks), the matching memory
 * VECTORS in Pinecone can still be retrieved by RAG and resurface the stale
 * fact. The codex (high-authority) usually overrides them, but not always — so
 * here we find those stale vectors semantically and remove them, and archive
 * the Mongo docs (kept as source-of-truth, just no longer retrievable).
 */
export const memorySupersessionService = {
  async supersedeMemories(params: {
    instanceId: string
    retiredFacts: string[]
    /** Only supersede memories created strictly before this — never the fresh,
     *  correcting memory this same turn produces. Defaults to now. */
    beforeDate?: Date
  }): Promise<{ archived: number }> {
    const { instanceId, retiredFacts, beforeDate } = params
    const facts = (retiredFacts || [])
      .map((f) => String(f || '').trim())
      .filter((f) => f.length >= 4)
    if (!facts.length) return { archived: 0 }

    const namespaceName = `mem_${instanceId}`
    const namespace = getPineconeIndex().namespace(namespaceName)
    const cutoff = (beforeDate ?? new Date()).getTime()

    const mongoIds = new Set<string>()
    const vectorIds = new Set<string>()

    for (const fact of facts) {
      let vector: number[]
      try {
        vector = await embed(fact)
      } catch {
        continue
      }

      let res: { matches?: Array<{ id?: string; score?: number; metadata?: Record<string, unknown> }> }
      try {
        res = await namespace.query({ topK: TOP_K, vector, includeMetadata: true })
      } catch {
        continue
      }

      for (const m of res.matches || []) {
        if ((m.score ?? 0) < SUPERSEDE_THRESHOLD) continue
        const meta = m.metadata || {}
        const createdRaw = meta.created_at ? String(meta.created_at) : ''
        const created = createdRaw ? new Date(createdRaw).getTime() : 0
        // Skip anything created this turn or later — that's the corrected fact.
        if (created && created >= cutoff) continue
        if (m.id) vectorIds.add(String(m.id))
        if (meta.mongo_id) mongoIds.add(String(meta.mongo_id))
      }
    }

    if (vectorIds.size === 0) return { archived: 0 }

    // Remove the vectors so RAG stops retrieving the stale fact.
    for (const id of vectorIds) {
      try {
        await deletePineconeVector(namespaceName, id)
      } catch {
        // best-effort
      }
    }

    // Archive the Mongo docs (kept for provenance; just not retrievable).
    if (mongoIds.size > 0) {
      try {
        await mongoColl.memories().updateMany(
          { _id: { $in: [...mongoIds].map((id) => parseObjectId(id)) } },
          { $set: { is_archived: true, updated_at: new Date() } },
        )
      } catch {
        // best-effort
      }
    }

    return { archived: mongoIds.size }
  },
}
