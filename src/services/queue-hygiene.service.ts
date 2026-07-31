import type { Queue } from 'bullmq'
import {
  getGenerationQueue,
  getMaintenanceQueue,
  getMemoryCurationQueue,
  getSceneSummaryQueue,
  QUEUE_RETENTION,
} from '../queues'

export type ManagedQueueName = 'generation' | 'memory-curation' | 'scene-summary' | 'maintenance'

const CLEAN_BATCH_SIZE = 1_000

const queues: Record<ManagedQueueName, () => Queue> = {
  generation: getGenerationQueue,
  'memory-curation': getMemoryCurationQueue,
  'scene-summary': getSceneSummaryQueue,
  maintenance: getMaintenanceQueue,
}

const retentionKeys: Record<ManagedQueueName, keyof typeof QUEUE_RETENTION> = {
  generation: 'generation',
  'memory-curation': 'memoryCuration',
  'scene-summary': 'sceneSummary',
  maintenance: 'maintenance',
}

export const MANAGED_QUEUES = Object.keys(queues) as ManagedQueueName[]

export function getManagedQueue(name: ManagedQueueName): Queue {
  return queues[name]()
}

export function completedRetentionSeconds(name: ManagedQueueName): number {
  return QUEUE_RETENTION[retentionKeys[name]].removeOnComplete.age
}

/**
 * Removes only completed BullMQ telemetry older than the existing retention
 * policy. It cannot select failed, waiting, active, delayed, paused, repeat,
 * scheduler, lock, session, or rate-limit keys.
 *
 * Work is capped per queue so the nightly maintenance run stays gentle on a
 * shared Redis instance. Remaining historical telemetry is handled tomorrow.
 */
export async function pruneExpiredCompletedQueueJobs(
  name: ManagedQueueName,
  maxBatches = 10,
): Promise<number> {
  return pruneCompletedQueueJobs(getManagedQueue(name), name, maxBatches)
}

/** Same conservative operation for a caller-owned Queue connection. */
export async function pruneCompletedQueueJobs(
  queue: Queue,
  name: ManagedQueueName,
  maxBatches = 10,
): Promise<number> {
  const retentionMs = completedRetentionSeconds(name) * 1_000
  let removed = 0

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex++) {
    const batch = await queue.clean(retentionMs, CLEAN_BATCH_SIZE, 'completed')
    removed += batch.length
    if (batch.length < CLEAN_BATCH_SIZE) break
  }

  return removed
}
