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

type TimelineEligibility = {
  clauses: Record<string, unknown>[]
  includesLegacyMain: boolean
  allowsMemory: (m: Pick<MemoryDoc, 'timeline_id' | 'time_anchor'>) => boolean
}

async function timelineEligibility(instanceId: string, timelineId?: string | null): Promise<TimelineEligibility | null> {
  if (!timelineId) return null
  const iid = parseObjectId(instanceId)
  const branches = await mongoColl.timelineBranches().find({ instance_id: iid }).toArray()
  const byId = new Map(branches.map((b) => [String(b.timeline_id), b]))
  const allowed = new Map<string, number | null>()
  const visit = (id: string, maxSequence: number | null) => {
    if (!id) return
    const prev = allowed.get(id)
    if (prev !== undefined && (prev === null || maxSequence === null || prev >= maxSequence)) return
    allowed.set(id, maxSequence)
    const branch = byId.get(id)
    if (branch?.parent_timeline_id) {
      visit(branch.parent_timeline_id, branch.forked_at_sequence)
    }
  }
  visit(timelineId, null)
  if (!allowed.size) allowed.set(timelineId, null)

  const clauses: Record<string, unknown>[] = []
  for (const [id, maxSequence] of allowed) {
    if (maxSequence === null) {
      clauses.push({ timeline_id: id })
    } else {
      clauses.push({ timeline_id: id, 'time_anchor.sequence': { $lte: maxSequence } })
    }
  }
  const mainMax = allowed.get('main')
  const includesLegacyMain = allowed.has('main')
  if (includesLegacyMain) {
    // Pre-TimeAnchor rows are main-timeline compatible, but have no sequence to
    // clamp. Keep them only when main is in the ancestry, never on unrelated branches.
    clauses.push({ timeline_id: { $exists: false } })
  }

  return {
    clauses,
    includesLegacyMain,
    allowsMemory: (m) => {
      const memTimeline = m.timeline_id || m.time_anchor?.timeline_id || ''
      if (!memTimeline) return includesLegacyMain
      const maxSequence = allowed.get(memTimeline)
      if (maxSequence === undefined) return false
      if (maxSequence === null) return true
      return (m.time_anchor?.sequence || 0) <= maxSequence
    },
  }
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
  /** Current timeline branch. New memories are scoped; legacy rows without
   *  timeline_id are still eligible on the main branch. */
  timelineId?: string | null,
  /** Current place entity; adds "what happened here before?" retrieval. */
  currentLocationEntityId?: string | null,
): Promise<RagResult> {
  const queryEmbedding = await embed(queryText)
  const index = getPineconeIndex()
  const instanceOid = parseObjectId(instanceId)
  const eligibility = await timelineEligibility(instanceId, timelineId)
  const memoryScope = (extra: Record<string, unknown> = {}) => ({
    instance_id: instanceOid,
    is_archived: false,
    ...(eligibility ? { $and: [{ $or: eligibility.clauses }] } : {}),
    ...extra,
  })

  const keywordSearch = async (): Promise<MemoryDoc[]> => {
    if (!queryText.trim()) return []
    try {
      return (await mongoColl
        .memories()
        .find(
          {
            ...memoryScope(),
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
          ...memoryScope(),
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

  const locationMemorySearch = async (): Promise<MemoryDoc[]> => {
    if (!currentLocationEntityId) return []
    try {
      const id = parseObjectId(currentLocationEntityId)
      return (await mongoColl
        .memories()
        .find({
          ...memoryScope(),
          $or: [
            { location_entity_id: id },
            { 'location_anchor.entity_id': id },
            { subject_entity_ids: id },
            { object_entity_ids: id },
          ],
        })
        .sort({ importance: -1, updated_at: -1 })
        .limit(maxMemoryResults)
        .toArray()) as MemoryDoc[]
    } catch (err) {
      console.warn('Location memory search skipped:', (err as Error).message)
      return []
    }
  }

  const openThreadSearch = (): Promise<MemoryDoc[]> =>
    mongoColl
      .memories()
      .find({
        ...memoryScope(),
        unresolved_thread: true,
      })
      .sort({ importance: -1, updated_at: -1 })
      .limit(OPEN_THREADS_LIMIT)
      .toArray() as Promise<MemoryDoc[]>

  const [loreResults, memoryResults, keywordMemories, entityMemories, locationMemories, threadMemories] =
    await Promise.all([
      index.namespace(`lore_${templateId}`).query({
        vector: queryEmbedding,
        topK: maxLoreResults,
        includeMetadata: true,
      }),
      index.namespace(`mem_${instanceId}`).query({
        vector: queryEmbedding,
        topK: timelineId ? Math.max(maxMemoryResults * 2, maxMemoryResults) : maxMemoryResults,
        includeMetadata: true,
      }),
      keywordSearch(),
      entityNeighborhoodSearch(),
      locationMemorySearch(),
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

  const vectorMatches = memoryResults.matches || []
  const vectorMongoIds = vectorMatches
    .map((m) => String((m.metadata || {}).mongo_id || ''))
    .filter(Boolean)
  const vectorDocs =
    eligibility && vectorMongoIds.length
      ? new Map(
          (
            (await mongoColl.memories()
              .find(
                { _id: { $in: vectorMongoIds.map((id) => parseObjectId(id)) } },
                { projection: { _id: 1, timeline_id: 1, time_anchor: 1 } },
              )
              .toArray()) as MemoryDoc[]
          ).map((m) => [idString(m._id), m]),
        )
      : new Map<string, MemoryDoc>()

  addRanked(
    vectorMatches
      .filter((m) => {
        if (!eligibility) return true
        const meta = (m.metadata || {}) as { mongo_id?: string; timeline_id?: string; sequence?: number }
        const mongoId = meta.mongo_id ? String(meta.mongo_id) : ''
        const doc = mongoId ? vectorDocs.get(mongoId) : null
        if (doc) return eligibility.allowsMemory(doc)
        const metaTimeline = String(meta.timeline_id || '')
        if (!metaTimeline) return eligibility.includesLegacyMain
        return eligibility.allowsMemory({
          timeline_id: metaTimeline,
          time_anchor: typeof meta.sequence === 'number'
            ? { sequence: meta.sequence, real_time: new Date(), timeline_id: metaTimeline, causal_parent_event_ids: [] }
            : undefined,
        })
      })
      .slice(0, maxMemoryResults)
      .map((m) => {
      const meta = (m.metadata || {}) as {
        text?: string
        mongo_id?: string
        importance?: number
        timeline_id?: string
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

  addRanked(
    locationMemories.map((m) => ({
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
        .concat(locationMemories)
        .filter((m) => fusedIdSet.has(idString(m._id)) || threadIds.has(idString(m._id)))
        .flatMap((m) => [
          ...(m.subject_entity_ids || []),
          ...(m.object_entity_ids || []),
          ...(m.location_entity_id ? [m.location_entity_id] : []),
          ...(m.location_anchor?.entity_id ? [m.location_anchor.entity_id] : []),
        ])
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
