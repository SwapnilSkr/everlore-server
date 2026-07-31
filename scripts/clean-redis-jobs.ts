import { Queue } from 'bullmq'
import Redis from 'ioredis'
import { env } from '../src/config/env'
import {
  completedRetentionSeconds,
  MANAGED_QUEUES,
  type ManagedQueueName,
  pruneCompletedQueueJobs,
} from '../src/services/queue-hygiene.service'

/**
 * Conservative Redis queue hygiene.
 *
 * Default: read-only report.
 * --execute: removes only COMPLETED jobs older than the queue's configured
 *            removeOnComplete age. It never removes failed, waiting, active,
 *            delayed, paused, repeat/scheduler, lock, session, or rate-limit
 *            data.
 *
 * BullMQ's terminal job records are operational telemetry only. Everlore's
 * durable generation history and failure records live in Mongo/DLQ.
 */

const execute = process.argv.includes('--execute')

function parseInfo(info: string, key: string): string | undefined {
  return info
    .split('\n')
    .find((line) => line.startsWith(`${key}:`))
    ?.slice(key.length + 1)
    .trim()
}

async function getCounts(queue: Queue) {
  return queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused')
}

async function main() {
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })

  try {
    await connection.ping()
    const [memoryInfo, keyCount] = await Promise.all([connection.info('memory'), connection.dbsize()])

    console.log('Redis queue hygiene')
    console.log(`Mode: ${execute ? 'EXECUTE (completed jobs only)' : 'DRY RUN (read-only)'}`)
    console.log(`Keys: ${keyCount}`)
    console.log(`Used memory: ${parseInfo(memoryInfo, 'used_memory_human') ?? 'unknown'}`)
    console.log(`Peak memory: ${parseInfo(memoryInfo, 'used_memory_peak_human') ?? 'unknown'}`)
    console.log(`Fragmentation ratio: ${parseInfo(memoryInfo, 'mem_fragmentation_ratio') ?? 'unknown'}`)

    for (const name of MANAGED_QUEUES) {
      const queue = new Queue(name, { connection })
      try {
        const before = await getCounts(queue)
        const retentionSeconds = completedRetentionSeconds(name)

        console.log(`\n[${name}]`)
        console.log('  counts:', before)
        console.log(`  completed retention: ${retentionSeconds}s`)

        if (!execute) {
          console.log('  action: none (run with --execute to prune only completed jobs beyond retention)')
          continue
        }

        const removed = await pruneCompletedQueueJobs(queue, name)
        console.log(`  removed completed beyond retention: ${removed}`)
        console.log('  after:', await getCounts(queue))
      } finally {
        await queue.close()
      }
    }

    if (!execute) {
      console.log('\nNo Redis data was changed.')
    }
  } finally {
    await connection.quit()
  }
}

main().catch((error) => {
  console.error('Redis queue hygiene failed:', error)
  process.exit(1)
})
