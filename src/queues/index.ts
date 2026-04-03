import { Queue } from 'bullmq'
import { getQueueRedisClient } from '../config/redis'

let generationQueue: Queue | null = null
let memoryCurationQueue: Queue | null = null
let sceneSummaryQueue: Queue | null = null
let maintenanceQueue: Queue | null = null

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
