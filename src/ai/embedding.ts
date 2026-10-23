import { getOpenAI } from '../config/openai'
import { env } from '../config/env'
import { AI_MODELS } from './models'
import { log } from '../utils/logger'
import { noteClientUse } from '../services/keep-warm'

/** Must match the Pinecone index vector dimension (serverless indexes use 1024). */
const EMBEDDING_DIMENSIONS = 1024

/**
 * Two kinds of embedding call, because they are paid for by different parties.
 *
 * `embed` is the background path (lore chunking, memory curation, summaries).
 * Nothing a player is looking at waits on it, so a slow call is worth waiting
 * for: it keeps the SDK's own timeout and retries, is never hedged and is never
 * abandoned. A dropped memory or lore chunk is worse than a slow one.
 *
 * `embedQuery` is the retrieval path, where a player is watching a blank screen.
 * A chat turn used to make TWO requests for the same text (summaries and RAG
 * each embedded the query themselves) and wait for the slower one. OpenAI
 * measured p50 539 ms / p90 3.5 s from prod, so the tail of a single call was
 * shaping the player's first word. One request per distinct text, one hedged
 * duplicate at EMBED_HEDGE_MS, a hard stop at EMBED_DEADLINE_MS — retrieval
 * degrades, the turn does not.
 *
 * Both paths are single-flight per text, so concurrent callers share a request.
 */
export const EMBED_HEDGE_MS = env.EMBED_HEDGE_MS
export const EMBED_DEADLINE_MS = env.EMBED_DEADLINE_MS
/** Retries are OFF for the query path: the hedge already covers a stalled call,
 *  and SDK retries would stack up behind the deadline instead of inside it. */
const EMBED_MAX_RETRIES = 0
/** A replayed or retried turn re-embeds identical text within seconds. */
const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 64

/** Raised when the whole query embedding exceeded EMBED_DEADLINE_MS. Callers
 *  use it to drop only the vector half of retrieval instead of the turn. */
export class EmbedTimeoutError extends Error {
  readonly code = 'embed_timeout'
  readonly ms: number
  constructor(ms: number) {
    super(`Query embedding exceeded ${ms}ms`)
    this.name = 'EmbedTimeoutError'
    this.ms = ms
  }
}

export function isEmbedTimeout(err: unknown): err is EmbedTimeoutError {
  return err instanceof EmbedTimeoutError || (err as { code?: string })?.code === 'embed_timeout'
}

/** The only part of the OpenAI client the query path touches. Audits inject a
 *  fake through `setEmbeddingClientForAudit` so the timing rules are exercised
 *  with no network and no env. */
export interface EmbeddingClient {
  embeddings: {
    create(
      body: { model: string; input: string; dimensions: number },
      options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
    ): Promise<{ data: Array<{ index: number; embedding: number[] }> }>
  }
}

let injectedClient: EmbeddingClient | null = null

/** Test seam. Pass null to fall back to the real OpenAI client. */
export function setEmbeddingClientForAudit(client: EmbeddingClient | null): void {
  injectedClient = client
}

/** The single place the query path resolves a client, so the injected one and
 *  the real one cannot drift apart. */
function embeddingsClient(): EmbeddingClient {
  if (injectedClient) return injectedClient
  const openai = getOpenAI()
  return openai as unknown as EmbeddingClient
}

async function requestEmbedding(
  text: string,
  options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
): Promise<number[]> {
  const openai = embeddingsClient()
  // Sent, not cached: this is the moment the connection was used, which is what
  // the keep-warm pinger reads to decide whether it has gone idle.
  noteClientUse('embedding')
  const response = await openai.embeddings.create(
    { model: AI_MODELS.embedding, input: text, dimensions: EMBEDDING_DIMENSIONS },
    // No options on the background path: the SDK's own timeout and retries are
    // the right policy when nobody is waiting on the answer.
    options
      ? {
          signal: options.signal,
          timeout: options.timeout ?? EMBED_DEADLINE_MS,
          maxRetries: options.maxRetries ?? EMBED_MAX_RETRIES,
        }
      : undefined,
  )
  return response.data[0].embedding
}

interface CachedEmbedding {
  embedding: number[]
  at: number
}

const recentResults = new Map<string, CachedEmbedding>()
const inFlight = new Map<string, Promise<number[]>>()

function cacheKey(text: string): string {
  return `${AI_MODELS.embedding}\u0000${EMBEDDING_DIMENSIONS}\u0000${text}`
}

/** Flights are per path: a background call must never inherit the query path's
 *  deadline, and the query path must never inherit a background call's patience. */
function flightKey(path: 'embed' | 'query', text: string): string {
  return `${path}\u0000${cacheKey(text)}`
}

/** Registers the shared promise and drops it once it settles. Both branches are
 *  handled: a caller may drop its copy, and an unhandled rejection would take
 *  the worker down. */
function trackFlight(
  key: string,
  promise: Promise<number[]>,
  onSuccess?: (embedding: number[]) => void,
): void {
  void promise
    .then(
      (embedding) => {
        onSuccess?.(embedding)
      },
      () => {},
    )
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key)
    })
}

