import { randomUUID } from 'crypto'
import { env } from '../config/env'
import { mongoColl } from '../config/mongo'
import { getPineconeIndex } from '../config/pinecone'
import { getRedisClient } from '../config/redis'
import { getMemoryCurationQueue, getSceneSummaryQueue, QUEUE_RETENTION } from '../queues'
import { queryRag } from '../providers/rag.provider'
import { buildPrompt } from '../utils/prompt-builder'
import { lengthMaxTokens } from '../utils/narrative-styles'
import { NSFW_MODE, DEFAULT_CHAT_MODE } from '../utils/chat-modes'
import { idString, parseObjectId } from '../utils/mongo-id'
import { parsePlayerInput } from '../utils/player-input-parser'
import { characterCodexService } from './character-codex.service'
import { entityGraphService } from './entity-graph.service'
import { timeService } from './time.service'
import { applyStateMutations, applyFlagMutations } from '../utils/state-mutator'
import { repairProseHygiene, validateProseHygiene } from '../utils/prose-hygiene'
import { callLLM, callLLMStream, embed, AI_MODELS } from '../ai'
import { classifyScene } from '../../worker/lib/nsfw-classifier'
import { EVENT_WINDOWS } from '../utils/event-window'

const events = () => mongoColl.events()
const memories = () => mongoColl.memories()
const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()
const sceneSummaries = () => mongoColl.sceneSummaries()
const chapterSummaries = () => mongoColl.chapterSummaries()
const arcSummaries = () => mongoColl.arcSummaries()
const characters = () => mongoColl.characters()
const users = () => mongoColl.users()

