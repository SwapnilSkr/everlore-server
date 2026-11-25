import { Job } from 'bullmq'
import { getRedisClient } from '../../src/config/redis'
import { memoryService, type ReplayResult } from '../../src/services/memory.service'
import { finishGenerationTurn, generationLockKey, markReplayTail, releaseGenerationLock } from '../../src/utils/generation-lock'
import { liveInstanceExists } from '../../src/utils/live-instance'
import { wireSpokenLines } from '../../src/services/media/events'
import { parseObjectId } from '../../src/utils/mongo-id'
import { log } from '../../src/utils/logger'
import { makeProseStreamFilter } from '../lib/prose-stream-filter'

/**
 * Streaming replay: generates an alternative response for an existing turn and
 * streams it token-by-token (same Redis→WS delta pipeline as normal turns).
 * Publishes `replay_delta` frames while generating and `replay_complete` when
 * the variant is persisted; always releases the per-instance generation lock.
 *
 * `replay_complete` frees the player before the character cards are refolded. The
 * lock stays held as a tail, so their next line waits for the refold instead of
 * reading half of it.
 */
export async function replayProcessor(job: Job) {
  const { instanceId, playerId, eventId } = job.data
  const redis = getRedisClient()
  const channel = `user:${playerId}:events`
  const lockKey = generationLockKey(playerId, instanceId)
  const token = String(job.id)
  let visibleAttemptMarked = false
  let saved = false
  const markVisibleAttempt = () => {
    if (visibleAttemptMarked) return
    visibleAttemptMarked = true
    // Replays are also streamed player-facing prose. Preserve the no-retry
    // contract and let the worker settle, rather than refund, once a delta is
    // visible to the player.
    job.discard()
    job.data.visibleStreamStarted = true
    void job.updateData(job.data).catch(() => {})
  }

  try {
    if (!(await liveInstanceExists(parseObjectId(instanceId)))) {
      return
    }
    if (job.data.replaySaved) {
      await finishGenerationTurn(redis, lockKey, token, true).catch(() => {})
      return
    }
    // The same filter as a primary turn, so a regenerate never streams speech
    // inside italics (or a JSON envelope) that the persisted variant then fixes.
    const proseFilter = makeProseStreamFilter()
    const publishReplayDelta = (delta: string) => {
      if (!delta) return
      markVisibleAttempt()
      redis.publish(
        channel,
        JSON.stringify({ type: 'replay_delta', instanceId, eventId, delta }),
      )
    }
    const onSaved = async (result: ReplayResult) => {
      publishReplayDelta(proseFilter.end())
      const ev: any = result.event
      const frame = JSON.stringify({
        type: 'replay_complete',
        instanceId,
        eventId,
        narrative: ev?.data?.ai_response || '',
        spoken_lines: wireSpokenLines(ev?.data?.spoken_lines),
        selected_index: result.selected_index,
        // Fresh chips + presence regenerated from the selected variant, so the
        // replayed turn shows tap-to-play choices like a primary turn.
        choices: ev?.data?.choices || [],
        present_characters: ev?.data?.present_characters || [],
        trackable_mentions: ev?.data?.trackable_mentions || [],
        // FINDING 6 / SHARED CONTRACT v1 item 3: refreshed instance projection so
        // the client updates the Play instance, not just the event.
        instance_state: (result as any).instance_state || null,
        variants: (ev?.data?.replay_variants || []).map((v: any) => ({
          id: v.id,
          narrative: v.narrative,
          model_used: v.model_used,
          created_at: v.created_at,
          choices: v.choices || [],
          present_characters: v.present_characters || [],
          // FINDING 7: each variant carries its own underline data so browsing a
          // variant restores correct trackable mentions without re-classifying.
          trackable_mentions: v.trackable_mentions || [],
        })),
      })
      // Recorded first: a worker that dies from here on must not write the
      // player a second version of a turn they are already reading.
      job.data.replaySaved = true
      await job.updateData(job.data).catch(() => {})
      saved = true
      if (!await markReplayTail(redis, lockKey, token, channel, frame)) {
        log.warn('replay.lease_lost', { instanceId, eventId })
        await redis.publish(channel, frame)
      }
    }
    await memoryService.replayEvent(
      eventId,
      playerId,
      (chunk) => publishReplayDelta(proseFilter.push(chunk)),
      onSaved,
    )

    // SHARED CONTRACT v1 item 4: a replay re-projects the latest turn, so notify
    // clients which surfaces changed (chips/presence + codex/bonds/places via the
    // post-replay rebuild).
    redis.publish(
      channel,
      JSON.stringify({
        type: 'world_projection_updated',
        instance_id: instanceId,
        scopes: ['bonds', 'threads', 'recap', 'places', 'calendar', 'codex', 'presence'],
        source: 'replay',
      }),
    )
    await finishGenerationTurn(redis, lockKey, token, true).catch(() => {})
  } catch (err) {
    if (saved) {
      // The player already has this version; the next line must not fail for it.
      log.error('replay.tail_failed', { instanceId, eventId, error: (err as Error).message })
      await finishGenerationTurn(redis, lockKey, token, true).catch(() => {})
      return
    }
    redis.publish(
      channel,
      JSON.stringify({
        type: 'error',
        code: 'REPLAY_FAILED',
        eventId,
        message: (err as Error).message,
      }),
    )
    // Do not swallow a failed replay. BullMQ otherwise marks it "completed",
    // hiding the failure from diagnostics and leaving no retry/dead-letter trail.
    throw err
  } finally {
    await releaseGenerationLock(redis, lockKey, token).catch(() => {})
  }
}
