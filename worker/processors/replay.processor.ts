import { Job } from 'bullmq'
import { getRedisClient } from '../../src/config/redis'
import { memoryService } from '../../src/services/memory.service'

/**
 * Streaming replay: generates an alternative response for an existing turn and
 * streams it token-by-token (same Redis→WS delta pipeline as normal turns).
 * Publishes `replay_delta` frames while generating and `replay_complete` when
 * the variant is persisted; always releases the per-instance generation lock.
 */
export async function replayProcessor(job: Job) {
  const { instanceId, playerId, eventId } = job.data
  const redis = getRedisClient()
  const channel = `user:${playerId}:events`
  const lockKey = `lock:gen:${playerId}:${instanceId}`

  try {
    await redis.expire(lockKey, 240)
    const result = await memoryService.replayEvent(eventId, playerId, (chunk) => {
      redis.publish(
        channel,
        JSON.stringify({ type: 'replay_delta', instanceId, eventId, delta: chunk }),
      )
    })

    const ev: any = result.event
    redis.publish(
      channel,
      JSON.stringify({
        type: 'replay_complete',
        instanceId,
        eventId,
        narrative: ev?.data?.ai_response || '',
        selected_index: result.selected_index,
        // Fresh chips + presence regenerated from the selected variant, so the
        // replayed turn shows tap-to-play choices like a primary turn.
        choices: ev?.data?.choices || [],
        present_characters: ev?.data?.present_characters || [],
        variants: (ev?.data?.replay_variants || []).map((v: any) => ({
          id: v.id,
          narrative: v.narrative,
          model_used: v.model_used,
          created_at: v.created_at,
          choices: v.choices || [],
          present_characters: v.present_characters || [],
        })),
      }),
    )
  } catch (err) {
    redis.publish(
      channel,
      JSON.stringify({
        type: 'error',
        code: 'REPLAY_FAILED',
        eventId,
        message: (err as Error).message,
      }),
    )
  } finally {
    await redis.del(lockKey)
  }
}
