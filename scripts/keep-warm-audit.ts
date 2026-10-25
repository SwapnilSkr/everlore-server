/**
 * KEEP-WARM: a quiet process stays connected, and pays next to nothing to do it.
 *
 * Prod history (212 turns, Oct 23 2026): after > 30 min with no turn anywhere on
 * the box the first word was p50 6.6 s; with a turn in the previous 5 min it was
 * 2.6 s. One process measured Pinecone search at 0.42 s warm and ~0.99 s after
 * 60 s–8 min idle, and a fresh process's first search took 2.3 s. With no players
 * the box is quiet most of the time, so most first turns were the slow kind.
 *
 * What is pinned here:
 *   - startup warms both clients once, without blocking the worker;
 *   - a client the process is already using is never pinged, and an idle one is
 *     pinged once per window with no overlapping requests;
 *   - the embedding ping goes straight to the client: the cache and the shared
 *     flights that serve turns cannot swallow it;
 *   - `stats` asks for index stats, `query` sends a scoped topK-1 search that
 *     cannot return a real record;
 *   - one ping sends `KEEP_WARM_PINECONE_WIDTH` requests at once (3 by default),
 *     because a turn runs three parallel searches and each needs its connection;
 *   - a ping that partly fails — one request of several — logs one line carrying
 *     the failed count, never throws, and never stops later pings;
 *   - `KEEP_WARM=off` sends nothing and schedules nothing;
 *   - real use moves the last-use time and a cache hit does not.
 *
 * No network, no env file, no Mongo: the clock is fake, the Pinecone index and
 * the OpenAI client are fakes, and every check is also run against a deliberately
 * broken copy of the module so it is shown to bite.
 *
 *   bun --no-env-file run scripts/keep-warm-audit.ts
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { VectorIndex } from '../src/services/vector-store'

let pass = 0
let fail = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok   ${label}`)
  } catch (err) {
    fail++
    console.log(`  FAIL ${label}\n       ${(err as Error).message}`)
  }
}

// ── Sources: shipped defaults and the mutation targets ────────────────────────
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const envSource = read('../src/config/env.ts')
const keepWarmSource = read('../src/services/keep-warm.ts')
const embeddingSource = read('../src/ai/embedding.ts')
const vectorSource = read('../src/services/vector-store.ts')

function fromSource(source: string, pattern: RegExp, what: string): string {
  const match = pattern.exec(source)
  if (!match) throw new Error(`${what} not found in its source file`)
  return match[1]
}
function shippedDefault(name: string, source: string = envSource): string {
  return fromSource(source, new RegExp(`${name}: '([^']*)'`), `${name} default`)
}
function mutate(source: string, before: string, after: string): string {
  if (!source.includes(before)) throw new Error(`Mutation target missing: ${before}`)
  return source.replace(before, after)
}

const PING_TEXT = fromSource(embeddingSource, /const PING_TEXT = '([^']*)'/, 'PING_TEXT')
const PING_TIMEOUT_MS = Number(
  fromSource(embeddingSource, /const PING_TIMEOUT_MS = ([\d_]+)/, 'PING_TIMEOUT_MS').replace(/_/g, ''),
)
const PING_SCOPE_ID = fromSource(vectorSource, /instanceId: '([^']*)' \}/, 'the keep-warm ping scope')

/** The whole warn line a failed ping logs, and the one field inside it that says
 *  how many of the ping's requests failed. Bites replace or remove them. */
const PING_FAILED_LOG = [
  '      const failedRequests = (error as { failed?: unknown }).failed',
  "      log.warn('keep_warm.ping_failed', {",
  '        client,',
  "        ...(typeof failedRequests === 'number' ? { failed: failedRequests } : {}),",
  '        error: (error as Error).message,',
  '      })',
].join('\n')
const FAILED_COUNT_LINE = "        ...(typeof failedRequests === 'number' ? { failed: failedRequests } : {}),\n"

/** The line that fans a ping's requests out; a serial loop bites it. */
const FAN_OUT_LINE = '      const settled = await Promise.allSettled(Array.from({ length: count }, send))'

// ── Boundaries ────────────────────────────────────────────────────────────────
const env = {
  VECTOR_LAYOUT: 'shared' as const,
  PINECONE_SHARED_NAMESPACE: 'everlore',
  PINECONE_INDEX: 'audit-index',
  KEEP_WARM: true,
  KEEP_WARM_PINECONE: 'stats' as 'stats' | 'query',
  KEEP_WARM_PINECONE_WIDTH: 3,
  KEEP_WARM_IDLE_MS: 10_000,
  KEEP_WARM_CHECK_MS: 5_000,
  EMBED_HEDGE_MS: 100,
  EMBED_DEADLINE_MS: 600,
}
mock.module('../src/config/env', () => ({ env }))

const unavailable = (): never => {
  throw new Error('External dependency reached in the keep-warm audit')
}

interface PingRequest {
  name: string
  // The request the ping builds; unpinned fields stay unknown on purpose.
  query: Record<string, unknown>
}

