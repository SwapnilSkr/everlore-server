/**
 * gc-1-live — the REAL group turn, real writers, real router, no database.
 *
 * Brief: .agents/tasks/gc-1-live.md. It runs `groupTurnProcessor` at 9d6a236
 * end to end: authored groups drive the instance, the real `callLLMWithFallback`
 * (→ `callLLM`) writes, and the real same-turn intent router decides the route.
 * Nothing is stubbed except the infrastructure below.
 *
 * SAFETY
 * - Run it from the shared `everlore-server/` ONLY so Bun loads the
 *   `OPENROUTER_API_KEY` from that `.env`. The key is never read, printed or
 *   logged here.
 * - Before any product import, every database / Redis / vector / object-store
 *   variable in `src/config/env.ts` is overwritten with a dead local address, so
 *   a missed mock fails loudly instead of writing to the production database.
 * - `globalThis.fetch` is replaced with a wrapper that allows only
 *   `openrouter.ai` and throws (logging the blocked host) for anything else.
 * - Mongo, Redis, queues, RAG, vectors, embeddings, post-process outbox and
 *   llm-trace are replaced in memory, using the `mock.module` pattern and the
 *   in-memory stores from scripts/group-chat-audit.ts.
 * - `--selftest` proves the fetch guard bites and that the Mongo/Redis stubs in
 *   use are the in-memory ones.
 *
 * USAGE (from /Users/fatman/Desktop/codes/rpg-ai/everlore-server):
 *   bun run <this script> --selftest     no calls
 *   bun run <this script> --plan         no calls, prints the planned spend
 *   bun run <this script> --smoke        up to 2 paid turns, ledger kept
 *   bun run <this script>                the run (spend cap $0.20)
 *   bun run <this script> --sample a,b   each named group's whole cast, its own folder and cap (₹25, $0.29)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import type { WorldTemplateDoc } from '../src/models/world-template.model'
import type { GroupMember } from '../src/services/group-chat/types'
import type { GroupTurnJob } from '../worker/processors/group-turn.processor'

// ---------------------------------------------------------------- paths, cap

const ROOT = resolve(import.meta.dir, '..', '..')
const sampleIndex = process.argv.indexOf('--sample')
const SAMPLE_SLUGS = sampleIndex > 0 ? (process.argv[sampleIndex + 1] || '').split(',').filter(Boolean) : []
const OUT_DIR = join(ROOT, sampleIndex > 0 ? `.agents/probes/group-chat/${process.env.SAMPLE_OUT || 'sample-nov7'}` : '.agents/probes/group-chat/live')
const LEDGER_FILE = join(OUT_DIR, 'spend.json')
const SUMMARY_FILE = join(OUT_DIR, 'summary.json')
const CAP_USD = sampleIndex > 0 ? Number(process.env.SAMPLE_CAP_USD) || 0.29 : 0.20
const INR_PER_USD = 85
/** Charged to the guard for a paid call whose response carried no cost. */
const UNPRICED_CALL_RESERVE_USD = 0.004
/** Used before the first turn, as the brief specifies. */
const FIRST_TURN_RESERVE_USD = 0.004
const PLAYER = 'Sam'
const PLAYER_AGE = 28
const PLAYER_ID = '300000000000000000000001'

// ⛔ Poison infrastructure env BEFORE any product module is imported. Bun has
// already loaded .env from the shared checkout at this point (that is the only
// reason to run from there), so overwriting process.env here is what keeps a
// missed mock away from production. OPENROUTER_API_KEY is deliberately kept.
const POISON: Record<string, string> = {
  // The shared .env carries NODE_ENV=production; this process is not the server.
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:1/never-everlore',
  REDIS_URL: 'redis://127.0.0.1:1',
  PINECONE_API_KEY: 'dead-pinecone-key',
  PINECONE_INDEX: 'never-everlore',
  PINECONE_SHARED_NAMESPACE: 'never-everlore',
  S3_BUCKET: 'never-everlore',
  CDN_BASE_URL: 'http://127.0.0.1:1',
  AWS_ACCESS_KEY_ID: 'dead',
  AWS_SECRET_ACCESS_KEY: 'dead',
  AWS_SESSION_TOKEN: 'dead',
  OPENAI_API_KEY: 'dead-openai-key',
  KEEP_WARM: 'off',
}
for (const [key, value] of Object.entries(POISON)) process.env[key] = value
if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set. Run from the shared everlore-server/ so Bun loads its .env.')
  process.exit(3)
}

const args = new Set(process.argv.slice(2))

// ---------------------------------------------------------------- spend ledger

interface Ledger {
  cap_usd: number
  spent_usd: number
  reserved_usd: number
  calls: number
  turns: number
  unpriced_calls: number
  max_turn_usd: number
  updated_at: string
}

class SpendStop extends Error {
  constructor(message: string) { super(message); this.name = 'SpendStop' }
}

function freshLedger(): Ledger {
  return { cap_usd: CAP_USD, spent_usd: 0, reserved_usd: 0, calls: 0, turns: 0, unpriced_calls: 0, max_turn_usd: 0, updated_at: new Date().toISOString() }
}

const ledger: Ledger = (() => {
  if (!existsSync(LEDGER_FILE)) return freshLedger()
  try {
    const raw = JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) as Partial<Ledger>
    if (!Number.isFinite(raw.spent_usd) || !Number.isFinite(raw.reserved_usd) || !Number.isFinite(raw.calls)) {
      throw new Error('missing numeric fields')
    }
    return { ...freshLedger(), ...raw } as Ledger
  } catch (error) {
    // A corrupt ledger must not silently reset the cap.
    throw new Error(`Unreadable ledger ${LEDGER_FILE}; fix or delete it deliberately`, { cause: error })
  }
})()

function saveLedger(): void {
  mkdirSync(OUT_DIR, { recursive: true })
  ledger.updated_at = new Date().toISOString()
  writeFileSync(LEDGER_FILE, `${JSON.stringify(ledger, null, 2)}\n`)
}

/** The brief's guard: the ledger plus the worst turn so far must still fit. */
function guardBeforeTurn(aLedger: Ledger = ledger): void {
  const reserve = aLedger.max_turn_usd > 0 ? aLedger.max_turn_usd : FIRST_TURN_RESERVE_USD
  if (aLedger.reserved_usd + reserve > aLedger.cap_usd) {
    throw new SpendStop(`spend guard: reserved $${aLedger.reserved_usd.toFixed(6)} + worst turn $${reserve.toFixed(6)} would pass the $${aLedger.cap_usd.toFixed(2)} cap`)
  }
}

/** Set once the cap is crossed. Further requests are refused before they are
 *  sent, so a swallowed writer error cannot keep spending. */
let capTripped = false

function charge(aLedger: Ledger, costUsd: number | null, billable = true): void {
  aLedger.calls += 1
  if (!billable) return
  if (costUsd === null) {
    aLedger.unpriced_calls += 1
    aLedger.reserved_usd += UNPRICED_CALL_RESERVE_USD
  } else {
    aLedger.spent_usd += costUsd
    aLedger.reserved_usd += costUsd
  }
  if (aLedger.reserved_usd > aLedger.cap_usd) {
    capTripped = true
    throw new SpendStop(`spend cap reached: reserved $${aLedger.reserved_usd.toFixed(6)} of $${aLedger.cap_usd.toFixed(2)}`)
  }
}

// ---------------------------------------------------------------- fetch guard

const realFetch = globalThis.fetch.bind(globalThis)
const blockedHosts: string[] = []
const httpCalls: HttpCall[] = []
let currentTurn = 'selftest'

