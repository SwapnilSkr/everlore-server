/**
 * gc-1g-recall — does everyone actually remember? A real group chat, played.
 *
 * Brief: .agents/tasks/gc-1g-recall.md. A whole Flat 4B group chat is played
 * through the REAL `groupTurnProcessor`, then curated by the real
 * `memoryProcessor` and summarized by the real summary processor against real
 * local Mongo, real local Redis, real embeddings, the real `queryRag` and an
 * in-memory cosine vector store. Eleven questions, a toggle-off turn, a real
 * rewind and a real reset follow, and the run measures prompt-level and
 * reply-level recall.
 *
 * SAFETY (read this before touching anything)
 * - The shared `.env` points at the PRODUCTION database. Run this script from
 *   the shared `everlore-server/` only so Bun loads the API keys from it.
 * - Before any product import, every database / Redis / vector / object-store
 *   variable in `src/config/env.ts` is overwritten: Mongo and Redis to servers
 *   THIS script starts on free non-default ports with data directories under
 *   the session scratchpad; everything else to dead local addresses.
 * - Right after connecting, the Mongo target is asserted to be 127.0.0.1 on the
 *   scratch port with the scratch database name, BEFORE the first product write.
 * - `globalThis.fetch` is wrapped: only `openrouter.ai` and `api.openai.com`
 *   pass. Anything else throws and is logged.
 * - `src/services/vector-store` is replaced with an in-memory store that really
 *   does cosine search and honours scopes and filters. Pinecone is never touched.
 *   `RAG_RERANK_ENABLED` is off.
 * - A ledger under `.agents/probes/group-chat/recall/spend.json` tracks real
 *   provider cost. No call is sent once the reserved total plus that call's
 *   upper estimate would pass $0.30.
 * - The planted writer lines are TEST FIXTURES. They are returned by the fetch
 *   wrapper instead of a provider response for exactly one narration call per
 *   planted turn, so the event that curation sees is a real stored event.
 *
 * USAGE (from the shared everlore-server/):
 *   bun run <worktree>/everlore-server/scripts/group-memory-recall.ts --selftest
 *   bun run <worktree>/everlore-server/scripts/group-memory-recall.ts --plan
 *   bun run <worktree>/everlore-server/scripts/group-memory-recall.ts --dry      offline rehearsal: every
 *     provider call answered locally, zero spend, outputs in recall/dry/ and never scored
 *   bun run <worktree>/everlore-server/scripts/group-memory-recall.ts           (paid; $0.30 cap)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { Collection, MongoClient, ObjectId } from 'mongodb'
import Redis from 'ioredis'

// ---------------------------------------------------------------- paths, cap

const ROOT = resolve(import.meta.dir, '..', '..')
/** `--scene=a|b` replays an owner-passed adult scene after the long chat, memories on. */
const SCENE = process.argv.find(arg => arg === '--scene=a' || arg === '--scene=b' || arg === '--scene=d')?.slice(-1) as 'a' | 'b' | 'd' | undefined
/** Strips memory from writer prompts and skips curation, to isolate what memory changes. */
const MEMORIES_OFF = Boolean(SCENE) && process.argv.includes('--memories=off')
const OUT_DIR = process.env.GROUP_MEMORY_RECALL_OUTPUT_DIR || join(ROOT, SCENE ? '.agents/probes/group-chat/adult-memory' : '.agents/probes/group-chat/recall')
const LEDGER_FILE = join(OUT_DIR, 'spend.json')
const WORK_DIR = process.env.COMMANDCODE_SCRATCHPAD || join(OUT_DIR, 'tmp')
const CAP_USD = SCENE ? Number(process.env.GROUP_SCENE_CAP_USD || 0.04) : 0.30
const INR_PER_USD = 87
const PLAYER = 'Sam'
const PLAYER_AGE = 28
const PLAYER_ID = '300000000000000000000001'
const SCRATCH_DB = 'everlore_recall_scratch'
/** text-embedding-3-small list price, per token. Priced from usage, not a provider cost. */
const EMBED_USD_PER_TOKEN = 0.00000002

const args = new Set(process.argv.slice(2))
// A misquoted flag must not fall through to the paid run.
const unknownArgs = [...args].filter(arg => !['--selftest', '--plan', '--dry', '--scene=a', '--scene=b', '--scene=d', '--memories=off'].includes(arg))
if (unknownArgs.length) throw new Error(`Unknown argument(s): ${unknownArgs.join(' | ')}`)
const MODE: 'selftest' | 'plan' | 'dry' | 'run' = args.has('--selftest') ? 'selftest' : args.has('--plan') ? 'plan'
  : args.has('--dry') ? 'dry' : 'run'
/** Offline rehearsal: every provider call is answered locally and costs nothing. */
const DRY = MODE === 'dry'
/** A dry run writes its own directory, so its fixtures can never be read as results. */
const RUN_DIR = DRY ? join(OUT_DIR, 'dry') : SCENE ? join(OUT_DIR, `scene-${SCENE}-memories-${MEMORIES_OFF ? 'off' : 'on'}`) : OUT_DIR

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(RUN_DIR, { recursive: true })
mkdirSync(WORK_DIR, { recursive: true })

// ---------------------------------------------------------------- local servers

interface Infra {
  mongoPort: number
  redisPort: number
  mongoUri: string
  redisUrl: string
  dir: string
}

const children: ChildProcess[] = []
const tempDirs: string[] = []
let infra: Infra | null = null

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function spawnLocal(command: string, argv: string[], logFile: string): ChildProcess {
  const handle = spawn(command, argv, { stdio: ['ignore', 'ignore', 'ignore'] })
  tempDirs.push(logFile)
  handle.on('error', error => { console.error(`${command} failed to start: ${error.message}`) })
  return handle
}

/** Starts the two servers this script owns. Nothing else is ever started or killed. */
async function startInfra(): Promise<Infra> {
  const dir = join(WORK_DIR, `recall-${Date.now().toString(36)}-${process.pid}`)
  mkdirSync(join(dir, 'mongo'), { recursive: true })
  mkdirSync(join(dir, 'redis'), { recursive: true })
  tempDirs.push(dir)

  const mongoPort = await freePort()
  const redisPort = await freePort()
  const mongoLog = join(dir, 'mongod.log')
  const redisLog = join(dir, 'redis.log')

  children.push(spawnLocal('mongod', ['--dbpath', join(dir, 'mongo'), '--port', String(mongoPort),
    '--bind_ip', '127.0.0.1', '--nounixsocket', '--logpath', mongoLog, '--setParameter', 'enableTestCommands=1'], mongoLog))
  children.push(spawnLocal('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1',
    '--save', '', '--appendonly', 'no', '--dir', join(dir, 'redis'), '--logfile', redisLog], redisLog))

  const mongoUri = `mongodb://127.0.0.1:${mongoPort}/${SCRATCH_DB}`
  const redisUrl = `redis://127.0.0.1:${redisPort}`

  const deadline = Date.now() + 30_000
  let mongoReady = false
  let redisReady = false
  while (Date.now() < deadline && !(mongoReady && redisReady)) {
    if (!mongoReady) {
      const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 500 })
      try { await client.connect(); await client.db().admin().command({ ping: 1 }); mongoReady = true } catch { /* not yet */ }
      finally { await client.close().catch(() => {}) }
    }
    if (!redisReady) {
      const client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
      try { await client.connect(); await client.ping(); redisReady = true } catch { /* not yet */ }
      finally { client.disconnect() }
    }
    if (!(mongoReady && redisReady)) await new Promise(done => setTimeout(done, 250))
  }
  if (!mongoReady || !redisReady) throw new Error(`scratch servers did not come up (mongo=${mongoReady} redis=${redisReady}); logs in ${dir}`)
  console.log(`scratch servers: mongod :${mongoPort}, redis-server :${redisPort}; data under ${dir}`)

  infra = { mongoPort, redisPort, mongoUri, redisUrl, dir }
  return infra
}

let cleaned = false
/** Stops only the two processes this script spawned, then removes its own temp dirs. */
function cleanupInfra(): void {
  if (cleaned) return
  cleaned = true
  for (const handle of children) {
    if (handle.pid && !handle.killed) { try { process.kill(handle.pid, 'SIGKILL') } catch { /* already gone */ } }
  }
  for (const path of tempDirs) { try { rmSync(path, { recursive: true, force: true }) } catch { /* best effort */ } }
  children.length = 0
}

process.on('exit', cleanupInfra)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { cleanupInfra(); process.exit(signal === 'SIGINT' ? 130 : 143) })
}

// ---------------------------------------------------------------- env poison

/** Dead local addresses used when no scratch servers are running (--selftest, --plan). */
const DEAD = {
  MONGODB_URI: `mongodb://127.0.0.1:1/${SCRATCH_DB}`,
  REDIS_URL: 'redis://127.0.0.1:1',
}

const POISON: Record<string, string> = {
  // The shared .env carries NODE_ENV=production; this process is not the server.
  NODE_ENV: 'test',
  MONGODB_URI: DEAD.MONGODB_URI,
  REDIS_URL: DEAD.REDIS_URL,
  PINECONE_API_KEY: 'dead-pinecone-key',
  PINECONE_INDEX: 'never-everlore',
  PINECONE_SHARED_NAMESPACE: 'never-everlore',
  VECTOR_LAYOUT: 'shared',
  S3_BUCKET: 'never-everlore',
  CDN_BASE_URL: 'http://127.0.0.1:1',
  AWS_ACCESS_KEY_ID: 'dead',
  AWS_SECRET_ACCESS_KEY: 'dead',
  AWS_SESSION_TOKEN: 'dead',
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: 'dead',
  TWILIO_ACCOUNT_SID: 'dead',
  TWILIO_AUTH_TOKEN: 'dead',
  TWILIO_VERIFY_SERVICE_SID: 'dead',
  KEEP_WARM: 'off',
  RAG_RERANK_ENABLED: 'false',
  NSFW_INTENT_DEFER_ENABLED: 'false',
}

async function poisonEnv(): Promise<void> {
  const local = MODE === 'run' || MODE === 'dry' ? await startInfra() : null
  if (local) {
    POISON.MONGODB_URI = local.mongoUri
    POISON.REDIS_URL = local.redisUrl
  }
  for (const [key, value] of Object.entries(POISON)) process.env[key] = value
  if (DRY) return
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is not set. Run from the shared everlore-server/ so Bun loads its .env.')
    process.exit(3)
  }
  if (MODE === 'run' && !process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set; real embeddings need it. Run from the shared everlore-server/.')
    process.exit(3)
  }
}

// ---------------------------------------------------------------- mongo host guard

interface MongoTarget { hosts: Array<{ host: string; port: number }>; database: string }

/** The URI that `connectMongo()` will actually use. Pure, so the selftest exercises it. */
function parseMongoTarget(uri: string): MongoTarget {
  const match = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?/.exec(uri)
  if (!match) throw new Error('MONGODB_URI is not a mongodb:// URI')
  const hosts = match[1].split(',').map(entry => {
    const [host, port] = entry.split(':')
    return { host, port: Number(port || 27017) }
  })
  return { hosts, database: (match[2] || '').split('/')[0] }
}

/** Fails unless every host is loopback on exactly the scratch port and the scratch database. */
function assertLocalMongo(uri: string, port: number, database: string): MongoTarget {
  const target = parseMongoTarget(uri)
  for (const host of target.hosts) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host.host)) {
      throw new Error(`refusing to run: Mongo host ${host.host} is not local`)
    }
    if (host.port !== port) throw new Error(`refusing to run: Mongo port ${host.port} is not the scratch port ${port}`)
  }
  if (target.database !== database) throw new Error(`refusing to run: Mongo database ${target.database} is not ${database}`)
  return target
}

// ---------------------------------------------------------------- spend ledger

interface LedgerBucket { calls: number; cost_usd: number; prompt_tokens: number; completion_tokens: number }

interface Ledger {
  cap_usd: number
  spent_usd: number
  reserved_usd: number
  calls: number
  planted_calls: number
  simulated_calls: number
  unpriced_calls: number
  max_turn_usd: number
  by_purpose: Record<string, LedgerBucket>
  updated_at: string
}

class SpendStop extends Error {
  constructor(message: string) { super(message); this.name = 'SpendStop' }
}

function freshLedger(): Ledger {
  return { cap_usd: CAP_USD, spent_usd: 0, reserved_usd: 0, calls: 0, planted_calls: 0, simulated_calls: 0, unpriced_calls: 0, max_turn_usd: 0,
    by_purpose: {}, updated_at: new Date().toISOString() }
}

/** A dry run must never be read as a measured run: its ledger starts clean. */
const ledger: Ledger = (() => {
  if (DRY) return freshLedger()
  // Verification may redirect artifacts, but it must keep the measured run's existing spend.
  // A scene replay has its own cap and ledger, separate from the recall test's.
  const prior = [LEDGER_FILE, ...(SCENE ? [] : [join(ROOT, '.agents/probes/group-chat/recall/spend.json')])].find(path => existsSync(path))
  if (!prior) return freshLedger()
  try {
    const raw = JSON.parse(readFileSync(prior, 'utf8')) as Partial<Ledger>
    if (!Number.isFinite(raw.spent_usd) || !Number.isFinite(raw.reserved_usd) || !Number.isFinite(raw.calls)) {
      throw new Error('missing numeric fields')
    }
    return { ...freshLedger(), ...raw } as Ledger
  } catch (error) {
    // A corrupt ledger must not silently reset the cap.
    throw new Error(`Unreadable ledger ${prior}; repair it without resetting prior spend`, { cause: error })
  }
})()

function saveLedger(): void {
  ledger.updated_at = new Date().toISOString()
  writeFileSync(join(RUN_DIR, 'spend.json'), `${JSON.stringify(ledger, null, 2)}\n`)
  if (SCENE && !DRY) writeFileSync(LEDGER_FILE, `${JSON.stringify(ledger, null, 2)}\n`)
}

/** Upper estimate per provider call, by what the request is. Measured on gc-1/gc-1f runs. */
const CALL_ESTIMATE_USD = {
  router: 0.00002,
  narration: 0.0006,
  adult_narration: 0.0017,
  curation: 0.005,
  summary: 0.002,
  embedding: 0.00002,
} as const

type PurposeKey = keyof typeof CALL_ESTIMATE_USD

/** Set once the cap is crossed; further requests are refused before they are sent. */
let capTripped = false

/** Books one call into a ledger. Returns true when that call passed the cap. */
function chargeInto(aLedger: Ledger, costUsd: number | null, purpose: PurposeKey, promptTokens: number, completionTokens: number, billable = true): boolean {
  aLedger.calls += 1
  if (!billable) { aLedger.planted_calls += 1; return false }
  const amount = costUsd ?? (purpose === 'embedding' ? promptTokens * EMBED_USD_PER_TOKEN : null)
  if (amount === null) { aLedger.unpriced_calls += 1; aLedger.reserved_usd += CALL_ESTIMATE_USD.narration } else {
    aLedger.spent_usd += amount
    aLedger.reserved_usd += amount
  }
  const bucket = aLedger.by_purpose[purpose] ?? { calls: 0, cost_usd: 0, prompt_tokens: 0, completion_tokens: 0 }
  bucket.calls += 1
  bucket.cost_usd += amount ?? CALL_ESTIMATE_USD.narration
  bucket.prompt_tokens += promptTokens
  bucket.completion_tokens += completionTokens
  aLedger.by_purpose[purpose] = bucket
  return aLedger.reserved_usd > aLedger.cap_usd
}

function charge(costUsd: number | null, purpose: PurposeKey, promptTokens: number, completionTokens: number, billable = true): void {
  if (chargeInto(ledger, costUsd, purpose, promptTokens, completionTokens, billable)) {
    capTripped = true
    throw new SpendStop(`spend cap reached: reserved $${ledger.reserved_usd.toFixed(6)} of $${CAP_USD.toFixed(2)}`)
  }
}

// ---------------------------------------------------------------- in-memory vectors

interface StoredVector { id: string; values: number[]; metadata: Record<string, unknown> }
type Scope = { kind: 'lore'; templateId: string } | { kind: 'mem' | 'sum'; instanceId: string }

