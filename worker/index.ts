import { Worker } from 'bullmq'
import { connectMongo } from '../src/config/mongo'
import { connectRedis, getQueueRedisClient } from '../src/config/redis'
import { generationProcessor } from './processors/generation.processor'
import { memoryProcessor } from './processors/memory.processor'
import { summaryProcessor } from './processors/summary.processor'
import { maintenanceProcessor } from './processors/maintenance.processor'
import { getMaintenanceQueue, QUEUE_RETENTION } from '../src/queues'
import { loadNsfwLexicon } from './lib/nsfw-classifier'

async function main() {
  // Initialize connections
  await connectMongo()
  await connectRedis()

  // Warm the NSFW routing lexicon from Mongo (falls back to built-ins if unseeded).
  await loadNsfwLexicon(true)

  const connection = getQueueRedisClient()

  const generationWorker = new Worker('generation', generationProcessor, {
    connection,
    concurrency: 3,
    limiter: { max: 10, duration: 60000 },
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
    })
    w.on('completed', (job) => {
      console.log(`[${w.name}] Job ${job.id} completed`)
    })
  }

  // Dead letter handling for generation failures
  generationWorker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
      try {
        const { mongoColl } = await import('../src/config/mongo')
        const { getRedisClient } = await import('../src/config/redis')
        const { ObjectId } = await import('mongodb')
        const redis = getRedisClient()

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

        await redis.del(`lock:gen:${job.data.playerId}:${job.data.instanceId}`)
      } catch (dlqErr) {
        console.error('Failed to handle dead letter:', (dlqErr as Error).message)
      }
    }
  })

  console.log('Everlore Worker Cluster running')
}

main().catch((err) => {
  console.error('Worker startup failed:', err)
  process.exit(1)
})