interface HttpCall {
  turn: string
  purpose: 'narration' | 'content_intent_same_turn'
  request_model: string | null
  response_model: string | null
  provider: string | null
  prompt_tokens: number
  completion_tokens: number
  cost_usd: number | null
  latency_ms: number
  status: number
  stream: boolean
}
const fetchFailures: Array<{ turn: string; url: string; error: string }> = []

function isAllowedUrl(value: string): boolean {
  try { return new URL(value).hostname === 'openrouter.ai' } catch { return false }
}

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  return new URL((input as Request).url)
}

const guardedFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
  if (capTripped) throw new SpendStop('spend cap already reached; refusing another request')
  const url = urlOf(input)
  if (url.hostname !== 'openrouter.ai') {
    blockedHosts.push(url.hostname)
    throw new Error(`Blocked non-OpenRouter request to ${url.hostname}`)
  }
  let requestModel: string | null = null
  let stream = false
  let purpose: HttpCall['purpose'] = 'narration'
  try {
    if (typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as { model?: unknown; stream?: unknown; max_tokens?: unknown; response_format?: { type?: unknown } }
      requestModel = typeof body.model === 'string' ? body.model : null
      stream = body.stream === true
      // The router is the only small json_object call the engine makes.
      if (body.response_format?.type === 'json_object' && Number(body.max_tokens) <= 16) purpose = 'content_intent_same_turn'
    }
  } catch { /* a non-JSON body is left unattributed */ }

  const started = performance.now()
  let response: Response
  try {
    response = await realFetch(input, init)
  } catch (error) {
    fetchFailures.push({ turn: currentTurn, url: url.href, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
  const latency = performance.now() - started
  let responseModel: string | null = null
  let provider: string | null = null
  let prompt = 0
  let completion = 0
  let cost: number | null = null
  try {
    const body = await response.clone().json() as {
      model?: unknown; provider?: unknown
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown }
    }
    if (typeof body.model === 'string') responseModel = body.model
    if (typeof body.provider === 'string') provider = body.provider
    prompt = Number(body.usage?.prompt_tokens) || 0
    completion = Number(body.usage?.completion_tokens) || 0
    const reported = Number(body.usage?.cost)
    cost = Number.isFinite(reported) ? reported : null
  } catch { /* an error body is still a call that may have been billed */ }

  const call: HttpCall = { turn: currentTurn, purpose, request_model: requestModel, response_model: responseModel, provider,
    prompt_tokens: prompt, completion_tokens: completion, cost_usd: cost, latency_ms: latency, status: response.status, stream }
  httpCalls.push(call)
  // Throwing here is the hard stop even mid-turn. Error responses are not billed.
  charge(ledger, cost, response.ok)
  saveLedger()
  return response
}, { preconnect: realFetch.preconnect })

globalThis.fetch = guardedFetch

// ---------------------------------------------------------------- stores

type Row = Record<string, unknown>
const tables = new Map<string, Row[]>()
function rows(name: string): Row[] { if (!tables.has(name)) tables.set(name, []); return tables.get(name)! }
function lookup(value: unknown, keys: string[]): unknown {
  if (!keys.length) return value
  if (Array.isArray(value)) return value.flatMap(entry => lookup(entry, keys))
  if (!value || typeof value !== 'object') return undefined
  return lookup((value as Row)[keys[0]], keys.slice(1))
}
const get = (row: Row, path: string) => lookup(row, path.split('.'))
function put(row: Row, path: string, value: unknown) {
  const keys = path.split('.'); let current = row
  for (const key of keys.slice(0, -1)) { current[key] ??= {}; current = current[key] as Row }
  current[keys.at(-1)!] = value
}
const eq = (a: unknown, b: unknown) => a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : a === b
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$and') return (expected as Row[]).every(clause => matches(row, clause))
    if (key === '$or') return (expected as Row[]).some(clause => matches(row, clause))
    const value = get(row, key)
    if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, other]) => {
        if (op === '$ne') return !eq(value, other)
        if (op === '$exists') return (value !== undefined) === other
        if (op === '$in') return (other as unknown[]).some(entry => eq(value, entry))
        if (op === '$lt') return Number(value) < Number(other)
        if (op === '$gte') return Number(value) >= Number(other)
        if (op === '$gt') return Number(value) > Number(other)
        throw new Error(`Unsupported in-memory query operator ${op}`)
      })
    }
    return Array.isArray(value) ? value.some(entry => eq(entry, expected)) : eq(value, expected)
  })
}
const clone = <T>(input: T): T => {
  if (!input || typeof input !== 'object' || input instanceof Date || input instanceof ObjectId) return input
  if (Array.isArray(input)) return input.map(clone) as T
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, clone(value)])) as T
}

function collection(name: string) {
  return {
    find(filter: Row = {}) {
      let values = rows(name).filter(row => matches(row, filter))
      const cursor = {
        sort(order: Record<string, number>) {
          values.sort((a, b) => {
            for (const [key, dir] of Object.entries(order)) {
              const av = get(a, key), bv = get(b, key)
              if (av !== bv) return (Number(av) < Number(bv) ? -1 : 1) * dir
            }
            return 0
          })
          return cursor
        },
        limit(n: number) { values = values.slice(0, n); return cursor },
        skip(n: number) { values = values.slice(n); return cursor },
        project(fields: Record<string, number>) {
          values = values.map(value => Object.fromEntries(Object.keys(fields).filter(key => fields[key] && key in value).map(key => [key, value[key]])))
          return cursor
        },
        async toArray() { return clone(values) },
      }
      return cursor
    },
    async findOne(filter: Row, options?: { sort?: Record<string, number>; projection?: Row }) {
      let cursor = this.find(filter)
      if (options?.sort) cursor = cursor.sort(options.sort)
      return (await cursor.toArray())[0] || null
    },
    async countDocuments(filter: Row) { return rows(name).filter(row => matches(row, filter)).length },
    async insertOne(row: Row) { rows(name).push(clone(row)); return { insertedId: row._id } },
    async updateOne(filter: Row, update: Row, options?: { upsert?: boolean }) {
      let row = rows(name).find(entry => matches(entry, filter))
      const existed = !!row
      if (!row && options?.upsert) {
        row = clone(filter)
        rows(name).push(row)
        Object.assign(row, clone((update.$setOnInsert ?? {}) as Row))
      }
      if (row) {
        for (const [key, value] of Object.entries((update.$set || {}) as Row)) put(row, key, clone(value))
        for (const [key, value] of Object.entries((update.$inc || {}) as Row)) put(row, key, Number(get(row, key) || 0) + Number(value))
        for (const key of Object.keys((update.$unset || {}) as Row)) delete row[key]
      }
      return { matchedCount: existed ? 1 : 0, modifiedCount: existed ? 1 : 0 }
    },
    async deleteMany(filter: Row) {
      const list = rows(name); const kept = list.filter(row => !matches(row, filter))
      const deleted = list.length - kept.length
      list.splice(0, list.length, ...kept)
      return { deletedCount: deleted }
    },
    async deleteOne(filter: Row) {
      const index = rows(name).findIndex(row => matches(row, filter))
      if (index >= 0) rows(name).splice(index, 1)
      return { deletedCount: index >= 0 ? 1 : 0 }
    },
  }
}

