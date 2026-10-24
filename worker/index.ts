import '../src/polyfill-v8-snapshot'
import { mediaProcessor } from './processors/media.processor'
import { mediaConcurrency } from '../src/services/media/config'
import { Worker, type Job } from 'bullmq'
import { connectMongo } from '../src/config/mongo'
import { connectRedis, getQueueRedisClient, getRedisClient } from '../src/config/redis'
import { env } from '../src/config/env'
import { generationProcessor } from './processors/generation.processor'
import { generationLockKey, releaseGenerationLock, startGenerationLockHeartbeat } from '../src/utils/generation-lock'
import { memoryProcessor } from './processors/memory.processor'
import { summaryProcessor } from './processors/summary.processor'
import { maintenanceProcessor } from './processors/maintenance.processor'
import { getMaintenanceQueue, QUEUE_RETENTION } from '../src/queues'
import { loadNsfwLexicon } from './lib/nsfw-classifier'
import { log } from '../src/utils/logger'
import { billingService } from '../src/services/billing.service'
import { startKeepWarm } from '../src/services/keep-warm'
import { startVectorFreshnessFloorRecovery } from '../src/services/vector-store'

/** Billing must never turn an already-visible story result into a worker error.
 * These mutations are idempotent ledger writes, so a later repair can safely
 * retry them if Mongo is temporarily unavailable. */
async function settleGenerationReservation(job: Job) {
  const playerId = job.data?.playerId
  const reservationId = job.data?.billingReservationId ?? null
  if (typeof playerId !== 'string' || !reservationId) return
  try {
    await billingService.settle(playerId, reservationId)
  } catch (error) {
    log.error('billing.generation_settlement_failed', {
      jobId: job.id,
      playerId,
      error: (error as Error).message,
    })
  }
}

async function releaseGenerationReservation(job: Job) {
  const playerId = job.data?.playerId
  const reservationId = job.data?.billingReservationId ?? null
  if (typeof playerId !== 'string' || !reservationId) return
  try {
    await billingService.release(playerId, reservationId)
  } catch (error) {
    log.error('billing.generation_release_failed', {
      jobId: job.id,
      playerId,
      error: (error as Error).message,
    })
  }
}

