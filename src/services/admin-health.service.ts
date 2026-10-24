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
 * Both vector pings together must finish inside this. The first one carries the
 * cold handshake — keep-warm's notes measure 1.7 s from Mumbai — and the pair is
 * `down` only when even that cannot answer.
 */
const PINECONE_PING_TIMEOUT_MS = 5000

/**
 * `degraded` means the dependency answered, just slowly. A database or cache
 * round trip over half a second is already felt by a player mid-turn; a vector
 * search gets three times that because it carries an embedding.
 */
const FAST_DEGRADED_MS = 500
const PINECONE_DEGRADED_MS = 1500

/** How many finished jobs are inspected per status for the 24 h figures, newest first. */
const FINISHED_JOB_SCAN = 200

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
  /** Every failure finished in the last day: the history the console shows. */
  failed_24h: number
  /** Job names whose newest finished run failed: the trouble happening now. */
  failing_now: number
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
 * cache and vector index, and an audit never touches the network. A pinecone
 * probe is one request: the check sends two of them.
 */
export interface HealthDependencies {
  pingMongo: () => Promise<unknown>
  pingRedis: () => Promise<unknown>
  pingPinecone: () => Promise<unknown>
  countGenerationWorkers: () => Promise<number>
}

const liveDependencies: HealthDependencies = {
  // Through mongoColl, so the check proves the connection the admin API itself uses.
  pingMongo: () => mongoColl.users().db.command({ ping: 1 }),
  pingRedis: () => getRedisClient().ping(),
  // The same request a player's search makes, through the store — the only
  // module allowed to hold the raw index.
  pingPinecone: () => vectorStore.ping('query', 1),
  countGenerationWorkers: async () => (await getGenerationQueue().getWorkers()).length,
}

export interface QueueReader {
  name: string
  label: string
  read: () => Promise<Omit<QueueHealth, 'name' | 'label'>>
}

type FinishedJob = { name: string; finishedOn?: number }

/**
 * How many job names have failed and not run again since. A name whose newest
 * finished run completed counts zero however many failures sit behind it: those
 * are history, and a fixed deploy must not read as an outage for a whole day.
 * The newest run wins; a tie (two runs finished in the same millisecond) goes to
 * the completed one, so a recovery is never reported as still failing.
 */
function failingNow(completed: FinishedJob[], failed: FinishedJob[], since: number): number {
  const newest = new Map<string, { finishedOn: number; failed: boolean }>()
  const note = (job: FinishedJob, isFailure: boolean) => {
    if (typeof job.finishedOn !== 'number' || job.finishedOn < since) return
    const seen = newest.get(job.name)
    if (!seen || job.finishedOn > seen.finishedOn) newest.set(job.name, { finishedOn: job.finishedOn, failed: isFailure })
  }
  for (const job of completed) note(job, false)
  for (const job of failed) note(job, true)
  return [...newest.values()].filter((run) => run.failed).length
}

export async function readQueue(queue: Queue): Promise<Omit<QueueHealth, 'name' | 'label'>> {
  const now = Date.now()
  const [counts, failed, completed, waiting] = await Promise.all([
    queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
    // Newest first: only the last day of finished jobs can matter here. A queue
    // with more finished jobs than this reports a floor, not a total.
    queue.getFailed(0, FINISHED_JOB_SCAN - 1),
    queue.getCompleted(0, FINISHED_JOB_SCAN - 1),
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
    failing_now: failingNow(completed, failed, since),
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

/**
 * Players' searches run in the worker, whose connections keep-warm holds open;
 * this process's own connection idles between console polls, and keep-alive dies
 * after 10–60 s idle. So the first request pays a cold handshake that says
 * nothing about players, and only the second — the one a player would feel — is
 * graded.
 */
async function pineconeCheck(ping: () => Promise<unknown>, degradedMs: number, timeoutMs: number): Promise<HealthCheck> {
  const identity = { key: 'pinecone' as const, label: 'Story memory search' }
  let measured = 0
  try {
    await withDeadline(async () => {
      await ping()
      const started = performance.now()
      await ping()
      measured = Math.round(performance.now() - started)
    }, timeoutMs)
  } catch {
    return { ...identity, status: 'down', detail: DOWN_DETAIL }
  }
  return { ...identity, status: measured > degradedMs ? 'degraded' : 'ok', detail: `${measured} ms`, latency_ms: measured }
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
  /** The vector pair's deadline; the audit scales it down so a slow pair costs no real seconds. */
  pineconeTimeoutMs?: number
}

export function createAdminHealthService(options: HealthServiceOptions = {}) {
  const dependencies = options.dependencies ?? liveDependencies
  const queueReaders = options.queues ?? liveQueueReaders
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS
  const pineconeTimeoutMs = options.pineconeTimeoutMs ?? PINECONE_PING_TIMEOUT_MS

  return {
    async health(now: Date = new Date()): Promise<HealthPayload> {
      // Configuration is read per request: a server that gains a vector-search
      // key shows the check recovering without a restart.
      const pinecone = env.PINECONE_API_KEY
        ? pineconeCheck(dependencies.pingPinecone, PINECONE_DEGRADED_MS, pineconeTimeoutMs)
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
