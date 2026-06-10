import { ObjectId } from 'mongodb'
import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { getPineconeIndex } from '../../src/config/pinecone'
import { callLLM, embed, AI_MODELS } from '../../src/ai'
import { parseObjectId, idString } from '../../src/utils/mongo-id'
import { getSceneSummaryQueue, QUEUE_RETENTION } from '../../src/queues'
import { log } from '../../src/utils/logger'

/** Roll up a fixed block of consecutive scene summaries into one chapter. */
const CHAPTER_SCENE_BLOCK = 8

/**
 * Embed a summary into Pinecone for semantic summary retrieval. The vector id is
 * deterministic per range/tier (`<tier>_<start>_<end>`) so a rebuild for the
 * same span overwrites in place — no orphan vectors. Best-effort: an embedding
 * failure leaves the Mongo summary intact (just not retrievable until rebuilt).
 */
async function embedSummary(
  instanceOid: ReturnType<typeof parseObjectId>,
  tier: 'scene' | 'chapter',
  startSequence: number,
  endSequence: number,
  text: string,
): Promise<string | null> {
  const vecId = `${tier}_${startSequence}_${endSequence}`
  try {
    const values = await embed(text)
    await getPineconeIndex()
      .namespace(`sum_${idString(instanceOid)}`)
      .upsert({
        records: [
          {
            id: vecId,
            values,
            metadata: { tier, text, start_sequence: startSequence, end_sequence: endSequence },
          },
        ],
      })
    return vecId
  } catch (err) {
    log.warn('summary.embed_failed', { tier, startSequence, endSequence, error: (err as Error).message })
    return null
  }
}

export async function summaryProcessor(job: Job) {
  // The 'scene-summary' worker handles both tiers; chapter jobs are discriminated
  // by `kind` so we don't need a second queue/worker registration.
  if (job.data.kind === 'chapter') {
    return chapterRollup(job)
  }

  const { instanceId, sceneTag, startSequence, endSequence } = job.data
  const instanceOid = parseObjectId(instanceId)
  log.info('scene_summary.started', {
    jobId: job.id,
    instanceId,
    sceneTag,
    startSequence,
    endSequence,
  })

  const events = await mongoColl.events()
    .find({
      instance_id: instanceOid,
      sequence: { $gte: startSequence, $lte: endSequence },
    })
    .sort({ sequence: 1 })
    .toArray()

  if (events.length < 6) {
    await mongoColl.worldInstances().updateOne(
      { _id: instanceOid },
      { $set: { 'current_scene.summary_pending': false } },
    )
    log.warn('scene_summary.skipped', {
      jobId: job.id,
      instanceId,
      sceneTag,
      startSequence,
      endSequence,
      eventsFound: events.length,
      reason: 'insufficient_events',
    })
    return { skipped: true }
  }

  const conversationText = events
    .map((e) => `[Turn ${e.sequence}] Player: ${e.data.player_input}\nWorld: ${e.data.ai_response}`)
    .join('\n\n')

  const summaryResult = await callLLM({
    model: AI_MODELS.sceneSummary,
    messages: [
      {
        role: 'system',
        content: `Compress the following scene into exactly 2 paragraphs. Preserve: key decisions, emotional shifts, promises made/broken, state changes, and any NSFW content descriptors (but do not write explicit content in the summary — just note "an intimate scene occurred" or similar). The summary must be self-contained and understandable without the original text.`,
      },
      { role: 'user', content: conversationText },
    ],
    temperature: 0.3,
    maxTokens: 400,
  })

  const pineconeId = await embedSummary(
    instanceOid,
    'scene',
    startSequence,
    endSequence,
    summaryResult,
  )

  const summary = {
    _id: new ObjectId(),
    instance_id: instanceOid,
    scene_tag: sceneTag,
    event_range: { start_sequence: startSequence, end_sequence: endSequence },
    summary_text: summaryResult,
    key_facts_extracted: [],
    model_used: AI_MODELS.sceneSummary,
    tokens_consumed: 0,
    pinecone_id: pineconeId,
    status: 'active' as const,
    created_at: new Date(),
  }

  // Replace, don't accumulate: a rebuild for the same range (e.g. after an
  // event edit staled the original) supersedes the previous summary row.
  await mongoColl.sceneSummaries().deleteMany({
    instance_id: instanceOid,
    'event_range.start_sequence': startSequence,
    'event_range.end_sequence': endSequence,
  })
  await mongoColl.sceneSummaries().insertOne(summary)

  await mongoColl.worldInstances().updateOne(
    { _id: instanceOid },
    { $set: { 'current_scene.summary_pending': false } },
  )

  log.info('scene_summary.succeeded', {
    jobId: job.id,
    instanceId,
    sceneTag,
    startSequence,
    endSequence,
    summaryId: summary._id.toString(),
  })

  // A completed scene may close out a chapter's worth of scenes.
  await maybeQueueChapter(instanceOid)

  return { summaryId: summary._id }
}