function readCache(key: string): number[] | null {
  const hit = recentResults.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    recentResults.delete(key)
    return null
  }
  return [...hit.embedding]
}

function writeCache(key: string, embedding: number[]): void {
  const now = Date.now()
  for (const [oldKey, entry] of recentResults) {
    if (now - entry.at > CACHE_TTL_MS) recentResults.delete(oldKey)
  }
  // Re-insert at the newest position so a refreshed key is not also the eviction target.
  recentResults.delete(key)
  // Map keeps insertion order, so the first key is the oldest write.
  while (recentResults.size >= CACHE_MAX_ENTRIES) {
    const oldest = recentResults.keys().next().value
    if (oldest === undefined) break
    recentResults.delete(oldest)
  }
  recentResults.set(key, { embedding: [...embedding], at: now })
}

/**
 * One query embedding under a deadline, with a single hedged duplicate.
 *
 * The duplicate exists because a stalled socket answers nowhere near its p50:
 * waiting on it costs the player a visible pause, while sending the identical
 * request again costs one more cheap call. The first success wins and the loser
 * is aborted; if neither answers by the deadline the whole thing rejects so
 * retrieval can drop its vector half and get on with the turn.
 */
function hedgedEmbed(text: string): Promise<number[]> {
  const startedAt = Date.now()
  return new Promise<number[]>((resolve, reject) => {
    let settled = false
    let started = 0
    let live = 0
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const controllers: AbortController[] = []

    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      if (hedgeTimer !== undefined) clearTimeout(hedgeTimer)
      for (const timer of timers) clearTimeout(timer)
      // Abort whatever is still running so a stuck request cannot hold a socket
      // after the turn has moved on.
      for (const controller of controllers) controller.abort()
      complete()
    }

    timers.push(
      setTimeout(() => {
        const ms = Date.now() - startedAt
        // Never the text: it is the player's own story.
        log.warn('embed.query_timeout', { ms })
        finish(() => reject(new EmbedTimeoutError(ms)))
      }, EMBED_DEADLINE_MS),
    )

    const attempt = () => {
      started++
      live++
      const controller = new AbortController()
      controllers.push(controller)
      requestEmbedding(text, { signal: controller.signal }).then(
        (embedding) => finish(() => resolve(embedding)),
        (err) => {
          live--
          if (settled) return
          // A failure before the hedge window is not worth waiting for: the
          // second request is what the hedge would have sent anyway.
          if (started < 2) {
            if (hedgeTimer !== undefined) clearTimeout(hedgeTimer)
            attempt()
            return
          }
          if (live === 0) finish(() => reject(err))
        },
      )
    }

    attempt()
    hedgeTimer = setTimeout(() => {
      if (!settled) attempt()
    }, EMBED_HEDGE_MS)
  })
}

/**
 * Background embedding: unbounded, exactly as before the query path was bounded.
 *
 * Lore chunking, memory curation and summary building all land here. The SDK's
 * defaults are kept (timeout, retries) because there is nothing visible waiting
 * on the answer, and an abandoned call would drop the memory it was making.
 * Concurrent callers with the same text still share one request.
 */
export function embed(text: string): Promise<number[]> {
  const key = flightKey('embed', text)
  const existing = inFlight.get(key)
  if (existing) return existing

  const promise = requestEmbedding(text)
  inFlight.set(key, promise)
  trackFlight(key, promise)
  return promise
}

/**
 * One bounded, deduplicated, cached QUERY embedding — the path a player waits on.
 *
 * Concurrent callers with the identical text (the summary search and the RAG
 * search do exactly this) share a single request, and a repeat within the cache
 * window does not leave the process at all. A rejection is never cached.
 */
export function embedQuery(text: string): Promise<number[]> {
  const key = cacheKey(text)
  const cached = readCache(key)
  if (cached) return Promise.resolve(cached)

  const flight = flightKey('query', text)
  const existing = inFlight.get(flight)
  if (existing) return existing

  const promise = hedgedEmbed(text)
  inFlight.set(flight, promise)
  trackFlight(flight, promise, (embedding) => writeCache(key, embedding))
  return promise
}

/** Batch embeddings for background indexing: deliberately unbounded by the
 *  hedge, since nothing a player waits on is behind it. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const openai = getOpenAI()
  noteClientUse('embedding')
  const response = await openai.embeddings.create({
    model: AI_MODELS.embedding,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

/** Two tokens: the cheapest request that still opens the connection. */
const PING_TEXT = 'keep warm'
/** Short on purpose — a warm-up must never hold a socket the way a turn does. */
const PING_TIMEOUT_MS = 2_000

/**
 * One embedding request straight through the client, for the keep-warm pinger.
 *
 * Deliberately not `embed` or `embedQuery`: those serve the recent-results cache
 * and share single flights, so a repeat would return without touching the
 * network — the one thing a warm-up ping must not do. No hedge and no retries
 * either; a ping that fails is sent again on the next check.
 */
export async function pingEmbedding(): Promise<void> {
  // The raw request, not `embed`/`embedQuery`: nothing here touches the cache or
  // a flight, and it carries its own short timeout with no retries.
  await requestEmbedding(PING_TEXT, { timeout: PING_TIMEOUT_MS, maxRetries: 0 })
}