const frames: Row[] = [], outbox: Row[] = []
const locks = new Map<string, string>()
const redis = {
  async get(key: string) { return locks.get(key) || null },
  async set(key: string, value: string) { locks.set(key, value); return 'OK' },
  async del(key: string) { locks.delete(key); return 1 },
  async publish(channel: string, text: string) { frames.push({ channel, ...JSON.parse(text) }); return 1 },
  async eval(_script: string, _keys: number, key: string, outcomeKey: string, before: string, after: string, _ttl: string, outcome: string, channel: string, frame: string) {
    if ((locks.get(key) || '') !== before) return 0
    if (channel) await this.publish(channel, frame)
    if (after) locks.set(key, after); else locks.delete(key)
    if (outcome) locks.set(outcomeKey, outcome)
    return 1
  },
}
const unavailable = (name: string): never => { throw new Error(`Unexpected external dependency in the live probe: ${name}`) }

const logs: Array<{ msg: string; fields: Row }> = []
const traceSnapshots: Array<{ turn: string; records: Row[] }> = []

// Mocks are installed before every product import (below).
mock.module('../src/config/mongo', () => ({
  mongoColl: new Proxy({}, { get: (_target, key) => () => collection(String(key)) }),
  coll: (name: string) => collection(name),
  getDb: () => unavailable('mongo.getDb'),
  connectMongo: () => unavailable('mongo.connectMongo'),
  accountTransaction: (work: () => unknown) => work(),
}))
mock.module('../src/config/redis', () => ({
  getRedisClient: () => redis,
  getRedisSubscriber: () => unavailable('redis.getRedisSubscriber'),
  getQueueRedisClient: () => unavailable('redis.getQueueRedisClient'),
  getRedisProcess: () => undefined,
  onRedisProcessReady: () => () => {},
  cacheRedisProcess: () => {},
  connectRedis: () => unavailable('redis.connectRedis'),
}))
mock.module('../src/services/llm-trace.service', () => ({
  flushLLMTracesLater: (records: Row[]) => { traceSnapshots.push({ turn: currentTurn, records }) },
  flushLLMTraces: async () => {},
  traceStore: () => ({ calls: collection('llmCalls'), bodies: collection('llmBodies') }),
  runBackgroundLLMTrace: async (_scope: unknown, fn: () => Promise<unknown>) => fn(),
  ensureStoryEngineLogIndexes: async () => {},
  truncateTraceText: (text: string) => ({ content: text }),
  buildTraceBody: () => ({}),
  traceLogFields: () => ({}),
}))
mock.module('../src/providers/rag.provider', () => ({
  queryRag: async () => ({ memoryTexts: [] as string[] }),
  querySummaries: async () => [],
}))
mock.module('../src/services/post-process-outbox.service', () => ({
  stagePostProcess: async (input: Row) => { outbox.push(input) },
  dispatchPostProcessOutbox: async () => 0,
}))
mock.module('../src/services/vector-store', () => ({
  vectorStore: { replaceLore: () => unavailable('vectorStore.replaceLore'), deleteScope: async () => {} },
}))
mock.module('../src/utils/logger', () => ({
  log: {
    debug() {},
    info(msg: string, fields: Row = {}) { if (String(msg).startsWith('group.')) logs.push({ msg, fields: clone(fields) }) },
    warn() {},
    error() {},
  },
  publicRequestMeta: () => ({}),
}))

// ---------------------------------------------------------------- real imports

const { mongoColl } = await import('../src/config/mongo')
const { getRedisClient, getQueueRedisClient } = await import('../src/config/redis')
const { env } = await import('../src/config/env')
const { groupTurnProcessor } = await import('../worker/processors/group-turn.processor')
const { seedGroupOpening } = await import('../src/services/group-chat/instance')
const { validateGroup } = await import('../src/services/group-chat/validation')
const { parseLines, emptyLineCounts, stripStageDirections } = await import('../src/services/group-chat/lines')
const { runWithLLMTrace, runWithLLMUsage, snapshotLLMTrace } = await import('../src/ai/usage')
const { AI_MODELS, narrationTemperature } = await import('../src/ai')
const { DEFAULT_CHAT_MODE } = await import('../src/utils/chat-modes')
const { vectorStore } = await import('../src/services/vector-store')
const { queryRag } = await import('../src/providers/rag.provider')

const NORMAL_MODEL = AI_MODELS.narrationSfw
const NORMAL_FALLBACKS = AI_MODELS.narrationSfwFallbacks
const ADULT_MODEL = AI_MODELS.groupNsfw
const ADULT_FALLBACKS = AI_MODELS.groupNsfwFallbacks
const ROUTER = { switch: env.NSFW_SAME_TURN_ROUTER, model: env.NSFW_SAME_TURN_ROUTER_MODEL, host: env.NSFW_SAME_TURN_ROUTER_HOST }

// ---------------------------------------------------------------- selftest

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`selftest failed: ${message}`)
}

async function selftest(): Promise<void> {
  // 1. The poisoned env is what the product's env module sees.
  assert(env.MONGODB_URI === POISON.MONGODB_URI, 'env.MONGODB_URI is not the dead address')
  assert(env.REDIS_URL === POISON.REDIS_URL, 'env.REDIS_URL is not the dead address')
  assert(env.PINECONE_API_KEY === POISON.PINECONE_API_KEY, 'env.PINECONE_API_KEY is not dead')
  assert(env.S3_BUCKET === POISON.S3_BUCKET && env.CDN_BASE_URL === POISON.CDN_BASE_URL, 'object store is not dead')
  assert(env.OPENROUTER_API_KEY === process.env.OPENROUTER_API_KEY, 'OpenRouter key changed')

  // 2. Mongo is the in-memory store, not a client.
  assert(getRedisClient() === redis, 'getRedisClient() is not the in-memory stub')
  assert(getQueueRedisClient, 'queue redis export missing')
  let queueThrew = false
  try { getQueueRedisClient() } catch { queueThrew = true }
  assert(queueThrew, 'queue Redis was reachable; it must be unavailable')
  const instances = mongoColl.worldInstances()
  assert(instances === instances, 'mongoColl is not stable')
  await instances.insertOne({ _id: new ObjectId(), marker: 'selftest' })
  const read = await instances.findOne({ marker: 'selftest' })
  assert(read?.marker === 'selftest', 'in-memory Mongo did not keep the row')
  let dbThrew = false
  try { (await import('../src/config/mongo')).getDb() } catch { dbThrew = true }
  assert(dbThrew, 'getDb() returned; a real Mongo connection may exist')
  await instances.deleteMany({ marker: 'selftest' })

  // 3. The fetch wrapper allows only OpenRouter and throws on anything else.
  assert(isAllowedUrl('https://openrouter.ai/api/v1/chat/completions'), 'OpenRouter URL was refused')
  assert(!isAllowedUrl('https://openrouter.ai.evil.example/x'), 'look-alike host was allowed')
  let blocked = false
  try { await guardedFetch('https://example.invalid/collect') } catch { blocked = true }
  assert(blocked, 'the fetch guard did not bite')
  assert(blockedHosts.includes('example.invalid'), 'the blocked host was not logged')

  // 4. The spend guard bites at the cap and before an over-budget turn.
  const near = { ...freshLedger(), reserved_usd: CAP_USD - 0.001, max_turn_usd: 0.002 }
  let stopped = false
  try { guardBeforeTurn(near) } catch (error) { stopped = error instanceof SpendStop }
  assert(stopped, 'the before-turn guard did not bite at the cap')
  const roomy = { ...freshLedger(), reserved_usd: 0.01, max_turn_usd: 0.002 }
  guardBeforeTurn(roomy)
  const ceiling = { ...freshLedger(), reserved_usd: CAP_USD - 0.001 }
  let chargedStop = false
  try { charge(ceiling, 0.002) } catch (error) { chargedStop = error instanceof SpendStop }
  assert(chargedStop, 'the per-call cap did not bite')

  // 5. Adult and group validation still bite through the real modules.
  const template = templateFrom(readGroup('flat-4b'))
  validateGroup(template)
  const underage = { ...template, seed_cast: template.seed_cast!.map((member, index) => index ? member : { ...member, group: { ...member.group!, age: 17 } }) }
  let ageThrew = false
  try { assertAdults(underage, PLAYER) } catch { ageThrew = true }
  assert(ageThrew, 'assertAdults accepted a minor')
  let groupThrew = false
  try { validateGroup({ ...template, is_sentient: true }) } catch { groupThrew = true }
  assert(groupThrew, 'validateGroup accepted a sentient group')

  // 6. The other external modules are the empty stubs.
  assert((await queryRag('x', 'y', 'z', 1, 1, [], 'main', null)).memoryTexts.length === 0, 'RAG is not empty')
  let vectorThrew = false
  try { vectorStore.replaceLore() } catch { vectorThrew = true }
  assert(vectorThrew, 'the vector store is reachable')

  console.log('PASS selftest: dead env, in-memory Mongo/Redis, OpenRouter-only fetch, spend guard, adult/group gates')
}