class FakeIndex {
  stats = 0
  queries: PingRequest[] = []
  /** Held open while a check measures how many requests reached the index at the
   *  same time; null means each request returns as soon as it is made. */
  gate: Promise<void> | null = null
  inFlight = 0
  maxInFlight = 0
  /** How many of the next describeIndexStats calls reject, for a partial ping. */
  failures = 0
  private async hold(): Promise<void> {
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.gate) await this.gate
    } finally {
      this.inFlight--
    }
  }
  namespace(name: string) {
    return {
      query: async (query: Record<string, unknown>) => {
        this.queries.push({ name, query })
        await this.hold()
        return { matches: [], namespace: name }
      },
    }
  }
  async describeIndexStats() {
    this.stats++
    await this.hold()
    if (this.failures > 0) {
      this.failures--
      throw new Error('stats unavailable')
    }
    return { namespaces: {} }
  }
}

let index = new FakeIndex()
mock.module('../src/config/pinecone', () => ({ getPineconeIndex: () => index }))

// The embedding client is the same fake for both entry points: the injected one
// (`setEmbeddingClientForAudit`) and `getOpenAI`, which `embedBatch` uses.
const embeddingRequests: Array<{ text: string; options?: { timeout?: number; maxRetries?: number } }> = []
let embeddingDelayMs = 0
const fakeEmbeddingClient = {
  embeddings: {
    async create(body: { input: string }, options?: { timeout?: number; maxRetries?: number }) {
      embeddingRequests.push({ text: body.input, options })
      if (embeddingDelayMs > 0) await Bun.sleep(embeddingDelayMs)
      return { data: [{ index: 0, embedding: [0.5, 0.5] }] }
    },
  },
}
mock.module('../src/config/openai', () => ({
  getOpenAI: () => fakeEmbeddingClient,
  getOpenRouter: unavailable,
}))

const warnings: Array<{ msg: string; fields: Record<string, unknown> }> = []
const fakeLog = {
  debug() {},
  info() {},
  warn(msg: string, fields: Record<string, unknown> = {}) {
    warnings.push({ msg, fields })
  },
  error() {},
}
mock.module('../src/utils/logger', () => ({ log: fakeLog }))

const embedding = await import('../src/ai/embedding')
const keepWarm = await import('../src/services/keep-warm')
const vectors = await import('../src/services/vector-store')
embedding.setEmbeddingClientForAudit(fakeEmbeddingClient)

type KeepWarmModule = typeof keepWarm
type EmbeddingApi = Pick<typeof embedding, 'embed' | 'embedQuery' | 'embedBatch' | 'pingEmbedding'>

/** A fake clock every module in the process reads, so an idle window is moved
 *  without waiting for one. */
let now = 0
function useClock(kw: KeepWarmModule): void {
  kw.setKeepWarmClockForAudit(() => now)
}

/** Evaluation of a mutated module copy, in the style of vector-store-audit: only
 *  our own source, in memory, never a working-tree file. */
function loadKeepWarm(source: string): KeepWarmModule {
  const js = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(source)
    .replace(/^import .*$/gm, '')
    .replace(/\bexport /g, '')
  return new Function(
    'env',
    'log',
    `${js}\n return { startKeepWarm, noteClientUse, lastClientUse, resetKeepWarmForAudit, setKeepWarmClockForAudit, keepWarmPineconeMode }`,
  )(env, fakeLog) as KeepWarmModule
}

function loadEmbedding(source: string): EmbeddingApi & { setEmbeddingClientForAudit(client: unknown): void } {
  const js = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(source)
    .replace(/^import .*$/gm, '')
    .replace(/\bexport /g, '')
  const api = new Function(
    'getOpenAI',
    'env',
    'AI_MODELS',
    'log',
    'noteClientUse',
    `${js}\n return { embed, embedQuery, embedBatch, pingEmbedding, setEmbeddingClientForAudit }`,
  )(
    () => fakeEmbeddingClient,
    env,
    { embedding: 'audit-embedding' },
    fakeLog,
    keepWarm.noteClientUse,
  ) as EmbeddingApi & { setEmbeddingClientForAudit(client: unknown): void }
  api.setEmbeddingClientForAudit(fakeEmbeddingClient)
  return api
}

function loadVectorStore(source: string): typeof vectors {
  const js = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(source)
    .replace(/^import .*$/gm, '')
    .replace(/\bexport /g, '')
  return new Function('env', 'getPineconeIndex', `${js}\n return { createVectorStore, setVectorIndexUseListener }`)(env, () => index) as typeof vectors
}

