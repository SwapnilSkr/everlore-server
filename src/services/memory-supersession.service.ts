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
    /** The turn whose codex retirement triggered this supersession. When given,
     *  the archived atoms are stamped `superseded_by_event_ids += eventId` — the
     *  race-free backward half of the Phase-2 version graph, from which the
     *  curator (and the repair job) materialize the forward `updates_memory_ids`
     *  on this event's new correcting atoms. */
    eventId?: string
  }): Promise<{ archived: number; supersededIds: string[] }> {
    const { instanceId, retiredFacts, beforeDate, eventId } = params
    const facts = (retiredFacts || [])
      .map((f) => String(f || '').trim())
      .filter((f) => f.length >= 4)
    if (!facts.length) return { archived: 0, supersededIds: [] }

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
        // Privacy scope: a MAIN-story codex retirement must never evict (or link
        // to) a PRIVATE side-chat secret. The boundary stays intact — a secret
        // only enters the main story by being shared, which mints a main atom.
        if (String(meta.origin || '') === 'side_chat') continue
        const createdRaw = meta.created_at ? String(meta.created_at) : ''
        const created = createdRaw ? new Date(createdRaw).getTime() : 0
        // Skip anything created this turn or later — that's the corrected fact.
        if (created && created >= cutoff) continue
        if (m.id) vectorIds.add(String(m.id))
        if (meta.mongo_id) mongoIds.add(String(meta.mongo_id))
      }
    }

    if (vectorIds.size === 0) return { archived: 0, supersededIds: [] }

    // Remove the vectors so RAG stops retrieving the stale fact.
    for (const id of vectorIds) {
      try {
        await deletePineconeVector(namespaceName, id)
      } catch {
        // best-effort
      }
    }

    // Archive the Mongo docs (kept for provenance; just not retrievable).
    // status 'superseded' (vs plain 'archived') records that a newer fact
    // replaced this one, not that it merely decayed. When the trigger is a known
    // turn, stamp the backward version-graph link too (`superseded_by_event_ids`).
    // A matched Pinecone vector can be an ORPHAN whose `mongo_id` no longer maps to
    // a live doc (a prior delete that left the vector behind) — its vector is still
    // worth evicting above, but it must NOT be counted as an archived atom. Resolve
    // to the real docs first so `archived`/`supersededIds` reflect actual atoms.
    if (mongoIds.size > 0) {
      try {
        const liveIds = (
          await mongoColl
            .memories()
            .find(
              { _id: { $in: [...mongoIds].map((id) => parseObjectId(id)) } },
              { projection: { _id: 1 } },
            )
            .toArray()
        ).map((m) => m._id)
        if (liveIds.length > 0) {
          const update: Record<string, unknown> = {
            $set: { is_archived: true, status: 'superseded', updated_at: new Date() },
          }
          if (eventId) {
            update.$addToSet = { superseded_by_event_ids: parseObjectId(eventId) }
          }
          await mongoColl.memories().updateMany({ _id: { $in: liveIds } }, update)
        }
        return { archived: liveIds.length, supersededIds: liveIds.map((id) => String(id)) }
      } catch {
        // best-effort
      }
    }

    return { archived: 0, supersededIds: [] }
  },
}
