/**
 * Pure audit: the app's telemetry ingest (`everlore-docs/phases/analytics.md`
 * §3, §4.1–§4.5, §6).
 *
 * What this proves, in the terms the contract uses:
 *   - a batch is validated field by field, and nothing the player typed can
 *     reach a stored document (only a scrubbed exception message holds text);
 *   - the size cap beats the parser, and the event/error caps hold;
 *   - a resent batch writes nothing twice;
 *   - network drops, refused requests and failed images are counters, never
 *     groups, and a crash with no in-app frame still gets its own group;
 *   - a group survives an unrelated line shift, and a fix that did not hold
 *     comes back as `regressed`;
 *   - signing in links the install and back-fills the session once;
 *   - deleting an account removes its rows and leaves a shared install alone;
 *   - no unique key is ever written with a null (AGENTS.md §3).
 *
 * No Mongo and no Redis: `mongoColl` is an in-memory store that enforces the
 * unique indexes the way Mongo does (a missing key counts as null, so two rows
 * without their id collide exactly as they would in prod), `getRedisClient` is
 * a counting fake, and the optional-auth plugin is a header stand-in. The route
 * is mounted on a fresh Elysia and driven through `.handle()`, so the status
 * codes are the real ones.
 *
 * The scrubber, the classing and the fingerprint also run against mutated
 * copies of their own source at the end, so the audit fails if any of those
 * checks has stopped biting.
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObjectId } from 'mongodb'
import { Elysia } from 'elysia'

type Doc = Record<string, any>

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const marker = 'STORYTEXTMARKER'

// ─────────────────────────────────────────────────────────────────────────────
// An in-memory Mongo, honest about the two properties this audit leans on:
// unique indexes (non-sparse, so a missing key is a null) and upsert semantics.
// ─────────────────────────────────────────────────────────────────────────────

const COLL_NAMES = [
  'app_events',
  'app_sessions',
  'app_installs',
  'app_errors',
  'app_error_groups',
  'app_error_counters',
  'app_daily',
] as const
type CollName = (typeof COLL_NAMES)[number]

const store: Record<CollName, Doc[]> = {
  app_events: [],
  app_sessions: [],
  app_installs: [],
  app_errors: [],
  app_error_groups: [],
  app_error_counters: [],
  app_daily: [],
}

/** §6: the only unique keys in the telemetry collections. */
const UNIQUE_KEYS: Partial<Record<CollName, string[]>> = {
  app_events: ['event_id'],
  app_errors: ['error_id'],
}

class DuplicateKeyError extends Error {
  code = 11000
}

function clone<T>(value: T): T {
  if (value instanceof ObjectId) return new ObjectId(value.toHexString()) as unknown as T
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T
  if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Doc = {}
    for (const [key, inner] of Object.entries(value)) out[key] = clone(inner)
    return out as T
  }
  return value
}

function idKey(value: unknown): string {
  return value instanceof ObjectId ? value.toHexString() : String(value)
}

function getPath(doc: Doc, path: string): unknown {
  let current: any = doc
  for (const part of path.split('.')) {
    if (current === undefined || current === null) return undefined
    current = current[part]
  }
  return current
}

function setPath(doc: Doc, path: string, value: unknown): void {
  const parts = path.split('.')
  let current: Doc = doc
  for (const part of parts.slice(0, -1)) {
    if (typeof current[part] !== 'object' || current[part] === null) current[part] = {}
    current = current[part]
  }
  current[parts[parts.length - 1]] = value
}

function isOperator(cond: unknown): cond is Doc {
  return (
    !!cond &&
    typeof cond === 'object' &&
    !(cond instanceof ObjectId) &&
    !(cond instanceof Date) &&
    !Array.isArray(cond)
  )
}

function valueEquals(docValue: unknown, cond: unknown): boolean {
  // Mongo matches a scalar against any element of an array (multikey), and that
  // is how `user_ids: <id>` and the purge's `$pull` find their rows.
  if (Array.isArray(docValue) && !Array.isArray(cond)) {
    return docValue.some((item) => valueEquals(item, cond))
  }
  if (cond instanceof ObjectId) return docValue instanceof ObjectId && docValue.equals(cond)
  if (cond instanceof Date) return docValue instanceof Date && docValue.getTime() === cond.getTime()
  if (typeof cond === 'string' || typeof cond === 'number' || typeof cond === 'boolean') {
    return docValue === cond
  }
  return idKey(docValue) === idKey(cond)
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const value = getPath(doc, key)
    if (isOperator(cond)) {
      if ('$exists' in cond) return (value !== undefined) === cond.$exists
      if ('$in' in cond) return (cond.$in as unknown[]).some((c) => valueEquals(value, c))
      if ('$size' in cond) return Array.isArray(value) && value.length === cond.$size
      throw new Error(`telemetry audit: unsupported filter operator on ${key}`)
    }
    return valueEquals(value, cond)
  })
}

/** Mongo's unique index indexes a missing key as null; the literal-null rule follows. */
function assertIndexes(name: CollName, docs: Doc[]): void {
  const ids = new Set<string>()
  for (const doc of docs) {
    const key = idKey(doc._id)
    if (ids.has(key)) throw new DuplicateKeyError(`E11000 duplicate key: ${name}._id ${key}`)
    ids.add(key)
  }
  for (const field of UNIQUE_KEYS[name] ?? []) {
    const seen = new Set<string>()
    for (const doc of docs) {
      const value = getPath(doc, field)
      const key = value === undefined || value === null ? '<null>' : String(value)
      if (seen.has(key)) {
        throw new DuplicateKeyError(`E11000 duplicate key: ${name}.${field} ${key}`)
      }
      seen.add(key)
    }
  }
}

function compareValues(a: unknown, b: unknown): number {
  const left = a instanceof Date ? a.getTime() : a
  const right = b instanceof Date ? b.getTime() : b
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1
  }
  return String(left) === String(right) ? 0 : String(left) < String(right) ? -1 : 1
}

