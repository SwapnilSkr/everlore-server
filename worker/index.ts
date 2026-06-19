import { Worker, type Job } from 'bullmq'
import { connectMongo } from '../src/config/mongo'
import { connectRedis, getQueueRedisClient, getRedisClient } from '../src/config/redis'
import { env } from '../src/config/env'
import { generationProcessor } from './processors/generation.processor'
import { generationLockKey, startGenerationLockHeartbeat } from '../src/utils/generation-lock'
import { memoryProcessor } from './processors/memory.processor'
import { summaryProcessor } from './processors/summary.processor'
import { maintenanceProcessor } from './processors/maintenance.processor'
import { getMaintenanceQueue, QUEUE_RETENTION } from '../src/queues'
import { loadNsfwLexicon } from './lib/nsfw-classifier'
import { log } from '../src/utils/logger'

async function main() {
  // Initialize connections
  await connectMongo()
  await connectRedis()

  // Warm the NSFW routing lexicon from Mongo (falls back to built-ins if unseeded).
  await loadNsfwLexicon(true)

  const connection = getQueueRedisClient()

  // Keep the per-instance turn lock alive while a turn actually runs, with a
  // short TTL — so if THIS process dies mid-turn the player is freed within the
  // heartbeat window instead of waiting out the (much longer) dispatch TTL.
  // Covers chat, continue, side_chat, and replay (all routed through here).
  const runGeneration = async (job: Job) => {
    const { playerId, instanceId } = job.data || {}
    if (!playerId || !instanceId) return generationProcessor(job)
    const stopHeartbeat = startGenerationLockHeartbeat(
      getRedisClient(),
      generationLockKey(playerId, instanceId),
    )
    try {
      return await generationProcessor(job)
    } finally {
      stopHeartbeat()
    }
  }

  const generationWorker = new Worker('generation', runGeneration, {
    connection,
    concurrency: env.GENERATION_CONCURRENCY,
    limiter: { max: env.GENERATION_RATE_MAX, duration: 60000 },
  })

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

  // Schedule recurring maintenance jobs
  const maintenanceQueue = getMaintenanceQueue()
  await maintenanceQueue.add('decay', { task: 'importance_decay' }, {
    repeat: { pattern: '0 3 * * *' },
    priority: 20,
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
  await maintenanceQueue.add('projection-checkpoint-scheduler', { task: 'schedule_projection_checkpoints' }, {
    repeat: { pattern: '15 * * * *' },
    priority: 30,
    removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
    removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
  })

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down workers...')
    await generationWorker.close()
    await memoryWorker.close()
    await summaryWorker.close()
    await maintenanceWorker.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Error monitoring
  const workers = [generationWorker, memoryWorker, summaryWorker, maintenanceWorker]
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
    w.on('completed', (job) => {
      console.log(`[${w.name}] Job ${job.id} completed`)
    })
  }

  // Generation failure handling. A turn can fail on a transient hiccup and then
  // succeed on retry, so we tell the player what's happening at each stage:
  //  - intermediate attempt failed, more remain → `generation_retrying` (the
  //    stream is still coming; don't show a dead end)
  //  - final attempt failed → `generation_failed` + dead-letter + release lock
  generationWorker.on('failed', async (job, err) => {
    if (!job) return
    const attemptsAllowed = job.opts.attempts || 1
    const isFinalAttempt = job.attemptsMade >= attemptsAllowed
    const redis = getRedisClient()

    if (!isFinalAttempt) {
      try {
        await redis.publish(
          `user:${job.data.playerId}:events`,
          JSON.stringify({
            type: 'generation_retrying',
            instanceId: job.data.instanceId,
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

      await redis.publish(
        `user:${job.data.playerId}:events`,
        JSON.stringify({
          type: 'generation_failed',
          instanceId: job.data.instanceId,
          message: 'The world could not respond. Please try again.',
        }),
      )

      await redis.del(generationLockKey(job.data.playerId, job.data.instanceId))
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
