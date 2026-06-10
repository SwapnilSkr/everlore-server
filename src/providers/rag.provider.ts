import { getPineconeIndex } from '../config/pinecone'
import { embed } from '../ai'
import { mongoColl } from '../config/mongo'
import { idString, parseObjectId } from '../utils/mongo-id'
import type { MemoryDoc } from '../models/memory.model'

interface RagResult {
  loreTexts: string[]
  memoryTexts: string[]
  /** Unresolved promises/conflicts/questions, highest-importance first. */
  openThreads: string[]
  retrievedMemoryMongoIds: string[]
  /** Entity ids linked to the retrieved memories — the hook for memory-driven
   *  codex pinning after RAG (collected from the Mongo-side retrieval paths). */
  retrievedEntityIds: string[]
}

/** Reciprocal-rank-fusion constant — standard value, dampens rank-1 dominance. */
const RRF_K = 60
/** Max open threads surfaced per turn (kept small: these are always injected). */
const OPEN_THREADS_LIMIT = 5

type FusedCandidate = {
  key: string
  text: string
  mongoId: string | null
  score: number
}

/**
 * Hybrid retrieval: vector search (Pinecone) for conceptual/emotional
 * similarity + Mongo $text keyword search for exact names, places, and
 * promises — fused with reciprocal rank fusion and an importance boost.
 * Vector-only RAG reliably misses exact-name recall; keyword-only misses
 * paraphrase. The fusion covers both failure modes.
 */