const vectorScopes = new Map<string, Map<string, StoredVector>>()
const scopeKey = (scope: Scope) => `${scope.kind}:${scope.kind === 'lore' ? scope.templateId : scope.instanceId}`
function scopeRecords(scope: Scope): Map<string, StoredVector> {
  const key = scopeKey(scope)
  if (!vectorScopes.has(key)) vectorScopes.set(key, new Map())
  return vectorScopes.get(key)!
}

function metadataMatches(metadata: Record<string, unknown>, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true
  return Object.entries(filter).every(([key, expected]) => {
    const value = metadata[key]
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      return Object.entries(expected as Record<string, unknown>).every(([op, other]) => {
        if (op === '$ne') return value !== other
        if (op === '$exists') return (value !== undefined) === other
        if (op === '$in') return (other as unknown[]).some(entry => Array.isArray(value) ? value.includes(entry) : value === entry)
        if (op === '$nin') return !(other as unknown[]).some(entry => Array.isArray(value) ? value.includes(entry) : value === entry)
        throw new Error(`unsupported vector filter operator ${op}`)
      })
    }
    return Array.isArray(value) ? value.includes(expected) : value === expected
  })
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, left = 0, right = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) { dot += a[i] * b[i]; left += a[i] ** 2; right += b[i] ** 2 }
  return left > 0 && right > 0 ? dot / (Math.sqrt(left) * Math.sqrt(right)) : 0
}