// ---------------------------------------------------------------- groups

const GROUP_FILES = ['flat-4b.json', 'alder-lane-watch.json', 'last-light-guild.json']
const GROUP_DIR = [
  process.env.GROUP_CHAT_DATA_DIR,
  join(ROOT, 'everlore-docs/launch/groups'),
  '/Users/fatman/Desktop/codes/rpg-ai/everlore-docs/launch/groups',
].filter((value): value is string => !!value && existsSync(value) && GROUP_FILES.every(file => existsSync(join(value, file))))[0]

const groupJson = new Map<string, any>() // authored JSON, validated below by validateGroup
function readGroup(slug: string): any {
  if (!GROUP_DIR) throw new Error('Authored groups not found; set GROUP_CHAT_DATA_DIR')
  if (!groupJson.has(slug)) groupJson.set(slug, JSON.parse(readFileSync(join(GROUP_DIR, `${slug}.json`), 'utf8')))
  return groupJson.get(slug)
}

function templateFrom(group: any): WorldTemplateDoc { // authored JSON, checked just below by validateGroup
  const now = new Date('2026-11-01T09:00:00Z')
  return {
    _id: new ObjectId(), creator_id: new ObjectId('200000000000000000000001'),
    slug: group.slug, title: group.title, description: group.description,
    kind: 'group', genre: group.genre, is_published: true, visibility: 'public', review_status: 'approved',
    is_sentient: false, is_nsfw_capable: group.is_nsfw_capable !== false, version: 1,
    seed_prompt: group.seed_prompt, global_lore: group.global_lore, narrative_style: group.narrative_style,
    seed_cast: group.seed_cast, topics: group.topics, opening_lines: group.opening_lines,
    base_stats_template: {}, flag_definitions: {}, scene_tags: group.scene_tags || [], model_preferences: {},
    max_context_memories: 25, max_lore_results: 10, created_at: now, updated_at: now,
  } as WorldTemplateDoc
}

function assertAdults(template: WorldTemplateDoc, player: string): void {
  const underage = (template.seed_cast || []).filter(member => !Number.isFinite(member.group?.age) || member.group!.age < 18)
  if (underage.length) throw new Error(`refusing an adult run: ${underage.map(member => `${member.name} is ${member.group?.age}`).join(', ')}`)
  if (!Number.isFinite(PLAYER_AGE) || PLAYER_AGE < 18) throw new Error(`refusing an adult run: the player (${player}) is not an adult`)
}

// ---------------------------------------------------------------- chats

const templates = new Map<string, WorldTemplateDoc>()

/** One template object (and therefore one _id) per authored group. A fresh
 *  object per chat would give an instance a template_id no row has. */
function templateFor(slug: string): WorldTemplateDoc {
  if (!templates.has(slug)) {
    const template = templateFrom(readGroup(slug))
    validateGroup(template)
    assertAdults(template, PLAYER)
    templates.set(slug, template)
  }
  return templates.get(slug)!
}

function ensurePlayer(nsfw: boolean): void {
  const existing = rows('users').find(row => String(row._id) === PLAYER_ID)
  if (existing) { put(existing, 'preferences.nsfw_enabled', nsfw); return }
  rows('users').push({ _id: new ObjectId(PLAYER_ID), guest: false, account_status: 'active',
    preferences: { player_name: PLAYER, nsfw_enabled: nsfw, ...(process.env.SAMPLE_PLAYER_GENDER ? { gender: process.env.SAMPLE_PLAYER_GENDER } : {}) } })
}

const insertedTemplates = new Set<string>()

async function createChat(template: WorldTemplateDoc, nsfw: boolean): Promise<{ instanceId: string; members: GroupMember[] }> {
  ensurePlayer(nsfw)
  if (!insertedTemplates.has(template.slug)) {
    rows('worldTemplates').push(clone(template) as unknown as Row)
    insertedTemplates.add(template.slug)
  }
  const instanceId = new ObjectId()
  const snapshot = (template.seed_cast || []).map(character => clone(character))
  const instance = {
    _id: instanceId, template_id: template._id, group_template_id: template._id,
    template_version: template.version,
    seed_cast_snapshot: snapshot,
    player_id: new ObjectId(PLAYER_ID),
    world_state: {}, active_flags: {},
    current_scene: { tag: 'dialogue', turn_count: 0, summary_pending: false },
    narration_pov: 'third', mode: DEFAULT_CHAT_MODE, message_length: 'medium',
    narrative_style_override: null, focus_character_id: null, persona_id: null, persona_snapshot: null,
    current_location: null,
    meta: { total_events: 0, total_memories: 0, total_tokens_consumed: 0, last_active_at: new Date(), is_archived: false },
    created_at: new Date(), updated_at: new Date(),
  }
  rows('worldInstances').push(instance as unknown as Row)
  rows('characters').push(...(template.seed_cast || []).map(character => ({
    _id: new ObjectId(), instance_id: instanceId, canonical_name: character.name,
  })))
  await seedGroupOpening(instance as never, template, PLAYER)
  const { loadGroupMembers } = await import('../src/services/group-chat/instance')
  const members = await loadGroupMembers(instance as never)
  return { instanceId: instanceId.toHexString(), members }
}

// ---------------------------------------------------------------- turn

interface TurnRecord {
  index: number
  player: string
  marker?: string
  expected: 'adult' | 'normal'
  route: 'adult' | 'normal' | null
  router: RouterRecord
  writing: Array<{ writer: string; model: string; purpose: string }>
  counts: Record<string, number>
  picked_but_silent: number | null
  event: { sequence: number; type: string; model_used: string; tokens_in: number; tokens_out: number } | null
  lines: Array<{ name: string; text: string; model: string | null; provider: string | null; cost_usd: number | null }>
  calls: CallRecord[]
  traces: TraceRecord[]
  elapsed_ms: number
  error: string | null
}

interface RouterRecord { started: boolean | null; settled: boolean | null; sexual: boolean | null; ms: number | null; host: string | null; fallback: string | null; error: string | null }
interface CallRecord { model: string | null; served_model: string | null; provider: string | null; purpose: string; prompt_tokens: number; completion_tokens: number; cost_usd: number | null; latency_ms: number; status: string; finish_reason: string | null }
interface TraceRecord { model: string; provider: string | null; purpose: string; cost_usd: number | null; duration_ms: number; status: string }

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

