import { ObjectId } from 'mongodb'
import { Job } from 'bullmq'
import { mongoColl } from '../../src/config/mongo'
import { callLLM, AI_MODELS } from '../../src/ai'
import { parseObjectId } from '../../src/utils/mongo-id'

export async function summaryProcessor(job: Job) {
  const { instanceId, sceneTag, startSequence, endSequence } = job.data
  const instanceOid = parseObjectId(instanceId)

  const events = await mongoColl.events()
    .find({
      instance_id: instanceOid,
      sequence: { $gte: startSequence, $lte: endSequence },
    })
    .sort({ sequence: 1 })
    .toArray()

  if (events.length < 6) return { skipped: true }

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

  const summary = {
    _id: new ObjectId(),
    instance_id: instanceOid,
    scene_tag: sceneTag,
    event_range: { start_sequence: startSequence, end_sequence: endSequence },
    summary_text: summaryResult,
    key_facts_extracted: [],
    model_used: AI_MODELS.sceneSummary,
    tokens_consumed: 0,
    created_at: new Date(),
  }

  await mongoColl.sceneSummaries().insertOne(summary)

  await mongoColl.worldInstances().updateOne(
    { _id: instanceOid },
    { $set: { 'current_scene.summary_pending': false } },
  )

  return { summaryId: summary._id }
}
