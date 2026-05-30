import { Queue } from 'bullmq'
import { getQueueRedisClient } from '../config/redis'

let generationQueue: Queue | null = null
let memoryCurationQueue: Queue | null = null
let sceneSummaryQueue: Queue | null = null
let maintenanceQueue: Queue | null = null

/**
 * Aggressive BullMQ job retention policy. Mongo + DLQ carry durable history;
 * Redis keeps only short-lived operational telemetry.
 */
export const QUEUE_RETENTION = {
  generation: {
    removeOnComplete: { age: 1800, count: 500 },
    removeOnFail: { age: 86400, count: 2000 },
  },
  memoryCuration: {
    removeOnComplete: { age: 900, count: 1000 },
    removeOnFail: { age: 86400, count: 2000 },
  },
  sceneSummary: {
    removeOnComplete: { age: 86400, count: 500 },
    removeOnFail: { age: 172800, count: 1000 },
  },
  maintenance: {
    removeOnComplete: { age: 86400, count: 200 },
    removeOnFail: { age: 604800, count: 500 },
  },
} as const

function getConnection() {
  return getQueueRedisClient()
}

export function getGenerationQueue(): Queue {
  if (!generationQueue) {
    generationQueue = new Queue('generation', { connection: getConnection() })
  }
  return generationQueue
}

export function getMemoryCurationQueue(): Queue {
  if (!memoryCurationQueue) {
    memoryCurationQueue = new Queue('memory-curation', { connection: getConnection() })
  }
  return memoryCurationQueue
}

export function getSceneSummaryQueue(): Queue {
  if (!sceneSummaryQueue) {
    sceneSummaryQueue = new Queue('scene-summary', { connection: getConnection() })
  }
  return sceneSummaryQueue
}

export function getMaintenanceQueue(): Queue {
  if (!maintenanceQueue) {
    maintenanceQueue = new Queue('maintenance', { connection: getConnection() })
  }
  return maintenanceQueue
}