function countingPings() {
  const calls = { pinecone: 0, embedding: 0 }
  return {
    calls,
    pings: {
      pinecone: async () => {
        calls.pinecone++
      },
      embedding: async () => {
        calls.embedding++
      },
    },
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

// ── The knobs that ship ───────────────────────────────────────────────────────
console.log('\nthe knobs ship with the defaults this check assumes:')
await check('defaults are on / stats / width 3 / 10000 / 5000', () => {
  assert.equal(shippedDefault('KEEP_WARM'), 'on')
  assert.equal(shippedDefault('KEEP_WARM_PINECONE'), 'stats')
  assert.equal(Number(shippedDefault('KEEP_WARM_PINECONE_WIDTH')), env.KEEP_WARM_PINECONE_WIDTH)
  assert.equal(Number(shippedDefault('KEEP_WARM_IDLE_MS')), env.KEEP_WARM_IDLE_MS)
  assert.equal(Number(shippedDefault('KEEP_WARM_CHECK_MS')), env.KEEP_WARM_CHECK_MS)
})

// ── (i) the width knob ────────────────────────────────────────────────────────
/** `env.ts` reads `process.env` as it loads, so the shipped parser is run as its
 *  own module against a fake process rather than against this process's env. */
function loadEnvModule(source: string, raw: Record<string, string> = {}): { KEEP_WARM_PINECONE_WIDTH: number } {
  const js = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(source)
    .replace(/^import .*$/gm, '')
    .replace(/\bexport /g, '')
  const processEnv = {
    JWT_SECRET: 'audit', MONGODB_URI: 'audit', REDIS_URL: 'audit',
    OPENAI_API_KEY: 'audit', OPENROUTER_API_KEY: 'audit', PINECONE_API_KEY: 'audit',
    ...raw,
  }
  return new Function('process', `${js}\n return { env }`)({ env: processEnv }).env
}

async function widthKnob(source: string): Promise<void> {
  const width = (raw?: Record<string, string>) => loadEnvModule(source, raw).KEEP_WARM_PINECONE_WIDTH
  assert.equal(Number(shippedDefault('KEEP_WARM_PINECONE_WIDTH', source)), 3, 'the shipped default must be 3')
  assert.equal(width(), 3, 'an unset width must be the default')
  assert.equal(width({ KEEP_WARM_PINECONE_WIDTH: '2' }), 2, 'a width in range must be kept')
  assert.equal(width({ KEEP_WARM_PINECONE_WIDTH: '0' }), 1, '0 must clamp up to 1')
  assert.equal(width({ KEEP_WARM_PINECONE_WIDTH: '-2' }), 1, 'a negative must clamp up to 1')
  assert.equal(width({ KEEP_WARM_PINECONE_WIDTH: '9' }), 6, 'above the range must clamp to 6')
  assert.equal(width({ KEEP_WARM_PINECONE_WIDTH: 'wide' }), 3, 'a non-number must fall back to 3')
  assert.equal(width({ KEEP_WARM_PINECONE_WIDTH: '2.5' }), 3, 'a non-integer must fall back to 3')
}

console.log('\n(i) the width ships as 3 and cannot leave 1–6:')
await check('3 by default, a valid width kept, out-of-range clamped, a non-number back to 3', () => widthKnob(envSource))
await check('bite (i) width clamp: dropping the clamp fails it', async () => {
  const broken = mutate(envSource, 'Math.min(6, Math.max(1, configuredWidth))', 'configuredWidth')
  await assert.rejects(() => widthKnob(broken), /clamp up to 1/)
  await widthKnob(envSource)
})

// ── (a) startup warm ──────────────────────────────────────────────────────────
async function startupWarm(kw: KeepWarmModule): Promise<void> {
  kw.resetKeepWarmForAudit()
  now = 0
  useClock(kw)
  const { calls, pings } = countingPings()
  let scheduledEvery: number | null = null
  const keeper = kw.startKeepWarm({
    pings,
    schedule: (_run, everyMs) => {
      scheduledEvery = everyMs
      return 0
    },
  })
  await keeper.ready
  keeper.stop()
  assert.deepEqual(calls, { pinecone: 1, embedding: 1 }, 'startup must warm each client exactly once')
  assert.equal(scheduledEvery, env.KEEP_WARM_CHECK_MS, 'the check loop must run on KEEP_WARM_CHECK_MS')
}

console.log('\n(a) startup warms both clients once:')
await check('each client is pinged once at startup, and the worker is not blocked on it', () => startupWarm(keepWarm))
await check('bite (a) startup warm: skipping the startup tick fails it', async () => {
  const broken = loadKeepWarm(
    mutate(keepWarmSource, 'const ready = tick().then(', 'const ready = Promise.resolve({ pinged: [], failed: [] }).then('),
  )
  await assert.rejects(() => startupWarm(broken))
  await startupWarm(keepWarm)
})

// ── (b) the idle window ───────────────────────────────────────────────────────
async function idleWindow(kw: KeepWarmModule): Promise<void> {
  kw.resetKeepWarmForAudit()
  now = 0
  useClock(kw)
  const { calls, pings } = countingPings()
  const keeper = kw.startKeepWarm({ pings, schedule: () => 0 })
  await keeper.ready
  assert.deepEqual(calls, { pinecone: 1, embedding: 1 })

  now = env.KEEP_WARM_IDLE_MS - 1
  await keeper.tick()
  assert.deepEqual(calls, { pinecone: 1, embedding: 1 }, 'a client used inside the window must not be pinged')

  now = env.KEEP_WARM_IDLE_MS
  await keeper.tick()
  assert.deepEqual(calls, { pinecone: 2, embedding: 2 }, 'a client idle for the whole window must be pinged')
  keeper.stop()
}

console.log('\n(b) a client used within the idle window is not pinged:')
await check('inside the window nothing is sent; at the window both are', () => idleWindow(keepWarm))
await check('bite (b) idle window: ignoring the window fails it', async () => {
  const broken = loadKeepWarm(
    mutate(
      keepWarmSource,
      'if (usedAt !== undefined && clock() - usedAt < env.KEEP_WARM_IDLE_MS) return \'skipped\'',
      'if (usedAt !== undefined && clock() - usedAt < 0) return \'skipped\'',
    ),
  )
  await assert.rejects(() => idleWindow(broken))
  await idleWindow(keepWarm)
})

// ── (c) one ping per window, never overlapping ────────────────────────────────
async function onePerWindow(kw: KeepWarmModule): Promise<void> {
  kw.resetKeepWarmForAudit()
  now = 0
  useClock(kw)
  let gate: Promise<void> | null = null
  const calls = { pinecone: 0, embedding: 0 }
  const pings = {
    pinecone: async () => {
      calls.pinecone++
      if (gate) await gate
    },
    embedding: async () => {
      calls.embedding++
      if (gate) await gate
    },
  }
  const keeper = kw.startKeepWarm({ pings, schedule: () => 0 })
  await keeper.ready
  assert.deepEqual(calls, { pinecone: 1, embedding: 1 })

  now = env.KEEP_WARM_IDLE_MS
  const held = deferred()
  gate = held.promise
  const first = keeper.tick()
  const second = keeper.tick()
  const third = keeper.tick()
  await Bun.sleep(0) // let all three passes reach their ping or their skip
  try {
    assert.deepEqual(calls, { pinecone: 2, embedding: 2 }, 'concurrent checks must not stack a second ping on one client')
  } finally {
    held.resolve()
  }
  await Promise.all([first, second, third])
  // Both pings counted as use, so this window is spent.
  await keeper.tick()
  assert.deepEqual(calls, { pinecone: 2, embedding: 2 }, 'a ping must reset the window')

  now += env.KEEP_WARM_IDLE_MS
  gate = null
  await keeper.tick()
  assert.deepEqual(calls, { pinecone: 3, embedding: 3 }, 'the next idle window must ping again')
  keeper.stop()
}

console.log('\n(c) an idle client is pinged once per window, never overlapping:')
await check('concurrent checks send one ping per client and one per window', () => onePerWindow(keepWarm))
await check('bite (c) overlap guard: dropping it fails the check', async () => {
  const broken = loadKeepWarm(
    mutate(keepWarmSource, "if (inFlight.has(client)) return 'skipped'", "if (inFlight.has(client) && false) return 'skipped'"),
  )
  await assert.rejects(() => onePerWindow(broken))
  await onePerWindow(keepWarm)
})

// ── (d) the embedding ping bypasses the cache and the shared flight ───────────
async function embeddingPingReachesWire(api: EmbeddingApi): Promise<void> {
  const tokens = PING_TEXT.trim().split(/\s+/).length
  assert.ok(tokens >= 1 && tokens <= 3, `the ping text must be 1–3 tokens (got ${tokens})`)

  // Sent while a query for the same text is still in the air: the ping must not
  // inherit that flight and return without a request.
  embeddingDelayMs = 40
  embeddingRequests.length = 0
  const flight = api.embedQuery(PING_TEXT)
  await Bun.sleep(0)
  const ping = api.pingEmbedding()
  await Promise.all([flight, ping])
  embeddingDelayMs = 0
  assert.equal(embeddingRequests.length, 2, 'the ping must be its own request, not the query flight')
  const pingRequest = embeddingRequests[1]
  assert.equal(pingRequest.text, PING_TEXT)
  assert.equal(pingRequest.options?.timeout, PING_TIMEOUT_MS, 'the ping must carry its short timeout')
  assert.equal(pingRequest.options?.maxRetries, 0, 'a stalled ping must not be retried')

  // The text is cached by now; a cache-serving ping would reach nothing.
  embeddingRequests.length = 0
  await api.embedQuery(PING_TEXT)
  assert.equal(embeddingRequests.length, 0, 'the repeat must be served from the cache')
  await api.pingEmbedding()
  assert.equal(embeddingRequests.length, 1, 'the ping must reach the client even for a cached text')
}

// Both this check and its bite run a freshly loaded copy of the module: the
// check needs the ping text to be uncached, and the real module's 60 s cache
// cannot be cleared from outside.
console.log('\n(d) the embedding ping bypasses the cache and single-flight:')
await check('the ping is its own request even when the text is cached or in flight', () =>
  embeddingPingReachesWire(loadEmbedding(embeddingSource)),
)
await check('bite (d) ping bypass: routing the ping through embedQuery fails it', async () => {
  const broken = loadEmbedding(
    mutate(
      embeddingSource,
      'await requestEmbedding(PING_TEXT, { timeout: PING_TIMEOUT_MS, maxRetries: 0 })',
      'await embedQuery(PING_TEXT)',
    ),
  )
  await assert.rejects(() => embeddingPingReachesWire(broken))
  await embeddingPingReachesWire(loadEmbedding(embeddingSource))
})

// ── (e) stats vs query ────────────────────────────────────────────────────────
async function scopedPingShape(createStore: typeof vectors.createVectorStore): Promise<void> {
  const fake = new FakeIndex()
  const store = createStore({
    layout: 'shared',
    sharedNamespace: 'everlore',
    getIndex: () => fake as unknown as VectorIndex,
  })
  await store.ping('stats')
  assert.equal(fake.stats, env.KEEP_WARM_PINECONE_WIDTH, 'one stats ping must send its whole width')
  assert.equal(fake.queries.length, 0, 'stats must not search')

  await store.ping('query')
  assert.equal(fake.queries.length, env.KEEP_WARM_PINECONE_WIDTH, 'one query ping must send its whole width')
  const request = fake.queries[0]
  assert.equal(request.name, 'everlore', 'the search must hit the shared namespace prod reads')
  assert.equal(request.query.topK, 1, 'one match is the cheapest legal search')
  assert.equal(request.query.includeMetadata, false, 'no metadata: this costs nothing extra')
  assert.equal(request.query.includeValues, false, 'no values')
  assert.deepEqual(
    request.query.filter,
    { scope_kind: { $eq: 'mem' }, scope_id: { $eq: PING_SCOPE_ID } },
    'the search must be scoped to a scope that cannot exist',
  )
  assert.equal((request.query.vector as number[]).length, 1024, 'the vector must match the index dimension')
}

async function pineconeModeIsWired(kw: KeepWarmModule): Promise<void> {
  assert.equal(kw.keepWarmPineconeMode(), env.KEEP_WARM_PINECONE, 'the mode must be read from the env knob')
}

async function endToEndModes(): Promise<void> {
  keepWarm.resetKeepWarmForAudit()
  now = 0
  useClock(keepWarm)
  env.KEEP_WARM_PINECONE = 'stats'
  index = new FakeIndex()
  let keeper = keepWarm.startKeepWarm({ schedule: () => 0 })
  await keeper.ready
  keeper.stop()
  assert.equal(index.stats, env.KEEP_WARM_PINECONE_WIDTH, 'stats mode must send a whole width of stats asks at startup')
  assert.equal(index.queries.length, 0, 'stats mode must not search')

  keepWarm.resetKeepWarmForAudit()
  index = new FakeIndex()
  env.KEEP_WARM_PINECONE = 'query'
  keeper = keepWarm.startKeepWarm({ schedule: () => 0 })
  await keeper.ready
  keeper.stop()
  env.KEEP_WARM_PINECONE = 'stats'
  assert.equal(index.stats, 0, 'query mode must not ask for index stats')
  assert.equal(index.queries.length, env.KEEP_WARM_PINECONE_WIDTH, 'query mode must send a whole width of scoped searches')
  assert.equal((index.queries[0].query.vector as number[]).length, 1024)
}

console.log('\n(e) KEEP_WARM_PINECONE selects the free stats call or the scoped search:')
await check('stats calls describeIndexStats; query calls a scoped topK-1 search', async () => {
  await scopedPingShape(vectors.createVectorStore)
  await pineconeModeIsWired(keepWarm)
  await endToEndModes()
})
await check('bite (e) mode selection: pinning stats fails the knob check', async () => {
  const broken = loadKeepWarm(mutate(keepWarmSource, 'return env.KEEP_WARM_PINECONE', "return 'stats'"))
  env.KEEP_WARM_PINECONE = 'query'
  try {
    await assert.rejects(() => pineconeModeIsWired(broken))
  } finally {
    env.KEEP_WARM_PINECONE = 'stats'
  }
  await pineconeModeIsWired(keepWarm)
})
await check('bite (e) search shape: topK 5 instead of 1 fails the scoped-ping check', async () => {
  const broken = loadVectorStore(mutate(vectorSource, 'topK: 1,', 'topK: 5,'))
  await assert.rejects(() => scopedPingShape(broken.createVectorStore))
  await scopedPingShape(vectors.createVectorStore)
})

// ── (j)/(k) one ping, `width` requests in flight ──────────────────────────────
/** What the fan-out must never become, used as a bite: each request is started
 *  and awaited in turn, so the second and third connections stay cold. */
const SERIAL_FAN_OUT = [
  '      const settled: PromiseSettledResult<unknown>[] = []',
  '      for (let i = 0; i < count; i++) {',
  '        try {',
  "          settled.push({ status: 'fulfilled', value: await send() })",
  '        } catch (reason) {',
  "          settled.push({ status: 'rejected', reason })",
  '        }',
  '      }',
].join('\n')

async function fanOut(api: typeof vectors, mode: 'stats' | 'query'): Promise<void> {
  const fake = new FakeIndex()
  const store = api.createVectorStore({
    layout: 'shared',
    sharedNamespace: 'everlore',
    getIndex: () => fake as unknown as VectorIndex,
  })
  const uses = { count: 0 }
  api.setVectorIndexUseListener(() => {
    uses.count++
  })
  // Held open: a request can only be counted as in flight while it waits here.
  const held = deferred()
  fake.gate = held.promise
  const ping = store.ping(mode, 3)
  try {
    await Bun.sleep(0)
    const reached = mode === 'stats' ? fake.stats : fake.queries.length
    assert.equal(reached, 3, `one ${mode} ping must send all three requests, not wait for one`)
    assert.equal(fake.maxInFlight, 3, `all three must be in flight together (max ${fake.maxInFlight})`)
    assert.equal(uses.count, 1, 'one ping must report the index as used once, not once per request')
    if (mode === 'stats') assert.equal(fake.queries.length, 0, 'a stats ping must not search')
    else assert.equal(fake.stats, 0, 'a query ping must not ask for index stats')
  } finally {
    held.resolve()
    await ping
    api.setVectorIndexUseListener(() => keepWarm.noteClientUse('pinecone'))
  }
  if (mode !== 'query') return
  for (const request of fake.queries) {
    assert.equal(request.name, 'everlore', 'every scoped search must hit the shared namespace prod reads')
    assert.equal(request.query.topK, 1, 'every scoped search must ask for one match')
    assert.deepEqual(
      request.query.filter,
      { scope_kind: { $eq: 'mem' }, scope_id: { $eq: PING_SCOPE_ID } },
      'every scoped search must be scoped to a scope that cannot exist',
    )
  }
}

async function widthReachesTheWire(): Promise<void> {
  keepWarm.resetKeepWarmForAudit()
  now = 0
  useClock(keepWarm)
  index = new FakeIndex()
  env.KEEP_WARM_PINECONE_WIDTH = 4
  try {
    const keeper = keepWarm.startKeepWarm({ schedule: () => 0 })
    await keeper.ready
    keeper.stop()
  } finally {
    env.KEEP_WARM_PINECONE_WIDTH = 3
  }
  assert.equal(index.stats, 4, 'the env width must be how many requests one ping sends')
}

console.log('\n(j)/(k) one ping sends a whole width of requests, all in flight at once:')
await check('(j) a stats ping reaches the index width times with max in flight == width', () => fanOut(vectors, 'stats'))
await check('bite (j) stats fan-out: a serial loop fails it', async () => {
  const broken = loadVectorStore(mutate(vectorSource, FAN_OUT_LINE, SERIAL_FAN_OUT))
  await assert.rejects(() => fanOut(broken, 'stats'), /must send all three requests/)
  await fanOut(vectors, 'stats')
})
await check('(k) a query ping sends width scoped topK-1 searches at once', () => fanOut(vectors, 'query'))
await check('bite (k) query fan-out: a serial loop fails it', async () => {
  const broken = loadVectorStore(mutate(vectorSource, FAN_OUT_LINE, SERIAL_FAN_OUT))
  await assert.rejects(() => fanOut(broken, 'query'), /must send all three requests/)
  await fanOut(vectors, 'query')
})
await check('the knob reaches the wire: a width of 4 sends four stats asks', widthReachesTheWire)

// ── (f) a failing ping never throws and never stops later pings ───────────────
async function failureIsolation(kw: KeepWarmModule): Promise<void> {
  kw.resetKeepWarmForAudit()
  now = 0
  useClock(kw)
  warnings.length = 0
  let pineconeAttempts = 0
  let embeddingAttempts = 0
  let pineconeFails = true
  const keeper = kw.startKeepWarm({
    pings: {
      pinecone: async () => {
        pineconeAttempts++
        if (pineconeFails) throw new Error('pinecone unavailable')
      },
      embedding: async () => {
        embeddingAttempts++
      },
    },
    schedule: () => 0,
  })
  await keeper.ready
  assert.equal(pineconeAttempts, 1)
  assert.equal(embeddingAttempts, 1, 'a failed pinecone ping must not stop the embedding ping')
  const logged = warnings.filter((entry) => entry.msg === 'keep_warm.ping_failed')
  assert.equal(logged.length, 1, 'a failed ping must be logged once')
  assert.equal(logged[0].fields.client, 'pinecone')
  assert.ok(
    !JSON.stringify(logged[0].fields).toLowerCase().includes('api_key'),
    'a ping log line must never carry a key',
  )

  now += env.KEEP_WARM_IDLE_MS
  pineconeFails = false
  await keeper.tick()
  assert.equal(pineconeAttempts, 2, 'the next window must try again')
  assert.equal(embeddingAttempts, 2)
  keeper.stop()
}

console.log('\n(f) a failing ping is logged, never thrown, and later pings still run:')
await check('a failure does not reject, stop the other client, or stop the next window', () => failureIsolation(keepWarm))
await check('bite (f) failure isolation: rethrowing the ping error fails it', async () => {
  const broken = loadKeepWarm(mutate(keepWarmSource, PING_FAILED_LOG, '      throw error'))
  await assert.rejects(() => failureIsolation(broken))
  await failureIsolation(keepWarm)
})

// ── (l) a partly failed ping is one logged line, and never a throw ────────────
async function partialFailureAtTheStore(api: typeof vectors): Promise<void> {
  const fake = new FakeIndex()
  const store = api.createVectorStore({
    layout: 'shared',
    sharedNamespace: 'everlore',
    getIndex: () => fake as unknown as VectorIndex,
  })
  fake.failures = 1
  let error: unknown
  try {
    await store.ping('stats', 3)
  } catch (err) {
    error = err
  }
  assert.ok(error, 'a partly failed ping must reject once')
  assert.equal((error as { failed?: unknown }).failed, 1, 'the error must carry how many requests failed')
  assert.equal((error as { total?: unknown }).total, 3, 'and how many were sent')
  assert.equal(fake.stats, 3, 'every request must be sent and settled, not abandoned at the first failure')
}

async function partialFailure(kw: KeepWarmModule): Promise<void> {
  kw.resetKeepWarmForAudit()
  now = 0
  useClock(kw)
  warnings.length = 0
  index = new FakeIndex()
  index.failures = 1
  const keeper = kw.startKeepWarm({
    // The shipped pinger's wire call, injected so a mutated copy of keep-warm
    // still exercises the real store.
    pings: { pinecone: () => vectors.vectorStore.ping('stats'), embedding: async () => {} },
    schedule: () => 0,
  })
  await keeper.ready
  assert.equal(index.stats, env.KEEP_WARM_PINECONE_WIDTH, 'every request must still be sent')
  const logged = warnings.filter((entry) => entry.msg === 'keep_warm.ping_failed')
  assert.equal(logged.length, 1, 'a partly failed ping must log exactly one line')
  assert.equal(logged[0].fields.client, 'pinecone')
  assert.equal(logged[0].fields.failed, 1, 'the line must say how many requests failed')
  assert.ok(
    !JSON.stringify(logged[0].fields).toLowerCase().includes('api_key'),
    'a ping log line must never carry a key',
  )

  now += env.KEEP_WARM_IDLE_MS
  index.failures = 0
  const before = index.stats
  await keeper.tick()
  assert.equal(index.stats - before, env.KEEP_WARM_PINECONE_WIDTH, 'the next idle window must ping again')
  keeper.stop()
}

console.log('\n(l) one failing request of width is one logged failure, never thrown:')
await check('(l) the store rejects once with the count, after every request has settled', () =>
  partialFailureAtTheStore(vectors),
)
await check('bite (l) allSettled: Promise.all loses the failed count', async () => {
  const broken = loadVectorStore(mutate(vectorSource, 'await Promise.allSettled(', 'await Promise.all('))
  await assert.rejects(() => partialFailureAtTheStore(broken), /must carry how many requests failed/)
  await partialFailureAtTheStore(vectors)
})
await check('(l) through the pinger: one warn line with the count, and later pings still run', () =>
  partialFailure(keepWarm),
)
await check('bite (l) partial failure: dropping the failed count from the warn line fails it', async () => {
  const broken = loadKeepWarm(mutate(keepWarmSource, FAILED_COUNT_LINE, ''))
  await assert.rejects(() => partialFailure(broken), /must say how many requests failed/)
  await partialFailure(keepWarm)
})

// ── (g) KEEP_WARM=off ─────────────────────────────────────────────────────────
async function offSwitch(kw: KeepWarmModule): Promise<void> {
  kw.resetKeepWarmForAudit()
  now = 0
  useClock(kw)
  const { calls, pings } = countingPings()
  let scheduled = 0
  env.KEEP_WARM = false
  try {
    const keeper = kw.startKeepWarm({
      pings,
      schedule: () => {
        scheduled++
        return 0
      },
    })
    await keeper.ready
    now += env.KEEP_WARM_IDLE_MS * 10
    await keeper.tick()
    keeper.stop()
  } finally {
    env.KEEP_WARM = true
  }
  assert.deepEqual(calls, { pinecone: 0, embedding: 0 }, 'KEEP_WARM=off must send nothing')
  assert.equal(scheduled, 0, 'KEEP_WARM=off must not run a check loop')
}

console.log('\n(g) KEEP_WARM=off sends nothing:')
await check('no ping and no check loop', () => offSwitch(keepWarm))
await check('bite (g) off switch: ignoring the flag fails it', async () => {
  const broken = loadKeepWarm(mutate(keepWarmSource, 'if (!env.KEEP_WARM) {', 'if (false) {'))
  await assert.rejects(() => offSwitch(broken))
  await offSwitch(keepWarm)
})

// ── (h) real use moves the last-use time, cache hits do not ───────────────────
async function pineconeUseCounts(): Promise<void> {
  keepWarm.resetKeepWarmForAudit()
  now = 0
  useClock(keepWarm)
  index = new FakeIndex()
  // The shipped pinger, once: this is where the store's use listener is registered.
  const boot = keepWarm.startKeepWarm({ schedule: () => 0 })
  await boot.ready
  boot.stop()
  assert.equal(keepWarm.lastClientUse('pinecone'), 0, 'the startup ping itself counts as use')

  now = 1_000
  await vectors.vectorStore.ping('stats')
  assert.equal(keepWarm.lastClientUse('pinecone'), 1_000, 'a store call that reached the index counts as use')
}

async function embeddingUseCounts(api: EmbeddingApi): Promise<void> {
  keepWarm.resetKeepWarmForAudit()
  now = 2_000
  useClock(keepWarm)
  embeddingDelayMs = 0
  embeddingRequests.length = 0

  await api.embedQuery('a question already asked')
  assert.equal(embeddingRequests.length, 1)
  assert.equal(keepWarm.lastClientUse('embedding'), 2_000)

  await api.embedQuery('a question already asked')
  assert.equal(embeddingRequests.length, 1, 'the repeat must be a cache hit')
  assert.equal(keepWarm.lastClientUse('embedding'), 2_000, 'a cache hit must not reset the idle window')

  now = 3_000
  await api.embed('a background text')
  assert.equal(keepWarm.lastClientUse('embedding'), 3_000, 'the background path must count')

  now = 4_000
  await api.embedBatch(['one', 'two'])
  assert.equal(keepWarm.lastClientUse('embedding'), 4_000, 'a batch must count')
}

console.log('\n(h) real use updates the last-use time, and cache hits do not:')
await check('a store call and every embedding entry point count; a cache hit does not', async () => {
  await pineconeUseCounts()
  await embeddingUseCounts(loadEmbedding(embeddingSource))
})
await check('bite (h) last use: dropping the note in requestEmbedding fails it', async () => {
  const broken = loadEmbedding(
    mutate(
      embeddingSource,
      "  // Sent, not cached: this is the moment the connection was used, which is what\n  // the keep-warm pinger reads to decide whether it has gone idle.\n  noteClientUse('embedding')\n",
      '',
    ),
  )
  await assert.rejects(() => embeddingUseCounts(broken))
  await embeddingUseCounts(loadEmbedding(embeddingSource))
})

// ── (j) the token encoder is built at worker startup, before any job ───────
// Building it took ~600 ms on the prod box and landed in the first turn's
// prompt build after every restart; no network ping can warm CPU work.
const workerSource = read('../worker/index.ts')
function encoderWarmProblems(source: string): string[] {
  const problems: string[] = []
  const warm = source.indexOf('\n  warmTokenEncoder()')
  const firstWorker = source.indexOf('new Worker(')
  if (!/import \{ warmTokenEncoder \} from '\.\.\/src\/utils\/token-counter'/.test(source)) problems.push('worker does not import warmTokenEncoder')
  if (warm < 0) problems.push('worker never builds the token encoder')
  else if (firstWorker >= 0 && warm > firstWorker) problems.push('the encoder is built after the workers start taking jobs')
  return problems
}
await check('(j) the worker builds the token encoder before it takes jobs', () => {
  assert.deepEqual(encoderWarmProblems(workerSource), [])
})
await check('bite (j) startup encoder: dropping the call fails it', () => {
  const late = mutate(workerSource, '\n  warmTokenEncoder()', '')
  assert.ok(encoderWarmProblems(late).length > 0)
  const moved = late.replace(/(\n\s*const memoryWorker = new Worker\()/, '\n  warmTokenEncoder()$1')
  assert.notEqual(moved, late, 'the memory worker anchor moved; update this audit')
  assert.ok(encoderWarmProblems(moved).length > 0)
})

// ── (k) warming really builds it ─────────────────────────────────────────────
const tokenCounter = await import('../src/utils/token-counter')
await check('(k) warmTokenEncoder leaves the encoder built', () => {
  assert.equal(tokenCounter.warmTokenEncoder(), true)
  assert.equal(tokenCounter.isTokenEncoderReady(), true)
  const started = performance.now()
  tokenCounter.countTokens('a warm encoder answers at once')
  assert.ok(performance.now() - started < 20, 'a warm count took 20 ms or more')
})
await check('bite (k) a warm function that builds nothing fails it', () => {
  const tokenSource = read('../src/utils/token-counter.ts')
  const broken = mutate(tokenSource, '    getEncoder()\n    return true', '    return true')
  // The broken copy sits beside the original so it resolves the same packages,
  // and runs in a fresh process so its encoder starts unbuilt.
  const file = new URL(`../src/utils/.token-counter-bite-${process.pid}.ts`, import.meta.url).pathname
  try {
    writeFileSync(file, broken)
    const out = Bun.spawnSync(['bun', '--no-env-file', '-e',
      `const m = await import(${JSON.stringify(file)}); m.warmTokenEncoder(); console.log(m.isTokenEncoderReady())`],
      { cwd: new URL('..', import.meta.url).pathname })
    assert.equal(out.stdout.toString().trim(), 'false', out.stderr.toString())
  } finally {
    rmSync(file, { force: true })
  }
})

console.log(`\nkeep-warm audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