/**
 * Enqueue a chapter rollup when CHAPTER_SCENE_BLOCK active scene summaries have
 * accumulated beyond the last chapter's coverage. Each scene completion rolls at
 * most one chapter, which keeps the cost flat as a playthrough grows.
 */
async function maybeQueueChapter(instanceOid: ObjectId): Promise<void> {
  const lastChapter = await mongoColl.chapterSummaries().findOne(
    { instance_id: instanceOid },
    { sort: { 'event_range.end_sequence': -1 } },
  )
  const coveredThrough = lastChapter?.event_range.end_sequence ?? 0

  const pending = await mongoColl.sceneSummaries()
    .find({
      instance_id: instanceOid,
      status: { $ne: 'stale' },
      'event_range.end_sequence': { $gt: coveredThrough },
    })
    .sort({ 'event_range.end_sequence': 1 })
    .toArray()

  if (pending.length < CHAPTER_SCENE_BLOCK) return

  const block = pending.slice(0, CHAPTER_SCENE_BLOCK)
  const queue = getSceneSummaryQueue()
  await queue.add(
    'summarize',
    {
      kind: 'chapter',
      instanceId: idString(instanceOid),
      chapterIndex: (lastChapter?.chapter_index ?? 0) + 1,
      startSequence: block[0].event_range.start_sequence,
      endSequence: block[block.length - 1].event_range.end_sequence,
      sceneSummaryIds: block.map((s) => idString(s._id)),
    },
    {
      priority: 16,
      removeOnComplete: QUEUE_RETENTION.sceneSummary.removeOnComplete,
      removeOnFail: QUEUE_RETENTION.sceneSummary.removeOnFail,
    },
  )
}

/** Compress a block of consecutive scene summaries into one chapter paragraph. */
async function chapterRollup(job: Job) {
  const { instanceId, chapterIndex, startSequence, endSequence } = job.data
  const instanceOid = parseObjectId(instanceId)

  // Fetch the child scenes by EVENT RANGE, not by stored id: scene summaries are
  // replaced (new _id) when rebuilt, so a range query stays correct across edits.
  const scenes = await mongoColl.sceneSummaries()
    .find({
      instance_id: instanceOid,
      status: { $ne: 'stale' },
      'event_range.start_sequence': { $gte: startSequence },
      'event_range.end_sequence': { $lte: endSequence },
    })
    .sort({ 'event_range.start_sequence': 1 })
    .toArray()

  if (scenes.length < 2) {
    log.warn('chapter_summary.skipped', { jobId: job.id, instanceId, chapterIndex, scenesFound: scenes.length })
    return { skipped: true }
  }

  const body = scenes
    .map((s, i) => `Scene ${i + 1}: ${s.summary_text}`)
    .join('\n\n')

  const summaryText = await callLLM({
    model: AI_MODELS.sceneSummary,
    messages: [
      {
        role: 'system',
        content: `Weave these consecutive scene summaries into a single cohesive CHAPTER summary of 2-3 paragraphs. Preserve the through-line: key decisions, relationship shifts, promises made or broken, debts, threats, and major state changes across the whole span. Keep NSFW descriptors non-explicit (e.g. "an intimate scene occurred"). The chapter must be self-contained and understandable on its own.`,
      },
      { role: 'user', content: body },
    ],
    temperature: 0.3,
    maxTokens: 500,
  })

  const pineconeId = await embedSummary(
    instanceOid,
    'chapter',
    startSequence,
    endSequence,
    summaryText,
  )

  const chapter = {
    _id: new ObjectId(),
    instance_id: instanceOid,
    chapter_index: chapterIndex,
    event_range: { start_sequence: startSequence, end_sequence: endSequence },
    scene_summary_ids: scenes.map((s) => s._id),
    summary_text: summaryText,
    model_used: AI_MODELS.sceneSummary,
    tokens_consumed: 0,
    pinecone_id: pineconeId,
    status: 'active' as const,
    created_at: new Date(),
  }

  // Replace-on-range, mirroring scene summaries: a rebuild for the same span
  // supersedes the prior chapter row.
  await mongoColl.chapterSummaries().deleteMany({
    instance_id: instanceOid,
    'event_range.start_sequence': startSequence,
    'event_range.end_sequence': endSequence,
  })
  await mongoColl.chapterSummaries().insertOne(chapter)

  log.info('chapter_summary.succeeded', {
    jobId: job.id,
    instanceId,
    chapterIndex,
    startSequence,
    endSequence,
    chapterId: chapter._id.toString(),
  })

  return { chapterId: chapter._id }
}
