import { env } from '../config/env'
import { log } from '../utils/logger'

/**
 * Keeps this process's Pinecone and OpenAI embedding connections warm.
 *
 * Prod history (212 turns, Oct 23 2026): after more than 30 minutes with no turn
 * anywhere on the box the first word was p50 6.6 s; with a turn in the previous
 * 5 minutes it was 2.6 s. With no players yet the box is quiet most of the time,
 * so most first turns were the slow kind. One process measured a Pinecone search
 * at 0.42 s warm and ~0.99 s after 60 s–8 min idle — its keep-alive dies somewhere
 * between 10 and 60 s idle — and a fresh process's first search took 2.3 s.
 *
 * So each process warms both clients once at startup, then pings a client that
 * has been idle for `KEEP_WARM_IDLE_MS`. Under steady traffic nothing is ever
 * idle and the pings stop by themselves.
 *
 * One connection is not enough. A turn searches Pinecone three times at once —
 * lore, memory and summaries — and each parallel request needs its own
 * connection. Box probe, one process: serial searches on saves unread for 58
 * days took 0.19 s, but three parallel searches with a single warm connection
 * took 0.94 s until the other two opened. So a ping sends
 * `KEEP_WARM_PINECONE_WIDTH` requests at once (3 by default), and three
 * concurrent stats pings every 10 s kept three connections at 0.38–0.47 s after
 * 30–60 s idle, where one warm connection had left two of them cold.
 *
 * Last use is reported by the modules that own each client — `ai/embedding`
 * directly, `services/vector-store` through the listener below — against a
 * monotonic clock, so a cache hit or a call that never left the process cannot
 * keep a dead connection looking warm.
 *
 * A ping is not a turn: nothing here touches `prep_stages` or `embed_ms`.
 */

export type WarmClientName = 'pinecone' | 'embedding'
export type WarmPing = () => Promise<void>

const WARM_CLIENTS: readonly WarmClientName[] = ['pinecone', 'embedding']

/** `performance.now()` cannot jump backwards, which is what makes "idle for N"
 *  mean the same thing after a system clock change as before one. */
let clock: () => number = () => performance.now()

/** Test seam, in the style of `setEmbeddingClientForAudit`. */
export function setKeepWarmClockForAudit(now: (() => number) | null): void {
  clock = now ?? (() => performance.now())
}

/** One monotonic timestamp per client per process. */
const lastUsedAt = new Map<WarmClientName, number>()

export function noteClientUse(client: WarmClientName): void {
  lastUsedAt.set(client, clock())
}

export function lastClientUse(client: WarmClientName): number | undefined {
  return lastUsedAt.get(client)
}

/** Test seam: forget every last-use time, as a fresh process would. */
export function resetKeepWarmForAudit(): void {
  lastUsedAt.clear()
}

/** The Pinecone ping mode, read when the ping is sent so both can be exercised. */
export function keepWarmPineconeMode(): 'stats' | 'query' {
  return env.KEEP_WARM_PINECONE
}

let vectorUseRegistered = false

/** The shipped Pinecone ping.
 *
 *  Both imports below are resolved on first use. `vector-store` cannot import
 *  this module to report its own use (that is a cycle), and `ai/embedding` must
 *  import it for the same reason — so this module owns the wire calls and pulls
 *  those modules in lazily. */
async function pingPinecone(): Promise<void> {
  const store = await import('./vector-store')
  if (!vectorUseRegistered) {
    store.setVectorIndexUseListener(() => noteClientUse('pinecone'))
    vectorUseRegistered = true
  }
  await store.vectorStore.ping(keepWarmPineconeMode())
}

async function pingEmbeddingClient(): Promise<void> {
  const { pingEmbedding } = await import('../ai/embedding')
  await pingEmbedding()
}

export interface KeepWarmTickResult {
  pinged: WarmClientName[]
  failed: WarmClientName[]
}

export interface KeepWarmOptions {
  /** Injected by the audit; the shipped wire calls are the defaults. */
  pings?: Partial<Record<WarmClientName, WarmPing>>
  /** Repeating check loop. The audit passes a no-op and drives `tick` itself. */
  schedule?: (run: () => void, everyMs: number) => unknown
  cancel?: (handle: unknown) => void
}

export interface KeepWarm {
  /** Settles once the startup warm has finished. The worker never awaits it. */
  ready: Promise<void>
  /** One check pass: pings only the clients that are idle right now. */
  tick(): Promise<KeepWarmTickResult>
  stop(): void
}

export function startKeepWarm(options: KeepWarmOptions = {}): KeepWarm {
  if (!env.KEEP_WARM) {
    log.info('keep_warm.disabled')
    return {
      ready: Promise.resolve(),
      async tick() {
        return { pinged: [], failed: [] }
      },
      stop() {},
    }
  }

  const pings: Record<WarmClientName, WarmPing> = {
    pinecone: options.pings?.pinecone ?? pingPinecone,
    embedding: options.pings?.embedding ?? pingEmbeddingClient,
  }
  const schedule = options.schedule ?? ((run: () => void, everyMs: number) => setInterval(run, everyMs))
  const cancel =
    options.cancel ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  const inFlight = new Set<WarmClientName>()
  let stopped = false

  const ping = async (client: WarmClientName): Promise<'pinged' | 'failed' | 'skipped'> => {
    // Overlap guard first: a slow ping and the next check must never stack a
    // second request onto the same client.
    if (inFlight.has(client)) return 'skipped'
    inFlight.add(client)
    try {
      // Idleness is decided here, under the guard, so a client the process used
      // while this pass was running is not pinged on stale information.
      const usedAt = lastUsedAt.get(client)
      if (usedAt !== undefined && clock() - usedAt < env.KEEP_WARM_IDLE_MS) return 'skipped'
      await pings[client]()
      // A ping is a use: the next one is a full idle window away.
      noteClientUse(client)
      return 'pinged'
    } catch (error) {
      // Logged, never thrown: a failed warm-up must not take the worker down or
      // stop later pings. A ping that sent several requests says how many of them
      // failed, and still produces this one line. The message carries no key and
      // no payload.
      const failedRequests = (error as { failed?: unknown }).failed
      log.warn('keep_warm.ping_failed', {
        client,
        ...(typeof failedRequests === 'number' ? { failed: failedRequests } : {}),
        error: (error as Error).message,
      })
      return 'failed'
    } finally {
      inFlight.delete(client)
    }
  }

  const tick = async (): Promise<KeepWarmTickResult> => {
    const result: KeepWarmTickResult = { pinged: [], failed: [] }
    if (stopped) return result
    for (const client of WARM_CLIENTS) {
      const outcome = await ping(client)
      if (outcome === 'pinged') result.pinged.push(client)
      if (outcome === 'failed') result.failed.push(client)
    }
    return result
  }

  // Startup warm: the worker has to start draining the queue immediately, so the
  // outcome is logged rather than awaited.
  const ready = tick().then((result) => {
    if (result.pinged.length > 0 || result.failed.length > 0) {
      log.info('keep_warm.startup_warm', { pinged: result.pinged, failed: result.failed })
    }
  })

  const handle = schedule(() => {
    void tick()
  }, env.KEEP_WARM_CHECK_MS)

  return {
    ready,
    tick,
    stop() {
      stopped = true
      cancel(handle)
    },
  }
}