function continuityText(value: string, max = 220): string {
  return String(value || '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function openingCharacterName(recentEvents: any[], names: string[]): string | null {
  const last = [...(recentEvents || [])].reverse().find((event) => String(event.data?.ai_response || '').trim())
  const text = String(last?.data?.ai_response || '')
    .trim()
    .replace(/^[\s*_]+/, '')
  for (const name of names) {
    if (!name) continue
    const re = new RegExp(`^${escapeRegExp(name)}(?:\\b|'s\\b)`, 'i')
    if (re.test(text)) return name
  }
  return null
}

function baseReplayVariantFor(event: any) {
  return {
    id: `base_${idString(event._id)}`,
    narrative: event.data?.ai_response || '',
    model_used: event.data?.model_used || AI_MODELS.narrationSfw,
    created_at: event.created_at || new Date(),
    source: 'base',
    retrieval_profile: {
      lore_top_k: 10,
      memory_top_k: 25,
      recent_event_window: 6,
    },
  }
}

function normalizeReplayVariants(event: any): any[] {
  const existing = Array.isArray(event.data?.replay_variants)
    ? event.data.replay_variants.filter((v: any) => typeof v?.narrative === 'string')
    : []
  if (existing.length > 0) return existing
  if (typeof event.data?.ai_response === 'string' && event.data.ai_response.trim()) {
    return [baseReplayVariantFor(event)]
  }
  return []
}

async function characterNamesForInstance(instanceId: any): Promise<string[]> {
  const codex = await characters()
    .find({ instance_id: instanceId }, { projection: { canonical_name: 1 } })
    .limit(40)
    .toArray()
  return codex.map((c: any) => c.canonical_name).filter(Boolean)
}

/**
 * Projection provenance: when a turn's content changes, any scene summary whose
 * range covers that turn now describes events that no longer happened. Mark it
 * stale (prompts skip stale summaries) and requeue a rebuild for the same range.
 */
async function staleSummariesCoveringEvent(event: any): Promise<number> {
  const covering = await sceneSummaries()
    .find({
      instance_id: event.instance_id,
      'event_range.start_sequence': { $lte: event.sequence },
      'event_range.end_sequence': { $gte: event.sequence },
      status: { $ne: 'stale' },
    })
    .toArray()
  if (covering.length === 0) return 0

  await sceneSummaries().updateMany(
    { _id: { $in: covering.map((s) => s._id) } },
    { $set: { status: 'stale' } },
  )

  const queue = getSceneSummaryQueue()
  for (const s of covering) {
    await queue.add(
      'summarize',
      {
        instanceId: idString(event.instance_id),
        sceneTag: s.scene_tag,
        startSequence: s.event_range.start_sequence,
        endSequence: s.event_range.end_sequence,
      },
      {
        priority: 15,
        delay: 2000,
        removeOnComplete: QUEUE_RETENTION.sceneSummary.removeOnComplete,
        removeOnFail: QUEUE_RETENTION.sceneSummary.removeOnFail,
      },
    )
  }

  // A chapter built over any of these scenes now describes a superseded span:
  // stale it and requeue a rebuild over the same scene set (delayed so the
  // child scene summaries above are rebuilt first).
  const coveringChapters = await chapterSummaries()
    .find({
      instance_id: event.instance_id,
      'event_range.start_sequence': { $lte: event.sequence },
      'event_range.end_sequence': { $gte: event.sequence },
      status: { $ne: 'stale' },
    })
    .toArray()
  if (coveringChapters.length > 0) {
    await chapterSummaries().updateMany(
      { _id: { $in: coveringChapters.map((c) => c._id) } },
      { $set: { status: 'stale' } },
    )
    for (const c of coveringChapters) {
      await queue.add(
        'summarize',
        {
          kind: 'chapter',
          instanceId: idString(event.instance_id),
          chapterIndex: c.chapter_index,
          startSequence: c.event_range.start_sequence,
          endSequence: c.event_range.end_sequence,
          sceneSummaryIds: c.scene_summary_ids.map((id) => idString(id)),
        },
        {
          priority: 16,
          delay: 5000,
          removeOnComplete: QUEUE_RETENTION.sceneSummary.removeOnComplete,
          removeOnFail: QUEUE_RETENTION.sceneSummary.removeOnFail,
        },
      )
    }
  }

  // Arcs sit above chapters: an arc over any affected chapter is now superseded.
  // Stale it and requeue (longer delay so the chapters above rebuild first).
  const coveringArcs = await arcSummaries()
    .find({
      instance_id: event.instance_id,
      'event_range.start_sequence': { $lte: event.sequence },
      'event_range.end_sequence': { $gte: event.sequence },
      status: { $ne: 'stale' },
    })
    .toArray()
  if (coveringArcs.length > 0) {
    await arcSummaries().updateMany(
      { _id: { $in: coveringArcs.map((a) => a._id) } },
      { $set: { status: 'stale' } },
    )
    for (const a of coveringArcs) {
      await queue.add(
        'summarize',
        {
          kind: 'arc',
          instanceId: idString(event.instance_id),
          arcIndex: a.arc_index,
          startSequence: a.event_range.start_sequence,
          endSequence: a.event_range.end_sequence,
        },
        {
          priority: 17,
          delay: 9000,
          removeOnComplete: QUEUE_RETENTION.sceneSummary.removeOnComplete,
          removeOnFail: QUEUE_RETENTION.sceneSummary.removeOnFail,
        },
      )
    }
  }

  return covering.length
}

async function recurateMemoriesForEvent(
  event: any,
  playerId: string,
  playerInputRaw: string,
  playerSpokenInput: string,
  playerNarrationFacts: string[],
  aiResponse: string,
): Promise<number> {
  let deletedMemories = 0
  const staleMemories = await memories()
    .find({ instance_id: event.instance_id, source_event_ids: event._id })
    .toArray()

  if (staleMemories.length > 0) {
    const ns = getPineconeIndex().namespace(`mem_${idString(event.instance_id)}`)
    for (const m of staleMemories) {
      if (!m.pinecone_id) continue
      try {
        await ns.deleteOne({ id: m.pinecone_id })
      } catch (err) {
        console.warn('Event recuration: failed to delete vector', m.pinecone_id, (err as Error).message)
      }
    }

    await memories().deleteMany({ _id: { $in: staleMemories.map((m) => m._id) } })
    deletedMemories = staleMemories.length
    await worldInstances().updateOne(
      { _id: event.instance_id },
      { $inc: { 'meta.total_memories': -deletedMemories } },
    )
  }

  // Graph edges asserted from the old content of this turn no longer hold;
  // re-curation re-creates whatever the new content still supports. Entities
  // whose ONLY reference was the deleted memories are pruned too — an edited-
  // out first mention must not linger as an active entity.
  try {
    await entityGraphService.removeEventProvenance(idString(event.instance_id), [event._id])
    const candidateEntityIds = [
      ...new Map(
        staleMemories
          .flatMap((m) => [...(m.subject_entity_ids || []), ...(m.object_entity_ids || [])])
          .map((id) => [idString(id), id] as const),
      ).values(),
    ]
    await entityGraphService.pruneOrphanEntities(idString(event.instance_id), candidateEntityIds)
  } catch (err) {
    console.warn('Event recuration: entity graph prune failed:', (err as Error).message)
  }

  const memoryCurationQueue = getMemoryCurationQueue()
  await memoryCurationQueue.add(
    'curate',
    {
      instanceId: idString(event.instance_id),
      playerId,
      eventId: idString(event._id),
      playerInput: playerInputRaw,
      playerSpokenInput,
      playerNarrationFacts,
      aiResponse: aiResponse || '',
      sceneTag: event.scene_tag || 'dialogue',
    },
    {
      priority: 5,
      delay: 500,
      removeOnComplete: QUEUE_RETENTION.memoryCuration.removeOnComplete,
      removeOnFail: QUEUE_RETENTION.memoryCuration.removeOnFail,
    },
  )

  return deletedMemories
}

export const memoryService = {
  async getEvents(instanceId: string, playerId: string, opts: any) {
    const limit = opts.limit || EVENT_WINDOWS.chroniclePageSize
    const skip = ((opts.page || 1) - 1) * limit
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const filter: Record<string, unknown> = { instance_id: iid, player_id: pid }
    if (opts.type) filter.type = opts.type

    const evs = await events()
      .find(filter)
      .sort({ sequence: -1 })
      .skip(skip)
      .limit(limit)
      .toArray()

    const total = await events().countDocuments(filter)
    return { events: evs.reverse(), total, page: opts.page || 1 }
  },

  async getMemories(instanceId: string, playerId: string, opts: any) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const filter: Record<string, unknown> = { instance_id: iid, player_id: pid }
    if (!opts.includeArchived) filter.is_archived = false

    // Advanced filters (all optional; absent = today's behavior).
    if (opts.type) filter.type = opts.type
    if (typeof opts.minImportance === 'number') {
      filter.importance = { $gte: opts.minImportance }
    }
    if (opts.unresolved) filter.unresolved_thread = true

    const q = typeof opts.q === 'string' ? opts.q.trim() : ''
    if (q) {
      // Full-text over text/subjects/objects, ranked by relevance.
      filter.$text = { $search: q }
      return memories()
        .find(filter, { projection: { score: { $meta: 'textScore' } } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(100)
        .toArray()
    }

    return memories()
      .find(filter)
      .sort({ importance: -1, updated_at: -1 })
      .toArray()
  },

  /**
   * Promise/Quest Tracker (Phase 10): the open and recently-resolved story
   * threads — the same `unresolved_thread` atoms that feed the open-threads
   * prompt section. Open threads rank by importance; resolved ones by when
   * they closed. Read-only.
   */
  async listThreads(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)

    const [open, resolved] = await Promise.all([
      memories()
        .find({
          instance_id: iid,
          player_id: pid,
          unresolved_thread: true,
          is_archived: false,
        })
        .sort({ importance: -1, updated_at: -1 })
        .limit(50)
        .toArray(),
      memories()
        .find({
          instance_id: iid,
          player_id: pid,
          resolved_at: { $ne: null },
          is_archived: false,
        })
        .sort({ resolved_at: -1 })
        .limit(30)
        .toArray(),
    ])

    const shape = (m: (typeof open)[number]) => ({
      id: idString(m._id),
      text: m.text,
      type: m.type,
      importance: m.importance,
      emotional_valence: m.emotional_valence || null,
      resolved_at: m.resolved_at || null,
      time_anchor: m.time_anchor || null,
    })

    return { open: open.map(shape), resolved: resolved.map(shape) }
  },

  /**
   * Memory-aware recap (Phase 10): a "Story so far" card for re-entering a
   * world after time away. Deterministic — it reuses the latest scene summary
   * (already LLM prose) as the spine and layers the live open threads,
   * relationship standings, and current place/time on top. No new LLM call, so
   * it's free to open and always reflects the current projections.
   */
  async buildRecap(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const instance = await worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new Error('Instance not found')

    const [latestSummary, latestEvent, openThreads, bondCards] = await Promise.all([
      sceneSummaries().findOne(
        { instance_id: iid, status: { $ne: 'stale' } },
        { sort: { 'event_range.end_sequence': -1 } },
      ),
      // Main story only — a private side chat must never become the recap spine.
      events().findOne(
        { instance_id: iid, type: { $ne: 'side_chat' } },
        { sort: { sequence: -1 }, projection: { 'data.ai_response': 1, sequence: 1 } },
      ),
      memories()
        .find({ instance_id: iid, unresolved_thread: true, is_archived: false })
        .sort({ importance: -1, updated_at: -1 })
        .limit(5)
        .toArray(),
      // Cast members with a tracked bond, most-recently-touched first.
      characters()
        .find({ instance_id: iid, is_protagonist: { $ne: true }, relationship: { $exists: true } })
        .sort({ updated_at: -1 })
        .limit(4)
        .toArray(),
    ])

    // Prose spine: the most recent scene summary, else a trimmed snippet of the
    // last thing that happened so a young playthrough still gets a recap.
    let spine: string | null = latestSummary?.summary_text || null
    const lastResponse = latestEvent?.data?.ai_response
    if (!spine && lastResponse) {
      const raw = lastResponse.trim()
      spine = raw.length > 400 ? `${raw.slice(0, 400).trimEnd()}…` : raw
    }

    return {
      spine,
      where: instance.current_location?.name || null,
      when: instance.current_time_anchor?.event_time_label || null,
      open_threads: openThreads.map((m) => ({
        id: idString(m._id),
        text: m.text,
        importance: m.importance,
      })),
      bonds: bondCards.map((c) => ({
        id: idString(c._id),
        name: c.canonical_name,
        disposition: c.disposition_to_player || null,
        meters: c.relationship
          ? {
              trust: c.relationship.trust,
              affection: c.relationship.affection,
              fear: c.relationship.fear,
              rivalry: c.relationship.rivalry,
            }
          : null,
      })),
    }
  },

  async editMemory(memoryId: string, playerId: string, updates: any) {
    const mid = parseObjectId(memoryId)
    const pid = parseObjectId(playerId)

    const memory = await memories().findOne({
      _id: mid,
      player_id: pid,
    })
    if (!memory) throw new Error('Memory not found')

    const updateFields: Record<string, unknown> = { updated_at: new Date() }
    if (updates.text) updateFields.text = updates.text
    if (updates.type) updateFields.type = updates.type
    if (updates.importance !== undefined) updateFields.importance = updates.importance

    await memories().updateOne({ _id: mid }, { $set: updateFields })

    if (updates.text) {
      const newEmbedding = await embed(updates.text)
      const index = getPineconeIndex()
      const ns = idString(memory.instance_id)
      const namespace = index.namespace(`mem_${ns}`)

      const vectorMetadata: Record<string, string | number | boolean | string[]> = {
        text: updates.text,
        type: updates.type || memory.type,
        importance: updates.importance ?? memory.importance,
        is_nsfw: memory.is_nsfw,
        mongo_id: idString(mid),
        unresolved_thread: memory.unresolved_thread === true,
        created_at: memory.created_at.toISOString(),
      }
      if (memory.subjects && memory.subjects.length > 0) {
        vectorMetadata.subjects = memory.subjects
      }
      // Privacy scope must survive re-embedding: without it an edited
      // side-chat memory's vector would lose its origin and the fail-closed
      // metadata fallback in queryRag couldn't recognize it as private.
      if (memory.origin === 'side_chat') {
        vectorMetadata.origin = 'side_chat'
        vectorMetadata.known_by = (memory.known_by_entity_ids || []).map((id) => idString(id))
      }

      if (memory.pinecone_id) {
        await namespace.upsert({
          records: [{
            id: memory.pinecone_id,
            values: newEmbedding,
            metadata: vectorMetadata,
          }],
        })
      } else {
        const newVecId = randomUUID()
        await namespace.upsert({
          records: [{
            id: newVecId,
            values: newEmbedding,
            metadata: vectorMetadata,
          }],
        })
        await memories().updateOne(
          { _id: mid },
          { $set: { pinecone_id: newVecId, is_archived: false, status: 'active' } },
        )
      }
    }

    return { success: true }
  },

  async deleteMemory(memoryId: string, playerId: string) {
    const mid = parseObjectId(memoryId)
    const pid = parseObjectId(playerId)

    const memory = await memories().findOne({
      _id: mid,
      player_id: pid,
    })
    if (!memory) throw new Error('Memory not found')

    if (memory.pinecone_id) {
      const index = getPineconeIndex()
      const ns = idString(memory.instance_id)
      await index.namespace(`mem_${ns}`).deleteOne({ id: memory.pinecone_id })
    }

    await memories().deleteOne({ _id: mid })
    await worldInstances().updateOne(
      { _id: memory.instance_id },
      { $inc: { 'meta.total_memories': -1 } },
    )

    return { success: true }
  },

  /**
   * Rewind a playthrough to a chosen turn: removes the event at [sequence] and
   * every event after it, then rolls everything back to that point —
   *  - deletes memories sourced from the removed turns (+ their Pinecone vectors,
   *    so they can't resurface via RAG),
   *  - deletes scene summaries covering the removed range,
   *  - recomputes world_state / active_flags by replaying the surviving turns
   *    from the template defaults (stats are stored as deltas, not snapshots),
   *  - recomputes the current scene + meta counts,
   *  - busts the cached session so the next turn rebuilds from fresh state.
   */
  async rewindToSequence(instanceId: string, playerId: string, sequence: number) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)

    const instance = await worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new Error('Instance not found')

    const template = await worldTemplates().findOne({ _id: instance.template_id })
    if (!template) throw new Error('Template not found')

    // Events being removed: the chosen turn and everything after it.
    const doomed = await events()
      .find({ instance_id: iid, sequence: { $gte: sequence } }, { projection: { _id: 1 } })
      .toArray()
    const doomedIds = doomed.map((e) => e._id)

    // 1. Memories sourced from removed turns → delete docs + Pinecone vectors.
    let deletedMemories = 0
    if (doomedIds.length > 0) {
      const mems = await memories()
        .find(
          { instance_id: iid, source_event_ids: { $in: doomedIds } },
          { projection: { _id: 1, pinecone_id: 1 } },
        )
        .toArray()
      if (mems.length > 0) {
        const ns = getPineconeIndex().namespace(`mem_${instanceId}`)
        for (const m of mems) {
          if (!m.pinecone_id) continue
          try {
            await ns.deleteOne({ id: m.pinecone_id })
          } catch (err) {
            console.warn('Rewind: failed to delete vector', m.pinecone_id, (err as Error).message)
          }
        }
        await memories().deleteMany({ _id: { $in: mems.map((m) => m._id) } })
        deletedMemories = mems.length
      }
    }

    // 2. Scene + chapter summaries covering the removed range, plus their
    //    Pinecone vectors (summary retrieval namespace).
    const doomedSummaries = await sceneSummaries()
      .find(
        { instance_id: iid, 'event_range.end_sequence': { $gte: sequence } },
        { projection: { pinecone_id: 1 } },
      )
      .toArray()
    const doomedChapters = await chapterSummaries()
      .find(
        { instance_id: iid, 'event_range.end_sequence': { $gte: sequence } },
        { projection: { pinecone_id: 1 } },
      )
      .toArray()
    const doomedArcs = await arcSummaries()
      .find(
        { instance_id: iid, 'event_range.end_sequence': { $gte: sequence } },
        { projection: { pinecone_id: 1 } },
      )
      .toArray()
    const summaryVecIds = [...doomedSummaries, ...doomedChapters, ...doomedArcs]
      .map((s) => s.pinecone_id)
      .filter((id): id is string => !!id)
    if (summaryVecIds.length > 0) {
      try {
        await getPineconeIndex()
          .namespace(`sum_${idString(iid)}`)
          .deleteMany({ ids: summaryVecIds })
      } catch (err) {
        console.warn('rewind: summary vector cleanup failed:', (err as Error).message)
      }
    }
    await sceneSummaries().deleteMany({
      instance_id: iid,
      'event_range.end_sequence': { $gte: sequence },
    })
    await chapterSummaries().deleteMany({
      instance_id: iid,
      'event_range.end_sequence': { $gte: sequence },
    })
    await arcSummaries().deleteMany({
      instance_id: iid,
      'event_range.end_sequence': { $gte: sequence },
    })

    // 3. The events themselves.
    await events().deleteMany({ instance_id: iid, sequence: { $gte: sequence } })

    // 3b. Rebuild the character codex as an EXACT projection of the surviving
    // ledger. The per-turn codex deltas are stored on each event (like
    // state_mutations), so the codex is replayed deterministically from the
    // survivors — no LLM, and not one fact or relationship-meter value from a
    // removed turn can linger. The protagonist's authored/onboarded identity is
    // re-seeded first so replayed deltas attach to it; its evolved facts/state
    // then rebuild from the surviving deltas too.
    const priorProtagonist = await characters().findOne({ instance_id: iid, is_protagonist: true })
    const reseedProtagonist = async () => {
      const protoName = priorProtagonist?.canonical_name || template.protagonist?.name
      if (!protoName) return
      await characterCodexService.seedProtagonist({
        instanceId,
        playerId,
        name: protoName,
        persona: priorProtagonist?.persona ?? template.protagonist?.persona,
        appearance: priorProtagonist?.appearance ?? template.protagonist?.appearance,
        aliases: priorProtagonist?.aliases || [],
        isPlayer: !template.is_sentient,
      })
    }
    // Load the surviving events ONCE, projecting only the fields the two
    // replays need (state/flag/codex deltas + scene tag) — never the full prose
    // or replay variants. Reused for both the codex rebuild here and the
    // world-state replay in step 4, so a deep rewind doesn't pull the entire
    // (potentially huge) transcript into memory, let alone twice.
    const survivors = await events()
      .find(
        { instance_id: iid },
        {
          projection: {
            sequence: 1,
            scene_tag: 1,
            time_anchor: 1,
            location_anchor: 1,
            'data.state_mutations': 1,
            'data.flag_mutations': 1,
            'data.codex_deltas': 1,
          },
        },
      )
      .sort({ sequence: 1 })
      .toArray()
    const hasLedgeredDeltas = survivors.some((e) => Array.isArray(e.data?.codex_deltas))

    if (hasLedgeredDeltas) {
      // Exact rebuild: drop the whole codex, restore protagonist identity, then
      // replay the surviving turns' stored deltas. The replay folds entirely in
      // memory and persists with a single bulk write, so a rewind at turn
      // 13,567 costs the same as one at turn 13 — no per-turn DB round-trips.
      await characters().deleteMany({ instance_id: iid })
      await reseedProtagonist()
      const batches = survivors
        .filter((ev) => Array.isArray(ev.data?.codex_deltas) && ev.data.codex_deltas.length > 0)
        .map((ev) => ({ sequence: ev.sequence, deltas: ev.data!.codex_deltas! }))
      await characterCodexService.rebuildCodexFromLedger({ instanceId, playerId, batches })
    } else {
      // Legacy worlds whose events predate ledgered deltas: there is nothing to
      // replay, so fall back to provenance pruning — keep the pre-rewind cast,
      // delete only characters first introduced in removed turns, clamp
      // survivors' last_seen. New play accrues deltas, so a later rewind of the
      // same world becomes exact.
      await characters().deleteMany({ instance_id: iid, first_seen_sequence: { $gte: sequence } })
      await characters().updateMany(
        { instance_id: iid, last_seen_sequence: { $gte: sequence } },
        { $set: { last_seen_sequence: Math.max(0, sequence - 1) } },
      )
      const survivingProtagonist = await characters().findOne({ instance_id: iid, is_protagonist: true })
      if (!survivingProtagonist) await reseedProtagonist()
    }

    // 3c. Entity-graph repair: entities born in removed turns are deleted,
    // edge provenance from removed events is pruned (empty edges dropped),
    // character entities re-link to the freshly re-minted codex cards, and
    // meter edges re-project from the rebuilt relationship ledger. Best-effort:
    // a graph hiccup must never abort the rewind itself.
    try {
      await entityGraphService.repairAfterRewind({
        instanceId,
        playerId,
        sequence,
        doomedEventIds: doomedIds,
        lastSurvivingEventId: survivors.length ? survivors[survivors.length - 1]._id : null,
      })
    } catch (err) {
      console.warn('Rewind: entity graph repair failed:', (err as Error).message)
    }

    // 4. Replay survivors from template defaults to rebuild state.
    const statLimits: Record<string, { min: number; max: number }> = {}
    let worldState: Record<string, number> = {}
    for (const [key, def] of Object.entries(template.base_stats_template)) {
      worldState[key] = def.default
      statLimits[key] = { min: def.min, max: def.max }
    }
    let activeFlags: Record<string, unknown> = {}
    for (const [key, def] of Object.entries(template.flag_definitions || {})) {
      activeFlags[key] = def.default
    }

    // Reuse the single projected load fetched above (no second full scan).
    for (const ev of survivors) {
      worldState = applyStateMutations(worldState, ev.data?.state_mutations || {}, statLimits)
      activeFlags = applyFlagMutations(activeFlags, ev.data?.flag_mutations || {})
    }

    // 5. Current scene from the tail of survivors.
    const last = survivors[survivors.length - 1]
    const sceneTag = last?.scene_tag || 'dialogue'
    let turnCount = 0
    for (let i = survivors.length - 1; i >= 0; i--) {
      if (survivors[i].scene_tag === sceneTag) turnCount++
      else break
    }
    const rewindTimeAnchor =
      last?.time_anchor ||
      (await timeService.initialAnchor({
        instanceId,
        templateId: idString(template._id),
        sequence: 0,
      }))
    const rewindLocation = last?.location_anchor || null

    // 6. Persist rolled-back instance state.
    await worldInstances().updateOne(
      { _id: iid },
      {
        $set: {
          world_state: worldState,
          active_flags: activeFlags,
          current_scene: { tag: sceneTag, turn_count: turnCount, summary_pending: false },
          current_time_anchor: rewindTimeAnchor,
          active_timeline_id: rewindTimeAnchor.timeline_id,
          default_calendar_id: rewindTimeAnchor.story_calendar?.calendar_id,
          current_location: rewindLocation,
          focus_character_id: null,
          'meta.total_events': survivors.length,
          'meta.total_memories': Math.max(0, (instance.meta?.total_memories || 0) - deletedMemories),
          // Milestones earned in the removed turns no longer happened.
          'meta.milestones': (instance.meta?.milestones || []).filter((m) => m.sequence < sequence),
          // The fate-seed marker may point at a removed turn; clamp it below the
          // rewind point so fate seeding isn't blocked on surviving play.
          'meta.last_fate_seed_sequence': Math.min(
            instance.meta?.last_fate_seed_sequence || 0,
            Math.max(0, sequence - 1),
          ),
          updated_at: new Date(),
        },
      },
    )

    // 7. Drop the cached session so the next generation uses fresh state.
    await getRedisClient().del(`session:${instanceId}`)

    return { success: true, deletedEvents: doomedIds.length, deletedMemories }
  },

  async editEvent(eventId: string, playerId: string, updates: any) {
    const eid = parseObjectId(eventId)
    const pid = parseObjectId(playerId)

    const event = await events().findOne({
      _id: eid,
      player_id: pid,
    })
    if (!event) throw new Error('Event not found')

    const nextAiResponse = updates.ai_response ?? event.data.ai_response
    const nextPlayerInput = updates.player_input ?? event.data.player_input
    const parsedPlayerInput = parsePlayerInput(nextPlayerInput || '')
    const aiChanged =
      typeof updates.ai_response === 'string' &&
      updates.ai_response !== event.data.ai_response
    const playerChanged =
      typeof updates.player_input === 'string' &&
      updates.player_input !== event.data.player_input
    const contentChanged = aiChanged || playerChanged
    const replayVariants = normalizeReplayVariants(event)
    const [editCharacterNames, editInstance] = await Promise.all([
      characterNamesForInstance(event.instance_id),
      worldInstances().findOne({ _id: event.instance_id, player_id: pid }, { projection: { message_length: 1, narration_pov: 1, template_id: 1 } }),
    ])
    const editTemplate = editInstance
      ? await worldTemplates().findOne({ _id: editInstance.template_id }, { projection: { is_sentient: 1 } })
      : null
    const proseHygieneIssues = validateProseHygiene({
      narrative: nextAiResponse || '',
      characterNames: editCharacterNames,
      messageLength: editInstance?.message_length || 'medium',
      playerAddressMode: editTemplate?.is_sentient ? 'you' : editInstance?.narration_pov === 'first' ? 'you' : 'role',
      avoidOpeningNames: editCharacterNames,
    })
    let nextReplayVariants = replayVariants
    let nextSelectedReplayIndex =
      typeof event.data?.selected_replay_index === 'number'
        ? event.data.selected_replay_index
        : Math.max(0, replayVariants.length - 1)

    if (aiChanged && typeof nextAiResponse === 'string' && nextAiResponse.trim()) {
      nextReplayVariants = [...replayVariants]
      if (nextReplayVariants[nextReplayVariants.length - 1]?.narrative !== nextAiResponse) {
        nextReplayVariants.push({
          id: randomUUID(),
          narrative: nextAiResponse,
          model_used: event.data?.model_used || AI_MODELS.narrationSfw,
          created_at: new Date(),
          source: 'edit',
          prose_hygiene_issues: proseHygieneIssues,
        })
      }
      nextSelectedReplayIndex = nextReplayVariants.length - 1
    }

    await events().updateOne(
      { _id: eid },
      {
        $push: {
          edit_history: {
            previous_data: event.data,
            edited_at: new Date(),
          },
        },
        $set: {
          'data.ai_response': nextAiResponse,
          'data.player_input': nextPlayerInput,
          'data.player_spoken_input': parsedPlayerInput.spoken,
          'data.player_narration_facts': parsedPlayerInput.narrationFacts,
          'data.replay_variants': nextReplayVariants,
          'data.selected_replay_index': nextSelectedReplayIndex,
          'data.prose_hygiene_issues': proseHygieneIssues,
          // A rewritten narrative invalidates the old next-move chips and the
          // scene's presence list (who was in the room may have changed).
          ...(aiChanged ? { 'data.choices': [], 'data.present_characters': [] } : {}),
          is_user_edited: true,
          updated_at: new Date(),
        },
      } as import('mongodb').UpdateFilter<import('../models/world-event.model').WorldEventDoc>,
    )

    let deletedMemories = 0

    if (contentChanged) {
      deletedMemories = await recurateMemoriesForEvent(
        event,
        playerId,
        parsedPlayerInput.raw,
        parsedPlayerInput.spoken,
        parsedPlayerInput.narrationFacts,
        nextAiResponse || '',
      )
      await staleSummariesCoveringEvent(event)
    }

    return {
      success: true,
      memories_deleted: deletedMemories,
      recuration_queued: contentChanged,
    }
  },

  /**
   * Generate an alternative response for an event. When [onDelta] is supplied
   * the narration is streamed token-by-token through the callback (used by the
   * streaming worker path); otherwise it is generated in one shot (REST).
   */
  async replayEvent(
    eventId: string,
    playerId: string,
    onDelta?: (chunk: string) => void,
  ) {
    const eid = parseObjectId(eventId)
    const pid = parseObjectId(playerId)

    const event = await events().findOne({ _id: eid, player_id: pid })
    if (!event) throw new Error('Event not found')
    if (!(event.data?.ai_response || '').trim() || event.data?.model_used === 'seed') {
      throw new Error('Replay is only supported for generated AI turns')
    }

    // Keep state consistency simple: replay only the latest turn in a thread.
    const newerCount = await events().countDocuments({
      instance_id: event.instance_id,
      sequence: { $gt: event.sequence },
    })
    if (newerCount > 0) {
      throw new Error('Replay is only available for the latest turn. Rewind first for earlier turns.')
    }

    const instance = await worldInstances().findOne({ _id: event.instance_id, player_id: pid })
    if (!instance) throw new Error('Instance not found')
    const template = await worldTemplates().findOne({ _id: instance.template_id })
    if (!template) throw new Error('Template not found')

    const player = await users().findOne(
      { _id: pid },
      { projection: { 'preferences.nsfw_enabled': 1 } },
    )
    const userNsfwEnabled = player?.preferences?.nsfw_enabled === true

    const parsed = parsePlayerInput(event.data.player_input || '')
    const replayVariants = normalizeReplayVariants(event)
    const replayDepth = replayVariants.length // 1-based progression after base

    // Incremental retrieval widening per replay, bounded aggressively.
    const factor = Math.min(1 + replayDepth * 0.35, 2.5)
    const loreTopK = Math.min(Math.max(Math.round((template.max_lore_results || 10) * factor), template.max_lore_results || 10), 40)
    const memoryTopK = Math.min(Math.max(Math.round((template.max_context_memories || 25) * factor), template.max_context_memories || 25), 80)
    const recentWindow = Math.min(6 + replayDepth * 2, 20)

    const priorEvents = await events()
      .find({ instance_id: event.instance_id, sequence: { $lt: event.sequence } })
      .sort({ sequence: -1 })
      .limit(recentWindow)
      .toArray()
    priorEvents.reverse()

    const activeSummary = await sceneSummaries().findOne(
      {
        instance_id: event.instance_id,
        'event_range.end_sequence': { $lt: priorEvents[0]?.sequence || 0 },
        status: { $ne: 'stale' },
      },
      { sort: { 'event_range.end_sequence': -1 } },
    )

    const codex = await characters()
      .find({ instance_id: event.instance_id })
      .sort({ mention_count: -1, updated_at: -1 })
      .limit(16)
      .toArray()
    const replayCodex: any[] = [...(codex as any[])]
    if (
      template.is_sentient &&
      template.protagonist?.name &&
      !replayCodex.some((c) => c.is_protagonist || c.canonical_name === template.protagonist?.name)
    ) {
      replayCodex.unshift({
        canonical_name: template.protagonist.name,
        persona: template.protagonist.persona,
        appearance: template.protagonist.appearance,
        immutable_facts: [],
        mutable_state: [],
        mention_count: 0,
        last_seen_sequence: event.sequence,
        is_protagonist: true,
      })
    }

    const ragQuery = parsed.raw || event.data.ai_response || template.seed_prompt
    const rag = await queryRag(
      idString(template._id),
      idString(event.instance_id),
      ragQuery,
      loreTopK,
      memoryTopK,
    )

    const mode = instance.mode || DEFAULT_CHAT_MODE
    const modeWantsNsfw = mode === NSFW_MODE
    const sceneClass =
      template.is_nsfw_capable && userNsfwEnabled
        ? modeWantsNsfw
          ? 'nsfw'
          : classifyScene(parsed.raw, priorEvents)
        : 'sfw'
    const modelId = sceneClass === 'nsfw'
      ? (template.model_preferences?.narration_nsfw || AI_MODELS.narrationNsfw)
      : (template.model_preferences?.narration_sfw || AI_MODELS.narrationSfw)

    const prompt = buildPrompt({
      seedPrompt: template.seed_prompt,
      isSentient: template.is_sentient,
      worldState: instance.world_state,
      activeFlags: instance.active_flags,
      globalLore: template.global_lore,
      retrievedLore: rag.loreTexts,
      retrievedMemories: rag.memoryTexts,
      openThreads: rag.openThreads,
      sceneSummary: activeSummary?.summary_text || null,
      recentEvents: priorEvents,
      userMessage: parsed.spoken || '[No spoken dialogue from player this turn.]',
      userSpokenInput: parsed.spoken,
      userNarrationFacts: parsed.narrationFacts,
      maxTokens: 7000,
      proseOnly: true,
      narrationPov: instance.narration_pov || 'third',
      chatMode: mode,
      narrativeStyle: template.narrative_style || '',
      styleNotes: template.style_notes || '',
      playerPersona: instance.persona_snapshot || null,
      messageLength: instance.message_length || 'medium',
      characterCodex: replayCodex,
      focusCharacterName: (() => {
        const fid = instance.focus_character_id ? idString(instance.focus_character_id) : ''
        const c = replayCodex.find((x) => x._id && idString(x._id) === fid)
        return c?.canonical_name
      })(),
    })

    const replayDirective = replayVariants
      .slice(-3)
      .map((v, i) => `Variant ${replayVariants.length - Math.min(3, replayVariants.length) + i + 1}: ${continuityText(v.narrative || '')}`)
      .join('\n')

    // The replay directive MUST sit BEFORE the final user turn. If appended
    // after it, the model often "answers" the directive — emitting the raw
    // REQUIREMENTS/bullet text instead of narrating. Splicing it in just before
    // the user message keeps the user turn last, so the model replies in-story.
    const baseMessages = prompt.messages
    const lastUserTurn = baseMessages[baseMessages.length - 1]
    const head = baseMessages.slice(0, -1)
    const replayMessages = [
      ...head,
      {
        role: 'system',
        content: `REPLAY OPTIMIZATION DIRECTIVE (instruction — do NOT repeat or quote this; respond only with in-character story prose):
- Produce a DISTINCT alternative response to the same turn.
- Improve precision, characterization, and continuity.
- Keep canonical narration facts true.
- Keep within context constraints (do not invent off-screen lore).
- If prior variants were weak, correct that.

REPLAY HYGIENE:
- This is an alternative handling of the SAME story beat, not a new timeline branch.
- Keep the same player intent, scene scope, involved characters, and canonical facts.
- Do not introduce new named characters, locations, lore, danger, romance, or escalation merely to be distinct.
- Distinct means better characterization, clearer prose, sharper continuity, cleaner formatting, or better pacing.
- If prior variants had hygiene issues, fix them; do not imitate their wording, structure, or mistakes.
- Do not line-edit, paraphrase, or lightly expand the immediately previous variant. Recompose the beat from the player turn and continuity facts.
- Preserve the player's *action/narration* facts as already happened in this same beat; never respond as if those actions are only pending.
- Natural conversation flow is mandatory: do not open with a character name, do not repeat protagonist or side-character names unless clarity requires it, and avoid full canonical names in ordinary narration.

Recent variants (for contrast, do not copy):
${replayDirective || '(none)'}`,
      },
      lastUserTurn,
    ]
    const replayTemp = Math.max(0.4, 0.68 - replayDepth * 0.04)
    // Match the alternative's length budget to the player's chosen reply length,
    // exactly like the primary turn — so a regenerate respects short/medium/long
    // instead of always running to a fixed 900-token ceiling.
    const replayMaxTokens = lengthMaxTokens(instance.message_length || 'medium')
    const replayNarrative = onDelta
      ? await callLLMStream(
          { model: modelId, messages: replayMessages, temperature: replayTemp, maxTokens: replayMaxTokens },
          onDelta,
        )
      : await callLLM({
          model: modelId,
          messages: replayMessages,
          temperature: replayTemp,
          maxTokens: replayMaxTokens,
        })
    const repairedReplay = await repairProseHygiene({
      narrative: replayNarrative.trim(),
      characterNames: replayCodex.map((c) => c.canonical_name),
      messageLength: instance.message_length || 'medium',
      playerAddressMode: template.is_sentient ? 'you' : (instance.narration_pov || 'third') === 'first' ? 'you' : 'role',
      previousOpeningNames: (() => {
        const previousOpeningName = openingCharacterName(
          priorEvents,
          replayCodex.map((c) => c.canonical_name),
        )
        return previousOpeningName ? [previousOpeningName] : []
      })(),
      avoidOpeningNames: replayCodex.map((c) => c.canonical_name),
      model: modelId,
    })

    const nextVariant = {
      id: randomUUID(),
      narrative: repairedReplay.narrative,
      model_used: modelId,
      created_at: new Date(),
      source: 'replay',
      prose_hygiene_issues: repairedReplay.issues,
      retrieval_profile: {
        lore_top_k: loreTopK,
        memory_top_k: memoryTopK,
        recent_event_window: recentWindow,
      },
    }
    const nextVariants = [...replayVariants, nextVariant]
    const selectedIdx = nextVariants.length - 1

    await events().updateOne(
      { _id: eid },
      {
        $push: {
          edit_history: {
            previous_data: event.data,
            edited_at: new Date(),
          },
        },
        $set: {
          'data.ai_response': nextVariant.narrative,
          'data.model_used': modelId,
          'data.replay_variants': nextVariants,
          'data.selected_replay_index': selectedIdx,
          'data.prose_hygiene_issues': repairedReplay.issues,
          // Stale tap-to-play chips + presence: derived from the prior prose.
          'data.choices': [],
          'data.present_characters': [],
          updated_at: new Date(),
        },
      } as import('mongodb').UpdateFilter<import('../models/world-event.model').WorldEventDoc>,
    )

    const deletedMemories = await recurateMemoriesForEvent(
      event,
      playerId,
      parsed.raw,
      parsed.spoken,
      parsed.narrationFacts,
      nextVariant.narrative,
    )
    await staleSummariesCoveringEvent(event)

    const updated = await events().findOne({ _id: eid })
    return {
      success: true,
      event: updated,
      replay_count: nextVariants.length,
      selected_index: selectedIdx,
      memories_deleted: deletedMemories,
    }
  },

  async selectReplayVariant(eventId: string, playerId: string, variantIndex: number) {
    const eid = parseObjectId(eventId)
    const pid = parseObjectId(playerId)
    const event = await events().findOne({ _id: eid, player_id: pid })
    if (!event) throw new Error('Event not found')

    const variants = normalizeReplayVariants(event)
    if (variantIndex < 0 || variantIndex >= variants.length) {
      throw new Error('Invalid replay variant index')
    }

    const chosen = variants[variantIndex]
    const nextAi = chosen.narrative || event.data.ai_response || ''
    const changed = nextAi !== event.data.ai_response
    const [selectedCharacterNames, selectedInstance] = await Promise.all([
      characterNamesForInstance(event.instance_id),
      worldInstances().findOne({ _id: event.instance_id, player_id: pid }, { projection: { message_length: 1, narration_pov: 1, template_id: 1 } }),
    ])
    const selectedTemplate = selectedInstance
      ? await worldTemplates().findOne({ _id: selectedInstance.template_id }, { projection: { is_sentient: 1 } })
      : null
    const proseHygieneIssues =
      Array.isArray(chosen.prose_hygiene_issues)
        ? chosen.prose_hygiene_issues
        : validateProseHygiene({
            narrative: nextAi,
            characterNames: selectedCharacterNames,
            messageLength: selectedInstance?.message_length || 'medium',
            playerAddressMode: selectedTemplate?.is_sentient ? 'you' : selectedInstance?.narration_pov === 'first' ? 'you' : 'role',
            avoidOpeningNames: selectedCharacterNames,
          })

    await events().updateOne(
      { _id: eid },
      {
        $push: {
          edit_history: {
            previous_data: event.data,
            edited_at: new Date(),
          },
        },
        $set: {
          'data.ai_response': nextAi,
          'data.model_used': chosen.model_used || event.data.model_used,
          'data.replay_variants': variants,
          'data.selected_replay_index': variantIndex,
          'data.prose_hygiene_issues': proseHygieneIssues,
          // Chips + presence belonged to the previously-selected variant's prose.
          ...(changed ? { 'data.choices': [], 'data.present_characters': [] } : {}),
          updated_at: new Date(),
        },
      } as import('mongodb').UpdateFilter<import('../models/world-event.model').WorldEventDoc>,
    )

    let deletedMemories = 0
    if (changed) {
      const parsed = parsePlayerInput(event.data.player_input || '')
      deletedMemories = await recurateMemoriesForEvent(
        event,
        playerId,
        parsed.raw,
        parsed.spoken,
        parsed.narrationFacts,
        nextAi,
      )
      await staleSummariesCoveringEvent(event)
    }

    const updated = await events().findOne({ _id: eid })
    return {
      success: true,
      event: updated,
      replay_count: variants.length,
      selected_index: variantIndex,
      memories_deleted: deletedMemories,
    }
  },
}
