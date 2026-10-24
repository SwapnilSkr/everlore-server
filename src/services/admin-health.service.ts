import type { Queue } from 'bullmq'
import { env } from '../config/env'
import { mongoColl } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import {
  getGenerationQueue,
  getMaintenanceQueue,
  getMediaQueue,
  getMemoryCurationQueue,
  getSceneSummaryQueue,
} from '../queues'
import { vectorStore } from './vector-store'

/** No dependency may hold the route open longer than this; a stall is `down`. */
const CHECK_TIMEOUT_MS = 2000

/**
 * `degraded` means the dependency answered, just slowly. A database or cache
 * round trip over half a second is already felt by a player mid-turn; a vector
 * search gets three times that because it carries an embedding.
 */
const FAST_DEGRADED_MS = 500
const PINECONE_DEGRADED_MS = 1500

/** How many failed jobs are inspected for the 24 h figure, newest first. */
const FAILED_JOB_SCAN = 200

const DAY_MS = 86_400_000

/** Fixed wording, so no dependency's own error text can reach a browser. */
const DOWN_DETAIL = 'Did not answer.'
const NOT_CONFIGURED_DETAIL = 'Search is not configured on this server.'

/** The process answering, not the request: Bun starts this clock with the runtime. */
const PROCESS_STARTED_AT = new Date(performance.timeOrigin).toISOString()

export type HealthStatus = 'ok' | 'degraded' | 'down'

export interface HealthCheck {
  key: 'mongo' | 'redis' | 'pinecone' | 'worker'
  label: string
  status: HealthStatus
  detail?: string
  latency_ms?: number
}

export interface QueueHealth {
  name: string
  label: string
  waiting: number
  active: number
  failed_24h: number
  oldest_waiting_s: number | null
}

export interface HealthPayload {
  generated_at: string
  version: { commit: string | null; started_at: string }
  checks: HealthCheck[]
  queues: QueueHealth[]
}

/**
 * The four probes, kept apart from the checks that grade them so the audit can
 * run the same grading against fakes — the real ones need a live database,
 * cache and vector index, and an audit never touches the network.
 */
export interface HealthDependencies {
  pingMongo: () => Promise<unknown>
  pingRedis: () => Promise<unknown>
  describePinecone: () => Promise<unknown>
  countGenerationWorkers: () => Promise<number>
}

const liveDependencies: HealthDependencies = {
  // Through mongoColl, so the check proves the connection the admin API itself uses.
  pingMongo: () => mongoColl.users().db.command({ ping: 1 }),
  pingRedis: () => getRedisClient().ping(),
  // Through the store, the only module allowed to hold the raw index; `stats`
  // is one unbilled describe call.
  describePinecone: () => vectorStore.ping('stats', 1),
  countGenerationWorkers: async () => (await getGenerationQueue().getWorkers()).length,
}

export interface QueueReader {
  name: string
  label: string
  read: () => Promise<Omit<QueueHealth, 'name' | 'label'>>
}

async function readQueue(queue: Queue): Promise<Omit<QueueHealth, 'name' | 'label'>> {
  const now = Date.now()
  const [counts, failed, waiting] = await Promise.all([
    queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
    // Newest first: only the last day of failures can matter here. A queue with
    // more failures than this reports a floor, not a total.
    queue.getFailed(0, FAILED_JOB_SCAN - 1),
    // Ascending through the waiting list reaches the job players have waited on
    // longest, which is the one that says a queue is stuck.
    queue.getJobs(['waiting'], 0, 0, true),
  ])
  const since = now - DAY_MS
  const oldest = waiting[0]?.timestamp
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    failed_24h: failed.filter((job) => typeof job.finishedOn === 'number' && job.finishedOn >= since).length,
    oldest_waiting_s: typeof oldest === 'number' ? Math.max(0, Math.round((now - oldest) / 1000)) : null,
  }
}

/**
 * Every queue the worker runs. Labels are written for the console, not for a
 * developer: a queue name alone says nothing about what its backlog costs.
 * The readers stay lazy — a queue handle connects on first use.
 */