async function main() {
  // Initialize connections
  await connectMongo()
  await connectRedis()
  const stopFloorRecovery = startVectorFreshnessFloorRecovery()

  // Prod p50 for the first word after a quiet half hour was 6.6 s against 2.6 s
  // with recent traffic: most of the difference is a cold Pinecone/OpenAI
  // connection. Warm both now and keep them warm while the box is quiet; this
  // never blocks startup.
  const keepWarm = startKeepWarm()

  // Warm the NSFW routing lexicon from Mongo (falls back to built-ins if unseeded).
  await loadNsfwLexicon(true)

  const connection = getQueueRedisClient()

  // Keep the per-instance turn lock alive while a turn actually runs, with a
  // short TTL — so if THIS process dies mid-turn the player is freed within the
  // heartbeat window instead of waiting out the (much longer) dispatch TTL.
  // Covers chat, continue, and replay (all routed through here).
  const runGeneration = async (job: Job) => {
    const { playerId, instanceId } = job.data || {}
    if (!playerId || !instanceId) return generationProcessor(job)
    const stopHeartbeat = startGenerationLockHeartbeat(
      getRedisClient(),
      generationLockKey(playerId, instanceId),
      String(job.id),
    )
    try {
      return await generationProcessor(job)
    } finally {
      stopHeartbeat()
      // Success has already promoted the successor atomically. Failure (also
      // a pickup/live-check exit) must fail its barrier without deleting it.
      await releaseGenerationLock(getRedisClient(), generationLockKey(playerId, instanceId), String(job.id))
    }
  }

  const generationWorker = new Worker('generation', runGeneration, {
    connection,
    concurrency: env.GENERATION_CONCURRENCY,
    limiter: { max: env.GENERATION_RATE_MAX, duration: 60000 },
  })

  const mediaWorker = new Worker('media', mediaProcessor, { connection, concurrency: mediaConcurrency(), maxStalledCount: 0 })

  const memoryWorker = new Worker('memory-curation', memoryProcessor, {
    connection,
    concurrency: 5,
    limiter: { max: 20, duration: 60000 },
  })

  const summaryWorker = new Worker('scene-summary', summaryProcessor, {
    connection,
    concurrency: 2,
  })

  const maintenanceWorker = new Worker('maintenance', maintenanceProcessor, {
    connection,
    concurrency: 1,
  })

  mediaWorker.on('failed', async (job) => {
    if (!job) return
    try {
      const { failMedia } = await import('../src/services/media/service')
      const { mongoColl } = await import('../src/config/mongo')
      const { parseObjectId } = await import('../src/utils/mongo-id')
      const asset = await mongoColl.mediaAssets().findOne({ _id: parseObjectId(job.data.mediaId) })
      if (asset && asset.status !== 'ready') {
        await failMedia(asset, { stage: 'worker', message: job.failedReason || 'media job failed outside its processor' })
      }
    } catch {
      log.warn('media.failure_cleanup_pending', { jobId: job.id })
    }
  })

  // Schedule recurring maintenance jobs
  const maintenanceQueue = getMaintenanceQueue()
  await maintenanceQueue.add('media-repair', { task: 'repair_media_reservations' }, {
    repeat: { pattern: '* * * * *' }, priority: 10, ...QUEUE_RETENTION.maintenance,
  })
  await maintenanceQueue.add('decay', { task: 'importance_decay' }, {
    repeat: { pattern: '0 3 * * *' },
    priority: 20,
    removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
    removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
  })
  // Conservative Redis hygiene: terminal completed telemetry only. The worker
  // never touches failed diagnostics, live/scheduled jobs, locks, sessions,
  // rate limits, or BullMQ repeat/scheduler state.
  await maintenanceQueue.add('queue-telemetry-prune', { task: 'prune_queue_telemetry' }, {
    repeat: { pattern: '30 4 * * *' },
    priority: 40,
    removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
    removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
  })
  await maintenanceQueue.add('post-process-outbox-dispatch', { task: 'dispatch_post_process_outbox' }, {
    repeat: { pattern: '* * * * *' },
    priority: 1,
    removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
    removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
  })
  await maintenanceQueue.add('character-projection-repair', { task: 'repair_character_projections' }, {
    repeat: { pattern: '*/15 * * * *' },
    priority: 25,
    removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
    removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
  })
  await maintenanceQueue.add('dedup-scheduler', { task: 'schedule_dedups' }, {
    repeat: { pattern: '0 4 * * 0' },
    priority: 20,
    removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
    removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
  })
  await maintenanceQueue.add('summary-repair', { task: 'repair_scene_summaries' }, {
    repeat: { pattern: '*/15 * * * *' },
    priority: 15,
    removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
    removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
  })
  await maintenanceQueue.add('continuity-audit-scheduler', { task: 'schedule_continuity_audits' }, {
    repeat: { pattern: '30 2 * * *' },
    priority: 25,
    removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
    removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
  })
  await maintenanceQueue.add('web-traffic-rollup', { task: 'rollup_web_traffic' }, {
    repeat: { pattern: '40 * * * *' },
    priority: 45,
    removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
    removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
  })
  await maintenanceQueue.add('projection-checkpoint-scheduler', { task: 'schedule_projection_checkpoints' }, {
    repeat: { pattern: '15 * * * *' },
    priority: 30,
    removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
    removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
  })

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down workers...')
    keepWarm.stop()
    stopFloorRecovery()
    await generationWorker.close()
    await mediaWorker.close()
    await memoryWorker.close()
    await summaryWorker.close()
    await maintenanceWorker.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Error monitoring
  const workers = [mediaWorker, generationWorker, memoryWorker, summaryWorker, maintenanceWorker]
  for (const w of workers) {
    w.on('failed', (job, err) => {
      console.error(`[${w.name}] Job ${job?.id} failed:`, err.message)
      if (w.name === 'scene-summary') {
        log.error('scene_summary.failed', {
          jobId: job?.id,
          instanceId: job?.data?.instanceId,
          sceneTag: job?.data?.sceneTag,
          startSequence: job?.data?.startSequence,
          endSequence: job?.data?.endSequence,
          error: err.message,
        })
      }
    })
    w.on('completed', async (job) => {
      console.log(`[${w.name}] Job ${job.id} completed`)
      if (w.name === 'generation') {
        await settleGenerationReservation(job)
      }
    })
  }

  // Generation failure handling. Story turns are deliberately single-attempt:
  // a visible response is never rejected or replaced by an automatic retry.
  // A pre-stream failure ends cleanly and leaves the retry decision with the
  // player; a post-stream failure keeps the visible draft intact.
  generationWorker.on('failed', async (job, err) => {
    if (!job) return
    const attemptsAllowed = job.opts.attempts || 1
    const isFinalAttempt = job.attemptsMade >= attemptsAllowed
    const streamWasVisible = job.data?.visibleStreamStarted === true
    const redis = getRedisClient()

    if (!isFinalAttempt) {
      if (streamWasVisible) {
        // The processor calls job.discard() at first visible prose, so this is
        // defensive only. A second attempt after visible output would replace a
        // player-facing scene with a different one, violating the stream
        // contract. Release the turn lock and leave the completed draft intact.
        log.error('generation.retry_suppressed_after_visible_stream', {
          jobId: job.id,
          instanceId: job.data.instanceId,
          error: err.message,
        })
        await releaseGenerationLock(redis, generationLockKey(job.data.playerId, job.data.instanceId), String(job.id))
        await settleGenerationReservation(job)
        return
      }
      try {
        // A failure can happen after streaming has ended (for example during a
        // canonical projection). The processor publishes this itself for known
        // stream failures, but the worker is the final safety net: every retry
        // must mark the visible attempt as provisional before a replacement can
        // begin. The client preserves its displayed draft until a new token
        // arrives, so this never creates an empty-bubble flash.
        await redis.publish(
          `user:${job.data.playerId}:events`,
          JSON.stringify({
            type: 'generation_reset',
            instanceId: job.data.instanceId,
            jobId: String(job.id),
          }),
        )
        await redis.publish(
          `user:${job.data.playerId}:events`,
          JSON.stringify({
            type: 'generation_retrying',
            instanceId: job.data.instanceId,
            jobId: String(job.id),
            attempt: job.attemptsMade,
            maxAttempts: attemptsAllowed,
          }),
        )
      } catch (retryErr) {
        console.error('Failed to publish retry notice:', (retryErr as Error).message)
      }
      return
    }

    try {
      const { mongoColl } = await import('../src/config/mongo')
      const { ObjectId } = await import('mongodb')

      await mongoColl.deadLetterJobs().insertOne({
        _id: new ObjectId(),
        queue: 'generation',
        jobId: job.id,
        data: job.data,
        error: err.message,
        stack: err.stack,
        failedAt: new Date(),
      })

      if (streamWasVisible) {
        // The player already has the completed stream. Do not send a reset or
        // a failure bubble that overwrites it; the failure is in the durable
        // post-stream tail and is retained in the DLQ for repair/diagnostics.
        // This is deliberately different from a pre-token failure, where no
        // playable prose exists and an error state is the correct UX.
        log.error('generation.tail_failed_after_visible_stream', {
          jobId: job.id,
          instanceId: job.data.instanceId,
          error: err.message,
        })
        await settleGenerationReservation(job)
        await releaseGenerationLock(redis, generationLockKey(job.data.playerId, job.data.instanceId), String(job.id))
        return
      }

      // No usable prose reached the player. Return the pre-dispatched Ink only
      // after the final retry has failed; intermediate failures may still finish
      // successfully on their next attempt.
      await releaseGenerationReservation(job)

      await redis.publish(
        `user:${job.data.playerId}:events`,
        JSON.stringify({
          // Mirror the retry path for post-stream failures as well. Without
          // this, a completed-looking but unpersisted bubble can be mistaken
          // for canon when the final error arrives.
          type: 'generation_reset',
          instanceId: job.data.instanceId,
          jobId: String(job.id),
        }),
      )

      await redis.publish(
        `user:${job.data.playerId}:events`,
        JSON.stringify({
          type: 'generation_failed',
          instanceId: job.data.instanceId,
          jobId: String(job.id),
          message: 'The world could not respond. Please try again.',
        }),
      )

      await releaseGenerationLock(redis, generationLockKey(job.data.playerId, job.data.instanceId), String(job.id))
    } catch (dlqErr) {
      console.error('Failed to handle dead letter:', (dlqErr as Error).message)
    }
  })

  console.log('Everlore Worker Cluster running')
}

main().catch((err) => {
  console.error('Worker startup failed:', err)
  process.exit(1)
})
