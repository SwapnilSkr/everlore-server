import { Queue } from 'bullmq'
import Redis from 'ioredis'
import { env } from '../src/config/env'

type QueueName = 'generation' | 'memory-curation' | 'scene-summary' | 'maintenance'

const QUEUES: QueueName[] = [
  'generation',
  'memory-curation',
  'scene-summary',
  'maintenance',
]

async function counts(queue: Queue) {
  return queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused')
}

async function main() {
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  await connection.ping()
  console.log('Redis connected')

  for (const name of QUEUES) {
    const queue = new Queue(name, { connection })
    const before = await counts(queue)

    // One-time aggressive cleanup: drop all currently retained completed/failed
    // records. Future jobs will be bounded by removeOnComplete/removeOnFail.
    const removedCompleted = await queue.clean(0, 1_000_000, 'completed')
    const removedFailed = await queue.clean(0, 1_000_000, 'failed')
    const after = await counts(queue)

    console.log(`[${name}]`)
    console.log('  before:', before)
    console.log(`  removed completed: ${removedCompleted.length}, failed: ${removedFailed.length}`)
    console.log('  after:', after)

    await queue.close()
  }

  await connection.quit()
}

main().catch((err) => {
  console.error('Queue cleanup failed:', err)
  process.exit(1)
})