function applyUpdate(doc: Doc, update: Doc, isInsert: boolean): Doc {
  const next = clone(doc)
  if (isInsert) {
    for (const [key, value] of Object.entries((update.$setOnInsert ?? {}) as Doc)) {
      setPath(next, key, clone(value))
    }
  }
  for (const [key, value] of Object.entries((update.$set ?? {}) as Doc)) {
    setPath(next, key, clone(value))
  }
  for (const [key, value] of Object.entries((update.$inc ?? {}) as Doc)) {
    setPath(next, key, Number(getPath(next, key) ?? 0) + Number(value))
  }
  for (const [key, value] of Object.entries((update.$max ?? {}) as Doc)) {
    const current = getPath(next, key)
    if (current === undefined || compareValues(current, value) < 0) setPath(next, key, clone(value))
  }
  for (const [key, value] of Object.entries((update.$min ?? {}) as Doc)) {
    const current = getPath(next, key)
    if (current === undefined || compareValues(current, value) > 0) setPath(next, key, clone(value))
  }
  for (const [key, value] of Object.entries((update.$addToSet ?? {}) as Doc)) {
    const array = (getPath(next, key) as unknown[] | undefined) ?? []
    if (!array.some((item) => valueEquals(item, value))) setPath(next, key, [...array, clone(value)])
  }
  for (const [key, raw] of Object.entries((update.$push ?? {}) as Doc)) {
    const array = (getPath(next, key) as unknown[] | undefined) ?? []
    const each = isOperator(raw) && '$each' in raw ? (raw.$each as unknown[]) : [raw]
    const merged = [...array, ...each.map((item) => clone(item))]
    const slice = isOperator(raw) && typeof raw.$slice === 'number' ? raw.$slice : undefined
    setPath(next, key, slice === undefined ? merged : merged.slice(slice))
  }
  for (const [key, value] of Object.entries((update.$pull ?? {}) as Doc)) {
    const array = (getPath(next, key) as unknown[] | undefined) ?? []
    setPath(next, key, array.filter((item) => !valueEquals(item, value)))
  }
  return next
}

function seedFromFilter(filter: Doc): Doc {
  const seed: Doc = {}
  for (const [key, value] of Object.entries(filter)) {
    if (isOperator(value)) continue
    setPath(seed, key, clone(value))
  }
  return seed
}

function project(doc: Doc, projection?: Doc): Doc {
  if (!projection) return doc
  const out: Doc = {}
  for (const key of Object.keys(projection)) {
    if (projection[key] && Object.hasOwn(doc, key)) out[key] = doc[key]
  }
  return out
}

function fakeColl(name: CollName) {
  return {
    insertOne: async (doc: Doc) => {
      const next = clone(doc)
      if (next._id === undefined) next._id = new ObjectId()
      assertIndexes(name, [...store[name], next])
      store[name].push(next)
      return { acknowledged: true, insertedId: next._id }
    },
    findOne: async (filter: Doc, opts: { projection?: Doc } = {}) => {
      const found = store[name].find((doc) => matches(doc, filter))
      return found ? project(clone(found), opts.projection) : null
    },
    find: (filter: Doc, opts: { projection?: Doc } = {}) => ({
      toArray: async () =>
        store[name]
          .filter((doc) => matches(doc, filter))
          .map((doc) => project(clone(doc), opts.projection)),
    }),
    updateOne: async (filter: Doc, update: Doc, opts: { upsert?: boolean } = {}) => {
      const index = store[name].findIndex((doc) => matches(doc, filter))
      if (index >= 0) {
        const next = store[name].slice()
        next[index] = applyUpdate(store[name][index], update, false)
        assertIndexes(name, next)
        store[name] = next
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
      }
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
      const inserted = applyUpdate(seedFromFilter(filter), update, true)
      if (inserted._id === undefined) inserted._id = new ObjectId()
      assertIndexes(name, [...store[name], inserted])
      store[name].push(inserted)
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
    },
    updateMany: async (filter: Doc, update: Doc) => {
      const next = store[name].map((doc) => (matches(doc, filter) ? applyUpdate(doc, update, false) : doc))
      assertIndexes(name, next)
      store[name] = next
      return { matchedCount: next.length, modifiedCount: next.length }
    },
    deleteMany: async (filter: Doc) => {
      const kept = store[name].filter((doc) => !matches(doc, filter))
      const deleted = store[name].length - kept.length
      store[name] = kept
      return { deletedCount: deleted }
    },
  }
}

function reset(): void {
  for (const name of COLL_NAMES) store[name] = []
  redisData.clear()
}

const docs = (name: CollName): Doc[] => store[name].map((doc) => clone(doc))

// ─────────────────────────────────────────────────────────────────────────────
// Fakes for everything the route touches that is not the code under test.
// ─────────────────────────────────────────────────────────────────────────────

const redisData = new Map<string, { value: number; expiresAt: number }>()
const fakeRedis = {
  incr: async (key: string) => {
    const entry = redisData.get(key) ?? { value: 0, expiresAt: 0 }
    entry.value += 1
    redisData.set(key, entry)
    return entry.value
  },
  expire: async (key: string, seconds: number) => {
    const entry = redisData.get(key)
    if (entry) entry.expiresAt = Date.now() + seconds * 1000
    return 1
  },
  ttl: async (key: string) => {
    const entry = redisData.get(key)
    if (!entry || entry.expiresAt === 0) return -1
    return Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000))
  },
  get: async (key: string) => String(redisData.get(key)?.value ?? 0),
}

/** Stands in for the JWT plugin: a request is signed in when it says who it is. */
const auditAuthPlugin = new Elysia({ name: 'telemetry-audit-auth' }).derive(
  { as: 'global' },
  ({ headers }) => ({
    user: headers['x-audit-user']
      ? { id: headers['x-audit-user'], email: '', username: '', tier: 'free' }
      : null,
  }),
)

const silentLog = { info() {}, warn() {}, error() {} }