const liveQueueReaders: QueueReader[] = [
  { name: 'generation', label: 'Story turns', read: () => readQueue(getGenerationQueue()) },
  { name: 'media', label: 'Pictures and voices', read: () => readQueue(getMediaQueue()) },
  { name: 'memory-curation', label: 'Memory tidying', read: () => readQueue(getMemoryCurationQueue()) },
  { name: 'scene-summary', label: 'Scene summaries', read: () => readQueue(getSceneSummaryQueue()) },
  { name: 'maintenance', label: 'Housekeeping', read: () => readQueue(getMaintenanceQueue()) },
]

async function withDeadline<T>(call: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Health check timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function latencyCheck(
  identity: { key: HealthCheck['key']; label: string },
  call: () => Promise<unknown>,
  degradedMs: number,
  timeoutMs: number,
): Promise<HealthCheck> {
  const started = performance.now()
  try {
    await withDeadline(call, timeoutMs)
    const latency_ms = Math.round(performance.now() - started)
    // The detail carries the measurement; the dependency never gets to write it.
    return { ...identity, status: latency_ms > degradedMs ? 'degraded' : 'ok', detail: `${latency_ms} ms`, latency_ms }
  } catch {
    return { ...identity, status: 'down', detail: DOWN_DETAIL }
  }
}

async function workerCheck(countWorkers: () => Promise<number>, timeoutMs: number): Promise<HealthCheck> {
  const identity = { key: 'worker' as const, label: 'Background worker' }
  try {
    const connected = await withDeadline(countWorkers, timeoutMs)
    // Nothing connected means turns are being accepted and never drained.
    return { ...identity, status: connected >= 1 ? 'ok' : 'down', detail: `${connected} connected` }
  } catch {
    return { ...identity, status: 'down', detail: DOWN_DETAIL }
  }
}

async function readQueues(readers: QueueReader[], timeoutMs: number): Promise<QueueHealth[]> {
  const rows = await Promise.all(
    readers.map(async (reader): Promise<QueueHealth | null> => {
      try {
        return { name: reader.name, label: reader.label, ...(await withDeadline(reader.read, timeoutMs)) }
      } catch {
        // Redis backs every queue, so an unreadable queue is almost always Redis
        // being down — the redis check already says so. Dropping the row beats
        // reporting a queue as empty and healthy when it could not be read.
        return null
      }
    }),
  )
  return rows.filter((row): row is QueueHealth => row !== null)
}

export interface HealthServiceOptions {
  dependencies?: HealthDependencies
  queues?: QueueReader[]
  timeoutMs?: number
}

export function createAdminHealthService(options: HealthServiceOptions = {}) {
  const dependencies = options.dependencies ?? liveDependencies
  const queueReaders = options.queues ?? liveQueueReaders
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS

  return {
    async health(now: Date = new Date()): Promise<HealthPayload> {
      // Configuration is read per request: a server that gains a vector-search
      // key shows the check recovering without a restart.
      const pinecone = env.PINECONE_API_KEY
        ? latencyCheck({ key: 'pinecone', label: 'Story memory search' }, dependencies.describePinecone, PINECONE_DEGRADED_MS, timeoutMs)
        : Promise.resolve<HealthCheck>({
            key: 'pinecone',
            label: 'Story memory search',
            status: 'down',
            detail: NOT_CONFIGURED_DETAIL,
          })

      const [checks, queues] = await Promise.all([
        Promise.all([
          latencyCheck({ key: 'mongo', label: 'Database' }, dependencies.pingMongo, FAST_DEGRADED_MS, timeoutMs),
          latencyCheck({ key: 'redis', label: 'Cache and queue' }, dependencies.pingRedis, FAST_DEGRADED_MS, timeoutMs),
          pinecone,
          workerCheck(dependencies.countGenerationWorkers, timeoutMs),
        ]),
        readQueues(queueReaders, timeoutMs),
      ])

      return {
        generated_at: now.toISOString(),
        // No deploy step hands this process a revision (there is no such variable
        // in env.ts), so the console shows nothing rather than a guess.
        version: { commit: null, started_at: PROCESS_STARTED_AT },
        checks,
        queues,
      }
    },
  }
}

export const adminHealthService = createAdminHealthService()