const COUNT_KEYS = ['player', 'unknown', 'off_list', 'over_cap', 'duplicate', 'unsafe', 'empty', 'stage_directions', 'copied_example', 'trimmed'] as const
function pickCounts(source: Row): Record<string, number> {
  return Object.fromEntries(COUNT_KEYS.map(key => [key, Number(source[key]) || 0]))
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function seedFor(text: string): number {
  let hash = 2166136261
  for (const char of text) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619) }
  return hash >>> 0
}

async function runTurn(chat: { instanceId: string; members: GroupMember[] }, turn: { index: number; player: string; expected: 'adult' | 'normal'; marker?: string }, runKey: string): Promise<TurnRecord> {
  const jobId = crypto.randomUUID()
  const key = `lock:gen:${PLAYER_ID}:${chat.instanceId}`
  locks.set(key, JSON.stringify({ owner: jobId, phase: 'running' }))
  currentTurn = `${runKey}#${turn.index}`
  const turnLogStart = logs.length
  const turnHttpStart = httpCalls.length
  const traceStart = traceSnapshots.length
  const startedAt = performance.now()
  let error: string | null = null
  let result: { eventId: string; sequence: number } | null = null
  let ownTraces: Row[] = []
  try {
    const job = { id: jobId, data: { instanceId: chat.instanceId, playerId: PLAYER_ID, userMessage: turn.player } } as never as { id: string; data: GroupTurnJob }
    result = await runWithLLMTrace({ instance_id: chat.instanceId, player_id: PLAYER_ID }, () => runWithLLMUsage(async () => {
      try { return await groupTurnProcessor(job as never, { rng: mulberry32(seedFor(`${runKey}/${turn.index}`)) }) as { eventId: string; sequence: number } }
      finally { ownTraces = snapshotLLMTrace() as unknown as Row[] }
    })) as { eventId: string; sequence: number }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const elapsed = performance.now() - startedAt
  const turnLogs = logs.slice(turnLogStart)
  const calls = httpCalls.slice(turnHttpStart)
  // The processor's own flush mock also records the snapshot; keep one copy.
  const flushed = traceSnapshots.slice(traceStart).flatMap(snapshot => snapshot.records)
  const traceRows: Row[] = ownTraces.length ? ownTraces : flushed
  // Full requests are kept per run+turn for the toggle-off system-text check.
  traceRecordsByTurn.set(currentTurn, traceRows)

  const replyLog = turnLogs.find(entry => entry.msg === 'group.reply_checked')?.fields
  const checksLog = turnLogs.find(entry => entry.msg === 'group.line_checks')?.fields
  const counts = pickCounts(replyLog ?? checksLog ?? {})
  const writing = ((replyLog?.writing ?? []) as Array<{ writer: string; model: string; purpose: string }>)
  const routingTrace = replyLog?.routing as RouterRecord | undefined

  const routerTraces = traceRows.filter(record => record.call?.purpose === 'content_intent_same_turn')
  const router: RouterRecord = routingTrace ? {
    started: routingTrace.started ?? null, settled: routingTrace.settled ?? null, sexual: routingTrace.sexual ?? null,
    ms: routingTrace.ms ?? null, host: routingTrace.host ?? null, fallback: routingTrace.fallback ?? null, error: routingTrace.error ?? null,
  } : {
    started: routerTraces.length > 0, settled: routerTraces.length > 0,
    sexual: null, ms: routerTraces[0] ? Math.round(Number(routerTraces[0].call?.duration_ms) || 0) : null,
    host: routerTraces[0] ? (routerTraces[0].call?.provider ?? null) : null, fallback: null,
    error: routerTraces[0] ? (routerTraces[0].call?.status && routerTraces[0].call?.status !== 'ok' ? String(routerTraces[0].call.status) : null) : null,
  }

  const traceList: TraceRecord[] = traceRows.map(record => ({
    model: String(record.call?.model ?? ''), provider: (record.call?.provider as string | undefined) ?? null,
    purpose: String(record.call?.purpose ?? ''), cost_usd: typeof record.call?.cost_usd === 'number' ? record.call!.cost_usd as number : null,
    duration_ms: Number(record.call?.duration_ms) || 0, status: String(record.call?.status ?? ''),
  }))
  const callList: CallRecord[] = calls.map(call => ({
    model: call.request_model, served_model: call.response_model, provider: call.provider,
    purpose: call.purpose,
    prompt_tokens: call.prompt_tokens, completion_tokens: call.completion_tokens,
    cost_usd: call.cost_usd, latency_ms: call.latency_ms, status: String(call.status), finish_reason: null,
  }))

  const eventRow = result ? rows('events').find(row => String(row._id) === result!.eventId) : undefined
  const eventData = eventRow?.data as Row | undefined
  const rawLines = (eventData?.lines ?? []) as Array<{ character_id: string; text: string }>
  const nameById = new Map(chat.members.map(member => [member.id, member.name]))
  const narrationTraces = traceRows.filter(record => record.call?.purpose === 'narration')
  const lines = attributeLines(rawLines, narrationTraces, chat.members, nameById)

  const record: TurnRecord = {
    index: turn.index, player: turn.player, ...(turn.marker ? { marker: turn.marker } : {}), expected: turn.expected,
    route: eventData ? (eventRow?.type === 'intimate' ? 'adult' : 'normal') : null,
    router, writing, counts, picked_but_silent: typeof replyLog?.picked_but_silent === 'number' ? replyLog!.picked_but_silent as number : null,
    event: eventData && result ? {
      sequence: result.sequence, type: String(eventRow?.type ?? ''),
      model_used: String(eventData.model_used ?? ''), tokens_in: Number(eventData.tokens_in) || 0, tokens_out: Number(eventData.tokens_out) || 0,
    } : null,
    lines, calls: callList, traces: traceList, elapsed_ms: elapsed, error,
  }
  const turnCost = callList.reduce((sum, call) => sum + (call.cost_usd ?? 0), 0)
  if (turnCost > ledger.max_turn_usd) ledger.max_turn_usd = turnCost
  ledger.turns += 1
  saveLedger()
  return record
}

/** A line keeps its call's order, so the final reply can be walked alongside
 *  the parsed per-call output. Trimmed lines are prefixes of the call text. */
function attributeLines(
  lines: Array<{ character_id: string; text: string }>,
  traces: Row[],
  members: GroupMember[],
  nameById: Map<string, string>,
): TurnRecord['lines'] {
  const parsed: Array<{ trace: number; name: string; text: string }> = []
  for (const [index, trace] of traces.entries()) {
    const counts = emptyLineCounts()
    for (const line of parseLines(String(trace.response ?? ''), members, PLAYER, counts)) {
      parsed.push({ trace: index, name: line.name, text: norm(stripStageDirections(line.text)) })
    }
  }
  let cursor = 0
  return lines.map(line => {
    const name = nameById.get(line.character_id) ?? ''
    const target = norm(line.text)
    let picked: number | null = null
    for (let index = cursor; index < parsed.length; index++) {
      const candidate = parsed[index]
      if (candidate.name === name && (target.startsWith(candidate.text) || candidate.text.startsWith(target))) {
        picked = index
        break
      }
    }
    if (picked !== null) cursor = picked + 1
    const trace = picked !== null ? traces[parsed[picked].trace] : traces[Math.min(cursor, Math.max(0, traces.length - 1))]
    const call = trace?.call as Row | undefined
    return {
      name, text: line.text,
      model: (call?.model as string | undefined) ?? null,
      provider: (call?.provider as string | undefined) ?? null,
      cost_usd: typeof call?.cost_usd === 'number' ? call!.cost_usd as number : null,
    }
  })
}

// ---------------------------------------------------------------- scenes

interface PlannedTurn { line: string; expected: 'adult' | 'normal'; marker?: string }

const SCENE_A: PlannedTurn[] = [
  { line: '@Jess you look really good tonight.', expected: 'adult' },
  { line: '@Jess I keep thinking about you in that dress.', expected: 'adult' },
  { line: '@Jess if we\'re both awake at 2am, I know what I\'d rather be doing.', expected: 'adult' },
  { line: '@Jess come to my room. Bring nothing.', expected: 'adult' },
  { line: '@Jess tell me exactly what you want me to do to you.', expected: 'adult' },
  { line: '@Jess I wanna fuck you.', expected: 'adult' },
  { line: '@Jess I want you naked in my bed right now.', expected: 'adult' },
  { line: '@Jess I\'m so hard thinking about you.', expected: 'adult' },
  { line: 'Everyone else asleep?', expected: 'normal' },
  { line: '@Jess don\'t stop.', expected: 'adult' },
  { line: '@Jess tell me what you want.', expected: 'adult' },
  { line: 'I want to fuck Jess tonight and everyone here should know it.', expected: 'adult' },
  { line: '@Marco morning. Any coffee?', expected: 'normal', marker: '## The next morning' },
  { line: '@Jess last night was good.', expected: 'adult' },
]

const SCENE_B: PlannedTurn[] = [
  { line: '@Tom you look really good tonight.', expected: 'adult' },
  { line: '@Tom I wanna fuck you.', expected: 'adult' },
  { line: '@Elena I want you naked in my bed right now.', expected: 'adult' },
  { line: '@Anya tell me exactly what you want me to do to you.', expected: 'adult' },
  { line: '@Marco I\'m so hard thinking about you.', expected: 'adult' },
  { line: 'The gas bill is fucking ridiculous.', expected: 'normal' },
]

const TOGGLE_OFF: PlannedTurn[] = [
  { line: '@Jess I wanna fuck you.', expected: 'normal' },
  { line: '@Jess I want you naked in my bed right now.', expected: 'normal' },
  { line: '@Jess tell me exactly what you want me to do to you.', expected: 'normal' },
  { line: '@Jess I\'m so hard thinking about you.', expected: 'normal' },
]

// ---------------------------------------------------------------- runs

interface RunRecord {
  key: string
  title: string
  group: string
  note: string
  turns: TurnRecord[]
}

const runs: RunRecord[] = []
const stops: string[] = []
const errors: Array<{ run: string; index: number; error: string }> = []

async function playPlanned(run: RunRecord, chat: { instanceId: string; members: GroupMember[] }, planned: PlannedTurn[]): Promise<void> {
  for (const [offset, turn] of planned.entries()) {
    try {
      guardBeforeTurn()
    } catch (error) {
      stops.push(error instanceof Error ? error.message : String(error))
      return
    }
    const record = await runTurn(chat, {
      index: offset + 1, player: turn.line, expected: turn.expected, ...(turn.marker ? { marker: turn.marker } : {}),
    }, run.key)
    run.turns.push(record)
    console.log(`${run.key} turn ${record.index}: route=${record.route ?? 'none'} calls=${record.calls.length} lines=${record.lines.length} cost=$${(record.calls.reduce((sum, call) => sum + (call.cost_usd ?? 0), 0)).toFixed(6)}${record.error ? ` error=${record.error}` : ''}`)
    if (record.error) { errors.push({ run: run.key, index: record.index, error: record.error }) }
    if (capTripped) { stops.push(`spend cap reached during ${run.key} turn ${record.index}`); return }
  }
}

function flatTemplate(): WorldTemplateDoc {
  return templateFor('flat-4b')
}

async function smoke(): Promise<void> {
  const template = flatTemplate()
  const chat = await createChat(template, true)
  const run: RunRecord = { key: 'smoke', title: 'Smoke (2 turns)', group: 'Flat 4B', note: 'Plumbing only; counts towards the cap.', turns: [] }
  await playPlanned(run, chat, [
    { line: '@Jess you around?', expected: 'normal' },
    { line: '@Jess I wanna fuck you.', expected: 'adult' },
  ])
  runs.push(run)
  writeTranscript('smoke.md', '# Smoke — Flat 4B\n\nTwo paid turns that prove the real engine is wired.\n', [run])
  writeSummary(join(OUT_DIR, 'smoke-summary.json'), false)
  const failed = run.turns.some(turn => turn.error)
  console.log(`smoke: ${run.turns.length} turn(s), ${run.turns.reduce((sum, turn) => sum + turn.calls.length, 0)} call(s), $${ledger.spent_usd.toFixed(6)}`)
  process.exit(failed ? 1 : 0)
}

/** New groups, before release: does every member stay in voice, and does an explicit line get an explicit reply? */
async function sampleRun(): Promise<void> {
  if (!SAMPLE_SLUGS.length) throw new Error('--sample needs comma-separated slugs')
  for (const slug of SAMPLE_SLUGS) {
    const template = templateFor(slug)
    const firstOnly = process.env.SAMPLE_FIRST === '1'
    const room: RunRecord = { key: `room:${slug}`, title: `${template.title}: the room`, group: template.title, note: 'Nobody tagged.', turns: [] }
    runs.push(room)
    if (!firstOnly) await playPlanned(room, await createChat(template, true), [
      { line: 'Anyone around tonight?', expected: 'normal' },
      { line: 'What did I miss today?', expected: 'normal' },
    ])
    for (const character of template.seed_cast!) {
      if (stops.length) return
      const run: RunRecord = { key: `member:${slug}:${character.name}`, title: `${template.title}: ${character.name}`, group: template.title, note: 'A fresh chat.', turns: [] }
      runs.push(run)
      await playPlanned(run, await createChat(template, true), [
        { line: `@${character.name} you around tonight?`, expected: 'normal' },
        { line: `@${character.name} I wanna fuck you.`, expected: 'adult' },
        ...(firstOnly ? [] : [{ line: `@${character.name} tell me exactly what you want me to do to you.`, expected: 'adult' as const }]),
      ])
      // A softer line must not get the same answer as a blunt one.
      if (firstOnly && SAMPLE_SLUGS.indexOf(slug) < 3) {
        const soft: RunRecord = { key: `soft:${slug}:${character.name}`, title: `${template.title}: ${character.name}, soft`, group: template.title, note: 'A fresh chat.', turns: [] }
        runs.push(soft)
        await playPlanned(soft, await createChat(template, true), [
          { line: `@${character.name} you around tonight?`, expected: 'normal' },
          { line: `@${character.name} you look really good tonight.`, expected: 'normal' },
        ])
      }
    }
  }
  if (process.env.SAMPLE_FIRST === '1') return
  const template = templateFor(SAMPLE_SLUGS[0])
  const off: RunRecord = { key: `off:${SAMPLE_SLUGS[0]}`, title: `${template.title}: toggle off`, group: template.title, note: 'Consent false.', turns: [] }
  runs.push(off)
  const name = template.seed_cast![0].name
  await playPlanned(off, await createChat(template, false), [
    { line: `@${name} I wanna fuck you.`, expected: 'normal' },
    { line: `@${name} tell me exactly what you want me to do to you.`, expected: 'normal' },
  ])
}

async function mainRun(): Promise<void> {
  // 1. Scene A, Flat 4B, one running chat, opening lines included.
  {
    const template = flatTemplate()
    const chat = await createChat(template, true)
    const run: RunRecord = { key: 'scene-a', title: 'Scene A — Flat 4B, one running chat', group: template.title, note: 'The 14 authored lines in order, opening lines included.', turns: [] }
    runs.push(run)
    await playPlanned(run, chat, SCENE_A)
  }
  // 2. Scene B, Flat 4B, a fresh chat.
  {
    const template = flatTemplate()
    const chat = await createChat(template, true)
    const run: RunRecord = { key: 'scene-b', title: 'Scene B — Flat 4B, fresh chat', group: template.title, note: 'The 6 authored lines, fresh chat.', turns: [] }
    runs.push(run)
    await playPlanned(run, chat, SCENE_B)
  }
  // 3. Toggle off, Flat 4B, a fresh chat, consent false.
  {
    const template = flatTemplate()
    const chat = await createChat(template, false)
    const run: RunRecord = { key: 'toggle-off', title: 'Toggle off — Flat 4B, fresh chat, consent false', group: template.title, note: 'E1, E2, E3, E5 with nsfw_enabled=false.', turns: [] }
    runs.push(run)
    await playPlanned(run, chat, TOGGLE_OFF)
  }
  // 4. Tag sweep, all 15 characters across all 3 groups, a fresh chat each.
  {
    const run: RunRecord = { key: 'sweep', title: 'Tag sweep — all 15 characters, all 3 groups', group: 'all', note: 'One normal turn then one adult turn per tagged character, fresh chat each.', turns: [] }
    runs.push(run)
    let member = 0
    for (const slug of ['flat-4b', 'alder-lane-watch', 'last-light-guild']) {
      const template = templateFor(slug)
      for (const character of template.seed_cast!) {
        member += 1
        const chat = await createChat(template, true)
        const groupMember = chat.members.find(entry => entry.name === character.name)
        if (!groupMember) throw new Error(`cast member ${character.name} has no card`)
        console.log(`sweep ${member}/15: ${template.title} / ${character.name}`)
        await playPlanned(run, chat, [
          { line: `@${character.name} you around tonight?`, expected: 'normal' },
          { line: `@${character.name} I wanna fuck you.`, expected: 'adult' },
        ])
        if (stops.length) break
      }
      if (stops.length) break
    }
  }
}

// ---------------------------------------------------------------- checks

function adMet(turn: TurnRecord): boolean {
  return turn.writing.every(entry => entry.writer === 'normal')
}
function adultModels(template: WorldTemplateDoc): string[] {
  return [...new Set([template.model_preferences?.narration_nsfw || ADULT_MODEL, ...ADULT_FALLBACKS].map(model => model.trim()).filter(Boolean))]
}
function intimacyTexts(template: WorldTemplateDoc): string[] {
  return (template.seed_cast || []).map(member => member.group?.intimacy || '').filter(Boolean)
}

function runChecks(): Array<{ name: string; pass: boolean; detail: string }> {
  const checks: Array<{ name: string; pass: boolean; detail: string }> = []
  const sweep = runs.find(run => run.key === 'sweep')

  // Sweep: every tagged character has at least one line in both turns.
  {
    const failures: string[] = []
    for (const [index, turn] of (sweep?.turns ?? []).entries()) {
      if (turn.error) { failures.push(`turn ${index + 1} threw: ${turn.error}`); continue }
      const name = /^@([^\s]+)/.exec(turn.player)?.[1] ?? ''
      const spoke = turn.lines.some(line => line.name === name)
      if (!spoke) failures.push(`turn ${index + 1}: ${name} wrote no line`)
    }
    checks.push({ name: 'sweep: every tagged character has at least one line in both turns', pass: failures.length === 0, detail: failures.join('; ') || `${sweep?.turns.length ?? 0} turns checked` })
  }

  // Toggle off: every writer is normal and no addressed block or intimacy line was sent.
  {
    const failures: string[] = []
    const template = flatTemplate()
    const intimacy = intimacyTexts(template)
    for (const turn of runs.find(run => run.key === 'toggle-off')?.turns ?? []) {
      if (!adMet(turn)) failures.push(`turn ${turn.index}: an adult writer was used: ${JSON.stringify(turn.writing)}`)
      for (const trace of turn.traces) {
        if (trace.purpose !== 'narration') continue
        const record = turnTraceRecord('toggle-off', turn, trace)
        const system = (record?.request as Array<{ role: string; content: string }> | undefined)?.find(message => message.role === 'system')?.content ?? ''
        const sent = ['You are writing only', 'is about flirting and sex', ...intimacy].filter(fragment => system.includes(fragment))
        if (sent.length) failures.push(`turn ${turn.index}: system text contained ${sent.length} forbidden block(s)`)
      }
      for (const call of turn.calls) {
        if (call.purpose === 'narration' && call.model && adultModels(template).includes(call.model)) {
          failures.push(`turn ${turn.index}: adult model used with consent off: ${call.model}`)
        }
      }
    }
    checks.push({ name: 'toggle off: every writer is normal; no addressed block or intimacy line was sent', pass: failures.length === 0, detail: failures.join('; ') || 'all writers normal; no addressed or intimacy text' })
  }

  // No turn throws.
  {
    const failures = runs.flatMap(run => run.turns.filter(turn => turn.error).map(turn => `${run.key} turn ${turn.index}: ${turn.error}`))
    checks.push({ name: 'no turn throws', pass: failures.length === 0, detail: failures.join('; ') || `${runs.reduce((sum, run) => sum + run.turns.length, 0)} turns ran without an error` })
  }
  return checks
}

/** Reconnect a summarized trace to its full request for the system-text check. */
function turnTraceRecord(runKey: string, turn: TurnRecord, trace: TraceRecord): Row | undefined {
  return traceRecordsByTurn.get(`${runKey}#${turn.index}`)?.find(record => String(record.call?.model) === trace.model && String(record.call?.purpose) === trace.purpose)
}
const traceRecordsByTurn = new Map<string, Row[]>()

// ---------------------------------------------------------------- output

function money(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(6)}`
}

function writeTranscript(file: string, header: string, selected: RunRecord[]): void {
  const lines: string[] = [header.trimEnd(), '']
  for (const run of selected) {
    lines.push(`## ${run.title}`, '', `_${run.note}_`, '')
    for (const turn of run.turns) {
      if (turn.marker) lines.push(turn.marker, '')
      const router = turn.router
      const routerText = router.started === false ? 'not asked'
        : `settled=${router.settled} sexual=${router.sexual} ${router.ms ?? '?'}ms host=${router.host ?? '?'}${router.fallback ? ` fallback=${router.fallback}` : ''}${router.error ? ` error=${router.error}` : ''}`
      const expected = turn.expected === 'adult' ? 'adult' : 'normal'
      lines.push(`**Turn ${turn.index}** — route=${turn.route ?? 'none'} (expected ${expected}) · router: ${routerText}`)
      lines.push('')
      lines.push(`Sam: ${turn.player}`)
      for (const line of turn.lines) {
        lines.push(`  ${line.name} [${line.model ?? 'unknown'} @ ${line.provider ?? 'unknown'} · ${money(line.cost_usd)}]: ${line.text}`)
      }
      if (turn.error) lines.push(`  ! turn error: ${turn.error}`)
      lines.push('')
    }
  }
  writeFileSync(join(OUT_DIR, file), `${lines.join('\n').trimEnd()}\n`)
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