mock.module('../src/config/env', () => ({
  env: { CHAT_RATE_MAX: 60, TEMPLATE_CREATE_RATE_MAX: 5, DISABLE_OTP_RATE_LIMIT: false },
}))
mock.module('../src/config/redis', () => ({ getRedisClient: () => fakeRedis }))
mock.module('../src/utils/logger', () => ({ log: silentLog }))
mock.module('../src/middleware/auth', () => ({ authPlugin: auditAuthPlugin }))
mock.module('../src/config/mongo', () => ({
  mongoColl: {
    appEvents: () => fakeColl('app_events'),
    appSessions: () => fakeColl('app_sessions'),
    appInstalls: () => fakeColl('app_installs'),
    appErrors: () => fakeColl('app_errors'),
    appErrorGroups: () => fakeColl('app_error_groups'),
    appErrorCounters: () => fakeColl('app_error_counters'),
    appDaily: () => fakeColl('app_daily'),
  },
}))

const { telemetryRoutes } = (await import('../src/routes/telemetry.routes')) as typeof import('../src/routes/telemetry.routes')
const { scrubMessage } = (await import('../src/services/telemetry/scrub')) as typeof import('../src/services/telemetry/scrub')
const { classifyError } = (await import('../src/services/telemetry/classify')) as typeof import('../src/services/telemetry/classify')
const { fingerprintError } = (await import('../src/services/telemetry/fingerprint')) as typeof import('../src/services/telemetry/fingerprint')
const { telemetryService } = (await import('../src/services/telemetry/ingest.service')) as typeof import('../src/services/telemetry/ingest.service')

const app = new Elysia().use(telemetryRoutes)

type Reply = { status: number; body: any; headers: Headers }

async function post(payload: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return postRaw(typeof payload === 'string' ? payload : JSON.stringify(payload), headers)
}

async function postRaw(raw: string, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await app.handle(
    new Request('http://localhost/app/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    }),
  )
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body, headers: response.headers }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const now = Date.now()
const iso = (offsetMs = 0): string => new Date(now + offsetMs).toISOString()
const INSTALL = '11111111-1111-4111-8111-111111111111'
const SESSION = '22222222-2222-4222-8222-222222222222'
const USER_A = '64b7f0c2a1b2c3d4e5f60718'
const USER_B = '64b7f0c2a1b2c3d4e5f60719'

let idSeq = 0
function uuid(): string {
  idSeq += 1
  return `00000000-0000-4000-8000-${String(idSeq).padStart(12, '0')}`
}

const DEVICE = {
  os: 'android',
  os_version: '35',
  model: 'SM-A155F',
  form: 'phone',
  locale: 'en-IN',
}
const APP = { version: '1.0.11', build: 14 }

function envelope(overrides: Doc = {}): Doc {
  return {
    install_id: INSTALL,
    session_id: SESSION,
    app: { ...APP },
    device: { ...DEVICE },
    sent_at: iso(),
    events: [],
    errors: [],
    ...overrides,
  }
}

function event(name: string, props?: Doc, extra: Doc = {}): Doc {
  return {
    id: uuid(),
    seq: 1,
    at: iso(-60_000),
    name,
    ...(props ? { props } : {}),
    ...extra,
  }
}

function errorSample(extra: Doc = {}): Doc {
  return {
    id: uuid(),
    at: iso(-60_000),
    source: 'handled',
    fatal: false,
    type: 'StateError',
    message: 'Bad state: No element',
    frames: [],
    ...extra,
  }
}

const IN_APP_FRAMES = [
  { file: 'package:everlore/features/play/state/play_cubit.dart', symbol: 'PlayCubit._onFrame', line: 412 },
  { file: 'package:everlore/features/play/state/play_cubit.dart', symbol: 'PlayCubit.load', line: 98 },
]

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let failures = 0
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}: ${(error as Error).message}`)
  }
}

function assertKeys(doc: Doc, allowed: readonly string[], where: string): void {
  const extra = Object.keys(doc).filter((key) => !allowed.includes(key))
  assert.deepEqual(extra, [], `${where} kept keys it should not: ${extra.join(', ')}`)
}

function assertNoNullish(value: unknown, path: string): void {
  assert.notEqual(value, null, `explicit null at ${path}`)
  assert.notEqual(value, undefined, `explicit undefined at ${path}`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNullish(item, `${path}[${index}]`))
    return
  }
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof ObjectId)) {
    for (const [key, inner] of Object.entries(value)) assertNoNullish(inner, `${path}.${key}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.1 — the route itself
// ─────────────────────────────────────────────────────────────────────────────

await check('§4.1: 202 and a kept count; bad items are dropped, the batch is not', async () => {
  reset()
  const reply = await post(
    envelope({
      events: [
        event('screen_view', { screen: 'discover', duration_ms: 41230, from: 'home' }),
        event('turn_sent', { input: 'typed', text: marker }),
        event('search', { query: marker }),
        event('screen_view', { screen: 'discover', duration_ms: '41230' }),
        event('world_viewed', { world_id: 'not-an-id' }),
        event('first_open'),
      ],
      errors: [
        errorSample({
          source: 'flutter',
          type: 'StateError',
          message: `Could not parse "${marker}" for user@example.com`,
          frames: IN_APP_FRAMES,
          screen: 'play',
        }),
        errorSample({ source: 'handled', type: 'BadResponse', http: { status: 401, route: '/auth/otp/verify' } }),
        errorSample({ source: 'handled', type: 'SocketException', message: 'Connection refused' }),
      ],
    }),
  )

  assert.equal(reply.status, 202)
  // 3 of 6 events (unknown name, wrong type, bad world id dropped) + 3 errors.
  assert.equal(reply.body.accepted, 6)

  const events = docs('app_events')
  assert.equal(events.length, 3)
  const names = events.map((doc) => doc.name).sort()
  assert.deepEqual(names, ['first_open', 'screen_view', 'turn_sent'])

  const turn = events.find((doc) => doc.name === 'turn_sent')!
  assert.deepEqual(turn.props, { input: 'typed' }, 'an unknown prop key must be dropped, not stored')

  assert.equal(docs('app_errors').length, 1, 'only a group class is stored as a sample')
  assert.equal(docs('app_error_groups').length, 1)
  assert.deepEqual(
    docs('app_error_counters').map((doc) => doc.class).sort(),
    ['expected_4xx', 'offline'],
    '4xx and offline are counters, never samples or groups',
  )
})