export async function queryRag(
  templateId: string,
  instanceId: string,
  queryText: string,
  maxLoreResults: number,
  maxMemoryResults: number,
  /** Entity ids mentioned in the player's turn — adds graph-neighborhood
   *  retrieval (memories LINKED to those entities by id, not by string). */
  mentionedEntityIds: string[] = [],
): Promise<RagResult> {
  const queryEmbedding = await embed(queryText)
  const index = getPineconeIndex()
  const instanceOid = parseObjectId(instanceId)

  const keywordSearch = async (): Promise<MemoryDoc[]> => {
    if (!queryText.trim()) return []
    try {
      return (await mongoColl
        .memories()
        .find(
          {
            instance_id: instanceOid,
            is_archived: false,
            $text: { $search: queryText },
          },
          { projection: { score: { $meta: 'textScore' } } as never },
        )
        .sort({ score: { $meta: 'textScore' } })
        .limit(maxMemoryResults)
        .toArray()) as MemoryDoc[]
    } catch (err) {
      // Text index may be missing on an older deployment — degrade to vector-only.
      console.warn('Keyword memory search skipped:', (err as Error).message)
      return []
    }
  }

  // Entity-neighborhood search: memories linked BY ID to the entities the
  // player named this turn. Catches what both other paths miss — a memory that
  // neither shares the query's wording (keyword) nor its meaning (vector) but
  // is about the person/place being asked about.
  const entityNeighborhoodSearch = async (): Promise<MemoryDoc[]> => {
    if (mentionedEntityIds.length === 0) return []
    try {
      const ids = mentionedEntityIds.map((id) => parseObjectId(id))
      return (await mongoColl
        .memories()
        .find({
          instance_id: instanceOid,
          is_archived: false,
          $or: [
            { subject_entity_ids: { $in: ids } },
            { object_entity_ids: { $in: ids } },
          ],
        })
        .sort({ importance: -1, updated_at: -1 })
        .limit(maxMemoryResults)
        .toArray()) as MemoryDoc[]
    } catch (err) {
      console.warn('Entity neighborhood search skipped:', (err as Error).message)
      return []
    }
  }

  const openThreadSearch = (): Promise<MemoryDoc[]> =>
    mongoColl
      .memories()
      .find({
        instance_id: instanceOid,
        unresolved_thread: true,
        is_archived: false,
      })
      .sort({ importance: -1, updated_at: -1 })
      .limit(OPEN_THREADS_LIMIT)
      .toArray() as Promise<MemoryDoc[]>

  const [loreResults, memoryResults, keywordMemories, entityMemories, threadMemories] =
    await Promise.all([
      index.namespace(`lore_${templateId}`).query({
        vector: queryEmbedding,
        topK: maxLoreResults,
        includeMetadata: true,
      }),
      index.namespace(`mem_${instanceId}`).query({
        vector: queryEmbedding,
        topK: maxMemoryResults,
        includeMetadata: true,
      }),
      keywordSearch(),
      entityNeighborhoodSearch(),
      openThreadSearch(),
    ])

  const loreTexts = (loreResults.matches || []).map(
    (m) => (m.metadata as { text?: string })?.text || '',
  )

  // ── Fuse vector + keyword memory rankings (RRF + importance boost) ──
  const candidates = new Map<string, FusedCandidate>()

  const addRanked = (
    items: Array<{ key: string; text: string; mongoId: string | null; importance: number }>,
  ) => {
    items.forEach((item, rank) => {
      if (!item.text) return
      const existing = candidates.get(item.key)
      const rrf = 1 / (RRF_K + rank)
      const boost = Math.min(Math.max(item.importance, 0), 5) * 0.0015
      if (existing) {
        existing.score += rrf
      } else {
        candidates.set(item.key, {
          key: item.key,
          text: item.text,
          mongoId: item.mongoId,
          score: rrf + boost,
        })
      }
    })
  }

  addRanked(
    (memoryResults.matches || []).map((m) => {
      const meta = (m.metadata || {}) as {
        text?: string
        mongo_id?: string
        importance?: number
      }
      const mongoId = meta.mongo_id ? String(meta.mongo_id) : null
      return {
        key: mongoId || `text:${meta.text || ''}`,
        text: meta.text || '',
        mongoId,
        importance: Number(meta.importance) || 3,
      }
    }),
  )

  addRanked(
    keywordMemories.map((m) => ({
      key: idString(m._id),
      text: m.text,
      mongoId: idString(m._id),
      importance: m.importance || 3,
    })),
  )

  addRanked(
    entityMemories.map((m) => ({
      key: idString(m._id),
      text: m.text,
      mongoId: idString(m._id),
      importance: m.importance || 3,
    })),
  )

  // Open threads get their own prompt section — keep the general memory list
  // free of duplicates so the budget isn't spent saying the same thing twice.
  const threadIds = new Set(threadMemories.map((m) => idString(m._id)))
  const fused = [...candidates.values()]
    .filter((c) => !c.mongoId || !threadIds.has(c.mongoId))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMemoryResults)

  const memoryTexts = fused.map((c) => c.text)
  const openThreads = threadMemories.map((m) => m.text)
  const retrievedMemoryMongoIds = fused
    .map((c) => c.mongoId)
    .filter((id): id is string => id !== null)

  // Memory-driven pinning hook: entity ids linked to the memories this query
  // surfaced (from the Mongo-side docs already in hand — no extra fetch). A
  // later phase can pin codex cards for these AFTER RAG.
  const fusedIdSet = new Set(retrievedMemoryMongoIds)
  const retrievedEntityIds = [
    ...new Set(
      [...keywordMemories, ...entityMemories, ...threadMemories]
        .filter((m) => fusedIdSet.has(idString(m._id)) || threadIds.has(idString(m._id)))
        .flatMap((m) => [...(m.subject_entity_ids || []), ...(m.object_entity_ids || [])])
        .map((id) => idString(id)),
    ),
  ]

  const accessedIds = [...new Set([...retrievedMemoryMongoIds, ...threadIds])]
  if (accessedIds.length > 0) {
    await mongoColl.memories().updateMany(
      { _id: { $in: accessedIds.map((id) => parseObjectId(id)) } },
      { $inc: { access_count: 1 }, $set: { last_accessed_at: new Date() } },
    )
  }

  return { loreTexts, memoryTexts, openThreads, retrievedMemoryMongoIds, retrievedEntityIds }
}