function writeSummary(file = SUMMARY_FILE, includeChecks = true): void {
  const turns = runs.flatMap(run => run.turns)
  const adultTurns = turns.filter(turn => turn.route === 'adult')
  const normalTurns = turns.filter(turn => turn.route === 'normal')
  const turnCost = (turn: TurnRecord) => turn.calls.reduce((sum, call) => sum + (call.cost_usd ?? 0), 0)
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const serving = new Map<string, { model: string; host: string; calls: number; cost_usd: number }>()
  for (const call of turns.flatMap(turn => turn.calls)) {
    const key = `${call.served_model ?? call.model ?? '?'} @ ${call.provider ?? '?'}`
    const entry = serving.get(key) ?? { model: call.served_model ?? call.model ?? '?', host: call.provider ?? '?', calls: 0, cost_usd: 0 }
    entry.calls += 1
    entry.cost_usd += call.cost_usd ?? 0
    serving.set(key, entry)
  }
  const summary = {
    generated_at: new Date().toISOString(),
    engine: { commit: '9d6a236', script: 'scripts/group-chat-live.ts', processor: 'worker/processors/group-turn.processor.ts' },
    models: { normal: NORMAL_MODEL, normal_fallbacks: NORMAL_FALLBACKS, adult: ADULT_MODEL, adult_fallbacks: ADULT_FALLBACKS, router: ROUTER,
      temperatures: { normal: narrationTemperature(NORMAL_MODEL), adult: narrationTemperature(ADULT_MODEL) } },
    spend: { cap_usd: CAP_USD, spent_usd: ledger.spent_usd, reserved_usd: ledger.reserved_usd, inr: ledger.spent_usd * INR_PER_USD,
      calls: ledger.calls, turns: ledger.turns, unpriced_calls: ledger.unpriced_calls, max_turn_usd: ledger.max_turn_usd },
    serving: [...serving.values()].sort((a, b) => b.calls - a.calls),
    totals: {
      turns: turns.length, calls: turns.reduce((sum, turn) => sum + turn.calls.length, 0),
      adult_turns: adultTurns.length, normal_turns: normalTurns.length,
      cost_adult_usd: mean(adultTurns.map(turnCost)), cost_normal_usd: mean(normalTurns.map(turnCost)),
      cost_adult_inr: (mean(adultTurns.map(turnCost)) ?? 0) * INR_PER_USD, cost_normal_inr: (mean(normalTurns.map(turnCost)) ?? 0) * INR_PER_USD,
      latency_p50_turn_ms: percentile(turns.map(turn => turn.elapsed_ms), 0.5),
      latency_p50_call_ms: percentile(turns.flatMap(turn => turn.calls.map(call => call.latency_ms)), 0.5),
    },
    router_misses: turns.filter(turn => turn.route !== null && (turn.route === 'adult') !== (turn.expected === 'adult')).map(turn => ({
      run: runs.find(run => run.turns.includes(turn))?.key ?? '?', index: turn.index, expected: turn.expected, route: turn.route, router: turn.router,
    })),
    runs: runs.map(run => ({
      key: run.key, title: run.title, group: run.group, note: run.note,
      turns: run.turns.map(turn => ({ ...turn, cost_usd: turnCost(turn) })),
    })),
    checks: includeChecks ? runChecks() : [],
    stops,
    errors,
    blocked_hosts: blockedHosts,
    fetch_failures: fetchFailures,
  }
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`)
}

// ---------------------------------------------------------------- plan

function plan(): void {
  const templates = GROUP_FILES.map(slug => templateFrom(readGroup(slug.replace('.json', ''))))
  for (const template of templates) { validateGroup(template); assertAdults(template, PLAYER) }
  const sweepTurns = templates.reduce((sum, template) => sum + (template.seed_cast?.length ?? 0) * 2, 0)
  const total = SCENE_A.length + SCENE_B.length + TOGGLE_OFF.length + sweepTurns
  const normal = SCENE_A.filter(turn => turn.expected === 'normal').length + SCENE_B.filter(turn => turn.expected === 'normal').length
    + TOGGLE_OFF.length + templates.reduce((sum, template) => sum + (template.seed_cast?.length ?? 0), 0)
  const adult = total - normal
  // Upper-bound estimates from the last measured run (gc-0-adult-5, out-8):
  // adult addressed ≈ $0.0017, cheap normal writer ≈ $0.0004, router ≈ $0.00002.
  const projected = adult * 0.0025 + normal * 0.0006
  console.log(`plan: ${total} turns (${adult} expected adult, ${normal} expected normal), ${sweepTurns} sweep turns`)
  console.log(`plan: projected ≈ $${projected.toFixed(4)} (₹${(projected * INR_PER_USD).toFixed(2)}); ledger $${ledger.spent_usd.toFixed(6)} reserved $${ledger.reserved_usd.toFixed(6)} of $${CAP_USD.toFixed(2)}`)
  console.log(`plan: models normal=${NORMAL_MODEL} adult=${ADULT_MODEL} → ${ADULT_FALLBACKS.join(', ')} router=${ROUTER.model} @ ${ROUTER.host} switch=${ROUTER.switch}`)
  console.log(`plan: output ${OUT_DIR}`)
}

// ---------------------------------------------------------------- main

mkdirSync(OUT_DIR, { recursive: true })

if (args.has('--selftest')) {
  await selftest()
  process.exit(0)
} else if (args.has('--plan')) {
  plan()
  process.exit(0)
} else if (args.has('--smoke')) {
  await smoke()
} else if (sampleIndex > 0) {
  await sampleRun()
  writeFileSync(join(OUT_DIR, 'turns.json'), JSON.stringify(runs.map(run => ({ key: run.key, turns: run.turns.map(turn => ({ index: turn.index, player: turn.player, expected: turn.expected, route: turn.route, ms: turn.elapsed_ms, calls: turn.calls.length, counts: turn.counts, error: turn.error, lines: turn.lines.map(line => ({ name: line.name, text: line.text })) })) })), null, 1))
  for (const stop of stops) console.log(`STOP ${stop}`)
  console.log(`sample: ${ledger.turns} turn(s), ${ledger.calls} call(s), $${ledger.spent_usd.toFixed(6)} (₹${(ledger.spent_usd * INR_PER_USD).toFixed(2)}), ${errors.length} error(s)`)
  process.exit(0)
} else {
  await mainRun()
}

// Keep the full trace requests for the toggle-off system-text check.
// (Written per turn in runTurn.)

const checks = runChecks()
writeTranscript('scene-a.md', '# Scene A — Flat 4B, one running chat, opening lines included\n', runs.filter(run => run.key === 'scene-a'))
writeTranscript('scene-b.md', '# Scene B — Flat 4B, a fresh chat\n', runs.filter(run => run.key === 'scene-b'))
writeTranscript('toggle-off.md', '# Toggle off — Flat 4B, a fresh chat, consent false\n', runs.filter(run => run.key === 'toggle-off'))
writeTranscript('sweep.md', '# Tag sweep — all 15 characters, all 3 groups\n', runs.filter(run => run.key === 'sweep'))
writeSummary()

for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
for (const stop of stops) console.log(`STOP ${stop}`)
const failed = checks.some(check => !check.pass)
console.log(`gc-1-live: ${failed ? 'FAILED' : 'passed'} — ${ledger.turns} turn(s), ${ledger.calls} call(s), $${ledger.spent_usd.toFixed(6)} (₹${(ledger.spent_usd * INR_PER_USD).toFixed(2)}); ledger ${LEDGER_FILE}`)
process.exit(failed ? 1 : 0)