await check('§4.1: a well-formed batch with nothing valid still answers 202 {accepted: 0}', async () => {
  reset()
  const reply = await post(envelope({ events: [event('search', { query: marker })] }))
  assert.equal(reply.status, 202)
  assert.equal(reply.body.accepted, 0)
  assert.equal(docs('app_events').length, 0)
})

await check('§4.1: an unparseable body is 400 and an over-sized one is 413 with nothing kept', async () => {
  reset()
  const garbage = await postRaw('{"install_id":')
  assert.equal(garbage.status, 400)

  const notABatch = await post({ hello: 'world' })
  assert.equal(notABatch.status, 400)

  const tooBig = await postRaw(
    `${JSON.stringify(envelope()).slice(0, -1)},"pad":"${'x'.repeat(70_000)}"}`,
  )
  assert.equal(tooBig.status, 413, 'the 64 KB cap must beat the parser')
  assert.equal(docs('app_events').length, 0)

  const declaredBig = await post('{}', { 'content-length': String(70_000) })
  assert.equal(declaredBig.status, 413, 'a declared over-size body is refused before it is read')
})

// ─────────────────────────────────────────────────────────────────────────────
// §9 — no free text, no unexpected keys
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_KEYS = [
  '_id', 'event_id', 'install_id', 'user_id', 'session_id', 'name', 'screen', 'duration_ms',
  'props', 'seq', 'at', 'received_at', 'app_version', 'build', 'device',
] as const
const ERROR_KEYS = [
  '_id', 'error_id', 'install_id', 'user_id', 'session_id', 'fingerprint', 'class', 'source',
  'fatal', 'type', 'message', 'frames', 'screen', 'http', 'breadcrumbs', 'at',
  'received_at', 'app_version', 'build', 'device',
] as const