/** Real cosine search, real scope isolation, real metadata filters. No network. */
const stubVectorStore = {
  async upsert(scope: Scope, records: StoredVector[]) {
    const target = scopeRecords(scope)
    for (const record of records) target.set(record.id, { id: record.id, values: [...record.values], metadata: { ...record.metadata } })
    return undefined
  },
  async query(scope: Scope, query: { vector: number[]; topK: number; filter?: object; includeMetadata?: boolean; includeValues?: boolean }) {
    const scored = [...scopeRecords(scope).values()]
      .filter(record => metadataMatches(record.metadata, query.filter as Record<string, unknown> | undefined))
      .map(record => ({ record, score: cosine(query.vector, record.values) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, query.topK)
    return {
      namespace: scopeKey(scope),
      matches: scored.map(({ record, score }) => ({
        id: record.id, score,
        ...(query.includeMetadata === false ? {} : { metadata: record.metadata }),
        ...(query.includeValues ? { values: record.values } : {}),
      })),
    }
  },
  async fetch(scope: Scope, ids: string[]) {
    const records: Record<string, StoredVector> = {}
    for (const id of ids) {
      const found = scopeRecords(scope).get(id)
      if (found) records[id] = found
    }
    return { records }
  },
  async deleteIds(scope: Scope, ids: string[]) {
    const target = scopeRecords(scope)
    for (const id of ids) target.delete(id)
    return undefined
  },
  async listIds(scope: Scope) { return [...scopeRecords(scope).keys()] },
  async deleteScope(scope: Scope) { vectorScopes.delete(scopeKey(scope)); return undefined },
  async replaceLore(scope: Scope, records: StoredVector[]) {
    vectorScopes.set(scopeKey(scope), new Map())
    return await this.upsert(scope, records)
  },
  async ping() { /* nothing to warm */ },
}

function vectorDump(kind: 'mem' | 'sum', instanceId: string): StoredVector[] {
  return [...scopeRecords({ kind, instanceId }).values()]
}

// ---------------------------------------------------------------- fetch guard + capture

interface CapturedCall {
  turn: string
  purpose: PurposeKey
  host: string
  model: string | null
  stream: boolean
  system: string
  user: string
  response: string
  rawResponse?: string
  cost_usd: number | null
  prompt_tokens: number
  completion_tokens: number
  status: number
  latency_ms: number
  planted: boolean
  simulated: boolean
  sections: { memories: string; openThreads: string; summaries: string; recent: string } | null
  error?: string
}

const realFetch = globalThis.fetch.bind(globalThis)
const blockedHosts: string[] = []
const httpCalls: CapturedCall[] = []
const fetchFailures: Array<{ turn: string; url: string; error: string }> = []
/** Requests that actually left this process. A dry run must end at 0. */
let networkCalls = 0
let currentTurn = 'selftest'

/** A scripted member line for a planted turn; consumed by exactly one narration call. */
let pendingPlanted: { name: string; line: string } | null = null

const ALLOWED_HOSTS = new Set(['openrouter.ai', 'api.openai.com'])

function isAllowedUrl(value: string): boolean {
  try { const url = new URL(value); return ALLOWED_HOSTS.has(url.hostname) && url.protocol === 'https:' } catch { return false }
}

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  return new URL((input as Request).url)
}

/** Splits the group writer prompt into the sections the brief asks about. */
function promptSections(user: string): CapturedCall['sections'] {
  const section = (label: string, next: string[]): string => {
    const start = user.indexOf(`${label}:\n`)
    if (start < 0) return ''
    const from = start + label.length + 2
    const ends = next.map(other => user.indexOf(`\n\n${other}:\n`, from)).filter(index => index >= 0)
    const end = ends.length ? Math.min(...ends) : user.length
    return user.slice(from, end).trim()
  }
  return {
    memories: section('Memories', ['Open threads', 'Summary so far', 'Recent messages', 'Now']),
    openThreads: section('Open threads', ['Summary so far', 'Recent messages', 'Now']),
    summaries: section('Summary so far', ['Recent messages', 'Now']),
    recent: section('Recent messages', ['Now']),
  }
}

/** The group adult chain, filled in once the models have been imported. */
let adultModelSet: Set<string> | null = null

function classify(body: Record<string, unknown>, host: string, system: string): PurposeKey {
  if (host === 'api.openai.com') return 'embedding'
  const responseFormat = body.response_format as { type?: unknown } | undefined
  if (responseFormat?.type === 'json_object' && Number(body.max_tokens) <= 16) return 'router'
  if (/^You are the memory curator/.test(system)) return 'curation'
  if (/^(Compress the following scene|Weave these consecutive scene summaries|Distill these consecutive chapters)/.test(system)) return 'summary'
  const model = String(body.model || '')
  return adultModelSet?.has(model) ? 'adult_narration' : 'narration'
}

function plantedResponse(body: Record<string, unknown>, planted: { name: string; line: string }): Response {
  return chatResponse(body, `${planted.name}: ${planted.line}`, 'fixture', 0)
}

function chatResponse(body: Record<string, unknown>, content: string, provider: string, cost: number): Response {
  const payload = {
    id: `${provider}-${crypto.randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model: String(body.model || 'fixture'), provider,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost },
  }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

// ---- offline rehearsal (--dry): every provider call is answered locally

let dryCallCounter = 0
const DRY_LINES = ['yeah fair enough', 'honestly same', 'ok but why though', 'noted', 'sure thing', 'that tracks', 'sounds right']

function dryHash(text: string): number {
  let hash = 2166136261
  for (const char of text) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619) }
  return hash >>> 0
}

/** Deterministic bag-of-words vector, so cosine search behaves like the real one. */
function dryEmbedding(text: string): number[] {
  const vector = new Array<number>(1024).fill(0)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const index = dryHash(word) % vector.length
    vector[index] += 1
  }
  return vector
}

/** A canned curator result built from what the numbered messages actually say. */
function dryCuration(user: string, body: Record<string, unknown>): string {
  const messages: Array<{ number: number; speaker: string; text: string }> = []
  for (const line of user.split('\n')) {
    const match = /^(\d+)\. (\{.*\})$/.exec(line.trim())
    if (!match) continue
    try {
      const parsed = JSON.parse(match[2]) as { speaker?: unknown; text?: unknown }
      messages.push({ number: Number(match[1]), speaker: String(parsed.speaker ?? ''), text: String(parsed.text ?? '') })
    } catch { /* not a numbered message */ }
  }
  const atoms: Array<Record<string, unknown>> = []
  for (const [key, fact] of Object.entries(FACTS)) {
    const message = messages.find(entry => !entry.text.includes('?')
      && fact.tokens.some(token => entry.text.toLowerCase().includes(token)))
    if (!message) continue
    const speaker = message.speaker === PLAYER ? 'player' : message.speaker
    atoms.push({
      text: `${speaker === 'player' ? 'The player' : speaker} mentioned: ${message.text}`,
      type: key === '6' ? 'promise' : 'observation',
      importance: key === '1' || key === '6' ? 4 : 3,
      is_nsfw: false,
      subjects: [speaker], objects: [],
      emotional_valence: null, emotional_cause: null, emotional_effect: null, relationship_delta: null,
      unresolved_thread: key === '6',
      retrieval_terms: [...fact.tokens],
      source_messages: [message.number],
    })
  }
  if (!atoms.length) {
    const first = messages[0]
    atoms.push({ text: `Flat 4B talked about ordinary flat business: ${first?.text ?? 'the rota'}.`, type: 'observation',
      importance: 2, is_nsfw: false, subjects: [first?.speaker === PLAYER ? 'player' : first?.speaker || 'player'], objects: [],
      emotional_valence: null, emotional_cause: null, emotional_effect: null, relationship_delta: null,
      unresolved_thread: false, retrieval_terms: [], source_messages: [first?.number ?? 1] })
  }
  const format = body.response_format as { json_schema?: { schema?: { properties?: { memories?: { items?: { properties?: { source_messages?: unknown } } } } } } } | undefined
  if (!format?.json_schema?.schema?.properties?.memories?.items?.properties?.source_messages) {
    for (const atom of atoms) delete atom.source_messages
  }
  return JSON.stringify({ memories: atoms, entities: [], closed_threads: [] })
}

function dryResponse(purpose: PurposeKey, body: Record<string, unknown>, system: string, user: string): { content: string; embedding?: number[] } {
  if (purpose === 'embedding') return { content: '', embedding: dryEmbedding(system || user) }
  if (purpose === 'router' && system.startsWith('You judge one reply')) return { content: JSON.stringify({ explicit: dryCallCounter % 2 === 0 }) }
  if (purpose === 'router') {
    const text = user.toLowerCase()
    return { content: JSON.stringify({ sexual_intent: /naked|make love|bed|kiss/.test(text) }) }
  }
  if (purpose === 'curation') return { content: dryCuration(user, body) }
  if (purpose === 'summary') return { content: 'The flat argued about bins and bills, made plans, and someone promised to bring a ladder.' }
  // narration: answer the speakers the prompt actually asked for
  const addressed = /You are writing only ([^']+)'s messages/.exec(system)?.[1]
  const only = /Only these people write in this reply: ([^.\n]+)\./.exec(user)?.[1]
  const names = addressed ? [addressed] : (only ? only.split(',').map(name => name.trim()).filter(Boolean) : [])
  dryCallCounter += 1
  const line = `${dryCallCounter} ${DRY_LINES[dryHash(`${currentTurn}:${user.length}`) % DRY_LINES.length]} (${currentTurn})`
  return { content: (names.length ? names : ['Tom']).map(name => `${name}: ${line}`).join('\n') }
}

function dryChatResponse(body: Record<string, unknown>, result: { content: string; embedding?: number[] }): Response {
  if (result.embedding) {
    return new Response(JSON.stringify({ object: 'list', model: String(body.model || 'dry-embedding'), data: [{ object: 'embedding', index: 0, embedding: result.embedding }], usage: { prompt_tokens: 0, total_tokens: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return chatResponse(body, result.content, 'dry-fixture', 0)
}

const guardedFetchBase = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
  if (capTripped) throw new SpendStop('spend cap already reached; refusing another request')
  const url = urlOf(input)
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    blockedHosts.push(url.hostname)
    throw new Error(`Blocked non-allowed request to ${url.hostname}`)
  }
  let body: Record<string, unknown> = {}
  try { if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown> } catch { /* leave unattributed */ }
  if (MEMORIES_OFF && Array.isArray(body.messages)) {
    for (const message of body.messages as Array<{ role?: string; content?: unknown }>) {
      if (message.role === 'user' && typeof message.content === 'string') {
        message.content = message.content.replace(/(?<=^|\n\n)(?:Memories|Open threads|Summary so far):\n[\s\S]*?\n\n(?=(?:Open threads|Summary so far|Recent messages|Now):\n)/g, '')
      }
    }
    init = { ...init, body: JSON.stringify(body) }
  }
  const model = typeof body.model === 'string' ? body.model : null
  const messages = Array.isArray(body.messages) ? body.messages as Array<{ role?: string; content?: string }> : []
  const system = messages.find(message => message.role === 'system')?.content ?? ''
  const user = messages.find(message => message.role === 'user')?.content ?? ''
  const purpose = classify(body, url.hostname, system)

  // Refuse BEFORE sending when this call's ceiling would pass the cap.
  if (ledger.reserved_usd + CALL_ESTIMATE_USD[purpose] > ledger.cap_usd) {
    capTripped = true
    throw new SpendStop(`spend guard: reserved $${ledger.reserved_usd.toFixed(6)} + ${purpose} $${CALL_ESTIMATE_USD[purpose]} would pass the $${CAP_USD.toFixed(2)} cap`)
  }

  if (purpose !== 'router' && purpose !== 'embedding' && purpose !== 'curation' && purpose !== 'summary' && pendingPlanted) {
    const planted = pendingPlanted
    pendingPlanted = null
    const response = plantedResponse(body, planted)
    httpCalls.push({ turn: currentTurn, purpose, host: url.hostname, model, stream: false, system, user,
      response: `${planted.name}: ${planted.line}`, cost_usd: 0, prompt_tokens: 0, completion_tokens: 0,
      status: 200, latency_ms: 0, planted: true, simulated: false, sections: promptSections(user) })
    charge(0, purpose, 0, 0, false)
    saveLedger()
    return response
  }

  if (DRY) {
    // Offline rehearsal: nothing leaves this process.
    const result = dryResponse(purpose, body, system, user)
    const text = result.embedding ? '' : result.content
    httpCalls.push({ turn: currentTurn, purpose, host: 'dry-fixture', model, stream: false, system, user,
      response: text, cost_usd: 0, prompt_tokens: 0, completion_tokens: 0, status: 200, latency_ms: 0,
      planted: false, simulated: true, sections: promptSections(user) })
    if (purpose === 'curation') writeCuratorResponses()
    ledger.calls += 1
    ledger.simulated_calls += 1
    saveLedger()
    return dryChatResponse(body, result)
  }

  const started = performance.now()
  networkCalls += 1
  let response: Response
  try {
    response = await realFetch(input, init)
  } catch (error) {
    fetchFailures.push({ turn: currentTurn, url: url.href, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
  const latency = performance.now() - started
  const rawResponse = await response.clone().text()
  let text = ''
  let promptTokens = 0
  let completionTokens = 0
  let cost: number | null = null
  let servedModel: string | null = model
  try {
    const raw = JSON.parse(rawResponse) as {
      model?: unknown
      choices?: Array<{ message?: { content?: unknown } }>
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown }
      data?: unknown
    }
    if (typeof raw.model === 'string') servedModel = raw.model
    promptTokens = Number(raw.usage?.prompt_tokens) || 0
    completionTokens = Number(raw.usage?.completion_tokens) || 0
    const reported = Number(raw.usage?.cost)
    cost = Number.isFinite(reported) ? reported : null
    if (purpose === 'embedding') cost = promptTokens * EMBED_USD_PER_TOKEN
    text = String(raw.choices?.[0]?.message?.content ?? '')
  } catch { /* an error body is still a call that may have been billed */ }

  httpCalls.push({ turn: currentTurn, purpose, host: url.hostname, model: servedModel, stream: body.stream === true,
    system, user, response: text, rawResponse, cost_usd: cost, prompt_tokens: promptTokens, completion_tokens: completionTokens,
    status: response.status, latency_ms: latency, planted: false, simulated: false, sections: promptSections(user) })
  if (purpose === 'curation') writeCuratorResponses()
  // Throwing here is the hard stop even mid-turn. Error responses are not billed.
  charge(cost, purpose, promptTokens, completionTokens, response.ok)
  saveLedger()
  return response
}

/** Every refused or failed request is recorded, so a swallowed writer error still shows. */
const guardedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
  try {
    return await guardedFetchBase(input, init)
  } catch (error) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    fetchFailures.push({ turn: currentTurn, url, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}, { preconnect: realFetch.preconnect })

globalThis.fetch = guardedFetch

// ---------------------------------------------------------------- product mocks

interface StagedJob { name: string; data: Record<string, unknown> }
const staged: StagedJob[] = []
const logs: Array<{ msg: string; fields: Record<string, unknown> }> = []
/** Texts handed to `groupWriterMemory`'s Mongo `text: {$in}` read, per turn, in call order. */
const ragInputsByTurn = new Map<string, string[][]>()
let findHookInstalled = false

function installFindHook(): void {
  if (findHookInstalled) return
  findHookInstalled = true
  const original = Collection.prototype.find
  // Test instrumentation only: records what groupWriterMemory was handed so its
  // dropped RAG results can be counted without copying product logic.
  Collection.prototype.find = function patchedFind(this: Collection, filter?: Record<string, unknown>, options?: Record<string, unknown>) {
    try {
      if ((this as { collectionName?: string }).collectionName === 'memories') {
        const inList = (filter?.text as { $in?: unknown } | undefined)?.$in
        if (Array.isArray(inList)) {
          const list = ragInputsByTurn.get(currentTurn) ?? []
          list.push(inList.map(String))
          ragInputsByTurn.set(currentTurn, list)
        }
      }
    } catch { /* instrumentation must never break a read */ }
    return original.call(this, filter as never, options as never)
  } as typeof Collection.prototype.find
}

const unavailable = (name: string): never => { throw new Error(`Unexpected external dependency in the recall probe: ${name}`) }

/** Installed before any product import. */
function installMocks(): void {
  const { mock } = require('bun:test') as typeof import('bun:test')
  mock.module('../src/services/vector-store', () => ({
    vectorStore: stubVectorStore,
    scopeId: (scope: Scope) => scope.kind === 'lore' ? scope.templateId : scope.instanceId,
    readVectorFreshness: async () => ({ states: {}, floor: undefined }),
    readVectorWriteStates: async () => ({}),
    parseVectorFreshnessFloor: () => undefined,
    raiseVectorFreshnessFloor: async () => '',
    establishVectorFreshnessFloor: async () => undefined,
    startVectorFreshnessFloorRecovery: () => () => {},
    vectorFreshnessFloorKey: (namespace: string) => `vecf:v1:${namespace}:floor`,
    scopeFromLegacyNamespace: unavailable,
    vectorStoreForLayout: () => stubVectorStore,
    listLegacyScopes: async () => [],
    deleteLegacyNamespace: async () => {},
    WarmPingError: class WarmPingError extends Error {},
    setVectorIndexUseListener: () => {},
    createVectorStore: () => stubVectorStore,
  }))
  mock.module('../src/services/post-process-outbox.service', () => ({
    stagePostProcess: async (input: StagedJob) => { staged.push({ name: String(input.kind ?? ''), data: input.payload }) },
    dispatchPostProcessOutbox: async () => 0,
  }))
  mock.module('../src/queues', () => ({
    QUEUE_RETENTION: { generation: { removeOnComplete: 10, removeOnFail: 10 }, sceneSummary: { removeOnComplete: 10, removeOnFail: 10 } },
    getMediaQueue: () => ({ add: async () => ({}) }),
    getGenerationQueue: () => ({ add: async () => ({}) }),
    getMemoryCurationQueue: () => ({ add: async () => ({}) }),
    getSceneSummaryQueue: () => ({ add: async () => ({}) }),
    getMaintenanceQueue: () => ({ add: async () => ({}) }),
    removeQueuedJobsForInstance: async () => {},
  }))
  mock.module('../src/utils/logger', () => ({
    log: {
      debug() {},
      info(msg: string, fields: Record<string, unknown> = {}) {
        if (String(msg).startsWith('group.')) logs.push({ msg, fields: structuredClone(fields) })
      },
      warn(msg: string, fields: Record<string, unknown> = {}) {
        if (String(msg).startsWith('group.')) logs.push({ msg, fields: structuredClone(fields) })
      },
      error() {},
    },
    publicRequestMeta: () => ({}),
  }))
}

// ---------------------------------------------------------------- chat fixtures

const GROUP_FILES = ['flat-4b.json', 'alder-lane-watch.json', 'last-light-guild.json']
const GROUP_DIR = [
  process.env.GROUP_CHAT_DATA_DIR,
  resolve(ROOT, 'everlore-docs/launch/groups'),
  '/Users/fatman/Desktop/codes/rpg-ai/everlore-docs/launch/groups',
].filter((value): value is string => !!value && existsSync(value) && GROUP_FILES.every(file => existsSync(join(value, file))))[0]

/** Authored group JSON (fixture input, read-only). */
interface AuthoredGroup {
  slug: string; title: string; description: string; genre: string
  is_nsfw_capable?: boolean; seed_prompt: string; global_lore: string; narrative_style?: string
  topics?: string[]; seed_cast?: Array<{ name: string; role?: string; persona?: string; group?: Record<string, unknown> }>
  opening_lines?: Array<{ name: string; text: string }>; scene_tags?: string[]
}

function readGroup(slug: string): AuthoredGroup {
  if (!GROUP_DIR) throw new Error('Authored groups not found; set GROUP_CHAT_DATA_DIR')
  return JSON.parse(readFileSync(join(GROUP_DIR, `${slug}.json`), 'utf8')) as AuthoredGroup
}

type FactKey = 1 | 2 | 3 | 4 | 5 | 6 | 7

interface TurnSpec {
  player: string
  /** Cast members the fixture rng keeps in the speaker roll (others are rolled out). */
  speakers: string[]
  /** Leave the speaker roll to the product's own randomness, as the passed scenes did. */
  rolled?: boolean
  /** The member this message goes to privately; absent means the group thread. */
  direct?: string
  /** Scripted member line returned instead of a provider response, exactly once. */
  planted?: { name: string; line: string }
  /** Which planted fact this turn carries, for provenance checks. */
  fact?: FactKey
  note?: string
}

interface QuestionSpec {
  id: string
  kind: 'normal' | 'adult' | 'bystander' | 'control'
  player: string
  speakers: string[]
  planted?: { name: string; line: string }
  before?: TurnSpec[]
  /** Every group must match in Memories or Open threads (OR inside a group). */
  promptMust: string[][]
  promptMustNot: string[]
  /** Every group must match in the answer (OR inside a group). */
  replyMust: string[][]
  replyMustNot: string[]
  note: string
}

const CAST = ['Priya', 'Marco', 'Jess', 'Tom', 'Anya']
const SILENT = 'Anya'

/** Facts planted in the chat. Tokens live only in this script (test fixtures). */
const FACTS = {
  1: { label: 'player sister Mira marries in June', tokens: ['mira', 'june'], person: PLAYER },
  2: { label: 'Jess sister Lena moved to Lisbon', tokens: ['lisbon'], person: 'Jess' },
  3: { label: 'Priya sister Asha is a vet', tokens: ['vet'], person: 'Priya' },
  4: { label: 'player allergic to peanuts', tokens: ['peanut'], person: PLAYER },
  5: { label: 'Marco interview on Thursday', tokens: ['interview'], person: 'Marco' },
  6: { label: 'player brings the ladder on Saturday', tokens: ['ladder'], person: PLAYER },
  7: { label: 'player got a small fox tattoo', tokens: ['fox', 'tattoo'], person: PLAYER },
} as const

const CHAT: TurnSpec[] = [
  // facts 1..6, all inside the first 15 events
  { player: 'morning all. my sister Mira is getting married in June so i will be away that week', speakers: ['Marco'], fact: 1 },
  { player: '@Jess how is your sister doing these days', speakers: ['Jess'], fact: 2,
    planted: { name: 'Jess', line: 'she is ok!! my sister Lena just moved to Lisbon for a job and now she is insufferable about it' } },
  { player: '@Priya your sister is a doctor too, right?', speakers: ['Priya'], fact: 3,
    planted: { name: 'Priya', line: 'My sister Asha is a vet, not a doctor. She once operated on her own dog and did not tell our mother.' } },
  { player: 'also i am allergic to peanuts, properly allergic, so please keep them off the open shelf', speakers: ['Tom'], fact: 4 },
  { player: '@Marco you around this week?', speakers: ['Marco'], fact: 5,
    planted: { name: 'Marco', line: 'got an interview Thursday. head chef job. don\'t say anything yet' } },
  { player: 'I will bring the ladder on Saturday like I promised, it is still in my mum\'s garage', speakers: ['Tom'], fact: 6 },
  // ordinary flat-share chatter, so the facts sink into the past
  { player: '@Tom is the bin situation actually resolved', speakers: ['Tom'] },
  { player: 'who keeps leaving the bathroom door open', speakers: ['Priya'] },
  { player: '@Marco any chance of dinner this week', speakers: ['Marco'] },
  { player: 'Gravy knocked another mug off the windowsill', speakers: ['Tom'] },
  { player: 'the boiler is making that noise again', speakers: ['Priya'] },
  { player: '@Jess are you out tonight', speakers: ['Jess'] },
  { player: 'i am at work till nine, save me something', speakers: ['Marco'] },
  { player: 'someone ate the good bread, i am not naming names', speakers: ['Priya', 'Marco'] },
  { player: '@Tom did Derek ever reply about the damp', speakers: ['Tom'] },
  { player: 'quiz night at the Hope, who is in', speakers: ['Jess', 'Marco'] },
  { player: 'i am in but i am not on Tom\'s team again', speakers: ['Priya'] },
  { player: 'the washing machine ate a sock and i blame the machine', speakers: ['Jess'] },
  { player: '@Priya are you on nights all week', speakers: ['Priya'] },
  { player: 'rude of the sun to be up this early', speakers: ['Marco'] },
  { player: 'i have made a spreadsheet for the rota', speakers: ['Tom'] },
  { player: 'of course you have', speakers: ['Priya'] },
  { player: '@Jess your ex liked my photo and it is weird', speakers: ['Jess'] },
  { player: 'landlord says he is coming Friday, everyone tidy', speakers: ['Tom'] },
  { player: 'i will be out Friday', speakers: ['Marco'] },
  { player: 'the pub quiz has a cash prize this time', speakers: ['Jess'] },
  { player: 'five pounds between six people, thrilling', speakers: ['Priya'] },
  { player: '@Tom the smoke alarm is chirping', speakers: ['Tom'] },
  { player: 'i changed the battery, it is fine now', speakers: ['Tom'] },
  { player: 'the cat is on the fire escape judging us again', speakers: ['Jess'] },
  { player: '@Marco how was the restaurant', speakers: ['Marco'] },
  { player: 'long. hot. the chef shouted at a plate', speakers: ['Marco'] },
  { player: 'i have a hospital thing Friday so i will be useless', speakers: ['Priya'] },
  { player: '@Jess did you ever find that dress', speakers: ['Jess'] },
  { player: 'yes and it cost more than my share of the rent', speakers: ['Jess'] },
  { player: 'i have started running in the mornings and it is awful', speakers: ['Tom'] },
  // fact 7, near event 40
  { player: 'i got a small fox tattoo yesterday afternoon, it is tiny, on my arm', speakers: ['Jess'], fact: 7,
    planted: { name: 'Jess', line: 'a FOX?? on your ARM?? show us immediately' } },
  // two real adult scenes, so a later adult turn has an established intimate scene
  { player: '@Jess you have been staring at me all evening. come to my room, i want you naked and i want to make love to you', speakers: ['Jess'] },
  { player: '@Jess stay behind after everyone goes to bed. i want you naked on my bed', speakers: ['Jess'] },
  { player: 'well that escalated', speakers: ['Priya'] },
  { player: '@Tom is the gas reading thing still broken', speakers: ['Tom'] },
  { player: 'i fixed it, it is in the spreadsheet', speakers: ['Tom'] },
  { player: '@Marco the leftovers in the fridge, are they yours', speakers: ['Marco'] },
  { player: 'they are now', speakers: ['Marco'] },
  { player: 'Gravy has brought in a leaf and left it as a gift', speakers: ['Jess'] },
  { player: 'acceptable gift. thank you gravy', speakers: ['Priya'] },
  { player: 'someone needs to take the bins out and it is not me', speakers: ['Tom'] },
  { player: 'i did them last week so it is someone else\'s turn', speakers: ['Priya'] },
  { player: 'the Hope is doing a sunday roast now', speakers: ['Jess'] },
  { player: 'i am in, obviously', speakers: ['Marco'] },
  // spare filler: absorbs a few failed turns and keeps the chat past the raw window
  { player: 'the fridge light is out, i am putting it on the list', speakers: ['Tom'] },
  { player: 'i will fix it on Sunday with the ladder', speakers: ['Priya'] },
  { player: 'the neighbours are having a party again', speakers: ['Jess'] },
  { player: 'let them live', speakers: ['Marco'] },
]

const QUESTIONS: QuestionSpec[] = [
  { id: 'Q1', kind: 'normal', player: '@Anya when is my sister\'s wedding again?', speakers: ['Anya'],
    promptMust: [['june']], promptMustNot: [], replyMust: [['june']], replyMustNot: ['lisbon', 'vet'],
    note: 'the silent member is asked first' },
  { id: 'Q2', kind: 'normal', player: '@Anya whose sister moved to Lisbon?', speakers: ['Anya'],
    promptMust: [['lisbon']], promptMustNot: [], replyMust: [['jess']], replyMustNot: ['mira', 'asha'],
    note: 'attribution of a relative' },
  { id: 'Q3', kind: 'normal', player: '@Jess how is your sister settling in?', speakers: ['Jess'],
    promptMust: [['lena', 'lisbon']], promptMustNot: [], replyMust: [['lena', 'lisbon']], replyMustNot: ['mira', 'asha'],
    note: 'Lena or Lisbon, or an indirect insufferable-sister reply for manual review; never Mira or Asha' },
  { id: 'Q4', kind: 'normal', player: '@Priya what does your sister do?', speakers: ['Priya'],
    promptMust: [['vet']], promptMustNot: [], replyMust: [['vet']], replyMustNot: ['lisbon'], note: 'the vet job' },
  { id: 'Q5', kind: 'normal', player: '@Tom can you get peanut stuff for the party?', speakers: ['Tom'],
    promptMust: [['peanut']], promptMustNot: [], replyMust: [['peanut', 'allerg']], replyMustNot: [], note: 'the allergy reaches the writer' },
  { id: 'Q6', kind: 'normal', player: '@Marco what did I promise for Saturday?', speakers: ['Marco'],
    promptMust: [['ladder']], promptMustNot: [], replyMust: [['ladder']], replyMustNot: [], note: 'the open thread' },
  { id: 'Q7', kind: 'normal', player: '@Marco how did Thursday go?', speakers: ['Marco'],
    promptMust: [['interview']], promptMustNot: [], replyMust: [['interview']], replyMustNot: [], note: 'the interview' },
  { id: 'Q8', kind: 'normal', player: 'lol ok', speakers: ['Priya'],
    before: [{ player: '@Jess i have the June wedding this weekend, wish me luck', speakers: ['Jess'],
      planted: { name: 'Jess', line: 'the June wedding!!! you will be FINE babe, i am wearing something illegal to it' } }],
    promptMust: [['june']], promptMustNot: [], replyMust: [], replyMustNot: [], note: 'a short line still retrieves' },
  { id: 'Q9', kind: 'adult', player: '@Jess June is going to be a nightmare, all i can think about is you. i want you naked, and i want to make love to you after the wedding',
    speakers: ['Jess', 'Marco'], promptMust: [['june']], promptMustNot: [], replyMust: [], replyMustNot: [],
    note: 'the adult addressed prompt' },
  { id: 'Q10', kind: 'bystander', player: '', speakers: [], promptMust: [], promptMustNot: [], replyMust: [], replyMustNot: [],
    note: 'the bystander call on Q9' },
  { id: 'Q11', kind: 'control', player: '@Priya what was the name of my brother again?', speakers: ['Priya'],
    promptMust: [], promptMustNot: ['brother'], replyMust: [], replyMustNot: [], note: 'never planted' },
]

/** The owner-passed lines, verbatim from scripts/group-chat-live.ts (test fixtures). */
const SCENE_LINES: Record<'a' | 'b', string[]> = {
  a: [
    '@Jess you look really good tonight.',
    '@Jess I keep thinking about you in that dress.',
    '@Jess if we\'re both awake at 2am, I know what I\'d rather be doing.',
    '@Jess come to my room. Bring nothing.',
    '@Jess tell me exactly what you want me to do to you.',
    '@Jess I wanna fuck you.',
    '@Jess I want you naked in my bed right now.',
    '@Jess I\'m so hard thinking about you.',
    'Everyone else asleep?',
    '@Jess don\'t stop.',
    '@Jess tell me what you want.',
    'I want to fuck Jess tonight and everyone here should know it.',
    '@Marco morning. Any coffee?',
    '@Jess last night was good.',
    '@Jess what do you remember most about last night?',
  ],
  b: [
    '@Tom you look really good tonight.',
    '@Tom I wanna fuck you.',
    '@Priya I want you naked in my bed right now.',
    '@Anya tell me exactly what you want me to do to you.',
    '@Marco I\'m so hard thinking about you.',
    'The gas bill is fucking ridiculous.',
  ],
}

/** An old everyday fact raised mid-scene: the narrowed adult call must still find it. */
const WEDDING_RECALL = '@Jess June is going to be a nightmare, all i can think about is you. i want you naked, and i want to make love to you after the wedding'
/** Something she said long before, asked vaguely: only the scene memories can answer it. */
const SCENE_RECALL = '@Jess remember what you told me you wanted me to do to you earlier? say it again'
/** Direct messages: an ordinary opening, a planted secret, then the owner-passed adult lines. */
const DIRECT_TO = 'Jess', DIRECT_OTHER = 'Priya', DIRECT_MARKER = 'persimmon'
const DIRECT_OPENING = ['hey, you ok? you went quiet in the group earlier.',
  `don't tell anyone in the flat. I got fired from the hospital last week and I'm hiding it. my locker code was ${DIRECT_MARKER.toUpperCase()} and I still have the badge.`,
  'the only other person who knows is my cousin ines, she lives over in whitby.']
const DIRECT_ADULT = ['tell me exactly what you want me to do to you.', 'I wanna fuck you.', 'I want you naked in my bed right now.', 'I\'m so hard thinking about you.', 'don\'t stop.',
  'tell me what you want.', 'I want to fuck you tonight and nobody in the flat can know.', 'last night was good.', 'what do you remember most about last night?', 'remember what you told me you wanted me to do to you earlier? say it again']
const DIRECT_RECALL = 'what did I tell you about the hospital, and what was that locker code?'
const DIRECT_RECALL_NAME = 'who else knows about it, and where does she live?'
const DIRECT_PROBES: Array<{ label: string; spec: TurnSpec }> = [
  { label: 'probe-direct-priya', spec: { player: 'what was my locker code? has Jess told you why I left the hospital?', speakers: [DIRECT_OTHER], direct: DIRECT_OTHER, rolled: true } },
  { label: 'probe-group-jess', spec: { player: '@Jess what was my locker code? and why am I not at the hospital any more?', speakers: ['Jess'], rolled: true } },
  { label: 'probe-group-all', spec: { player: 'has anyone heard why I\'ve been home so much lately?', speakers: [], rolled: true } },
]
const TOGGLE_OFF: TurnSpec = { player: '@Jess you look good tonight', speakers: ['Jess'] }
const POST_REWIND: TurnSpec = { player: '@Priya any tattoos in this flat?', speakers: ['Priya'] }

// ---------------------------------------------------------------- plan

interface PlanEstimate {
  turns: number; events: number; calls: number; usd: number; curation: number; summaries: number; embeddings: number
}

function estimatePlan(): PlanEstimate {
  const turns = CHAT.length + QUESTIONS.filter(question => question.kind !== 'bystander').reduce((sum, question) => sum + 1 + (question.before?.length ?? 0), 0) + 2
  // Two calls per ordinary turn (one writer, one possible repair) and six adult
  // calls across the two adult turns (addressed, retry, and a bystander).
  const narration = (turns - 2) * 2 + 6
  const routerUsd = turns * CALL_ESTIMATE_USD.router
  const events = turns + 1
  const curation = Math.floor(turns / 5)
  const summaries = Math.floor(turns / 12)
  const embeddings = turns * 2 + 40
  const calls = narration + turns + curation + summaries + embeddings
  const usd = (turns - 2) * 2 * CALL_ESTIMATE_USD.narration + 6 * CALL_ESTIMATE_USD.adult_narration + routerUsd
    + curation * CALL_ESTIMATE_USD.curation + summaries * CALL_ESTIMATE_USD.summary + embeddings * CALL_ESTIMATE_USD.embedding
  return { turns, events, calls, usd, curation, summaries, embeddings }
}

function printPlan(): void {
  const planned = estimatePlan()
  const lines: string[] = []
  lines.push(`plan: ${CHAT.length} chat turns, ${QUESTIONS.filter(question => question.kind !== 'bystander').length} questions, 1 toggle-off turn, 1 post-rewind turn`)
  let index = 0
  for (const turn of CHAT) {
    index += 1
    lines.push(`  chat ${index}: [${turn.speakers.join(', ')}] ${turn.player}${turn.planted ? `  ⟵ planted ${turn.planted.name}` : ''}`)
  }
  for (const question of QUESTIONS) {
    if (question.kind === 'bystander') { lines.push(`  ${question.id}: (bystander call on the previous turn)`); continue }
    for (const before of question.before ?? []) {
      index += 1
      lines.push(`  ${question.id} setup: [${before.speakers.join(', ')}] ${before.player}${before.planted ? `  ⟵ planted ${before.planted.name}` : ''}`)
    }
    index += 1
    lines.push(`  ${question.id} ${question.kind}: [${question.speakers.join(', ')}] ${question.player}`)
  }
  index += 1
  lines.push(`  toggle-off: ${TOGGLE_OFF.player}`)
  index += 1
  lines.push(`  post-rewind: ${POST_REWIND.player}`)
  lines.push(`plan: ${index} player turns, ${planned.events} events (raw window is 30)`)
  lines.push(`plan: ≈${planned.calls} calls (${planned.curation} curation, ${planned.summaries} summaries, ${planned.embeddings} embeddings)`)
  lines.push(`plan: upper estimate $${planned.usd.toFixed(4)} (₹${(planned.usd * INR_PER_USD).toFixed(2)}), prior reserved $${ledger.reserved_usd.toFixed(6)}, total $${(ledger.reserved_usd + planned.usd).toFixed(6)} of the $${CAP_USD.toFixed(2)} cap`)
  lines.push(`plan: output ${OUT_DIR}`)
  console.log(lines.join('\n'))
  if (ledger.reserved_usd + planned.usd > CAP_USD) throw new Error(`plan estimate $${planned.usd.toFixed(4)} does not fit the $${CAP_USD.toFixed(2)} cap; shrink the filler`)
}

// ---------------------------------------------------------------- selftest

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`selftest failed: ${message}`)
}

async function selftest(): Promise<void> {
  const printed: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => { printed.push(values.map(String).join(' ')) }
  try {
    const { env } = await import('../src/config/env')

    // 1. Every overwritten variable holds the local or dead value.
    assert(env.MONGODB_URI === POISON.MONGODB_URI, 'env.MONGODB_URI is not the scratch/dead address')
    assert(env.REDIS_URL === POISON.REDIS_URL, 'env.REDIS_URL is not the scratch/dead address')
    assert(env.PINECONE_API_KEY === POISON.PINECONE_API_KEY, 'env.PINECONE_API_KEY is not dead')
    assert(env.S3_BUCKET === POISON.S3_BUCKET && env.CDN_BASE_URL === POISON.CDN_BASE_URL, 'object store is not dead')
    assert(env.RAG_RERANK_ENABLED === false, 'RAG re-rank is enabled')
    assert(env.KEEP_WARM === false, 'keep-warm is enabled')
    assert(env.OPENROUTER_API_KEY === process.env.OPENROUTER_API_KEY && !!env.OPENROUTER_API_KEY, 'OpenRouter key changed')

    // 2. The fetch guard bites, and its allow-list is exact.
    assert(isAllowedUrl('https://openrouter.ai/api/v1/chat/completions'), 'OpenRouter URL was refused')
    assert(isAllowedUrl('https://api.openai.com/v1/embeddings'), 'OpenAI URL was refused')
    assert(!isAllowedUrl('https://openrouter.ai.evil.example/x'), 'look-alike host was allowed')
    let blocked = false
    try { await guardedFetch('https://example.invalid/collect') } catch { blocked = true }
    assert(blocked, 'the fetch guard did not bite')
    assert(blockedHosts.includes('example.invalid'), 'the blocked host was not logged')

    // 3. The Mongo host guard refuses a non-local address and a wrong port.
    let remoteThrew = false
    try { assertLocalMongo('mongodb://prod.example.com:27017/everlore', 27017, 'everlore') } catch { remoteThrew = true }
    assert(remoteThrew, 'a non-local Mongo host was accepted')
    assertLocalMongo('mongodb://127.0.0.1:27999/everlore_recall_scratch', 27999, 'everlore_recall_scratch')
    let portThrew = false
    try { assertLocalMongo('mongodb://127.0.0.1:27017/everlore_recall_scratch', 27999, 'everlore_recall_scratch') } catch { portThrew = true }
    assert(portThrew, 'a non-scratch Mongo port was accepted')
    let dbThrew = false
    try { assertLocalMongo('mongodb://127.0.0.1:27999/everlore', 27999, 'everlore_recall_scratch') } catch { dbThrew = true }
    assert(dbThrew, 'a non-scratch database was accepted')

    // 4. The vector stub really ranks by cosine, and scope isolation holds.
    const scope = { kind: 'mem' as const, instanceId: 'selftest-instance' }
    await stubVectorStore.upsert(scope, [
      { id: 'near', values: [1, 0, 0], metadata: { text: 'near', is_nsfw: false } },
      { id: 'far', values: [0, 1, 0], metadata: { text: 'far', is_nsfw: true } },
    ])
    await stubVectorStore.upsert({ kind: 'mem', instanceId: 'other-instance' }, [{ id: 'elsewhere', values: [1, 0, 0], metadata: { text: 'elsewhere' } }])
    const ranked = await stubVectorStore.query(scope, { vector: [0.9, 0.1, 0], topK: 2 })
    assert(ranked.matches[0]?.id === 'near', 'the vector stub did not rank the near vector first')
    assert(ranked.matches.every(match => match.id !== 'elsewhere'), 'the vector stub leaked across scopes')
    const filtered = await stubVectorStore.query(scope, { vector: [1, 0, 0], topK: 5, filter: { is_nsfw: false } })
    assert(filtered.matches.length === 1 && filtered.matches[0].id === 'near', 'the vector stub ignored a metadata filter')
    const fetched = await stubVectorStore.fetch(scope, ['far'])
    assert(fetched.records.far?.values[1] === 1, 'the vector stub lost a stored value')
    await stubVectorStore.deleteIds(scope, ['near'])
    assert((await stubVectorStore.listIds(scope)).length === 1, 'the vector stub did not delete an id')
    await stubVectorStore.deleteScope(scope)
    assert((await stubVectorStore.listIds(scope)).length === 0, 'the vector stub did not clear a scope')

    // 5. The spend guard bites at the cap: before a call, and inside the charge.
    const near = { ...freshLedger(), reserved_usd: CAP_USD - 0.000001 }
    assert(near.reserved_usd + CALL_ESTIMATE_USD.narration > CAP_USD, 'the pre-call spend guard would not have refused')
    const ceiling = { ...freshLedger(), reserved_usd: CAP_USD - 0.001, cap_usd: CAP_USD }
    assert(chargeInto(ceiling, 0.002, 'narration', 0, 0), 'the charge guard did not refuse a call that passes the cap')
    const roomy = { ...freshLedger() }
    assert(!chargeInto(roomy, 0.002, 'narration', 0, 0), 'the charge guard refused a call inside the cap')
    assert(roomy.spent_usd === 0.002, 'the charge guard did not book the real cost')
    const unpriced = { ...freshLedger() }
    chargeInto(unpriced, null, 'narration', 0, 0)
    assert(unpriced.unpriced_calls === 1 && unpriced.reserved_usd === CALL_ESTIMATE_USD.narration, 'an unpriced call was not reserved')
    const embedded = { ...freshLedger() }
    chargeInto(embedded, null, 'embedding', 1_000_000, 0)
    assert(Math.abs(embedded.spent_usd - 0.02) < 1e-9, 'an embedding was not priced from its tokens')

    // Scoring regressions must fail offline even when the same token appears in recent history.
    const fixtureCall = (sections: NonNullable<CapturedCall['sections']>) => ({ sections }) as CapturedCall
    const emptySections = { memories: '', openThreads: '', summaries: '', recent: '' }
    const june = QUESTIONS[0]
    assert(recallPromptCheck(june, fixtureCall({ ...emptySections, memories: 'June' })).pass, 'Memories did not earn recall')
    assert(recallPromptCheck(june, fixtureCall({ ...emptySections, openThreads: 'June' })).pass, 'Open threads did not earn recall')
    for (const key of ['summaries', 'recent'] as const) {
      const result = recallPromptCheck(june, fixtureCall({ ...emptySections, [key]: 'June' }))
      assert(result.pass === false, `${key} alone earned hard recall with zero atoms`)
      assert(result.detail.includes(key === 'summaries' ? 'june: Summary' : 'june: raw history'), 'token section was not reported')
    }
    const all = recallPromptCheck(june, fixtureCall({ memories: 'June', openThreads: 'June', summaries: 'June', recent: 'June' }))
    assert(all.detail.includes('june: Memories, Open threads, Summary, raw history'), 'not every matching section was reported')
    const ladder = QUESTIONS.find(question => question.id === 'Q6')!
    const onlyMemory = fixtureCall({ ...emptySections, memories: 'ladder' })
    assert(!recallPromptCheck(ladder, onlyMemory, true).pass, 'unresolved ladder did not require Open threads')
    assert(recallPromptCheck(ladder, onlyMemory, false).pass, 'resolved ladder incorrectly required Open threads')
    assert(recallPromptCheck(ladder, fixtureCall({ ...emptySections, openThreads: 'ladder' }), true).pass, 'unresolved ladder missing from Open threads')
    const bystander = QUESTIONS.find(question => question.id === 'Q10')!
    assert(!recallPromptCheck(bystander, fixtureCall({ ...emptySections, recent: 'june' })).pass, 'Q10 raw history earned recall')
    assert(!recallPromptCheck(bystander, fixtureCall({ ...emptySections, summaries: 'june' })).pass, 'Q10 summary earned recall')
    assert(recallPromptCheck(bystander, fixtureCall({ ...emptySections, memories: 'june' })).pass, 'Q10 memory failed recall')
    assert(!recallPromptCheck(QUESTIONS[2], fixtureCall({ ...emptySections, memories: 'unrelated' })).pass, 'Q3 had no required recall token')
    const allergy = QUESTIONS.find(question => question.id === 'Q5')!
    assert(tokenCheck('Q5 reply', 'Remember your allergy.', allergy.replyMust, allergy.replyMustNot).pass, 'Q5 rejected an allergy reply')
    const stored: AtomRow = { id: 'atom', text: 'Mira marries in June.', type: 'observation', importance: 3, isNsfw: false,
      thread: false, subjects: ['player'], objects: [], sources: ['event'], sourceSequences: [2], vectorIds: [] }
    for (const subject of ['player', PLAYER]) {
      assert(checkFact(1, [{ ...stored, subjects: [subject] }], { eventId: 'event', sequence: 2 }).pass, 'canonical or named player rejected')
    }
    for (const subjects of [['Jess'], ['Priya']]) {
      assert(!checkFact(1, [{ ...stored, subjects }], { eventId: 'event', sequence: 2 }).pass, 'wrong person escaped misattribution')
    }
    assert(!checkFact(1, [], { eventId: 'event', sequence: 2 }).pass, 'zero stored atoms earned coverage')
    for (const patch of [{ subjects: ['player', 'Jess'] }, { subjects: ['Jess'], objects: ['Sam'] },
      { subjects: ['Jess'], text: "Sam's sister Mira has a June wedding." }]) {
      assert(checkFact(1, [{ ...stored, ...patch }], { eventId: 'event', sequence: 2 }).pass, 'right person present was called misattribution')
    }
    const incidental = { ...stored, text: 'Sam asked Priya about his brother, she mentioned Mira', sources: ['wrong'] }
    assert(!statesFact(1, incidental), 'Mira mention alone earned wedding provenance')
    assert(!checkFact(1, [stored, incidental], { eventId: 'event', sequence: 2 }).detail.includes('MISATTRIBUTED'), 'incidental Mira was misattributed')
    assert(!checkFact(1, [{ ...stored, text: 'Mira was mentioned in passing.' }], { eventId: 'event', sequence: 2 }).pass, 'incidental token earned provenance')
    assert(!checkFact(1, [{ ...stored, sources: ['wrong'] }], { eventId: 'event', sequence: 2 }).pass, 'wrong source earned provenance')
    assert(statesFact(1, { ...stored, text: "Sam's sister Mira has a wedding planned." }), 'wedding without June rejected')
    assert(!statesFact(4, { ...stored, text: 'Tom flagged Sam is on the fridge list for peanuts' }), 'peanut list earned allergy provenance')
    const allergic = { ...stored, text: 'Sam is allergic to peanuts.', subjects: ['Tom'] }
    assert(checkFact(4, [allergic], { eventId: 'event', sequence: 2 }).pass, 'allergy with right person in text rejected')
    assert(!checkFact(4, [{ ...allergic, text: 'Jess is allergic to peanuts.' }], { eventId: 'event', sequence: 2 }).pass, 'wrong allergy person accepted')
    assert(!checkFact(4, [{ ...allergic, sources: ['wrong'] }], { eventId: 'event', sequence: 2 }).pass, 'wrong allergy provenance accepted')
    assert(recallReplyCheck(QUESTIONS[2], "oh she's INSUFFERABLE sam 🥲").pass === null, 'Q3 actual indirect answer must be read by a person')
    assert(recallReplyCheck(QUESTIONS[2], 'My sister is being insufferable about it.').pass === null, 'Q3 indirect answer must be read by a person')
    assert(recallReplyCheck(QUESTIONS[2], 'My sister Mira is insufferable.').pass === false, 'Q3 wrong sister accepted')
    assert(recallReplyCheck(QUESTIONS[2], 'Lena is settling in well.').pass === true, 'Q3 explicit answer rejected')

    const counts = memoryBatchCounts([{ fields: { memoriesCreated: 4, closuresAccepted: 2, closuresRejected: 3 } }, { fields: { memoriesCreated: 1 } }])
    assert(counts.created === 5 && counts.accepted === 2 && counts.rejected === 3, 'memory and closure counts were lost')
    const logLength = logs.length
    logs.push({ msg: 'group.memory_batch', fields: { memoriesCreated: 5, closuresAccepted: 2, closuresRejected: 3 } })
    try {
      const summary = summaryMarkdown({ checks: [], atoms: [stored], archivedBeforeRewind: 2, factChecks: [], toggle: null,
        rewind: [], reset: null, watermarksBefore: null, watermarksAfter: null, postSections: '', answers: [], factEvents: new Map() })
      assert(summary.includes('atoms: created 5; archived before rewind 2; live before rewind 1'), 'created archived and live reporting was lost')
      assert(summary.includes('closures: accepted 2; rejected 3'), 'closure reporting was lost')
    } finally { logs.splice(logLength) }

    const rawCalls = [{ purpose: 'curation', turn: 'test-1', response: '{}', rawResponse: '{invalid raw body', status: 500 },
      { purpose: 'curation', turn: 'test-2', response: '{"memories":[]}', status: 200 }] as CapturedCall[]
    const rawMarkdown = curatorResponsesMarkdown(rawCalls)
    assert(rawMarkdown.includes('{invalid raw body') && rawMarkdown.includes('{"memories":[]}'), 'raw curator responses were lost')
    assert(rawMarkdown.includes('HTTP 500') && rawMarkdown.includes('test-2'), 'curator response metadata was lost')

    // 6. Nothing secret was printed.
    const secret = process.env.OPENROUTER_API_KEY || ''
    assert(!printed.join('\n').includes(secret), 'the selftest printed the OpenRouter key')
  } finally {
    console.log = originalLog
  }
  console.log('PASS selftest: dead env, allowed-hosts-only fetch, local Mongo guard, cosine vector stub, spend guard, recall sections, player attribution and allergy scoring; no secret printed')
}

// ---------------------------------------------------------------- run

interface TurnResult {
  index: number
  label: string
  player: string
  speakers: string[]
  planted: { name: string; line: string } | null
  fact: FactKey | null
  route: 'adult' | 'normal' | null
  sequence: number | null
  eventId: string | null
  eventType: string | null
  modelUsed: string | null
  lines: Array<{ name: string; text: string; model: string | null; cost: number | null }>
  writing: Array<{ writer: string; model: string; purpose: string }>
  calls: CapturedCall[]
  error: string | null
  cost: number
  elapsedMs: number
}

interface PostProcessRecord { kind: string; ok: boolean; result?: unknown; error?: string; calls: number }

interface Check { name: string; pass: boolean | null; detail: string }

const turns: TurnResult[] = []
const postProcess: PostProcessRecord[] = []
const stops: string[] = []
const notes: string[] = []
const errors: string[] = []
const factEvents = new Map<FactKey, { eventId: string; sequence: number }>()

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

function tagsOf(text: string): string[] {
  return CAST.filter(name => new RegExp(`@${name}(?![\\p{L}\\p{N}_])`, 'iu').test(text))
}

/** Fixture randomness: keeps exactly the planned speakers in the roll, no others. */
function makeRng(speakers: string[], tags: string[]): () => number {
  const drawOrder = CAST.filter(name => !tags.includes(name))
  let draw = 0
  return () => {
    if (draw < drawOrder.length) {
      const name = drawOrder[draw]
      draw += 1
      return speakers.includes(name) ? 0 : 1
    }
    draw += 1
    // rollBystanders only adds one when this draw is >= 0.5.
    return 0.9
  }
}

function templateFrom(group: AuthoredGroup) {
  const now = new Date('2026-11-01T09:00:00Z')
  // Authored JSON straight into the template shape; validateGroup checks it next.
  return {
    _id: new ObjectId(), creator_id: new ObjectId('200000000000000000000001'),
    slug: group.slug, title: group.title, description: group.description,
    kind: 'group', genre: group.genre, is_published: true, visibility: 'public', review_status: 'approved',
    is_sentient: false, is_nsfw_capable: group.is_nsfw_capable !== false, version: 1,
    seed_prompt: group.seed_prompt, global_lore: group.global_lore, narrative_style: group.narrative_style,
    seed_cast: group.seed_cast, topics: group.topics, opening_lines: group.opening_lines,
    base_stats_template: {}, flag_definitions: {}, scene_tags: group.scene_tags || [], model_preferences: {},
    max_context_memories: 25, max_lore_results: 10, created_at: now, updated_at: now,
  } as never
}

function assertAdults(template: { seed_cast?: Array<{ name: string; group?: { age?: number } }> }): void {
  const underage = (template.seed_cast || []).filter(member => !Number.isFinite(member.group?.age) || (member.group!.age as number) < 18)
  if (underage.length) throw new Error(`refusing an adult run: ${underage.map(member => member.name).join(', ')} are not adults`)
  if (PLAYER_AGE < 18) throw new Error('refusing an adult run: the player is not an adult')
}

async function runProbe(): Promise<number> {
  const local = infra
  if (!local) throw new Error('scratch servers were not started')

  const { connectMongo, getDb, mongoColl } = await import('../src/config/mongo')
  await connectMongo()

  // THE assertion: loopback, scratch port, scratch database — before the first product write.
  assertLocalMongo(process.env.MONGODB_URI!, local.mongoPort, SCRATCH_DB)
  const db = getDb()
  const attached = (db as unknown as { client?: { options?: { hosts?: Array<{ host: string; port: number }> } } }).client?.options?.hosts
  if (!attached || !attached.length) throw new Error('refusing to write: could not read the connected Mongo hosts')
  for (const host of attached) {
    if (host.host !== '127.0.0.1' || host.port !== local.mongoPort) {
      throw new Error(`refusing to write: Mongo is connected to ${host.host}:${host.port}`)
    }
  }
  if (db.databaseName !== SCRATCH_DB) throw new Error(`refusing to write: database is ${db.databaseName}`)
  await db.admin().command({ ping: 1 })
  console.log(`mongo: connected to 127.0.0.1:${local.mongoPort}/${SCRATCH_DB} (scratch)`)

  const { connectRedis, getRedisClient } = await import('../src/config/redis')
  await connectRedis()
  console.log(`redis: connected to 127.0.0.1:${local.redisPort} (scratch)`)

  const { validateGroup } = await import('../src/services/group-chat/validation')
  const { seedGroupOpening, loadGroupMembers } = await import('../src/services/group-chat/instance')
  const { groupTurnProcessor } = await import('../worker/processors/group-turn.processor')
  const { memoryProcessor } = await import('../worker/processors/memory.processor')
  const { summaryProcessor } = await import('../worker/processors/summary.processor')
  const { memoryService } = await import('../src/services/memory.service')
  const { deletionService } = await import('../src/services/deletion.service')
  const { materializeTemplateCast } = await import('../src/services/template-cast.service')
  const { AI_MODELS } = await import('../src/ai')
  const { DEFAULT_CHAT_MODE } = await import('../src/utils/chat-modes')

  const adultChain = [...new Set([AI_MODELS.groupNsfw, ...AI_MODELS.groupNsfwFallbacks])]
  adultModelSet = new Set(adultChain)

  // ---- the group, created the way a new group is
  const group = readGroup('flat-4b')
  const template = templateFrom(group)
  validateGroup(template as never)
  assertAdults(template as never)
  await mongoColl.worldTemplates().insertOne(template as never)

  const playerId = new ObjectId(PLAYER_ID)
  await mongoColl.users().insertOne({
    _id: playerId, guest: false, account_status: 'active',
    preferences: { player_name: PLAYER, nsfw_enabled: true },
  } as never)

  const instanceId = new ObjectId()
  const instance = {
    _id: instanceId, template_id: (template as { _id: ObjectId })._id, group_template_id: (template as { _id: ObjectId })._id,
    template_version: 1, seed_cast_snapshot: (template as { seed_cast?: unknown }).seed_cast,
    player_id: playerId, world_state: {}, active_flags: {},
    current_scene: { tag: 'dialogue', turn_count: 0, summary_pending: false },
    narration_pov: 'third', mode: DEFAULT_CHAT_MODE, message_length: 'medium',
    narrative_style_override: null, focus_character_id: null, persona_id: null, persona_snapshot: null, current_location: null,
    meta: { total_events: 0, total_memories: 0, total_tokens_consumed: 0, last_active_at: new Date(), is_archived: false },
    created_at: new Date(), updated_at: new Date(),
  }
  await mongoColl.worldInstances().insertOne(instance as never)

  try {
    await materializeTemplateCast({ template: template as never, instanceId: instanceId.toHexString(), playerId: PLAYER_ID })
  } catch (error) {
    // The cast cards are the only thing group turns need; fall back to the shape
    // the group processor reads, and say so in the report.
    notes.push(`materializeTemplateCast failed (${(error as Error).message}); inserted minimal cast cards instead`)
    const cards = ((template as { seed_cast?: Array<{ name: string }> }).seed_cast || []).map(member => ({
      _id: new ObjectId(), instance_id: instanceId, canonical_name: member.name,
    }))
    if (cards.length) await mongoColl.characters().insertMany(cards as never)
  }

  await seedGroupOpening(instance as never, template as never, PLAYER)
  if (SCENE) {
    // The passed scenes ran at Sunday 19:21, so hold every replay at that hour through the product's own offset.
    const started = new Date()
    const minutes = ((19 * 60 + 21 - (started.getUTCHours() * 60 + started.getUTCMinutes())) % 1440 + 1440) % 1440
    await mongoColl.worldInstances().updateOne({ _id: instanceId }, { $set: { 'group_state.tz_offset_minutes': minutes } } as never)
  }
  const reloaded = await mongoColl.worldInstances().findOne({ _id: instanceId })
  const members = await loadGroupMembers(reloaded as never)
  const nameById = new Map(members.map(member => [member.id, member.name]))
  const idByName = new Map(members.map(member => [member.name, member.id]))
  const silentId = idByName.get(SILENT)
  console.log(`group: ${(template as { title: string }).title} — ${members.map(member => member.name).join(', ')}; silent member ${SILENT}`)

  // ---- processing the post-process outbox, in order, in-process
  async function drainPostProcess(): Promise<void> {
    if (MEMORIES_OFF) { staged.length = 0; return }
    while (staged.length) {
      const job = staged.shift()!
      const kind = job.data.groupMemory ? 'memory' : job.data.groupSummary ? 'summary' : 'unknown'
      const before = httpCalls.length
      currentTurn = `post-process/${kind}`
      try {
        const result = kind === 'memory'
          ? await memoryProcessor({ id: crypto.randomUUID(), data: job.data } as never)
          : kind === 'summary'
            ? await summaryProcessor({ id: crypto.randomUUID(), data: job.data } as never)
            : { skipped: 'unknown' }
        postProcess.push({ kind, ok: true, result: result as unknown, calls: httpCalls.length - before })
      } catch (error) {
        // A failed curator job is a recorded failure, not a crash that loses the run.
        postProcess.push({ kind, ok: false, error: (error as Error)?.message ?? String(error), calls: httpCalls.length - before })
        errors.push(`${kind} job failed: ${(error as Error)?.message ?? String(error)}`)
      }
    }
  }

  // ---- one real group turn
  let turnIndex = 0
  const background: Promise<void>[] = []
  async function runTurn(spec: TurnSpec, label: string): Promise<TurnResult> {
    turnIndex += 1
    const index = turnIndex
    if (ledger.reserved_usd + CALL_ESTIMATE_USD.narration * 4 > CAP_USD) {
      capTripped = true
      throw new SpendStop(`spend guard before ${label}: reserved $${ledger.reserved_usd.toFixed(6)} plus a turn would pass the $${CAP_USD.toFixed(2)} cap`)
    }
    const jobId = crypto.randomUUID()
    const lockKey = `lock:gen:${PLAYER_ID}:${instanceId.toHexString()}`
    await getRedisClient().set(lockKey, JSON.stringify({ owner: jobId, phase: 'running' }), 'EX', 180)
    const tags = tagsOf(spec.player)
    const missing = tags.filter(name => !spec.speakers.includes(name))
    if (missing.length) throw new Error(`turn ${label}: ${missing.join(', ')} is tagged but not a planned speaker`)
    currentTurn = label
    pendingPlanted = spec.planted ?? null
    const callStart = httpCalls.length
    const logStart = logs.length
    const started = performance.now()
    let result: { eventId: string; sequence: number } | null = null
    let error: string | null = null
    try {
      result = await groupTurnProcessor({
        id: jobId, data: { instanceId: instanceId.toHexString(), playerId: PLAYER_ID, userMessage: spec.player, ...(spec.direct ? { directWith: idByName.get(spec.direct) } : {}) },
      } as never, { ...(spec.rolled ? {} : { rng: makeRng(spec.speakers, tags) }), onBackground: (work: Promise<void>) => { background.push(work) } }) as { eventId: string; sequence: number }
      await Promise.all(background.splice(0))
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    pendingPlanted = null
    const elapsedMs = performance.now() - started
    const calls = httpCalls.slice(callStart)
    const replyLog = logs.slice(logStart).filter(entry => entry.msg === 'group.reply_checked').at(-1)?.fields
    const event = result ? await mongoColl.events().findOne({ _id: new ObjectId(result.eventId) }) : null
    const rawLines = ((event?.data as { lines?: Array<{ character_id: string; text: string }> } | undefined)?.lines ?? [])
    const lines = rawLines.map(line => {
      const producer = calls.filter(call => call.purpose === 'narration' || call.purpose === 'adult_narration')
        .find(call => norm(call.response).includes(norm(line.text).slice(0, 40)))
      return { name: nameById.get(line.character_id) ?? line.character_id, text: line.text,
        model: producer?.model ?? null, cost: producer?.cost_usd ?? null }
    })
    const record: TurnResult = {
      index, label, player: spec.player, speakers: spec.speakers, planted: spec.planted ?? null, fact: spec.fact ?? null,
      route: event ? (event.type === 'intimate' ? 'adult' : 'normal') : null,
      sequence: result?.sequence ?? null, eventId: result?.eventId ?? null,
      eventType: event ? String(event.type) : null, modelUsed: (event?.data as { model_used?: string } | undefined)?.model_used ?? null,
      lines, writing: (replyLog?.writing as TurnResult['writing'] | undefined) ?? [], calls, error, elapsedMs,
      cost: calls.reduce((sum, call) => sum + (call.cost_usd ?? 0), 0),
    }
    turns.push(record)
    if (record.cost > ledger.max_turn_usd) { ledger.max_turn_usd = record.cost; saveLedger() }
    if (spec.fact) factEvents.set(spec.fact, { eventId: result?.eventId ?? '', sequence: result?.sequence ?? 0 })
    if (error) errors.push(`turn ${label}: ${error}`)
    console.log(`${label}: route=${record.route ?? 'none'} calls=${calls.length} lines=${lines.length} $${record.cost.toFixed(6)}${error ? ` error=${error}` : ''}${tags.length ? ` tags=${tags.join(',')}` : ''}`)
    await drainPostProcess()
    return record
  }

  try {
    if (SCENE === 'd') {
      for (const spec of CHAT.slice(0, CHAT.findIndex(entry => entry.fact === 7) + 1)) await runTurn(spec, `chat-${turnIndex + 1}`)
      const direct = (player: string): TurnSpec => ({ player, speakers: [DIRECT_TO], direct: DIRECT_TO, rolled: true })
      const opening: TurnResult[] = [], adult: TurnResult[] = []
      for (const [offset, player] of DIRECT_OPENING.entries()) opening.push(await runTurn(direct(player), `direct-open-${offset + 1}`))
      for (const [offset, player] of DIRECT_ADULT.entries()) adult.push(await runTurn(direct(player), `direct-adult-${offset + 1}`))
      const recall = await runTurn(direct(DIRECT_RECALL), 'direct-recall')
      await runTurn(direct(DIRECT_RECALL_NAME), 'direct-recall-name')
      const probes: TurnResult[] = []
      for (const { label, spec } of DIRECT_PROBES) probes.push(await runTurn(spec, label))
      await mongoColl.users().updateOne({ _id: playerId }, { $set: { 'preferences.nsfw_enabled': false } } as never)
      const toggleTurn = await runTurn({ ...direct('you look good tonight'), rolled: true }, 'direct-toggle-off')

      const atoms = await mongoColl.memories().find({ instance_id: instanceId, is_archived: false }).toArray()
      const jessId = idByName.get(DIRECT_TO)
      const privateAtoms = atoms.filter(atom => (atom as { private_to?: string }).private_to === jessId)
      const adultPrivate = privateAtoms.filter(atom => atom.is_nsfw === true)
      const failures: string[] = []
      if (!privateAtoms.length) failures.push('no private memory was stored, so the privacy checks proved nothing')
      if (!recall.lines.some(line => norm(line.text).includes(DIRECT_MARKER))) failures.push('direct-recall: the character lost the exact code')
      const writersOf = (turn: TurnResult) => turn.calls.filter(call => call.purpose === 'narration' || call.purpose === 'adult_narration')
      const allTurns = [...opening, ...adult, recall, ...probes, toggleTurn]
      for (const turn of allTurns) {
        if (turn.error) failures.push(`${turn.label}: ${turn.error}`)
        if (!turn.lines.length) failures.push(`${turn.label}: nobody replied`)
      }
      for (const turn of [...opening, ...adult, recall, toggleTurn]) {
        if (turn.lines.some(line => line.name !== DIRECT_TO)) failures.push(`${turn.label}: someone other than ${DIRECT_TO} replied`)
        for (const call of writersOf(turn)) {
          const narrow = call.system.includes('You are writing only')
          if (narrow && call.user.includes('Group chat (read-only')) failures.push(`${turn.label}: the adult direct prompt has the group block`)
          if (!narrow && !call.user.includes('Group chat (read-only')) failures.push(`${turn.label}: the normal direct prompt lacks the group block`)
        }
      }
      // The secret and every private fact must be absent from every other thread's calls.
      const secrets = [DIRECT_MARKER, 'fired from the hospital', ...privateAtoms.map(atom => norm(String(atom.text)))]
      const leakIn = (text: string) => secrets.filter(secret => norm(text).includes(norm(secret)))
      for (const turn of probes) {
        for (const call of turn.calls) {
          const found = leakIn(`${call.system ?? ''}\n${call.user ?? ''}`)
          if (found.length) failures.push(`${turn.label}: a ${call.purpose} request held private text: ${found[0].slice(0, 60)}`)
        }
        if (turn.lines.some(line => norm(line.text).includes(DIRECT_MARKER))) failures.push(`${turn.label}: a reply said the secret`)
      }
      const toggleWriters = writersOf(toggleTurn)
      if (toggleWriters.some(call => adultModelSet?.has(String(call.model)))) failures.push('toggle off: an adult model wrote')
      const toggleText = toggleWriters.map(call => call.user).join('\n')
      if (adultPrivate.some(atom => norm(toggleText).includes(norm(String(atom.text))))) failures.push('toggle off: an adult memory reached a prompt')

      const out: string[] = ['# Direct messages, evening clock', '', `${turnIndex - allTurns.length} ordinary group turns came first.`, '']
      for (const turn of allTurns) {
        const tame = turn.eventId ? (await mongoColl.events().findOne({ _id: new ObjectId(turn.eventId) }))?.data?.tame === true : false
        const held = writersOf(turn).map(call => (call.sections?.memories ?? '').split('\n').filter(Boolean).length)
        out.push(`## ${turn.label}: route=${turn.route}${tame ? ' · marked tame' : ''} · memory lines per writer: ${held.join(', ')} · ${Math.round(turn.elapsedMs)} ms · $${turn.cost.toFixed(6)}`, '', `Sam: ${turn.player}`)
        for (const line of turn.lines) out.push(`  ${line.name} [${line.model ?? 'unknown'}]: ${line.text}`)
        out.push('')
      }
      out.push('## Failures', '', ...(failures.length ? failures.map(item => `- ${item}`) : ['- none']), '', `Private memories for ${DIRECT_TO}: ${privateAtoms.length} of ${atoms.length}.`, ...privateAtoms.map(atom => `- ${atom.text}`), '',
        `Ledger: $${ledger.spent_usd.toFixed(6)} (₹${(ledger.spent_usd * INR_PER_USD).toFixed(2)}) of $${CAP_USD.toFixed(2)}.`)
      writeFileSync(join(RUN_DIR, 'scene.md'), `${out.join('\n')}\n`)
      writeFileSync(join(RUN_DIR, 'adult-prompts.md'), `${allTurns.flatMap(turn => writersOf(turn).map(call => `## ${turn.label} · ${call.model}\n\n${call.user}\n\n--- reply\n${call.response}\n`)).join('\n')}\n`)
      writeCuratorResponses()
      console.log(`direct: ${failures.length} failure(s), ${privateAtoms.length} private memories, $${ledger.spent_usd.toFixed(6)}; ${join(RUN_DIR, 'scene.md')}`)
      return failures.length ? 1 : 0
    }
    if (SCENE) {
      // The ordinary chat up to fact 7, without its abrupt adult turns, then the passed lines.
      for (const spec of CHAT.slice(0, CHAT.findIndex(entry => entry.fact === 7) + 1)) await runTurn(spec, `chat-${turnIndex + 1}`)
      const sceneTurns: TurnResult[] = []
      for (const [offset, player] of SCENE_LINES[SCENE].entries()) {
        sceneTurns.push(await runTurn({ player, speakers: tagsOf(player), rolled: true }, `scene-${offset + 1}`))
      }
      if (SCENE === 'a') sceneTurns.push(await runTurn({ player: WEDDING_RECALL, speakers: tagsOf(WEDDING_RECALL), rolled: true }, 'wedding-recall'))
      if (SCENE === 'a') sceneTurns.push(await runTurn({ player: SCENE_RECALL, speakers: tagsOf(SCENE_RECALL), rolled: true }, 'scene-recall'))
      const atoms = await mongoColl.memories().find({ instance_id: instanceId, is_archived: false }).toArray()
      const intimate = new Set(turns.filter(turn => turn.eventType === 'intimate' && turn.eventId).map(turn => turn.eventId!))
      const adultAtoms = atoms.filter(atom => atom.is_nsfw === true || (atom.source_event_ids || []).some(id => intimate.has(String(id))))

      if (!MEMORIES_OFF) await mongoColl.users().updateOne({ _id: playerId }, { $set: { 'preferences.nsfw_enabled': false } } as never)
      const toggleTurn = MEMORIES_OFF ? null : await runTurn(TOGGLE_OFF, 'toggle-off')
      const toggleWriters = (toggleTurn?.calls ?? []).filter(call => call.purpose === 'narration' || call.purpose === 'adult_narration')
      const toggleText = toggleWriters.map(call => [call.sections?.memories, call.sections?.openThreads].join('\n')).join('\n').toLowerCase()
      const leaked = adultAtoms.filter(atom => toggleText.includes(norm(String(atom.text))))

      const failures: string[] = []
      if (!MEMORIES_OFF && !adultAtoms.length) failures.push('no adult memory was stored, so the toggle check proved nothing')
      if (leaked.length) failures.push(`toggle off: ${leaked.length} adult memory reached a prompt`)
      if (toggleWriters.some(call => adultModelSet?.has(String(call.model)))) failures.push('toggle off: an adult model wrote')
      const out: string[] = [`# Scene ${SCENE.toUpperCase()} with memories ${MEMORIES_OFF ? 'off' : 'on'}, evening clock`, '', `${turnIndex - sceneTurns.length - 1} ordinary turns came first. Speakers in the scene were rolled by the product.`, '']
      for (const turn of [...sceneTurns, ...(toggleTurn ? [toggleTurn] : [])]) {
        const writers = turn.calls.filter(call => call.purpose === 'narration' || call.purpose === 'adult_narration')
        const held = writers.map(call => (call.sections?.memories ?? '').split('\n').filter(Boolean).length)
        const tagged = tagsOf(turn.player)
        if (turn.error) failures.push(`${turn.label}: ${turn.error}`)
        if (!turn.lines.length) failures.push(`${turn.label}: nobody replied`)
        for (const name of tagged) if (!turn.lines.some(line => line.name === name)) failures.push(`${turn.label}: ${name} was tagged and did not reply`)
        if (writers.some(call => MEMORIES_OFF ? Boolean(call.sections?.memories || call.sections?.summaries) : !call.system.includes('You are writing only') && !call.sections?.memories)) failures.push(`${turn.label}: memory state of a writer prompt is wrong`)
        if (writers.some(call => !/\b19:\d\d\b/.test(call.user) && !/\b2\d:\d\d\b/.test(call.user))) failures.push(`${turn.label}: a writer prompt was not at the evening clock`)
        for (const call of writers.filter(call => call.system.includes('You are writing only'))) {
          if ((call.sections?.memories ?? '').split('\n').filter(Boolean).length > 10 || call.sections?.openThreads || call.sections?.summaries) failures.push(`${turn.label}: the adult prompt is not narrow`)
          if (turn.label === 'wedding-recall' && !MEMORIES_OFF && !/mira/i.test(call.sections?.memories ?? '')) failures.push('wedding-recall: the wedding fact was not in the adult prompt')
          if (turn.label === 'scene-recall' && !MEMORIES_OFF && !atoms.some(atom => atom.explicit_fact === true && (call.sections?.memories ?? '').includes(String(atom.text)))) failures.push('scene-recall: no explicit scene fact was in the adult prompt')
        }
        const tame = turn.eventId ? (await mongoColl.events().findOne({ _id: new ObjectId(turn.eventId) }))?.data?.tame === true : false
        out.push(`## ${turn.label}: route=${turn.route}${tame ? ' · marked tame' : ''} · memory lines per writer: ${held.join(', ')} · $${turn.cost.toFixed(6)}`, '', `Sam: ${turn.player}`)
        for (const line of turn.lines) out.push(`  ${line.name} [${line.model ?? 'unknown'}]: ${line.text}`)
        out.push('')
      }
      const firstAddressed = sceneTurns.flatMap(turn => turn.calls).find(call => call.system.includes('You are writing only'))
      out.push('## Memories in the first adult addressed prompt', '', firstAddressed?.sections?.memories || '(none)', '', '## Failures', '', ...(failures.length ? failures.map(item => `- ${item}`) : ['- none']), '',
        `Adult memories stored: ${adultAtoms.length} of ${atoms.length}.`, ...adultAtoms.map(atom => `- ${atom.text}`), '', `Ledger: $${ledger.spent_usd.toFixed(6)} (₹${(ledger.spent_usd * INR_PER_USD).toFixed(2)}) of $${CAP_USD.toFixed(2)}.`)
      writeFileSync(join(RUN_DIR, 'scene.md'), `${out.join('\n')}\n`)
      writeFileSync(join(RUN_DIR, 'adult-prompts.md'), `${sceneTurns.flatMap(turn => turn.calls.filter(call => call.system.includes('You are writing only')).map(call => `## ${turn.label} · ${call.model}\n\n${call.user}\n\n--- reply\n${call.response}\n`)).join('\n')}\n`)
      writeCuratorResponses()
      console.log(`scene ${SCENE}: ${failures.length} failure(s), ${adultAtoms.length} adult memories, $${ledger.spent_usd.toFixed(6)}; ${join(RUN_DIR, 'scene.md')}`)
      return failures.length ? 1 : 0
    }

    // ---- the chat, past the 30-event raw window
    for (const spec of CHAT) await runTurn(spec, `chat-${turnIndex + 1}`)

    const chatLastSequence = Math.max(...turns.map(turn => turn.sequence ?? 0))
    // Sequence 1 is the authored opening, where every member already has a line.
    const silentLines = await mongoColl.events().countDocuments({
      instance_id: instanceId, sequence: { $gte: 2, $lte: chatLastSequence }, 'data.lines.character_id': silentId,
    })
    const silentEvents = silentLines === 0 ? [] : (await mongoColl.events().find({
      instance_id: instanceId, sequence: { $gte: 2, $lte: chatLastSequence }, 'data.lines.character_id': silentId,
    }, { projection: { sequence: 1 } }).toArray()).map(event => Number(event.sequence))
    const silentCheck: Check = {
      name: `${SILENT} says nothing before the first question`,
      pass: silentLines === 0,
      detail: silentLines === 0 ? `0 stored lines by ${SILENT} in ${chatLastSequence - 1} played events (the authored opening aside)`
        : `${silentLines} stored line(s) by ${SILENT} at sequence ${silentEvents.join(', ')}`,
    }

    // ---- the questions
    const answers: Array<{ question: QuestionSpec; turn: TurnResult; call: CapturedCall | null; reply: string; prompt: Check; replyCheck: Check; extra: string }> = []
    const checks: Check[] = [silentCheck]
    let bystanderRecord: { turn: TurnResult; call: CapturedCall | null } | null = null
    for (const question of QUESTIONS) {
      if (question.kind === 'bystander') {
        const q9 = answers.at(-1)!
        const narration = q9.turn.calls.filter(call => call.purpose === 'narration' || call.purpose === 'adult_narration')
        const bystanders = narration.slice(1).filter(call => !call.system.includes('You are writing only'))
        const call = bystanders.at(-1) ?? null
        const check = recallPromptCheck(question, call)
        checks.push(check)
        answers.push({ question, turn: q9.turn, call, reply: '', prompt: check, replyCheck: { name: 'Q10 reply', pass: null, detail: 'bystander line is in the Q9 transcript' }, extra: 'same turn as Q9' })
        bystanderRecord = { turn: q9.turn, call }
        continue
      }
      for (const before of question.before ?? []) await runTurn(before, `${question.id}-setup`)
      const ladderUnresolved = question.id === 'Q6' && (await mongoColl.memories().find({ instance_id: instanceId, is_archived: false, unresolved_thread: true }).toArray()).some(atom => String(atom.text).toLowerCase().includes('ladder'))
      const turn = await runTurn({ player: question.player, speakers: question.speakers }, question.id)
      const call = primaryCall(turn)
      const reply = turn.lines.map(line => `${line.name}: ${line.text}`).join('\n')
      const promptCheck = recallPromptCheck(question, call, ladderUnresolved)
      const replyCheck = DRY
        ? { name: `${question.id} reply level`, pass: null as boolean | null, detail: 'dry run: the reply text is simulated, so it is not scored' }
        : question.kind === 'control'
          ? { name: `${question.id} reply level`, pass: null as boolean | null, detail: `manual review: control question, no fixture fact. Possible invented names: ${inventedNames(reply).join(', ') || 'none'}` }
          : recallReplyCheck(question, reply)
      checks.push(promptCheck, replyCheck)
      let extra = ''
      if (question.id === 'Q9') {
        const addressed = turn.calls.find(entry => entry.system.includes('You are writing only'))
        const adult = addressed ? adultChain.includes(String(addressed.model)) : false
        checks.push({ name: 'Q9 the addressed writer is the adult chain', pass: adult, detail: addressed ? `model ${addressed.model}` : 'no addressed call' })
        extra = `addressed model: ${addressed?.model ?? 'none'}`
      }
      answers.push({ question, turn, call, reply, prompt: promptCheck, replyCheck, extra })
    }

    // ---- atoms on stored records, while they still exist
    const sequenceById = new Map<string, number>()
    for (const event of await mongoColl.events().find({ instance_id: instanceId }).toArray()) {
      sequenceById.set(String(event._id), Number(event.sequence))
    }
    const readAtoms = async () => (await mongoColl.memories().find({ instance_id: instanceId, is_archived: false }).toArray()).map(doc => ({
      id: String(doc._id), text: String(doc.text), type: String(doc.type), importance: Number(doc.importance),
      isNsfw: doc.is_nsfw === true, thread: doc.unresolved_thread === true,
      subjects: (doc.subjects || []).map(String), objects: (doc.objects || []).map(String),
      sources: (doc.source_event_ids || []).map(String),
      sourceSequences: (doc.source_event_ids || []).map(id => sequenceById.get(String(id)) ?? 0).sort((a, b) => a - b),
      vectorIds: doc.pinecone_id ? [String(doc.pinecone_id)] : [],
    }))
    const atomsBeforeRewind = await readAtoms()
    const archivedBeforeRewind = await mongoColl.memories().countDocuments({ instance_id: instanceId, is_archived: true })
    const factKeys: FactKey[] = [1, 2, 3, 4, 5, 6, 7]
    const factChecks = factKeys.map(key => checkFact(key, atomsBeforeRewind, factEvents.get(key)))

    // ---- toggle off: one normal turn after the adult turns
    await mongoColl.users().updateOne({ _id: playerId }, { $set: { 'preferences.nsfw_enabled': false } } as never)
    const toggleTurn = await runTurn(TOGGLE_OFF, 'toggle-off')
    await mongoColl.users().updateOne({ _id: playerId }, { $set: { 'preferences.nsfw_enabled': true } } as never)
    const intimateEventIds = new Set(turns.filter(turn => turn.eventType === 'intimate' && turn.eventId).map(turn => turn.eventId!))
    const adultAtoms = atomsBeforeRewind.filter(atom => atom.isNsfw || atom.sources.some(id => intimateEventIds.has(id)))
    const toggleSections = [primaryCall(toggleTurn)?.sections].filter(Boolean).map(section => [section!.memories, section!.openThreads, section!.summaries].join('\n')).join('\n')
    const leaked = adultAtoms.filter(atom => toggleSections.toLowerCase().includes(norm(atom.text)))
    const adultModelUsed = toggleTurn.calls.some(call => adultChain.includes(String(call.model)))
    const toggleCheck: Check = {
      name: 'toggle off: no adult-sourced atom reaches the prompt',
      pass: leaked.length === 0 && !adultModelUsed,
      detail: leaked.length ? `leaked: ${leaked.map(atom => atom.text.slice(0, 60)).join(' | ')}` : adultModelUsed ? 'an adult model wrote with consent off' : `${adultAtoms.length} adult atom(s) held; none reached the prompt`,
    }

    // ---- rewind to before fact 7
    const fact7 = factEvents.get(7)
    if (!fact7?.sequence) throw new Error('fact 7 was never planted; cannot rewind')
    const watermarksBefore = await watermarks(instanceId)
    const memVectorsBefore = await stubVectorStore.listIds({ kind: 'mem', instanceId: instanceId.toHexString() })
    const foxAtoms = atomsBeforeRewind.filter(atom => atom.text.toLowerCase().includes('fox') || atom.text.toLowerCase().includes('tattoo'))
    const foxVectors = foxAtoms.flatMap(atom => atom.vectorIds)
    await memoryService.rewindToSequence(instanceId.toHexString(), PLAYER_ID, fact7.sequence)
    const watermarksAfter = await watermarks(instanceId)
    const atomsAfterRewind = await readAtoms()
    const memVectorsAfter = await stubVectorStore.listIds({ kind: 'mem', instanceId: instanceId.toHexString() })
    const postTurn = await runTurn(POST_REWIND, 'post-rewind')
    const postSections = [primaryCall(postTurn)?.sections].filter(Boolean).map(section => [section!.memories, section!.openThreads, section!.summaries].join('\n')).join('\n')
    const rewindChecks: Check[] = [
      { name: 'rewind: the fact 7 atom is gone',
        pass: atomsAfterRewind.every(atom => !atom.text.toLowerCase().includes('fox') && !atom.text.toLowerCase().includes('tattoo')),
        detail: `${foxAtoms.length} fox atom(s) before; ${atomsAfterRewind.filter(atom => atom.text.toLowerCase().includes('fox') || atom.text.toLowerCase().includes('tattoo')).length} after` },
      { name: 'rewind: the fact 7 vectors are gone',
        pass: foxVectors.every(id => !memVectorsAfter.includes(id)),
        detail: `${foxVectors.length} fox vector(s); mem scope ${memVectorsBefore.length} → ${memVectorsAfter.length}` },
      { name: 'rewind: atoms for facts 1 to 6 remain',
        pass: ([1, 2, 3, 4, 5, 6] as FactKey[])
          .every(key => atomsAfterRewind.some(atom => matchesFact(atom, FACTS[key].tokens))),
        detail: `${atomsBeforeRewind.length} atom(s) before; ${atomsAfterRewind.length} after` },
      { name: 'rewind: a new question asks about tattoos without a fox fact',
        pass: !/fox/.test(postSections.toLowerCase()) && !/tattoo/.test(postSections.toLowerCase()),
        detail: postSections ? postSections.slice(0, 200) : 'no memory sections in the post-rewind prompt' },
    ]
    console.log(`watermarks before rewind: ${JSON.stringify(watermarksBefore)}; after: ${JSON.stringify(watermarksAfter)}`)

    // ---- the real reset
    await deletionService.resetInstance(instanceId.toHexString(), PLAYER_ID)
    const resetAtoms = await readAtoms()
    const resetMemVectors = await stubVectorStore.listIds({ kind: 'mem', instanceId: instanceId.toHexString() })
    const resetSumVectors = await stubVectorStore.listIds({ kind: 'sum', instanceId: instanceId.toHexString() })
    const resetSummaries = await mongoColl.sceneSummaries().countDocuments({ instance_id: instanceId })
    const resetChapters = await mongoColl.chapterSummaries().countDocuments({ instance_id: instanceId })
    const resetArcs = await mongoColl.arcSummaries().countDocuments({ instance_id: instanceId })
    const eventsAfterReset = await mongoColl.events().countDocuments({ instance_id: instanceId })
    const resetCheck: Check = {
      name: 'reset: no atoms, vectors or summaries remain',
      pass: resetAtoms.length === 0 && resetMemVectors.length === 0 && resetSumVectors.length === 0
        && resetSummaries === 0 && resetChapters === 0 && resetArcs === 0,
      detail: `atoms ${resetAtoms.length}, mem vectors ${resetMemVectors.length}, sum vectors ${resetSumVectors.length}, summaries ${resetSummaries}/${resetChapters}/${resetArcs}; events left ${eventsAfterReset} (the re-seeded opening)`,
    }

    checks.push(...factChecks, toggleCheck, ...rewindChecks, resetCheck)

    // ---- output
    writeCuratorResponses()
    writeTranscript(answers)
    writeQuestions(answers, bystanderRecord)
    writeAtoms(atomsBeforeRewind, atomsAfterRewind, factChecks)
    writeSummary({
      checks, atoms: atomsBeforeRewind, archivedBeforeRewind, factChecks, toggle: toggleCheck, rewind: rewindChecks, reset: resetCheck,
      watermarksBefore, watermarksAfter, postSections, answers, factEvents,
    })

    const hard = checks.filter(check => check.pass === false)
    for (const check of checks) console.log(`${check.pass === false ? 'FAIL' : check.pass === null ? 'MANUAL' : 'PASS'} ${check.name} — ${check.detail}`)
    for (const stop of stops) console.log(`STOP ${stop}`)
    console.log(`gc-1g-recall: ${hard.length ? `${hard.length} hard failure(s)` : 'passed'} — ${turns.length} turns, ${ledger.calls} calls (${ledger.planted_calls} planted), $${ledger.spent_usd.toFixed(6)} (₹${(ledger.spent_usd * INR_PER_USD).toFixed(2)}); ledger ${join(RUN_DIR, 'spend.json')}`)
    return hard.length ? 1 : 0
  } catch (error) {
    stops.push(error instanceof Error ? error.message : String(error))
    console.error(`gc-1g-recall stopped: ${stops.at(-1)}`)
    try {
      writeCuratorResponses()
      writeTranscript([])
      writeSummary({ checks: [{ name: 'run stopped early', pass: false, detail: stops.at(-1)! }], atoms: [], factChecks: [], toggle: null, rewind: [], reset: null,
        watermarksBefore: null, watermarksAfter: null, postSections: '', answers: [], factEvents })
    } catch { /* the partial run is still in the log */ }
    return 1
  } finally {
    try { getRedisClient().disconnect() } catch { /* not connected */ }
    try {
      const client = (getDb() as unknown as { client?: { close(): Promise<void> } }).client
      if (client) await client.close()
    } catch { /* not connected */ }
  }

  // ---- helpers that need the session
  async function watermarks(id: ObjectId) {
    const doc = await mongoColl.worldInstances().findOne({ _id: id }, { projection: { group_state: 1 } })
    const state = (doc?.group_state || {}) as { curated_through_sequence?: number; summarized_through_sequence?: number }
    return { curated_through_sequence: state.curated_through_sequence ?? 1, summarized_through_sequence: state.summarized_through_sequence ?? 1 }
  }
}

/** Report every matching section even when that section cannot earn a hard pass. */
function recallPromptCheck(question: QuestionSpec, call: CapturedCall | null, ladderUnresolved = false): Check {
  const sections = call?.sections
  const groups = question.id === 'Q10' ? [Object.values(FACTS).flatMap(fact => [...fact.tokens])] : question.promptMust
  const tokens = [...new Set([...groups.flat(), ...question.promptMustNot])]
  const labelled = [
    ['Memories', sections?.memories ?? ''], ['Open threads', sections?.openThreads ?? ''],
    ['Summary', sections?.summaries ?? ''], ['raw history', sections?.recent ?? ''],
  ] as const
  const locations = tokens.map(token => {
    const found = labelled.filter(([, text]) => text.toLowerCase().includes(token.toLowerCase())).map(([label]) => label)
    return `${token}: ${found.join(', ') || 'absent'}`
  }).join('; ')
  const eligible = question.id === 'Q6' && ladderUnresolved
    ? sections?.openThreads ?? ''
    : question.kind === 'control' ? labelled.slice(0, 3).map(([, text]) => text).join('\n').trim()
      : [sections?.memories, sections?.openThreads].filter(Boolean).join('\n').trim()
  const check = tokenCheck(`${question.id} prompt level`, eligible, groups, question.promptMustNot)
  return { ...check, detail: `${check.detail}; token sections — ${locations || '(no fixture tokens)'}${question.id === 'Q6' ? `; ladder atom unresolved: ${ladderUnresolved}; required section: ${ladderUnresolved ? 'Open threads' : 'Memories or Open threads'}` : ''}` }
}

function curatorResponsesMarkdown(calls: CapturedCall[]): string {
  const lines = ['# Raw curator responses', '', DRY ? 'DRY fixtures; no measured provider responses.' : 'Every curator HTTP response, before atom parsing or validation.', '']
  for (const [index, call] of calls.filter(call => call.purpose === 'curation').entries()) {
    lines.push(`## ${index + 1}. ${call.turn} — ${call.model ?? 'unknown model'} (HTTP ${call.status})`, '', '```', call.rawResponse ?? call.response, '```', '')
  }
  return `${lines.join('\n')}\n`
}

function writeCuratorResponses(): void {
  writeFileSync(join(RUN_DIR, 'curator-responses.md'), curatorResponsesMarkdown(httpCalls))
}

function tokenCheck(name: string, text: string, must: string[][], mustNot: string[]): Check {
  const lower = text.toLowerCase()
  const missing = must.filter(group => !group.some(token => lower.includes(token)))
  const forbidden = mustNot.filter(token => lower.includes(token))
  const pass = text.length > 0 && missing.length === 0 && forbidden.length === 0
  const detail = text.length === 0 ? 'no section text captured'
    : `${missing.length ? `missing: ${missing.map(group => group.join('|')).join(', ')}` : 'all required tokens present'}${forbidden.length ? `; forbidden: ${forbidden.join(', ')}` : ''}`
  return { name, pass, detail }
}

function inventedNames(reply: string): string[] {
  const known = new Set([...CAST, PLAYER].map(name => name.toLowerCase()))
  const matches = reply.match(/\b[A-Z][a-z]{2,}\b/g) ?? []
  return [...new Set(matches.map(name => name.toLowerCase()))].filter(name => !known.has(name))
    .filter(name => !['the', 'and', 'but', 'you', 'your', 'what', 'who', 'when', 'did', 'was', 'never', 'not', 'no', 'yes', 'ok'].includes(name))
}

function primaryCall(turn: TurnResult): CapturedCall | null {
  const narration = turn.calls.filter(call => call.purpose === 'narration' || call.purpose === 'adult_narration')
  if (!narration.length) return null
  const firstLine = turn.lines[0]
  if (firstLine) {
    const needle = norm(firstLine.text).slice(0, 40)
    for (let index = narration.length - 1; index >= 0; index--) {
      if (needle && norm(narration[index].response).includes(needle)) return narration[index]
    }
  }
  return narration[narration.length - 1]
}

interface AtomRow {
  id: string; text: string; type: string; importance: number; isNsfw: boolean; thread: boolean
  subjects: string[]; objects: string[]; sources: string[]; sourceSequences: number[]; vectorIds: string[]
}

function matchesFact(atom: AtomRow, tokens: readonly string[]): boolean {
  const text = atom.text.toLowerCase()
  return tokens.every(token => text.includes(token))
}

function statesFact(key: FactKey, atom: AtomRow): boolean {
  const text = atom.text.toLowerCase()
  if (key === 1) return text.includes('mira') && /wedding|marri|june/.test(text)
  if (key === 4) return text.includes('peanut') && text.includes('allerg')
  return matchesFact(atom, FACTS[key].tokens)
}

function checkFact(key: FactKey, atoms: AtomRow[], event: { eventId: string; sequence: number } | undefined): Check {
  const fact = FACTS[key]
  const matching = atoms.filter(atom => statesFact(key, atom))
  const expected = fact.person.toLowerCase()
  const names = expected === PLAYER.toLowerCase() ? [expected, 'player', 'the player'] : [expected]
  const hasPerson = (atom: AtomRow) => [...atom.subjects, ...atom.objects].some(name => names.includes(name.toLowerCase())) ||
    names.some(name => new RegExp(`\\b${name}\\b`, 'i').test(atom.text))
  const hasRightSubject = matching.some(hasPerson)
  const withProvenance = matching.filter(atom => hasPerson(atom) && event?.eventId && atom.sources.includes(event.eventId))
  const provenanceOk = withProvenance.length > 0
  const misattributed = matching.filter(atom => !hasPerson(atom))
  const pass = matching.length > 0 && hasRightSubject && provenanceOk && misattributed.length === 0
  const detail = matching.length === 0 ? 'no atom stored'
    : `atoms: ${matching.length}; right person: ${hasRightSubject}; provenance: ${provenanceOk}${event ? ` (event seq ${event.sequence})` : ''}` +
      `${misattributed.length ? `; MISATTRIBUTED: ${misattributed.map(atom => `${atom.text.slice(0, 60)} [${atom.subjects.join(', ')}]`).join(' | ')}` : ''}`
  return { name: `fact ${key} (${fact.label}): atom, subject and provenance`, pass, detail }
}

function recallReplyCheck(question: QuestionSpec, reply: string): Check {
  const check = tokenCheck(`${question.id} reply level`, reply, question.replyMust, question.replyMustNot)
  if (!check.pass && question.id === 'Q3' && /insufferable/i.test(reply) &&
    !question.replyMustNot.some(token => reply.toLowerCase().includes(token))) {
    return { ...check, pass: null, detail: 'manual review: reply plainly discusses the sister being insufferable; confirm Lisbon context in the transcript' }
  }
  return check
}

function memoryBatchCounts(batches: Array<{ fields: Record<string, unknown> }>) {
  const sum = (key: string) => batches.reduce((total, entry) => total + Number(entry.fields[key] ?? 0), 0)
  return { created: sum('memoriesCreated'), accepted: sum('closuresAccepted'), rejected: sum('closuresRejected') }
}

function money(value: number): string { return `$${value.toFixed(6)}` }

function plantedMark(turn: TurnResult): string { return turn.planted ? ' ⟵ planted fixture line' : '' }

function writeTranscript(answers: Array<{ question: QuestionSpec }>): void {
  const lines: string[] = ['# Transcript — Flat 4B, played through the real group turn processor', '']
  for (const turn of turns) {
    const tags = tagsOf(turn.player)
    lines.push(`## ${turn.label}${turn.fact ? ` (fact ${turn.fact})` : ''}${turn.route ? ` — route ${turn.route}` : ''}`)
    lines.push('')
    lines.push(`**${PLAYER}:** ${turn.player}${tags.length ? `  _(tags: ${tags.join(', ')})_` : ''}`)
    for (const line of turn.lines) {
      const planted = turn.planted && line.name === turn.planted.name && norm(line.text).includes(norm(turn.planted.line).slice(0, 30))
      lines.push(`- **${line.name}** [${line.model ?? 'no model'} · ${line.cost === null ? 'n/a' : money(line.cost)}]: ${line.text}${planted ? plantedMark(turn) : ''}`)
    }
    if (!turn.lines.length) lines.push('- _(no stored lines)_')
    if (turn.error) lines.push(`- ! turn error: ${turn.error}`)
    lines.push('')
  }
  writeFileSync(join(RUN_DIR, 'transcript.md'), `${lines.join('\n').trimEnd()}\n`)
}

function writeQuestions(
  answers: Array<{ question: QuestionSpec; turn: TurnResult; call: CapturedCall | null; reply: string; prompt: Check; replyCheck: Check; extra: string }>,
  bystander: { turn: TurnResult; call: CapturedCall | null } | null,
): void {
  const lines: string[] = ['# Questions — prompt level and reply level, reported separately', '',
    'Fixture tokens live only in the test script. Prompt level is machine-checked on the writer prompt; reply level is machine-checked on the stored reply and must be read in the transcript.', '']
  for (const answer of answers) {
    const { question, turn, call } = answer
    lines.push(`## ${question.id} — ${question.note}`)
    if (question.kind !== 'bystander') {
      lines.push('', `**${PLAYER}:** ${question.player}`, `**Route:** ${turn.route ?? 'none'} · **speaker(s):** ${turn.lines.map(line => line.name).join(', ') || 'none'} · **model:** ${call?.model ?? 'none'}`)
    } else {
      lines.push('', '**Bystander call on the Q9 turn.**')
    }
    if (call?.sections) {
      lines.push('', '**Memories:**', '', call.sections.memories || '(none)', '', '**Open threads:**', '', call.sections.openThreads || '(none)',
        '', '**Summary so far:**', '', call.sections.summaries || '(none)', '', '**Raw history:**', '', call.sections.recent || '(none)')
    } else {
      lines.push('', '_(no prompt captured for this turn)_')
    }
    if (question.kind !== 'bystander') {
      lines.push('', '**Reply:**', '', answer.reply || '(no stored lines)')
    }
    lines.push('', `- ${answer.prompt.pass === false ? 'FAIL' : answer.prompt.pass === null ? 'MANUAL' : 'PASS'} prompt — ${answer.prompt.detail}`)
    if (question.kind !== 'bystander') lines.push(`- ${answer.replyCheck.pass === false ? 'FAIL' : answer.replyCheck.pass === null ? 'MANUAL' : 'PASS'} reply — ${answer.replyCheck.detail}`)
    if (answer.extra) lines.push(`- ${answer.extra}`)
    lines.push('')
  }
  if (bystander?.call) lines.push(`## Q10 bystander\n\nModel: ${bystander.call.model ?? 'none'}\n\n\`\`\`\n${bystander.call.user}\n\`\`\`\n`)
  writeFileSync(join(RUN_DIR, 'questions.md'), `${lines.join('\n').trimEnd()}\n`)
}

function writeAtoms(before: AtomRow[], after: AtomRow[], factChecks: Check[]): void {
  const lines: string[] = ['# Stored atoms (before rewind)', '', `${before.length} atom(s). Source sequences are the events each atom cites.`, '']
  for (const atom of [...before].sort((a, b) => (a.sourceSequences[0] ?? 0) - (b.sourceSequences[0] ?? 0))) {
    lines.push(`- ${atom.text}`)
    lines.push(`  subjects: ${atom.subjects.join(', ') || '(none)'} · objects: ${atom.objects.join(', ') || '(none)'} · type: ${atom.type} · importance: ${atom.importance} · nsfw: ${atom.isNsfw} · thread: ${atom.thread} · sources: ${atom.sourceSequences.join(', ') || '(none)'}`)
  }
  lines.push('', '## Fact checks', '')
  for (const check of factChecks) lines.push(`- ${check.pass ? 'PASS' : 'FAIL'} ${check.name} — ${check.detail}`)
  lines.push('', `After rewind: ${after.length} atom(s).`)
  for (const atom of after) lines.push(`- ${atom.text}`)
  writeFileSync(join(RUN_DIR, 'atoms.md'), `${lines.join('\n').trimEnd()}\n`)
}

function summaryMarkdown(input: {
  checks: Check[]
  atoms: AtomRow[]
  archivedBeforeRewind?: number
  factChecks: Check[]
  toggle: Check | null
  rewind: Check[]
  reset: Check | null
  watermarksBefore: Record<string, number> | null
  watermarksAfter: Record<string, number> | null
  postSections: string
  answers: Array<{ question: QuestionSpec; prompt: Check; replyCheck: Check }>
  factEvents: Map<FactKey, { eventId: string; sequence: number }>
}): string {
  const pass = input.checks.filter(check => check.pass === true).length
  const fail = input.checks.filter(check => check.pass === false)
  const manual = input.checks.filter(check => check.pass === null).length
  const purpose = (key: PurposeKey) => ledger.by_purpose[key] ?? { calls: 0, cost_usd: 0, prompt_tokens: 0, completion_tokens: 0 }
  const writer = purpose('narration'), adult = purpose('adult_narration'), curation = purpose('curation')
  const summaryCost = purpose('summary'), embedding = purpose('embedding'), router = purpose('router')
  const events = turns.filter(turn => turn.eventId).length
  const memoryCost = curation.cost_usd + embedding.cost_usd
  const lines: string[] = [DRY ? '# Recall run summary — DRY REHEARSAL (every provider call simulated; nothing measured)' : '# Recall run summary', '']
  lines.push(`- turns: ${turns.length}; events stored: ${events}; atoms before rewind: ${input.atoms.length}`)
  lines.push(`- atoms: created ${memoryBatchCounts(logs.filter(entry => entry.msg === 'group.memory_batch')).created}; archived before rewind ${input.archivedBeforeRewind ?? 'unavailable'}; live before rewind ${input.atoms.length}`)
  lines.push(`- atom coverage: ${input.factChecks.filter(check => check.pass === true).length}/7 planted facts stored with correct subject and provenance`)
  lines.push(`- checks: ${pass} pass, ${fail.length} fail, ${manual} manual (read by a person)`)
  lines.push(`- spend: ${money(ledger.spent_usd)} (₹${(ledger.spent_usd * INR_PER_USD).toFixed(2)}) of the $${CAP_USD.toFixed(2)} cap; ${ledger.calls} calls, ${ledger.planted_calls} planted fixtures, ${ledger.unpriced_calls} unpriced`)
  lines.push('')
  lines.push('## Pass counts')
  lines.push('')
  for (const check of input.checks) lines.push(`- ${check.pass === false ? 'FAIL' : check.pass === null ? 'MANUAL' : 'PASS'} ${check.name} — ${check.detail}`)
  lines.push('')
  lines.push('## Costs, by purpose (from real provider usage, ledger)')
  lines.push('')
  lines.push('| purpose | calls | cost | prompt tokens | completion tokens |')
  lines.push('|---|---|---|---|---|')
  for (const [name, bucket] of Object.entries(ledger.by_purpose)) {
    lines.push(`| ${name} | ${bucket.calls} | ${money(bucket.cost_usd)} (₹${(bucket.cost_usd * INR_PER_USD).toFixed(2)}) | ${bucket.prompt_tokens} | ${bucket.completion_tokens} |`)
  }
  lines.push('')
  lines.push(`- writer (normal): ${money(writer.cost_usd)} · writer (adult): ${money(adult.cost_usd)} · router: ${money(router.cost_usd)}`)
  lines.push(`- curator: ${money(curation.cost_usd)} · summary: ${money(summaryCost.cost_usd)} · embeddings: ${money(embedding.cost_usd)} (priced from tokens at $0.02/1M)`)
  lines.push(`- memory cost per 100 events: ${events ? money((memoryCost / events) * 100) : 'n/a'} (₹${events ? ((memoryCost / events) * 100 * INR_PER_USD).toFixed(2) : 'n/a'})`)
  lines.push('')
  const memoryBatches = logs.filter(entry => entry.msg === 'group.memory_batch')
  const memoryValidation = logs.filter(entry => entry.msg === 'group.memory_validation')
  const summaryBatches = logs.filter(entry => entry.msg === 'group.summary_batch')
  lines.push('## Curator and summary batches')
  lines.push('')
  lines.push(`- group.memory_batch: ${memoryBatches.length} (${memoryBatches.filter(entry => entry.fields.success === true).length} ok, ${memoryBatches.filter(entry => entry.fields.success === false).length} failed)`)
  for (const entry of memoryBatches) lines.push(`  - through ${entry.fields.through}: events ${entry.fields.events}, messages ${entry.fields.messages}, created ${entry.fields.memoriesCreated ?? 0}, closures accepted ${entry.fields.closuresAccepted ?? 0}, rejected ${entry.fields.closuresRejected ?? 0}, invalid citations ${entry.fields.invalidCitations ?? 0}, invalid atoms ${entry.fields.invalidAtoms ?? 0}, duplicates ${entry.fields.duplicates ?? 0}, ok ${entry.fields.success}`)
  lines.push(`- closures: accepted ${memoryBatchCounts(memoryBatches).accepted}; rejected ${memoryBatchCounts(memoryBatches).rejected}`)
  const invalidCitations = memoryValidation.reduce((sum, entry) => sum + Number(entry.fields.invalidCitations ?? 0), 0)
  const invalidAtoms = memoryValidation.reduce((sum, entry) => sum + Number(entry.fields.invalidAtoms ?? 0), 0)
  lines.push(`- validation totals: invalid citations ${invalidCitations}, invalid atoms ${invalidAtoms}`)
  const failed = postProcess.filter(record => !record.ok)
  lines.push(`- post-process jobs: ${postProcess.length} (${failed.length} failed)`)
  for (const record of failed) lines.push(`  - ${record.kind}: ${record.error}`)
  lines.push(`- group.summary_batch: ${summaryBatches.length}`)
  lines.push('')
  const drops = turnRagDrops()
  lines.push('## RAG results dropped by groupWriterMemory')
  lines.push('')
  lines.push(`- writer calls where at least one retrieved memory/thread was dropped: ${drops.callsWithDrops} of ${drops.calls} calls; ${drops.dropped} text(s) dropped in total`)
  lines.push('')
  lines.push('## Rewind')
  lines.push('')
  lines.push(`- watermarks before: ${JSON.stringify(input.watermarksBefore)}`)
  lines.push(`- watermarks after: ${JSON.stringify(input.watermarksAfter)}`)
  for (const check of input.rewind) lines.push(`- ${check.pass ? 'PASS' : 'FAIL'} ${check.name} — ${check.detail}`)
  if (input.reset) lines.push('', '## Reset', '', `- ${input.reset.pass ? 'PASS' : 'FAIL'} ${input.reset.name} — ${input.reset.detail}`)
  lines.push('')
  lines.push('## Safety')
  lines.push('')
  lines.push(`- provider requests actually sent: ${networkCalls}${DRY ? ' (a dry run must be 0)' : ''}`)
  lines.push(`- blocked hosts: ${blockedHosts.length ? [...new Set(blockedHosts)].join(', ') : 'none'}`)
  lines.push(`- fetch failures: ${fetchFailures.length}${fetchFailures.length ? ` — ${fetchFailures.slice(0, 3).map(failure => `${failure.turn}: ${failure.error}`).join('; ')}` : ''}`)
  lines.push(`- stops: ${stops.length ? stops.join('; ') : 'none'}`)
  lines.push(`- turn errors: ${errors.length ? errors.join('; ') : 'none'}`)
  if (notes.length) { lines.push('', '## Notes', ''); for (const note of notes) lines.push(`- ${note}`) }
  lines.push('')
  lines.push(`_Generated ${new Date().toISOString()}._`)
  return `${lines.join('\n')}\n`
}

function writeSummary(input: Parameters<typeof summaryMarkdown>[0]): void {
  writeFileSync(join(RUN_DIR, 'summary.md'), summaryMarkdown(input))
}

/** Pairs each writer call with the texts groupWriterMemory was handed. */
function turnRagDrops(): { calls: number; callsWithDrops: number; dropped: number } {
  let calls = 0, callsWithDrops = 0, dropped = 0
  for (const turn of turns) {
    const inputs = ragInputsByTurn.get(turn.label) ?? []
    const narration = turn.calls.filter(call => call.purpose === 'narration' || call.purpose === 'adult_narration')
    const paired = Math.min(inputs.length, narration.length)
    for (let index = 0; index < paired; index++) {
      calls += 1
      const handed = [...new Set(inputs[index])]
      const sections = narration[index].sections
      const shown = `${sections?.memories ?? ''}\n${sections?.openThreads ?? ''}`.toLowerCase()
      const lost = handed.filter(text => !shown.includes(norm(text)))
      if (lost.length) { callsWithDrops += 1; dropped += lost.length }
    }
  }
  return { calls, callsWithDrops, dropped }
}

// ---------------------------------------------------------------- main

await poisonEnv()
installMocks()
if (MODE === 'run' || MODE === 'dry') installFindHook()

if (MODE === 'selftest') {
  await selftest()
  cleanupInfra()
  process.exit(0)
} else if (MODE === 'plan') {
  printPlan()
  cleanupInfra()
  process.exit(0)
} else {
  if (DRY) console.log('dry rehearsal: every provider call is answered locally; nothing is spent and nothing is measured')
  let code = 1
  try {
    code = await runProbe()
  } catch (error) {
    console.error(`gc-1g-recall refused or failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    cleanupInfra()
  }
  process.exit(code)
}