await check('§9: a batch stuffed with extra string fields stores none of them', async () => {
  reset()
  const reply = await post(
    envelope({
      note: marker,
      events: [
        event('screen_view', { screen: 'discover', duration_ms: 1000 }, { text: marker }),
        event('turn_sent', { input: 'typed', caption: marker }),
      ],
      errors: [
        errorSample({
          source: 'flutter',
          extra: marker,
          message: `Illegal argument "${marker}"`,
          frames: [{ ...IN_APP_FRAMES[0], source: marker }],
          breadcrumbs: [{ at: iso(-90_000), kind: 'action', name: 'turn_sent', text: marker }],
          http: { status: 502, route: '/instances/:id/choices', body: marker },
        }),
      ],
    }),
  )
  assert.equal(reply.status, 202)

  const blob = JSON.stringify(store)
  assert.ok(!blob.includes(marker), 'player text reached a stored document')

  const [screen] = docs('app_events').filter((doc) => doc.name === 'screen_view')
  assertKeys(screen, EVENT_KEYS, 'app_events')
  assertKeys(screen.device, ['os', 'os_version', 'model', 'form', 'locale'], 'device')
  assertKeys(screen.props, ['screen', 'duration_ms', 'from'], 'props')

  const [sample] = docs('app_errors')
  assertKeys(sample, ERROR_KEYS, 'app_errors')
  assertKeys(sample.frames[0], ['file', 'symbol', 'line'], 'frames')
  assertKeys(sample.breadcrumbs[0], ['at', 'kind', 'name'], 'breadcrumbs')
  assertKeys(sample.http, ['status', 'route'], 'http')

  const group = docs('app_error_groups')[0]
  assertKeys(group, ['_id', 'class', 'category', 'type', 'title', 'top_frame', 'status', 'first_seen', 'last_seen', 'count', 'versions'], 'app_error_groups')
  assertKeys(docs('app_sessions')[0], ['_id', 'install_id', 'user_id', 'started_at', 'last_at', 'app_version', 'build', 'device', 'screen_path', 'counts'], 'app_sessions')
  assertKeys(docs('app_installs')[0], ['_id', 'first_seen', 'last_seen', 'first_version', 'build', 'device', 'user_ids'], 'app_installs')
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.1 / §4.4 — caps
// ─────────────────────────────────────────────────────────────────────────────

await check('§4.1: at most 100 events and 10 errors per batch', async () => {
  reset()
  const manyEvents = await post(
    envelope({ events: Array.from({ length: 150 }, () => event('first_open')) }),
    { 'x-audit-user': USER_A },
  )
  assert.equal(manyEvents.status, 202)
  assert.equal(manyEvents.body.accepted, 100)
  assert.equal(docs('app_events').length, 100)

  reset()
  const manyErrors = await post(
    envelope({ errors: Array.from({ length: 15 }, () => errorSample({ source: 'flutter' })) }),
    { 'x-audit-user': USER_A },
  )
  assert.equal(manyErrors.body.accepted, 10)
  assert.equal(docs('app_errors').length, 10)
  assert.equal(docs('app_error_groups')[0].count, 10)
})

await check('§4.1: a required prop, a bad id, or a timestamp outside the window drops the item', async () => {
  reset()
  const reply = await post(
    envelope({
      events: [
        event('screen_view', { screen: 'discover' }),
        event('world_viewed', {}),
        event('first_open', undefined, { at: iso(-8 * 24 * 60 * 60 * 1000) }),
        event('first_open', undefined, { at: iso(11 * 60 * 1000) }),
        event('first_open', undefined, { seq: -1 }),
        event('first_open', undefined, { id: 'not-a-uuid' }),
        event('first_open', undefined, { at: iso(5 * 60 * 1000) }),
      ],
    }),
  )
  assert.equal(reply.status, 202)
  assert.equal(reply.body.accepted, 1, 'only the well-formed item survives')
  assert.equal(docs('app_events').length, 1)
})

await check('§4.4: an unauthenticated batch may carry at most 20 events', async () => {
  reset()
  const reply = await post(envelope({ events: Array.from({ length: 30 }, () => event('first_open')) }))
  assert.equal(reply.body.accepted, 20)
  assert.equal(docs('app_events').length, 20)
})

await check('§4.4: 60 batches per install in 10 minutes, then 429 with Retry-After', async () => {
  reset()
  const headers = { 'x-forwarded-for': '10.0.0.1' }
  let last: Reply | undefined
  for (let i = 0; i < 61; i++) {
    last = await post(envelope({ install_id: INSTALL, events: [] }), headers)
  }
  assert.equal(last!.status, 429)
  assert.ok(Number(last!.headers.get('retry-after')) > 0, 'a 429 must say when to come back')
  assert.ok(
    !JSON.stringify(store).includes('10.0.0.1'),
    'the address may be spent on the limit but never stored (§4.4)',
  )
})

await check('§4.4: 300 batches per address in 10 minutes, then 429', async () => {
  reset()
  const headers = { 'x-forwarded-for': '10.0.0.2' }
  let last: Reply | undefined
  for (let i = 0; i < 301; i++) {
    last = await post(envelope({ install_id: uuid(), session_id: uuid(), events: [] }), headers)
  }
  assert.equal(last!.status, 429)
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.1 — idempotency
// ─────────────────────────────────────────────────────────────────────────────

await check('§4.1: a resent batch inserts nothing twice and counts nothing twice', async () => {
  reset()
  const batch = envelope({
    events: [event('first_open'), event('screen_view', { screen: 'discover', duration_ms: 5000 })],
    errors: [errorSample({ source: 'flutter', frames: IN_APP_FRAMES })],
    app: { version: '1.0.11', build: 14 },
  })

  const first = await post(batch, { 'x-audit-user': USER_A })
  assert.equal(first.body.accepted, 3)
  const second = await post(batch, { 'x-audit-user': USER_A })
  assert.equal(second.status, 202)
  assert.equal(second.body.accepted, 0, 'a duplicate item was counted as accepted')

  assert.equal(docs('app_events').length, 2)
  assert.equal(docs('app_errors').length, 1)
  assert.equal(docs('app_error_groups')[0].count, 1)
  const session = docs('app_sessions')[0]
  assert.deepEqual(session.counts, { events: 2, errors: 1, actions: 0 })
  assert.equal(session.screen_path.length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.3 — the scrubber (also run against a mutant, below)
// ─────────────────────────────────────────────────────────────────────────────

function assertScrubber(scrub: (raw: string) => string): void {
  assert.equal(scrub('Bad state: No element'), 'Bad state: No element')
  assert.equal(scrub('Could not parse "the moon was full"'), "Could not parse '…'")
  assert.equal(scrub("said 'hello there' twice"), "said '…' twice")
  assert.equal(scrub('contact user@example.com now'), 'contact <email> now')
  assert.equal(scrub('waited 1234567 ms'), 'waited <n> ms')
  assert.equal(scrub('id 0123456789abcdef01234567'), 'id <id>')
  assert.equal(scrub('id 012345678901234567890123'), 'id <id>')
  assert.equal(scrub('GET https://api.test/search?q=moon&page=2'), 'GET https://api.test/search?…')
  assert.equal(scrub("don't stop"), "don't stop", 'an apostrophe is not a quote')
  assert.equal(scrub('x'.repeat(400)).length, 300)
}

await check('§4.3: the scrubber keeps the shape and loses the particulars', () => {
  assertScrubber(scrubMessage)
})

await check('§4.3: a stored error message is scrubbed and its group title is that message', async () => {
  reset()
  await post(
    envelope({
      errors: [
        errorSample({
          source: 'flutter',
          message: `Could not parse "the moon was full and she said" from token 123456789`,
          frames: IN_APP_FRAMES,
        }),
      ],
    }),
  )
  const [sample] = docs('app_errors')
  assert.equal(sample.message, "Could not parse '…' from token <n>")
  assert.equal(docs('app_error_groups')[0].title, "Could not parse '…' from token <n>")
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.5 — classing (also run against a mutant, below)
// ─────────────────────────────────────────────────────────────────────────────

function assertClassing(classify: (error: any) => string): void {
  assert.equal(classify({ fatal: true, source: 'handled', type: 'StateError' }), 'crash')
  assert.equal(classify({ fatal: false, source: 'flutter', type: 'StateError' }), 'crash')
  assert.equal(classify({ fatal: false, source: 'platform', type: 'StateError' }), 'crash')
  assert.equal(classify({ fatal: false, source: 'zone', type: 'StateError' }), 'crash')
  assert.equal(classify({ fatal: false, source: 'handled', type: 'StateError' }), 'handled_bug')
  assert.equal(
    classify({ fatal: false, source: 'handled', type: 'StateError', http: { status: 502 } }),
    'server_5xx',
  )
  assert.equal(
    classify({ fatal: false, source: 'handled', type: 'StateError', http: { status: 401 } }),
    'expected_4xx',
  )
  assert.equal(classify({ fatal: false, source: 'handled', type: 'SocketException' }), 'offline')
  assert.equal(classify({ fatal: false, source: 'flutter', type: 'SocketException' }), 'offline')
  assert.equal(
    classify({ fatal: false, source: 'flutter', type: 'NetworkImageLoadException' }),
    'image_load',
  )
}

await check('§4.5: every class comes from type, source and http — never from text', () => {
  assertClassing(classifyError)
})

await check('§4.5: a 5xx groups by route and status; a 4xx and an offline drop never do', async () => {
  reset()
  await post(
    envelope({
      errors: [
        errorSample({ source: 'handled', type: 'BadResponse', http: { status: 502, route: '/instances/:id/choices' } }),
        errorSample({ source: 'handled', type: 'BadResponse', http: { status: 502, route: '/instances/:id/choices' } }),
        errorSample({ source: 'handled', type: 'BadRequest', http: { status: 422, route: '/worlds' } }),
        errorSample({ source: 'handled', type: 'SocketException' }),
        errorSample({ source: 'flutter', type: 'NetworkImageLoadException', screen: 'discover' }),
      ],
    }),
  )

  const groups = docs('app_error_groups')
  assert.equal(groups.length, 1, 'only the server fault is worth a group')
  assert.equal(groups[0].class, 'server_5xx')
  assert.equal(groups[0].category, 'Our server failed a request')
  assert.equal(groups[0].top_frame, '/instances/:id/choices · 502')
  assert.equal(groups[0].count, 2)

  const counters = docs('app_error_counters')
  assert.deepEqual(
    counters.map((doc) => doc.class).sort(),
    ['expected_4xx', 'image_load', 'offline'],
  )
  const refused = counters.find((doc) => doc.class === 'expected_4xx')!
  assert.equal(refused.route, '/worlds')
  assert.equal(refused.status, 422)
  const image = counters.find((doc) => doc.class === 'image_load')!
  assert.equal(image.screen, 'discover')
})

// ─────────────────────────────────────────────────────────────────────────────
// §2.8 — the fingerprint (also run against a mutant, below)
// ─────────────────────────────────────────────────────────────────────────────

function assertFingerprint(fp: (error: any, cls: string) => string): void {
  const base = { type: 'StateError', frames: IN_APP_FRAMES }
  const shifted = {
    type: 'StateError',
    frames: IN_APP_FRAMES.map((frame) => ({ ...frame, line: frame.line + 17 })),
  }
  assert.equal(fp(base, 'crash'), fp(shifted, 'crash'), 'a line shift must not split a group')

  const moved = { type: 'StateError', frames: [{ ...IN_APP_FRAMES[0], symbol: 'PlayCubit.other' }, IN_APP_FRAMES[1]] }
  assert.notEqual(fp(base, 'crash'), fp(moved, 'crash'), 'a different top frame is a different error')

  const typed = { type: 'TypeError', frames: IN_APP_FRAMES }
  assert.notEqual(fp(base, 'crash'), fp(typed, 'crash'))

  // Only the top three in-app frames count.
  const deep = {
    type: 'StateError',
    frames: [
      ...IN_APP_FRAMES,
      { file: 'package:everlore/a.dart', symbol: 'A.a', line: 1 },
      { file: 'package:everlore/b.dart', symbol: 'B.b', line: 2 },
    ],
  }
  const deeper = {
    type: 'StateError',
    frames: [
      ...IN_APP_FRAMES,
      { file: 'package:everlore/a.dart', symbol: 'A.a', line: 1 },
      { file: 'package:everlore/c.dart', symbol: 'C.c', line: 3 },
    ],
  }
  assert.equal(fp(deep, 'crash'), fp(deeper, 'crash'), 'the fourth in-app frame is not part of the key')

  // No in-app frame: the top three of any package, so two plugin errors stay apart.
  const plugin = { type: 'StateError', frames: [{ file: 'package:flutter/framework.dart', symbol: 'A.b', line: 1 }] }
  const plugin2 = { type: 'StateError', frames: [{ file: 'package:flutter/framework.dart', symbol: 'A.c', line: 1 }] }
  assert.notEqual(fp(plugin, 'crash'), fp(plugin2, 'crash'))

  // A server fault is keyed by what the player saw, not by Dart frames.
  const asServer = (status: number, frames: any[]) => ({ type: 'BadResponse', frames, http: { route: '/x', status } })
  assert.equal(fp(asServer(502, IN_APP_FRAMES), 'server_5xx'), fp(asServer(502, []), 'server_5xx'))
  assert.notEqual(fp(asServer(502, IN_APP_FRAMES), 'server_5xx'), fp(asServer(503, IN_APP_FRAMES), 'server_5xx'))
}

await check('§2.8: the fingerprint keys the type and the top in-app frames, without lines', () => {
  assertFingerprint(fingerprintError)
})

await check('§2.8: a crash outside our code, and a line shift, still land on one group', async () => {
  reset()
  const outside = { file: 'package:flutter/src/widgets/framework.dart', symbol: 'RenderObject.layout', line: 10 }
  // Different messages on purpose: the fingerprint must not look at them (§4.3).
  const samples = [
    errorSample({ source: 'flutter', frames: [outside], message: 'Bad state: No element' }),
    errorSample({ source: 'flutter', frames: [{ ...outside, line: 99 }], message: 'Another wording entirely' }),
    errorSample({ source: 'flutter', frames: IN_APP_FRAMES, message: 'Bad state: No element' }),
    errorSample({ source: 'flutter', frames: [{ ...IN_APP_FRAMES[0], line: 900 }, IN_APP_FRAMES[1]], message: 'third message' }),
  ]
  for (const sample of samples) {
    await post(envelope({ errors: [sample], app: { version: '1.0.11', build: 14 } }))
  }

  const groups = docs('app_error_groups')
  assert.equal(groups.length, 2, 'four samples with two shapes must make two groups')
  assert.deepEqual(groups.map((group) => group.count).sort(), [2, 2])
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.2 — installs, sessions, back-fill
// ─────────────────────────────────────────────────────────────────────────────

await check('§4.2: signing in links the install and back-fills the session once', async () => {
  reset()
  const install = uuid()
  const session = uuid()

  const before = await post(
    envelope({
      install_id: install,
      session_id: session,
      events: [event('first_open'), event('screen_view', { screen: 'welcome', duration_ms: 4000 })],
    }),
  )
  assert.equal(before.status, 202)
  assert.ok(docs('app_events').every((doc) => doc.user_id === undefined), 'a signed-out event has no user')
  assert.equal(docs('app_installs')[0].user_ids, undefined, 'an install that never signed in has no user_ids key')

  const signedIn = await post(
    envelope({ install_id: install, session_id: session, events: [event('sign_in_completed', { method: 'google' })] }),
    { 'x-audit-user': USER_A },
  )
  assert.equal(signedIn.body.accepted, 1)

  const events = docs('app_events')
  assert.equal(events.length, 3)
  assert.ok(
    events.every((doc) => doc.user_id instanceof ObjectId && doc.user_id.toHexString() === USER_A),
    'the session before sign-in was not back-filled',
  )
  assert.equal(docs('app_sessions')[0].user_id.toHexString(), USER_A)
  assert.deepEqual(docs('app_installs')[0].user_ids.map((id: ObjectId) => id.toHexString()), [USER_A])

  // A second account on the same phone: its own session, its own events, and the
  // first account's history untouched.
  const other = uuid()
  await post(
    envelope({
      install_id: install,
      session_id: other,
      events: [event('sign_in_completed', { method: 'phone' })],
    }),
    { 'x-audit-user': USER_B },
  )

  const after = docs('app_events')
  assert.equal(after.filter((doc) => doc.user_id?.toHexString() === USER_A).length, 3)
  assert.equal(after.filter((doc) => doc.user_id?.toHexString() === USER_B).length, 1)
  assert.deepEqual(
    docs('app_installs')[0].user_ids.map((id: ObjectId) => id.toHexString()).sort(),
    [USER_A, USER_B].sort(),
    'an install holds every account that used it',
  )

  // Re-signing in as the same user must not duplicate the link.
  await post(
    envelope({ install_id: install, session_id: session, events: [event('session_start', { launch: 'cold' })] }),
    { 'x-audit-user': USER_A },
  )
  assert.equal(docs('app_installs')[0].user_ids.length, 2)
})

await check('§6: the session keeps its screen path, counts and last-seen', async () => {
  reset()
  await post(
    envelope({
      events: [
        event('session_start', { launch: 'cold' }),
        event('screen_view', { screen: 'discover', duration_ms: 41_230 }),
        event('screen_view', { screen: 'play', duration_ms: 2000, partial: true }),
        event('turn_sent', { input: 'typed' }),
      ],
    }),
  )

  const [session] = docs('app_sessions')
  assert.equal(session._id, SESSION)
  assert.equal(session.install_id, INSTALL)
  assert.deepEqual(session.counts, { events: 4, errors: 0, actions: 1 })
  assert.deepEqual(
    session.screen_path.map((step: Doc) => step.screen),
    ['discover', 'play'],
  )
  assert.equal(session.screen_path[1].partial, true)
  assert.ok(session.last_at >= session.started_at)
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.5a — status, regression, ignored
// ─────────────────────────────────────────────────────────────────────────────

await check('§4.5a: a new group starts unverified; a newer version regresses a resolved one', async () => {
  reset()
  const sample = () => errorSample({ source: 'flutter', frames: IN_APP_FRAMES, message: 'Bad state: No element' })

  await post(envelope({ errors: [sample()], app: { version: '1.0.11', build: 14 } }))
  const created = docs('app_error_groups')[0]
  assert.equal(created.status, 'new')
  assert.equal(created.category, 'The app crashed')
  assert.equal(created.type, 'StateError')

  // The admin resolves it in 1.0.11 (the PATCH is a later task; the rule is here).
  store.app_error_groups[0].status = 'resolved'
  store.app_error_groups[0].resolved_in_version = '1.0.11'

  await post(envelope({ errors: [sample()], app: { version: '1.0.11', build: 14 } }))
  assert.equal(docs('app_error_groups')[0].status, 'resolved', 'the same version did not regress it')

  await post(envelope({ errors: [sample()], app: { version: '1.0.12', build: 15 } }))
  const regressed = docs('app_error_groups')[0]
  assert.equal(regressed.status, 'regressed')
  assert.equal(regressed.count, 3)

  // Ignored keeps counting and stays ignored.
  store.app_error_groups[0].status = 'ignored'
  await post(envelope({ errors: [sample()], app: { version: '1.0.12', build: 15 } }))
  const ignored = docs('app_error_groups')[0]
  assert.equal(ignored.status, 'ignored')
  assert.equal(ignored.count, 4)
})

await check('§6: per-version counts use a dot-free field name', async () => {
  reset()
  await post(envelope({ errors: [errorSample({ source: 'flutter', frames: IN_APP_FRAMES })], app: { version: '1.0.11', build: 14 } }))
  await post(envelope({ errors: [errorSample({ source: 'flutter', frames: IN_APP_FRAMES })], app: { version: '1.0.12', build: 15 } }))
  const [group] = docs('app_error_groups')
  assert.deepEqual(group.versions, { '1_0_11': 1, '1_0_12': 1 })
})

// ─────────────────────────────────────────────────────────────────────────────
// §6 — account deletion
// ─────────────────────────────────────────────────────────────────────────────

await check('§6: deleting an account removes its rows and leaves a shared install alone', async () => {
  reset()
  const shared = uuid()
  const own = uuid()
  const uidA = new ObjectId(USER_A)
  const uidB = new ObjectId(USER_B)

  await fakeColl('app_installs').insertOne({ _id: shared, first_seen: new Date(), last_seen: new Date(), first_version: '1.0.11', build: 14, device: DEVICE, user_ids: [uidA, uidB] })
  await fakeColl('app_installs').insertOne({ _id: own, first_seen: new Date(), last_seen: new Date(), first_version: '1.0.11', build: 14, device: DEVICE, user_ids: [uidA] })
  await fakeColl('app_installs').insertOne({ _id: uuid(), first_seen: new Date(), last_seen: new Date(), first_version: '1.0.11', build: 14, device: DEVICE })
  for (const [userId, install] of [[uidA, shared], [uidB, shared], [uidA, own]] as const) {
    await fakeColl('app_events').insertOne({
      event_id: uuid(), install_id: install, user_id: userId, session_id: uuid(), name: 'first_open',
      seq: 1, at: new Date(), received_at: new Date(), app_version: '1.0.11', build: 14, device: DEVICE,
    })
    await fakeColl('app_sessions').insertOne({
      _id: uuid(), install_id: install, user_id: userId, started_at: new Date(), last_at: new Date(),
      app_version: '1.0.11', build: 14, device: DEVICE, counts: { events: 1, errors: 0, actions: 0 },
    })
  }
  await fakeColl('app_errors').insertOne({
    error_id: uuid(), install_id: own, user_id: uidA, session_id: uuid(), fingerprint: 'f', class: 'crash',
    source: 'flutter', fatal: true, type: 'StateError', frames: [], breadcrumbs: [], at: new Date(),
    received_at: new Date(), app_version: '1.0.11', build: 14, device: DEVICE,
  })
  await fakeColl('app_error_groups').insertOne({
    _id: 'f', class: 'crash', category: 'The app crashed', type: 'StateError', title: 't', status: 'new',
    first_seen: new Date(), last_seen: new Date(), count: 1,
  })

  await telemetryService.purgeUser(USER_A)

  assert.equal(docs('app_events').filter((doc) => doc.user_id?.toHexString() === USER_A).length, 0)
  assert.equal(docs('app_sessions').filter((doc) => doc.user_id?.toHexString() === USER_A).length, 0)
  assert.equal(docs('app_errors').length, 0)
  assert.equal(docs('app_events').length, 1, "the other account's event must survive")

  const installs = docs('app_installs')
  const sharedRow = installs.find((doc) => String(doc._id) === shared)!
  assert.deepEqual(sharedRow.user_ids.map((id: ObjectId) => id.toHexString()), [USER_B], 'a shared install loses only that id')
  assert.equal(installs.find((doc) => String(doc._id) === own), undefined, "the account's own install is gone")
  assert.equal(installs.filter((doc) => doc.user_ids === undefined).length, 1, 'an install that never signed in stays')

  // Groups and counters hold counts, not people.
  assert.equal(docs('app_error_groups').length, 1)
})

await check('§6: account deletion actually calls the telemetry purge', () => {
  const source = readFileSync(join(root, 'src/services/deletion.service.ts'), 'utf8')
  const start = source.indexOf('async deleteAccount(')
  assert.ok(start > 0, 'deleteAccount not found')
  const body = source.slice(start)
  assert.ok(
    body.includes('telemetryService.purgeUser(userId)'),
    'deleteAccount must purge telemetry before the user document goes',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// §3 / §6 — literal nulls and unique keys
// ─────────────────────────────────────────────────────────────────────────────

await check('AGENTS §3: no telemetry row is ever written with a null or undefined', async () => {
  reset()
  await post(
    envelope({
      events: [
        event('first_open'),
        event('screen_view', { screen: 'discover', duration_ms: 41230 }),
        event('turn_sent', { input: 'typed' }),
      ],
      errors: [
        errorSample({ source: 'flutter', frames: IN_APP_FRAMES }),
        errorSample({ source: 'handled', type: 'BadResponse', http: { status: 401, route: '/auth/otp/verify' } }),
        errorSample({ source: 'handled', type: 'SocketException' }),
        errorSample({ source: 'flutter', type: 'NetworkImageLoadException', screen: 'discover' }),
      ],
    }),
    { 'x-audit-user': USER_A },
  )

  for (const name of COLL_NAMES) {
    for (const doc of store[name]) assertNoNullish(doc, `${name}[${idKey(doc._id)}]`)
  }
  for (const doc of docs('app_events')) assert.ok(typeof doc.event_id === 'string')
  for (const doc of docs('app_errors')) assert.ok(typeof doc.error_id === 'string')
  for (const doc of docs('app_error_counters')) assert.ok(typeof doc._id === 'string')
})

// ─────────────────────────────────────────────────────────────────────────────
// The audit bites: run the pure checks against mutated copies of the real code.
// ─────────────────────────────────────────────────────────────────────────────

const mutantsDir = mkdtempSync(join(tmpdir(), 'telemetry-audit-'))
try {
  const mutant = async (source: string, from: string, to: string, label: string): Promise<any> => {
    const original = readFileSync(join(root, 'src/services/telemetry', source), 'utf8')
    assert.equal(
      original.split(from).length,
      2,
      `mutation anchor for ${label} not found exactly once; update this audit with the code`,
    )
    const file = join(mutantsDir, `${label}.ts`)
    writeFileSync(file, original.replace(from, to))
    return import(file)
  }

  await check('bites: without the quoted-run collapse, the scrubber check fails', async () => {
    const { scrubMessage: mutantScrub } = await mutant(
      'scrub.ts',
      'let text = collapseQuoted(raw)',
      'let text = raw',
      'scrub-mutant',
    )
    assert.throws(() => assertScrubber(mutantScrub))
  })

  await check('bites: with offline classed as a crash, the classing check fails', async () => {
    const { classifyError: mutantClassify } = await mutant(
      'classify.ts',
      "if (CONNECTIVITY_TYPES.includes(error.type)) return 'offline'",
      "if (CONNECTIVITY_TYPES.includes(error.type)) return 'crash'",
      'classify-mutant',
    )
    assert.throws(() => assertClassing(mutantClassify))
  })

  await check('bites: a fingerprint that ignores the frames splits and collapses groups', async () => {
    const { fingerprintError: mutantFingerprint } = await mutant(
      'fingerprint.ts',
      'return sha1([error.type, ...frames].join(\'\\n\'))',
      'return sha1(error.type)',
      'fingerprint-mutant',
    )
    assert.throws(() => assertFingerprint(mutantFingerprint))
  })
} finally {
  rmSync(mutantsDir, { recursive: true, force: true })
}

console.log(
  failures === 0 ? '\ntelemetry: ALL GREEN' : `\ntelemetry: ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
