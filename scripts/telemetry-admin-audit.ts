/**
 * Pure audit: the admin analytics API, the `app_daily` rollup, the triage note
 * and the Play vitals reader (`everlore-docs/phases/analytics.md` §4.5–§4.7, §5,
 * §6, §4.6a).
 *
 * What this proves, in the contract's own terms:
 *   - every route is inside the admin guard, and refuses a caller who is not
 *     signed in;
 *   - each response has exactly the §4.6a key set, `null` rather than a missing
 *     field, for every endpoint;
 *   - `days` is 7–90 and a 400 otherwise;
 *   - the funnel arithmetic holds on a cohort that signed up and behaved
 *     differently — including a player who never opened a world, one who came
 *     back the next day, and a session that predates sign-in;
 *   - the daily row is a correct, idempotent fold of one day's raw rows: screen
 *     views, players, median and exit rate, next screens, actions, counters,
 *     versions and the funnel;
 *   - "Needs a look" is the structural filter §4.5a describes, not a status;
 *   - confirming records who did it and resolving records the version, and a
 *     sample from a newer version regresses the group;
 *   - the triage note is one queue write per *new* group, never for an existing
 *     or ignored group, never past the daily or monthly cap, `off` when
 *     disabled, and `failed` on an answer that is not the JSON asked for;
 *   - the vitals reader tolerates empty results, merges the crash and ANR metric
 *     sets, reads the documented request bodies, and never leaks an upstream
 *     body or a credential.
 *
 * No Mongo, no Redis, no network, no model: `mongoColl` is an in-memory store, the
 * maintenance queue records its jobs, `callLLM` is a stub, and Play is driven
 * through an injected `fetch`.
 *
 * Run with: `bun --no-env-file run scripts/telemetry-admin-audit.ts`
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'

type Doc = Record<string, any>

// ─────────────────────────────────────────────────────────────────────────────
// An in-memory Mongo: equality and the range/set operators these queries use,
// dotted paths, upserts, sorting, limiting and projection.
// ─────────────────────────────────────────────────────────────────────────────

const COLL_NAMES = [
  'app_events',
  'app_sessions',
  'app_installs',
  'app_errors',
  'app_error_groups',
  'app_error_counters',
  'app_daily',
  'app_triage_calls',
  'users',
  'world_instances',
  'events',
] as const
type CollName = (typeof COLL_NAMES)[number]

const store = Object.fromEntries(COLL_NAMES.map((name) => [name, [] as Doc[]])) as Record<CollName, Doc[]>

function reset(): void {
  for (const name of COLL_NAMES) store[name] = []
  jobs.length = 0
  llmCalls.length = 0
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
  return !!cond && typeof cond === 'object' && !(cond instanceof ObjectId) &&
    !(cond instanceof Date) && !Array.isArray(cond)
}

function valueEquals(docValue: unknown, cond: unknown): boolean {
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

function compareValues(left: unknown, right: unknown): number {
  const a = left instanceof Date ? left.getTime() : left
  const b = right instanceof Date ? right.getTime() : right
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  const sa = String(a)
  const sb = String(b)
  return sa === sb ? 0 : sa < sb ? -1 : 1
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const value = getPath(doc, key)
    if (isOperator(cond)) {
      if ('$exists' in cond) return (value !== undefined) === cond.$exists
      if ('$in' in cond) return (cond.$in as unknown[]).some((candidate) => valueEquals(value, candidate))
      if ('$ne' in cond) return !valueEquals(value, cond.$ne)
      if (Array.isArray(value)) return value.some((item) => inRange(item, cond))
      return inRange(value, cond)
    }
    return valueEquals(value, cond)
  })
}

function inRange(value: unknown, cond: Doc): boolean {
  if ('$gte' in cond && compareValues(value, cond.$gte) < 0) return false
  if ('$lte' in cond && compareValues(value, cond.$lte) > 0) return false
  if ('$gt' in cond && compareValues(value, cond.$gt) <= 0) return false
  if ('$lt' in cond && compareValues(value, cond.$lt) >= 0) return false
  return true
}

function applyUpdate(doc: Doc, update: Doc, isInsert: boolean): Doc {
  const next = clone(doc)
  if (isInsert) {
    for (const [key, value] of Object.entries((update.$setOnInsert ?? {}) as Doc)) {
      setPath(next, key, clone(value))
    }
  }
  for (const [key, value] of Object.entries((update.$set ?? {}) as Doc)) setPath(next, key, clone(value))
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
  // Mongo returns `_id` unless the projection excludes it explicitly.
  if (projection._id !== 0 && Object.hasOwn(doc, '_id')) out._id = doc._id
  for (const key of Object.keys(projection)) {
    if (key === '_id') continue
    if (projection[key] && Object.hasOwn(doc, key)) out[key] = doc[key]
  }
  return out
}

function sortBy(spec: Doc) {
  const entries = Object.entries(spec)
  return (left: Doc, right: Doc): number => {
    for (const [key, direction] of entries) {
      const order = compareValues(getPath(left, key), getPath(right, key))
      if (order !== 0) return Number(direction) < 0 ? -order : order
    }
    return 0
  }
}

function fakeColl(name: CollName) {
  const rows = () => store[name]
  const cursor = (matched: Doc[], projection?: Doc) => ({
    sort(spec: Doc) { return cursor([...matched].sort(sortBy(spec)), projection) },
    limit(count: number) { return cursor(matched.slice(0, count), projection) },
    async toArray() { return matched.map((doc) => project(clone(doc), projection)) },
  })
  return {
    find: (filter: Doc = {}, opts: { projection?: Doc } = {}) =>
      cursor(rows().filter((doc) => matches(doc, filter)), opts.projection),
    findOne: async (filter: Doc, opts: { projection?: Doc; sort?: Doc } = {}) => {
      let matched = rows().filter((doc) => matches(doc, filter))
      if (opts.sort) matched = [...matched].sort(sortBy(opts.sort))
      const found = matched[0]
      return found ? project(clone(found), opts.projection) : null
    },
    countDocuments: async (filter: Doc = {}) => rows().filter((doc) => matches(doc, filter)).length,
    distinct: async (field: string, filter: Doc = {}) => {
      const values: unknown[] = []
      for (const doc of rows().filter((match) => matches(match, filter))) {
        const value = getPath(doc, field)
        if (value === undefined) continue
        const list = Array.isArray(value) ? value : [value]
        for (const item of list) {
          if (!values.some((seen) => valueEquals(seen, item))) values.push(item)
        }
      }
      return values
    },
    insertOne: async (doc: Doc) => {
      const next = clone(doc)
      if (next._id === undefined) next._id = new ObjectId()
      rows().push(next)
      return { acknowledged: true, insertedId: next._id }
    },
    updateOne: async (filter: Doc, update: Doc, opts: { upsert?: boolean } = {}) => {
      const index = rows().findIndex((doc) => matches(doc, filter))
      if (index >= 0) {
        rows()[index] = applyUpdate(rows()[index], update, false)
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
      }
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
      const inserted = applyUpdate(seedFromFilter(filter), update, true)
      if (inserted._id === undefined) inserted._id = new ObjectId()
      rows().push(inserted)
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
    },
    updateMany: async (filter: Doc, update: Doc) => {
      let modified = 0
      for (let index = 0; index < rows().length; index++) {
        if (!matches(rows()[index], filter)) continue
        rows()[index] = applyUpdate(rows()[index], update, false)
        modified++
      }
      return { matchedCount: modified, modifiedCount: modified }
    },
    deleteMany: async (filter: Doc) => {
      const before = rows().length
      store[name] = rows().filter((doc) => !matches(doc, filter))
      return { deletedCount: before - store[name].length }
    },
    replaceOne: async (filter: Doc, doc: Doc, opts: { upsert?: boolean } = {}) => {
      const index = rows().findIndex((match) => matches(match, filter))
      if (index >= 0) {
        rows()[index] = clone(doc)
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
      }
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
      rows().push(clone(doc))
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
    },
  }
}

const docs = (name: CollName): Doc[] => store[name].map((doc) => clone(doc))

// ─────────────────────────────────────────────────────────────────────────────
// Fakes for everything else the code touches.
// ─────────────────────────────────────────────────────────────────────────────

const jobs: Array<{ name: string; data: Doc; opts: Doc }> = []
const llmCalls: Doc[] = []
let llmReply: (request: Doc) => string = () =>
  JSON.stringify({ likely_cause: 'A screen ran out of data to show.', suggested_owner: 'app-logic', confidence: 'medium' })

let installsReport: { available: boolean; reason: string | null; reason_kind: string | null; last_updated: string | null; daily: Record<string, number> } = {
  available: true, reason: null, reason_kind: null, last_updated: null, daily: {},
}

const silentLog = { info() {}, warn() {}, error() {} }

mock.module('../src/utils/logger', () => ({ log: silentLog }))
mock.module('../src/middleware/rate-limit', () => ({
  rateLimit: async () => ({ allowed: true, remaining: 1_000 }),
}))
mock.module('../src/services/play-installs.service', () => ({
  readPlayInstalls: async () => installsReport,
}))
mock.module('../src/queues', () => ({
  QUEUE_RETENTION: { maintenance: { removeOnComplete: {}, removeOnFail: {} } },
  getMaintenanceQueue: () => ({
    add: async (name: string, data: Doc, opts: Doc) => {
      jobs.push({ name, data, opts })
      return { id: opts?.jobId }
    },
  }),
}))
mock.module('../src/ai/client', () => ({
  callLLM: async (request: Doc) => {
    llmCalls.push(request)
    return llmReply(request)
  },
}))
mock.module('../src/config/mongo', () => ({
  mongoColl: {
    appEvents: () => fakeColl('app_events'),
    appSessions: () => fakeColl('app_sessions'),
    appInstalls: () => fakeColl('app_installs'),
    appErrors: () => fakeColl('app_errors'),
    appErrorGroups: () => fakeColl('app_error_groups'),
    appErrorCounters: () => fakeColl('app_error_counters'),
    appDaily: () => fakeColl('app_daily'),
    appTriageCalls: () => fakeColl('app_triage_calls'),
    users: () => fakeColl('users'),
    worldInstances: () => fakeColl('world_instances'),
    events: () => fakeColl('events'),
  },
}))

const { Elysia } = await import('elysia')
const { env } = await import('../src/config/env')
const { HttpError } = await import('../src/utils/http-error')
const { requireAdmin } = await import('../src/middleware/admin-auth')
const { adminAnalyticsRoutes } = await import('../src/routes/admin-analytics.routes')
const { analyticsService } = await import('../src/services/telemetry/analytics.service')
const { triageService } = await import('../src/services/telemetry/triage.service')
const { appDailyRollupService, dayRange, medianFromHist } = await import('../src/services/telemetry/rollup.service')
const { telemetryService } = await import('../src/services/telemetry/ingest.service')
const { loadPlayVitals, createVitalsReader, emptyVitals } = await import('../src/services/play-vitals.service')
const { STORY_TURN_TYPES } = await import('../src/services/admin-activity')

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0
let failures = 0
async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}: ${(error as Error).message}`)
  }
}

const ADMIN = 'audit-admin'
const ADMIN_PASSWORD = 'audit-password'
const BASIC = `Basic ${Buffer.from(`${ADMIN}:${ADMIN_PASSWORD}`).toString('base64')}`

const app = new Elysia({ prefix: '/admin' })
  .onError(({ error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.statusCode
      return { error: error.message }
    }
  })
  .use(requireAdmin)
  .use(adminAnalyticsRoutes)

const FINGERPRINT = 'a'.repeat(40)

async function request(
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const response = await app.handle(new Request(`http://localhost${path}`, {
    ...init,
    headers: { authorization: BASIC, ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  }))
  let body: unknown = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

const get = (path: string, headers: Record<string, string> = {}) => request(path, {}, headers)
const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  request(path, { method, body: JSON.stringify(body) }, headers)

const DAY_MS = 86_400_000

/**
 * The triage hook is deliberately fire-and-forget (a Redis hiccup must never
 * fail an ingest), so the audit waits a tick for the queue write to land.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25))
}
function todayStart(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}
function dayMoment(offset: number, hour = 10, minute = 0): Date {
  return new Date(todayStart().getTime() + offset * DAY_MS + hour * 3_600_000 + minute * 60_000)
}
function dayString(offset: number): string {
  return dayMoment(offset).toISOString().slice(0, 10)
}

function keys(doc: Doc, allowed: readonly string[], where: string): void {
  assert.deepEqual(
    Object.keys(doc).sort(),
    [...allowed].sort(),
    `${where} keys: ${Object.keys(doc).join(', ')}`,
  )
}

const ID = (hex: string) => new ObjectId(hex)
const USER = ['64b7f0c2a1b2c3d4e5f60718', '64b7f0c2a1b2c3d4e5f60719', '64b7f0c2a1b2c3d4e5f6071a']
const INSTALL = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
const SESSION = ['11111111-1111-4111-8111-000000000001', '11111111-1111-4111-8111-000000000002', '11111111-1111-4111-8111-000000000003']
const DEVICE = { os: 'android', os_version: '35', model: 'SM-A155F', form: 'phone', locale: 'en-IN' }

function seedEvent(over: Doc = {}): Doc {
  return {
    install_id: INSTALL[0],
    user_id: ID(USER[0]),
    session_id: SESSION[0],
    name: 'screen_view',
    seq: 1,
    at: dayMoment(-3, 10),
    received_at: dayMoment(-3, 10),
    app_version: '1.0.11',
    build: 14,
    device: { ...DEVICE },
    ...over,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.6 — the guard. Every route, both ways it can refuse.
// ─────────────────────────────────────────────────────────────────────────────

await check('§4.6: every analytics route refuses a caller who is not signed in', async () => {
  const routes = new Map<string, { method: string; path: string; url: string }>()
  for (const route of app.routes as Array<{ method: string; path: string }>) {
    const method = String(route.method).toUpperCase()
    const url = route.path.replace(':fp', FINGERPRINT).replace(':sessionId', SESSION[0])
    routes.set(`${method} ${route.path}`, { method, path: route.path, url })
  }

  const originalUsername = env.ADMIN_USERNAME
  const originalPassword = env.ADMIN_PASSWORD
  try {
    for (const route of routes.values()) {
      // A body-bearing route validates before the guard runs, so the probe sends
      // the smallest body its schema accepts.
      const init: RequestInit = route.method === 'GET'
        ? { method: route.method }
        : { method: route.method, body: '{}' }

      env.ADMIN_USERNAME = ''
      env.ADMIN_PASSWORD = ''
      const unconfigured = await request(route.url, init, { authorization: '' })
      assert.equal(unconfigured.status, 503, `${route.method} ${route.path} without credentials`)
      assert.deepEqual(unconfigured.body, { error: 'Admin credentials are not configured' })

      env.ADMIN_USERNAME = ADMIN
      env.ADMIN_PASSWORD = ADMIN_PASSWORD
      const anonymous = await request(route.url, init, { authorization: '' })
      assert.equal(anonymous.status, 401, `${route.method} ${route.path} with credentials but no auth`)
      assert.deepEqual(anonymous.body, { error: 'Unauthorized' })
    }
  } finally {
    env.ADMIN_USERNAME = originalUsername
    env.ADMIN_PASSWORD = originalPassword
  }

  // Everything after this point talks to a configured console.
  env.ADMIN_USERNAME = ADMIN
  env.ADMIN_PASSWORD = ADMIN_PASSWORD

  assert(routes.size >= 10, `the table is short: ${[...routes.keys()].join(', ')}`)
  for (const expected of [
    'GET /admin/analytics/funnel',
    'GET /admin/analytics/sessions',
    'GET /admin/analytics/sessions/:sessionId',
    'GET /admin/analytics/screens',
    'GET /admin/analytics/actions',
    'GET /admin/analytics/errors',
    'GET /admin/analytics/errors/:fp',
    'PATCH /admin/analytics/errors/:fp',
    'POST /admin/analytics/errors/:fp/triage',
    'GET /admin/analytics/counters',
    'GET /admin/analytics/vitals',
  ]) {
    assert(routes.has(expected), `missing route: ${expected}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.6a — days validation
// ─────────────────────────────────────────────────────────────────────────────

await check('§4.6a: days is 7–90 and a 400 otherwise', async () => {
  reset()
  for (const path of ['/admin/analytics/funnel', '/admin/analytics/screens', '/admin/analytics/actions',
    '/admin/analytics/errors', '/admin/analytics/counters']) {
    for (const bad of ['6', '91', 'thirty', '7.5', '']) {
      const response = await get(`${path}?days=${bad}`)
      assert.equal(response.status, 400, `${path} accepted days=${bad}`)
      assert.match(response.body.error, /between 7 and 90/)
    }
    for (const good of ['7', '90']) {
      const response = await get(`${path}?days=${good}`)
      assert.equal(response.status, 200, `${path} refused days=${good}: ${JSON.stringify(response.body)}`)
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.6 / §4.6a — the funnel
// ─────────────────────────────────────────────────────────────────────────────

await check('§4.6: the funnel counts a cohort step by step', async () => {
  reset()
  // Four installs first opened in the window; three of them signed up.
  installsReport = { available: true, reason: null, reason_kind: null, last_updated: null, daily: { [dayString(-3)]: 5, [dayString(-2)]: 2 } }
  store.app_installs.push(
    { _id: INSTALL[0], first_seen: dayMoment(-3, 8), last_seen: dayMoment(-3, 8), first_version: '1.0.11', build: 14, device: { ...DEVICE } },
    { _id: INSTALL[1], first_seen: dayMoment(-3, 8), last_seen: dayMoment(-3, 8), first_version: '1.0.11', build: 14, device: { ...DEVICE }, user_ids: [ID(USER[0])] },
    { _id: INSTALL[2], first_seen: dayMoment(-3, 8), last_seen: dayMoment(-3, 8), first_version: '1.0.11', build: 14, device: { ...DEVICE }, user_ids: [ID(USER[1])] },
    { _id: '44444444-4444-4444-8444-444444444444', first_seen: dayMoment(-2, 8), last_seen: dayMoment(-2, 8), first_version: '1.0.11', build: 14, device: { ...DEVICE }, user_ids: [ID(USER[2])] },
  )
  store.users.push(
    { _id: ID(USER[0]), username: 'mira', created_at: dayMoment(-3, 9) },
    { _id: ID(USER[1]), username: 'arun', created_at: dayMoment(-3, 9) },
    { _id: ID(USER[2]), username: 'zoe', created_at: dayMoment(-2, 9) },
  )
  // U1 opened a world and played a turn, and came back the next day.
  store.app_events.push(
    seedEvent({ name: 'world_viewed', props: { world_id: '0123456789abcdef01234567' }, user_id: ID(USER[0]), at: dayMoment(-3, 10) }),
    // U3 opened a world and played a turn, and has not come back.
    seedEvent({ name: 'world_viewed', props: { world_id: '0123456789abcdef01234567' }, user_id: ID(USER[2]), install_id: '44444444-4444-4444-8444-444444444444', session_id: SESSION[2], at: dayMoment(-2, 10) }),
  )
  store.events.push(
    { _id: new ObjectId(), player_id: ID(USER[0]), type: 'narration', created_at: dayMoment(-3, 10) },
    { _id: new ObjectId(), player_id: ID(USER[2]), type: 'narration', created_at: dayMoment(-2, 10) },
  )
  store.app_sessions.push(
    // The unsigned install's session: it reached "opened the app" and no further.
    { _id: SESSION[0], install_id: INSTALL[0], started_at: dayMoment(-3, 8), last_at: dayMoment(-3, 8, 30), app_version: '1.0.11', build: 14, device: { ...DEVICE }, screen_path: [{ screen: 'welcome', duration_ms: 1000, at: dayMoment(-3, 8) }], counts: { events: 1, errors: 0, actions: 0 } },
    // U1 came back the next day.
    { _id: SESSION[1], install_id: INSTALL[1], user_id: ID(USER[0]), started_at: dayMoment(-2, 9), last_at: dayMoment(-2, 9, 30), app_version: '1.0.11', build: 14, device: { ...DEVICE }, screen_path: [{ screen: 'play', duration_ms: 1000, at: dayMoment(-2, 9) }], counts: { events: 1, errors: 0, actions: 0 } },
    // U2 signed up and stopped at "signed up".
    { _id: '21111111-1111-4111-8111-000000000002', install_id: INSTALL[2], user_id: ID(USER[1]), started_at: dayMoment(-3, 9), last_at: dayMoment(-3, 9, 30), app_version: '1.0.11', build: 14, device: { ...DEVICE }, screen_path: [{ screen: 'auth', duration_ms: 1000, at: dayMoment(-3, 9) }], counts: { events: 1, errors: 0, actions: 0 } },
    // U3 played a turn and stopped there; its d1 has not happened yet.
    { _id: SESSION[2], install_id: '44444444-4444-4444-8444-444444444444', user_id: ID(USER[2]), started_at: dayMoment(-2, 9), last_at: dayMoment(-2, 9, 30), app_version: '1.0.11', build: 14, device: { ...DEVICE }, screen_path: [{ screen: 'play', duration_ms: 1000, at: dayMoment(-2, 9) }], counts: { events: 1, errors: 0, actions: 0 } },
  )

  const response = await get('/admin/analytics/funnel?days=7')
  assert.equal(response.status, 200)
  const body = response.body
  keys(body, ['days', 'generated_at', 'installs', 'steps', 'note'], 'funnel')
  keys(body.installs, ['available', 'reason', 'total'], 'funnel.installs')
  assert.equal(body.days, 7)
  assert.equal(body.installs.available, true)
  assert.equal(body.installs.total, 7, 'the Play total sums the window')

  const byKey = Object.fromEntries(body.steps.map((step: Doc) => [step.key, step]))
  for (const step of body.steps) {
    keys(step, ['key', 'label', 'count', 'pct_of_prev', 'dropped_sessions'], `step ${step.key}`)
  }
  assert.deepEqual(body.steps.map((step: Doc) => step.key),
    ['first_open', 'signed_up', 'opened_world', 'first_turn', 'returned_d1'])

  assert.equal(byKey.first_open.count, 4)
  assert.equal(byKey.first_open.pct_of_prev, null)
  assert.equal(byKey.signed_up.count, 3)
  assert.equal(byKey.signed_up.pct_of_prev, 75, '3 of 4 installs signed up')
  assert.equal(byKey.opened_world.count, 2, 'one player signed up and never opened a world')
  assert.equal(byKey.opened_world.pct_of_prev, 66.7)
  assert.equal(byKey.first_turn.count, 2)
  assert.equal(byKey.first_turn.pct_of_prev, 100)
  assert.equal(byKey.returned_d1.count, 1, 'one player came back the next day')
  assert.equal(byKey.returned_d1.pct_of_prev, 50)

  assert.deepEqual(byKey.signed_up.dropped_sessions, [SESSION[0]], 'the pre-sign-in session is the sample')
  assert.deepEqual(byKey.opened_world.dropped_sessions, ['21111111-1111-4111-8111-000000000002'])
  assert.deepEqual(byKey.first_turn.dropped_sessions, [])
  assert.deepEqual(byKey.returned_d1.dropped_sessions, [SESSION[2]])
  assert.match(body.note, /Installs come from Play/)
})

// ─────────────────────────────────────────────────────────────────────────────
// §6 — the daily rollup
// ─────────────────────────────────────────────────────────────────────────────

function seedRollupDay(): string {
  const day = dayString(-3)
  store.app_events.push(
    seedEvent({ session_id: SESSION[0], name: 'screen_view', screen: 'discover', duration_ms: 1000, props: { screen: 'discover', duration_ms: 1000 }, at: dayMoment(-3, 10, 0) }),
    seedEvent({ session_id: SESSION[0], name: 'screen_view', screen: 'play', duration_ms: 3000, props: { screen: 'play', duration_ms: 3000 }, at: dayMoment(-3, 10, 1) }),
    seedEvent({ session_id: SESSION[0], name: 'turn_sent', props: { input: 'typed' }, at: dayMoment(-3, 10, 2) }),
    seedEvent({ session_id: SESSION[0], name: 'world_viewed', props: { world_id: '0123456789abcdef01234567' }, at: dayMoment(-3, 10, 3) }),
    seedEvent({ session_id: SESSION[0], name: 'sign_in_completed', props: { method: 'google' }, at: dayMoment(-3, 10, 4) }),
    seedEvent({ session_id: SESSION[1], user_id: ID(USER[1]), install_id: INSTALL[1], name: 'screen_view', screen: 'discover', duration_ms: 1000, props: { screen: 'discover', duration_ms: 1000 }, at: dayMoment(-3, 11, 0) }),
    seedEvent({ session_id: SESSION[2], user_id: ID(USER[2]), install_id: INSTALL[2], name: 'screen_view', screen: 'discover', duration_ms: 3000, props: { screen: 'discover', duration_ms: 3000 }, at: dayMoment(-3, 12, 0) }),
  )
  store.app_sessions.push(
    { _id: SESSION[0], install_id: INSTALL[0], user_id: ID(USER[0]), started_at: dayMoment(-3, 10), last_at: dayMoment(-3, 10, 5), app_version: '1.0.11', build: 14, device: { ...DEVICE }, screen_path: [{ screen: 'discover', duration_ms: 1000, at: dayMoment(-3, 10) }, { screen: 'play', duration_ms: 3000, at: dayMoment(-3, 10, 1) }], counts: { events: 5, errors: 2, actions: 2 } },
    { _id: SESSION[1], install_id: INSTALL[1], user_id: ID(USER[1]), started_at: dayMoment(-3, 11), last_at: dayMoment(-3, 11, 30), app_version: '1.0.11', build: 14, device: { ...DEVICE }, screen_path: [{ screen: 'discover', duration_ms: 1000, at: dayMoment(-3, 11) }], counts: { events: 1, errors: 0, actions: 0 } },
    { _id: SESSION[2], install_id: INSTALL[2], user_id: ID(USER[2]), started_at: dayMoment(-3, 12), last_at: dayMoment(-3, 12, 30), app_version: '1.0.11', build: 14, device: { ...DEVICE }, screen_path: [{ screen: 'discover', duration_ms: 3000, at: dayMoment(-3, 12) }], counts: { events: 1, errors: 0, actions: 0 } },
  )
  store.app_error_counters.push(
    { _id: `${day}|offline`, day, class: 'offline', count: 2 },
    { _id: `${day}|expected_4xx`, day, class: 'expected_4xx', route: '/auth/otp/verify', status: 400, count: 3 },
    { _id: `${day}|image_load`, day, class: 'image_load', screen: 'discover', count: 1 },
  )
  store.app_errors.push(
    { _id: new ObjectId(), error_id: 'aaaaaaaa-0000-4000-8000-000000000001', install_id: INSTALL[0], user_id: ID(USER[0]), session_id: SESSION[0], fingerprint: FINGERPRINT, class: 'crash', source: 'flutter', fatal: true, type: 'StateError', frames: [], breadcrumbs: [], at: dayMoment(-3, 10, 5), received_at: dayMoment(-3, 10, 6), app_version: '1.0.11', build: 14, device: { ...DEVICE } },
    { _id: new ObjectId(), error_id: 'aaaaaaaa-0000-4000-8000-000000000002', install_id: INSTALL[1], user_id: ID(USER[1]), session_id: SESSION[1], fingerprint: FINGERPRINT, class: 'crash', source: 'flutter', fatal: true, type: 'StateError', frames: [], breadcrumbs: [], at: dayMoment(-3, 11, 5), received_at: dayMoment(-3, 11, 6), app_version: '1.0.11', build: 14, device: { ...DEVICE } },
  )
  store.app_error_groups.push({
    _id: FINGERPRINT, class: 'crash', category: 'The app crashed', type: 'StateError', title: 'Bad state',
    status: 'new', first_seen: dayMoment(-3, 10, 5), last_seen: dayMoment(-3, 11, 5), count: 2,
  })
  store.users.push(
    { _id: ID(USER[0]), username: 'mira', created_at: dayMoment(-3, 9) },
    { _id: ID(USER[1]), username: 'arun', created_at: dayMoment(-3, 9) },
    { _id: ID(USER[2]), username: 'zoe', created_at: dayMoment(-3, 9) },
  )
  store.app_installs.push(
    { _id: INSTALL[0], first_seen: dayMoment(-3, 8), last_seen: dayMoment(-3, 8), first_version: '1.0.11', build: 14, device: { ...DEVICE }, user_ids: [ID(USER[0])] },
    { _id: INSTALL[1], first_seen: dayMoment(-3, 8), last_seen: dayMoment(-3, 8), first_version: '1.0.11', build: 14, device: { ...DEVICE }, user_ids: [ID(USER[1])] },
    { _id: INSTALL[2], first_seen: dayMoment(-3, 8), last_seen: dayMoment(-3, 8), first_version: '1.0.11', build: 14, device: { ...DEVICE }, user_ids: [ID(USER[2])] },
  )
  store.events.push({ _id: new ObjectId(), player_id: ID(USER[0]), type: 'narration', created_at: dayMoment(-3, 10, 3) })
  return day
}

await check('§6: the daily row folds one day of raw rows, and a re-roll overwrites it', async () => {
  reset()
  const day = seedRollupDay()

  await appDailyRollupService.rollupDay(day)
  const [row] = docs('app_daily')
  assert.equal(row._id, day)

  const discover = row.screens.discover
  assert.equal(discover.views, 3)
  assert.equal(discover.players, 3)
  assert.equal(discover.total_ms, 5000)
  assert.equal(discover.median_ms, 1000, 'median of 1000/1000/3000')
  assert.equal(discover.exits, 2, 'two sessions ended on discover')
  assert.deepEqual(discover.next, { play: 1 })

  const play = row.screens.play
  assert.equal(play.views, 1)
  assert.equal(play.exits, 1)
  assert.equal(play.median_ms, 3000)

  assert.equal(row.actions.turn_sent.count, 1)
  assert.deepEqual(row.actions.turn_sent.props, { input: { typed: 1 } })
  assert.equal(row.actions.sign_in_completed.count, 1)
  assert.equal(row.actions.screen_view, undefined, 'a screen view is not an action')

  assert.deepEqual(row.counters, {
    offline: 2, expected_4xx: 3, image_load: 1, top_4xx: { '/auth/otp/verify|400': 3 },
  })
  assert.equal(row.errors.samples, 2)
  assert.equal(row.errors.players, 2)
  assert.equal(row.errors.groups_new, 1)
  assert.deepEqual(row.errors.by_class, { crash: 2 })

  assert.deepEqual(row.versions, { '1.0.11': 7 })
  assert.equal(row.sessions, 3)
  assert.deepEqual(row.funnel, {
    first_opens: 3, sessions_started: 3, sign_ins: 1, signups: 3,
    opened_world: 1, first_turn: 1, returned_d1: 0,
  })

  // Idempotent: the same day rolled again is the same row, not a doubled one.
  await appDailyRollupService.rollupDay(day)
  assert.equal(docs('app_daily').length, 1)
  assert.equal(docs('app_daily')[0].screens.discover.views, 3)

  // And a row that a corrected raw set no longer supports is replaced, not merged.
  store.app_events = store.app_events.filter((event) => event.screen !== 'play')
  await appDailyRollupService.rollupDay(day)
  assert.equal(docs('app_daily')[0].screens.play.views, 0, 'the removed views are gone from the row')
  assert.equal(docs('app_daily')[0].screens.play.exits, 1, 'the session still ended there')
})

await check('§6: backfill writes days with raw rows and no row, and skips the ones it has', async () => {
  reset()
  const day = seedRollupDay()
  await appDailyRollupService.rollupDay(day)

  const result = await appDailyRollupService.backfillMissing()
  assert(result.checked >= 3, 'the raw rows span the day and today')
  assert.equal(result.written, result.checked - 1, 'only the already-written day is skipped')
  assert.equal(new Set(docs('app_daily').map((row) => row._id)).size, docs('app_daily').length)
  assert(docs('app_daily').some((row) => row._id === day))
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.6a — screens, actions, counters
// ─────────────────────────────────────────────────────────────────────────────

function seedDailyScreens(): void {
  const empty = {
    sessions: 0,
    funnel: { first_opens: 0, sessions_started: 0, sign_ins: 0, signups: 0, opened_world: 0, first_turn: 0, returned_d1: 0 },
    actions: {}, counters: { offline: 0, expected_4xx: 0, image_load: 0, top_4xx: {} }, errors: { samples: 0, players: 0, groups_new: 0, by_class: {} },
  }
  const day2 = dayString(-2)
  const day1 = dayString(-1)
  store.app_daily.push(
    {
      ...empty, _id: day2, day: day2, updated_at: new Date(), sessions: 2,
      screens: { play: { views: 2, players: 2, total_ms: 4000, median_ms: 2000, exits: 1, next: { chronicle: 1 }, hist: { 2: 2 } } },
      versions: { '1.0.10': 4 },
    },
    {
      ...empty, _id: day1, day: day1, updated_at: new Date(), sessions: 2,
      screens: { play: { views: 2, players: 2, total_ms: 8000, median_ms: 4000, exits: 1, next: { chronicle: 1 }, hist: { 4: 2 } } },
      versions: { '1.0.11': 4 },
    },
  )
}

await check('§4.6a: screens merge a window, and exit rate is the share of sessions', async () => {
  reset()
  seedDailyScreens()

  const response = await get('/admin/analytics/screens?days=7')
  assert.equal(response.status, 200)
  keys(response.body, ['days', 'items', 'versions'], 'screens')
  const item = response.body.items[0]
  keys(item, ['screen', 'views', 'players', 'mean_ms', 'median_ms', 'exit_rate', 'next'], 'screen item')
  keys(item.next[0], ['screen', 'share'], 'screen.next')

  assert.equal(item.screen, 'play')
  assert.equal(item.views, 4)
  assert.equal(item.players, 4)
  assert.equal(item.mean_ms, 3000, '(4000 + 8000) / 4')
  assert.equal(item.median_ms, 2000, 'merged histogram of 2 s and 4 s views')
  assert.equal(item.exit_rate, 50, '2 exits of 4 sessions')
  assert.deepEqual(item.next, [{ screen: 'chronicle', share: 100 }])
  assert.deepEqual(response.body.versions, ['1.0.11', '1.0.10'], 'newest first')
})

await check('§4.6a: a version filter narrows screens to that version', async () => {
  reset()
  seedDailyScreens()
  store.app_events.push(
    seedEvent({ app_version: '1.0.11', session_id: SESSION[0], screen: 'discover', duration_ms: 5000, props: { screen: 'discover', duration_ms: 5000 }, at: dayMoment(-1, 10) }),
  )
  store.app_sessions.push({
    _id: SESSION[0], install_id: INSTALL[0], started_at: dayMoment(-1, 10), last_at: dayMoment(-1, 10, 5),
    app_version: '1.0.11', build: 14, device: { ...DEVICE },
    screen_path: [{ screen: 'discover', duration_ms: 5000, at: dayMoment(-1, 10) }], counts: { events: 1, errors: 0, actions: 0 },
  })

  const response = await get('/admin/analytics/screens?days=7&version=1.0.11')
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.items.map((item: Doc) => item.screen), ['discover'])
  assert.equal(response.body.items[0].views, 1)
  assert.equal(response.body.items[0].exit_rate, 100)
  assert.deepEqual(response.body.versions, ['1.0.11', '1.0.10'])
})

await check('§4.6a: actions carry a per-day series and prop breakdowns', async () => {
  reset()
  const empty = {
    sessions: 0,
    funnel: { first_opens: 0, sessions_started: 0, sign_ins: 0, signups: 0, opened_world: 0, first_turn: 0, returned_d1: 0 },
    screens: {}, counters: { offline: 0, expected_4xx: 0, image_load: 0, top_4xx: {} }, errors: { samples: 0, players: 0, groups_new: 0, by_class: {} }, versions: {},
  }
  store.app_daily.push(
    { ...empty, _id: dayString(-2), day: dayString(-2), updated_at: new Date(), actions: { turn_sent: { count: 2, players: 2, props: { input: { typed: 2 } } } } },
    { ...empty, _id: dayString(-1), day: dayString(-1), updated_at: new Date(), actions: { turn_sent: { count: 3, players: 1, props: { input: { typed: 1, choice: 2 } } } } },
  )

  const response = await get('/admin/analytics/actions?days=7')
  assert.equal(response.status, 200)
  keys(response.body, ['days', 'items'], 'actions')
  const item = response.body.items[0]
  keys(item, ['name', 'count', 'players', 'daily', 'breakdown'], 'action item')
  keys(item.daily[0], ['date', 'count'], 'action.daily')
  keys(item.breakdown.input[0], ['value', 'count'], 'action.breakdown')

  assert.equal(item.name, 'turn_sent')
  assert.equal(item.count, 5)
  assert.equal(item.players, 3)
  assert.equal(item.daily.length, 7, 'every day in the window is present')
  assert.deepEqual(item.daily.map((entry: Doc) => entry.date), dayRange(7))
  assert.deepEqual(item.breakdown.input, [{ value: 'typed', count: 3 }, { value: 'choice', count: 2 }])
})

await check('§4.6a: counters are the three classes that never group', async () => {
  reset()
  const empty = {
    sessions: 0,
    funnel: { first_opens: 0, sessions_started: 0, sign_ins: 0, signups: 0, opened_world: 0, first_turn: 0, returned_d1: 0 },
    screens: {}, actions: {}, errors: { samples: 0, players: 0, groups_new: 0, by_class: {} }, versions: {},
  }
  store.app_daily.push({
    ...empty, _id: dayString(-1), day: dayString(-1), updated_at: new Date(),
    counters: { offline: 4, expected_4xx: 2, image_load: 1, top_4xx: { '/auth/otp/verify|400': 2 } },
  })

  const response = await get('/admin/analytics/counters?days=7')
  assert.equal(response.status, 200)
  keys(response.body, ['days', 'daily', 'top_4xx'], 'counters')
  keys(response.body.daily[0], ['date', 'offline', 'expected_4xx', 'image_load'], 'counters.daily')
  keys(response.body.top_4xx[0], ['route', 'status', 'count'], 'counters.top_4xx')

  const today = response.body.daily.find((entry: Doc) => entry.date === dayString(-1))
  assert.deepEqual(today, { date: dayString(-1), offline: 4, expected_4xx: 2, image_load: 1 })
  assert.deepEqual(response.body.top_4xx, [{ route: '/auth/otp/verify', status: 400, count: 2 }])
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.6a — sessions
// ─────────────────────────────────────────────────────────────────────────────

function seedSessions(): void {
  store.users.push({ _id: ID(USER[0]), username: 'mira', created_at: dayMoment(-5, 9) })
  store.app_sessions.push(
    {
      _id: SESSION[0], install_id: INSTALL[0], user_id: ID(USER[0]), started_at: dayMoment(-1, 12), last_at: dayMoment(-1, 12, 2),
      app_version: '1.0.11', build: 14, device: { ...DEVICE },
      screen_path: [{ screen: 'discover', duration_ms: 41230, at: dayMoment(-1, 12) }],
      counts: { events: 3, errors: 1, actions: 2 },
    },
    {
      _id: SESSION[1], install_id: INSTALL[1], started_at: dayMoment(-1, 9), last_at: dayMoment(-1, 9, 5),
      app_version: '1.0.10', build: 13, device: { ...DEVICE },
      screen_path: [{ screen: 'play', duration_ms: 1000, at: dayMoment(-1, 9) }],
      counts: { events: 1, errors: 0, actions: 0 },
    },
    {
      _id: SESSION[2], install_id: INSTALL[2], started_at: dayMoment(-2, 12), last_at: dayMoment(-2, 12, 5),
      app_version: '1.0.11', build: 14, device: { ...DEVICE },
      screen_path: [{ screen: 'home', duration_ms: 1000, at: dayMoment(-2, 12) }],
      counts: { events: 1, errors: 0, actions: 0 },
    },
  )
}

await check('§4.6a: sessions list paginates on started_at and names the player', async () => {
  reset()
  seedSessions()

  const page = await get('/admin/analytics/sessions?limit=2')
  assert.equal(page.status, 200, JSON.stringify(page.body))
  keys(page.body, ['items', 'next_before'], 'sessions')
  const [newest, middle] = page.body.items
  for (const item of page.body.items) {
    keys(item, ['id', 'user', 'install_id', 'app_version', 'build', 'device', 'started_at', 'last_at',
      'duration_ms', 'path', 'actions', 'errors'], 'session item')
    keys(item.device, ['os', 'os_version', 'model', 'form'], 'session device')
    keys(item.path[0], ['screen', 'duration_ms'], 'session path step')
  }
  assert.equal(page.body.items.length, 2)
  assert.equal(page.body.next_before, middle.started_at)
  assert.deepEqual(newest.user, { id: USER[0], username: 'mira' })
  assert.equal(newest.duration_ms, 120_000)
  assert.deepEqual(newest.path, [{ screen: 'discover', duration_ms: 41230 }])
  assert.equal(newest.actions, 2)
  assert.equal(newest.errors, 1)

  const second = await get(`/admin/analytics/sessions?limit=2&before=${encodeURIComponent(page.body.next_before)}`)
  assert.equal(second.status, 200)
  assert.equal(second.body.items.length, 1)
  assert.equal(second.body.items[0].id, SESSION[2])
  assert.equal(second.body.next_before, second.body.items[0].started_at)
  assert.equal(second.body.items[0].user, null, 'a session that never signed in has no user')
})

await check('§4.6a: dropped_at keeps the sessions that ended on that screen', async () => {
  reset()
  seedSessions()
  const response = await get('/admin/analytics/sessions?dropped_at=play')
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.items.map((item: Doc) => item.id), [SESSION[1]])
})

await check('§4.6a: a session timeline is every event and error in order', async () => {
  reset()
  seedSessions()
  store.app_events.push(
    seedEvent({ session_id: SESSION[0], name: 'screen_view', screen: 'discover', duration_ms: 41230, props: { screen: 'discover', duration_ms: 41230 }, at: dayMoment(-1, 10) }),
    seedEvent({ session_id: SESSION[0], name: 'turn_sent', props: { input: 'typed' }, at: dayMoment(-1, 10, 1) }),
  )
  store.app_errors.push({
    _id: new ObjectId(), error_id: 'aaaaaaaa-0000-4000-8000-000000000009', install_id: INSTALL[0],
    user_id: ID(USER[0]), session_id: SESSION[0], fingerprint: FINGERPRINT, class: 'crash', source: 'flutter',
    fatal: true, type: 'StateError', message: 'Bad state', screen: 'play', frames: [], breadcrumbs: [],
    at: dayMoment(-1, 10, 1, 30), received_at: dayMoment(-1, 10, 2), app_version: '1.0.11', build: 14, device: { ...DEVICE },
  })

  const response = await get(`/admin/analytics/sessions/${SESSION[0]}`)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  keys(response.body, ['session', 'timeline'], 'session detail')
  const kinds = response.body.timeline.map((entry: Doc) => entry.kind)
  assert.deepEqual(kinds, ['event', 'event', 'error'])

  const [view, turn, error] = response.body.timeline
  keys(view, ['at', 'kind', 'name', 'screen', 'duration_ms', 'props'], 'timeline event')
  assert.equal(view.screen, 'discover')
  assert.equal(turn.screen, null, 'a field the server cannot know is null, not missing')
  assert.equal(turn.duration_ms, null)
  assert.deepEqual(turn.props, { input: 'typed' })
  keys(error, ['at', 'kind', 'fingerprint', 'category', 'title', 'screen'], 'timeline error')
  assert.equal(error.category, 'The app crashed')
  assert.equal(error.title, 'Bad state')

  const missing = await get('/admin/analytics/sessions/99999999-9999-4999-8999-999999999999')
  assert.equal(missing.status, 404)
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.5 / §4.5a — the error list, views and sorting
// ─────────────────────────────────────────────────────────────────────────────

function seedGroups(): void {
  const at = (offset: number) => dayMoment(offset, 10)
  store.app_error_groups.push(
    { _id: 'a'.repeat(40), class: 'crash', category: 'The app crashed', type: 'StateError', title: 'Bad state', status: 'new', first_seen: at(-2), last_seen: at(-1), count: 2, versions: { '1_0_11': 2 }, top_frame: 'package:everlore/x.dart#X.y' },
    { _id: 'b'.repeat(40), class: 'crash', category: 'The app crashed', type: 'RangeError', title: 'Out of range', status: 'new', first_seen: at(-2), last_seen: at(-1), count: 3, versions: { '1_0_11': 3 } },
    { _id: 'c'.repeat(40), class: 'handled_bug', category: 'Something broke on a screen', type: 'BadState', title: 'Broke', status: 'new', first_seen: at(-2), last_seen: at(-1), count: 1, versions: { '1_0_9': 1 } },
    { _id: 'd'.repeat(40), class: 'handled_bug', category: 'Something broke on a screen', type: 'BadState', title: 'Broke', status: 'confirmed', first_seen: at(-2), last_seen: at(-1), count: 1, versions: { '1_0_11': 1 }, verified_by: 'operator', verified_at: at(-1) },
    { _id: 'e'.repeat(40), class: 'crash', category: 'The app crashed', type: 'StateError', title: 'Gone', status: 'resolved', first_seen: at(-3), last_seen: at(-2), count: 1, versions: { '1_0_10': 1 }, resolved_in_version: '1.0.10' },
    { _id: 'f'.repeat(40), class: 'handled_bug', category: 'Something broke on a screen', type: 'BadState', title: 'Noise', status: 'ignored', first_seen: at(-3), last_seen: at(-2), count: 1, versions: { '1_0_11': 1 } },
  )

  const sample = (fingerprint: string, user: string, install: string, minute: number) => ({
    _id: new ObjectId(), error_id: `aaaaaaaa-0000-4000-8000-0000000000${minute}`, install_id: install,
    user_id: ID(user), session_id: SESSION[0], fingerprint, class: fingerprint === 'a'.repeat(40) ? 'crash' : 'crash',
    source: 'flutter', fatal: true, type: 'StateError', message: 'Bad state', screen: 'play',
    frames: [{ file: 'package:everlore/x.dart', symbol: 'X.y', line: 1 }],
    breadcrumbs: [{ at: dayMoment(-1, 9, 59), kind: 'action', name: 'turn_sent' }],
    at: dayMoment(-1, 10, minute), received_at: dayMoment(-1, 10, minute), app_version: '1.0.11', build: 14, device: { ...DEVICE },
  })
  store.app_errors.push(
    sample('a'.repeat(40), USER[0], INSTALL[0], 1),
    sample('a'.repeat(40), USER[1], INSTALL[1], 2),
    sample('b'.repeat(40), USER[0], INSTALL[0], 3),
    sample('b'.repeat(40), USER[1], INSTALL[1], 4),
    sample('b'.repeat(40), USER[2], INSTALL[2], 5),
  )
  store.users.push(
    { _id: ID(USER[0]), username: 'mira', created_at: dayMoment(-9, 9) },
    { _id: ID(USER[1]), username: 'arun', created_at: dayMoment(-9, 9) },
    { _id: ID(USER[2]), username: 'zoe', created_at: dayMoment(-9, 9) },
  )
}

const ERROR_ITEM_KEYS = [
  'fingerprint', 'class', 'category', 'context_parts', 'explanation', 'suggested_cause', 'triage_state',
  'type', 'title', 'top_frame', 'status', 'first_seen', 'last_seen', 'events', 'players',
  'on_newest_version', 'versions', 'verified_by', 'verified_at',
] as const

await check('§4.5a: "Needs a look" is status, class, players and version — not a status list', async () => {
  reset()
  seedGroups()

  const response = await get('/admin/analytics/errors?days=30')
  assert.equal(response.status, 200)
  keys(response.body, ['items', 'counts'], 'errors')
  keys(response.body.counts, ['needs_look', 'confirmed', 'resolved', 'ignored'], 'errors.counts')
  for (const item of response.body.items) keys(item, ERROR_ITEM_KEYS, 'error item')

  assert.deepEqual(response.body.counts, { needs_look: 2, confirmed: 1, resolved: 1, ignored: 1 })

  const keysSeen = response.body.items.map((item: Doc) => item.fingerprint)
  assert.deepEqual(keysSeen, ['b'.repeat(40), 'a'.repeat(40)],
    'needs_look only, sorted by players then last seen')

  const byFingerprint = Object.fromEntries(response.body.items.map((item: Doc) => [item.fingerprint, item]))
  assert.equal(byFingerprint['a'.repeat(40)].players, 2)
  assert.equal(byFingerprint['b'.repeat(40)].players, 3)
  assert.equal(byFingerprint['a'.repeat(40)].on_newest_version, true)
  assert.deepEqual(byFingerprint['a'.repeat(40)].context_parts,
    { screen: 'play', action: 'turn_sent', version: '1.0.11' })
  assert.deepEqual(byFingerprint['a'.repeat(40)].versions, [{ version: '1.0.11', count: 2 }])
  assert.equal(byFingerprint['a'.repeat(40)].triage_state, 'pending', 'no note yet')

  const confirmed = await get('/admin/analytics/errors?view=confirmed&days=30')
  assert.deepEqual(confirmed.body.items.map((item: Doc) => item.fingerprint), ['d'.repeat(40)])
  assert.equal(confirmed.body.items[0].verified_by, 'operator')
  assert(confirmed.body.items[0].verified_at)

  const ignored = await get('/admin/analytics/errors?view=ignored&days=30')
  assert.deepEqual(ignored.body.items.map((item: Doc) => item.fingerprint), ['f'.repeat(40)])

  const all = await get('/admin/analytics/errors?view=all&days=30')
  assert.equal(all.body.items.length, 6)
  assert.equal(all.body.counts.needs_look, 2)

  const badView = await get('/admin/analytics/errors?view=nonsense')
  assert.equal(badView.status, 400)
})

await check('§4.6a: a group detail carries its note, daily counts and latest samples', async () => {
  reset()
  seedGroups()

  const response = await get(`/admin/analytics/errors/${'a'.repeat(40)}`)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  keys(response.body, ['group', 'daily', 'samples'], 'error detail')
  keys(response.body.group, [
    ...ERROR_ITEM_KEYS, 'note', 'suggested_owner', 'confidence', 'resolved_in_version',
  ], 'error group')
  assert.equal(response.body.group.note, null)
  assert.equal(response.body.group.suggested_owner, null)
  assert.equal(response.body.group.confidence, null)
  assert.equal(response.body.group.resolved_in_version, null)

  assert.equal(response.body.daily.length, 30, 'every day of the history is present')
  keys(response.body.daily[0], ['date', 'count'], 'error daily')
  const sampleDay = response.body.daily.find((entry: Doc) => entry.date === dayString(-1))
  assert.equal(sampleDay.count, 2, 'both samples fall on the same day')

  const sample = response.body.samples[0]
  keys(sample, ['id', 'at', 'user', 'session_id', 'app_version', 'device', 'source', 'fatal', 'message',
    'screen', 'http', 'frames', 'breadcrumbs'], 'error sample')
  keys(sample.device, ['os', 'os_version', 'model', 'form'], 'sample device')
  assert.deepEqual(sample.user, { id: USER[1], username: 'arun' }, 'newest sample first')
  assert.equal(sample.http, null)
  assert.deepEqual(sample.frames, [{ file: 'package:everlore/x.dart', symbol: 'X.y', line: 1 }])

  const missing = await get(`/admin/analytics/errors/${'9'.repeat(40)}`)
  assert.equal(missing.status, 404)
  const malformed = await get('/admin/analytics/errors/not-a-fingerprint')
  assert.equal(malformed.status, 400)
})

await check('§4.6: PATCH confirms with the admin name, resolves with the newest version', async () => {
  reset()
  seedGroups()
  const fingerprint = 'c'.repeat(40)

  const empty = await send('PATCH', `/admin/analytics/errors/${fingerprint}`, {})
  assert.equal(empty.status, 400, 'at least one field is required')

  const tooLong = await send('PATCH', `/admin/analytics/errors/${fingerprint}`, { explanation: 'x'.repeat(301) })
  assert.equal(tooLong.status, 422, 'the 300-character bound is a validation rule')

  const confirmed = await send('PATCH', `/admin/analytics/errors/${fingerprint}`, {
    status: 'confirmed',
    explanation: 'The story screen lost its place after a turn.',
    note: 'Looks like the same bug as last week.',
  })
  assert.equal(confirmed.status, 200)
  keys(confirmed.body, ['group'], 'PATCH response')
  assert.equal(confirmed.body.group.status, 'confirmed')
  assert.equal(confirmed.body.group.verified_by, ADMIN, 'the signed-in admin is recorded')
  assert(confirmed.body.group.verified_at, 'confirmation carries a time')
  assert.equal(confirmed.body.group.explanation, 'The story screen lost its place after a turn.')
  assert.equal(confirmed.body.group.note, 'Looks like the same bug as last week.')

  const resolved = await send('PATCH', `/admin/analytics/errors/${fingerprint}`, { status: 'resolved' })
  assert.equal(resolved.status, 200)
  assert.equal(resolved.body.group.status, 'resolved')
  assert.equal(resolved.body.group.resolved_in_version, '1.0.9', 'the newest version this group was seen in')
})

await check('§4.5a: a sample from a newer version regresses a resolved group', async () => {
  reset()
  const error = (version: string) => ({
    install_id: INSTALL[0],
    session_id: SESSION[0],
    app: { version, build: 14 },
    device: { ...DEVICE },
    events: [],
    errors: [{
      id: 'aaaaaaaa-0000-4000-8000-00000000000a',
      at: new Date().toISOString(),
      source: 'handled',
      fatal: false,
      type: 'StateError',
      message: 'Bad state: No element',
      frames: [{ file: 'package:everlore/play/play_cubit.dart', symbol: 'PlayCubit.load', line: 12 }],
    }],
  })

  await telemetryService.ingest(error('1.0.9') as any, null)
  await settle()
  const [group] = docs('app_error_groups')
  const fingerprint = String(group._id)

  const resolved = await send('PATCH', `/admin/analytics/errors/${fingerprint}`, { status: 'resolved' })
  assert.equal(resolved.body.group.resolved_in_version, '1.0.9')

  await telemetryService.ingest({ ...error('1.0.10'), errors: [{
    ...error('1.0.10').errors[0],
    id: 'aaaaaaaa-0000-4000-8000-00000000000b',
  }] } as any, null)
  await settle()

  const [after] = docs('app_error_groups')
  assert.equal(after.status, 'regressed', 'the fix did not hold on the newer version')
  assert.equal(after.count, 2)

  const list = await get('/admin/analytics/errors?days=30')
  assert.equal(list.body.items[0].status, 'regressed')
  assert.equal(list.body.counts.needs_look, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.7 — the triage note
// ─────────────────────────────────────────────────────────────────────────────

function crashBatch(id: string, version = '1.0.11'): any {
  return {
    install_id: INSTALL[0],
    session_id: SESSION[0],
    app: { version, build: 14 },
    device: { ...DEVICE },
    events: [],
    errors: [{
      id,
      at: new Date().toISOString(),
      source: 'flutter',
      fatal: true,
      type: 'StateError',
      message: 'Bad state: No element',
      frames: [{ file: 'package:everlore/play/play_cubit.dart', symbol: 'PlayCubit.load', line: 12 }],
      breadcrumbs: [{ at: new Date().toISOString(), kind: 'action', name: 'turn_sent' }],
    }],
  }
}

await check('§4.7: one queue write per new group, none for an existing one', async () => {
  reset()
  llmReply = () => JSON.stringify({ likely_cause: 'A screen ran out of data to show.', suggested_owner: 'app-logic', confidence: 'medium' })

  await telemetryService.ingest(crashBatch('aaaaaaaa-0000-4000-8000-0000000000c1'), null)
  await settle()
  assert.equal(jobs.length, 1, 'a new group queues one note')
  assert.equal(jobs[0].data.task, 'triage_error_group')
  const [group] = docs('app_error_groups')
  assert.equal(jobs[0].opts.jobId, String(group._id), 'the job id is the fingerprint, so it dedupes')

  await telemetryService.ingest(crashBatch('aaaaaaaa-0000-4000-8000-0000000000c2'), null)
  await settle()
  assert.equal(jobs.length, 1, 'a second sample of the same group queues nothing')

  // A group that already exists is not re-triaged by ingest either.
  store.app_error_groups[0].count = 5
  await telemetryService.ingest(crashBatch('aaaaaaaa-0000-4000-8000-0000000000c3'), null)
  await settle()
  assert.equal(jobs.length, 1)
})

await check('§4.7: a good answer is stored, costed and recorded once', async () => {
  reset()
  await telemetryService.ingest(crashBatch('aaaaaaaa-0000-4000-8000-0000000000d1'), null)
  await settle()
  const [created] = docs('app_error_groups')
  const fingerprint = String(created._id)

  const state = await triageService.run(fingerprint)
  assert.equal(state, 'done')
  assert.equal(llmCalls.length, 1, 'exactly one model call')
  assert.equal(llmCalls[0].model, env.AUTHORING_MODEL)
  assert.equal(llmCalls[0].purpose, 'error_triage')

  const prompt = llmCalls[0].messages.map((message: Doc) => message.content).join('\n')
  assert.match(prompt, /StateError/)
  assert.match(prompt, /package:everlore\/play\/play_cubit\.dart#PlayCubit\.load:12/)
  assert.match(prompt, /action:turn_sent/)
  assert(!prompt.includes(USER[0]), 'no user id reaches the model')
  assert(!prompt.includes(INSTALL[0]), 'no install id reaches the model')

  const [group] = docs('app_error_groups')
  assert.equal(group.triage.state, 'done')
  assert.equal(group.triage.likely_cause, 'A screen ran out of data to show.')
  assert.equal(group.triage.suggested_owner, 'app-logic')
  assert.equal(group.triage.confidence, 'medium')
  assert(group.triage.likely_cause.length <= 300)

  const ledger = docs('app_triage_calls')
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].fingerprint, fingerprint)
  assert(ledger[0].cost_usd > 0 && ledger[0].cost_usd < 0.01, 'a call costs a fraction of a cent')

  const listed = await get('/admin/analytics/errors?days=30')
  assert.equal(listed.body.items[0].triage_state, 'done')
  assert.equal(listed.body.items[0].suggested_cause, 'A screen ran out of data to show.')
  const detail = await get(`/admin/analytics/errors/${fingerprint}`)
  assert.equal(detail.body.group.suggested_owner, 'app-logic')
  assert.equal(detail.body.group.confidence, 'medium')
})

await check('§4.7: an ignored group is never triaged', async () => {
  reset()
  await telemetryService.ingest(crashBatch('aaaaaaaa-0000-4000-8000-0000000000e1'), null)
  await settle()
  const fingerprint = String(docs('app_error_groups')[0]._id)
  store.app_error_groups[0].status = 'ignored'

  const state = await triageService.run(fingerprint)
  assert.equal(state, 'not_applicable')
  assert.equal(llmCalls.length, 0)
  assert.equal(docs('app_triage_calls').length, 0)
})

await check('§4.7: the daily cap stops the call, and says so', async () => {
  reset()
  await telemetryService.ingest(crashBatch('aaaaaaaa-0000-4000-8000-0000000000f1'), null)
  await settle()
  const fingerprint = String(docs('app_error_groups')[0]._id)

  const originalCap = env.ERROR_TRIAGE_DAILY_CAP
  try {
    env.ERROR_TRIAGE_DAILY_CAP = 1
    store.app_triage_calls.push({ at: new Date(), fingerprint: 'x'.repeat(40), cost_usd: 0.0002 })
    const state = await triageService.run(fingerprint)
    assert.equal(state, 'capped')
    assert.equal(llmCalls.length, 0, 'a capped group makes no call')
    assert.equal(docs('app_error_groups')[0].triage.state, 'capped')
  } finally {
    env.ERROR_TRIAGE_DAILY_CAP = originalCap
  }
})

await check('§4.7: the monthly spend cap stops the call too', async () => {
  reset()
  await telemetryService.ingest(crashBatch('aaaaaaaa-0000-4000-8000-000000000101'), null)
  await settle()
  const fingerprint = String(docs('app_error_groups')[0]._id)

  const originalCap = env.ERROR_TRIAGE_MONTHLY_USD_CAP
  try {
    env.ERROR_TRIAGE_MONTHLY_USD_CAP = 0.5
    store.app_triage_calls.push(
      { at: new Date(), fingerprint: 'x'.repeat(40), cost_usd: 0.3 },
      { at: new Date(), fingerprint: 'y'.repeat(40), cost_usd: 0.3 },
    )
    const state = await triageService.run(fingerprint)
    assert.equal(state, 'capped')
    assert.equal(llmCalls.length, 0)
  } finally {
    env.ERROR_TRIAGE_MONTHLY_USD_CAP = originalCap
  }
})

await check('§4.7: disabled means off, and no call', async () => {
  reset()
  await telemetryService.ingest(crashBatch('aaaaaaaa-0000-4000-8000-000000000111'), null)
  await settle()
  const fingerprint = String(docs('app_error_groups')[0]._id)
  const queuedBefore = jobs.length

  const original = env.ERROR_TRIAGE_ENABLED
  try {
    env.ERROR_TRIAGE_ENABLED = false
    assert.equal(await triageService.run(fingerprint), 'off')
    assert.equal(llmCalls.length, 0)

    // A disabled server does not even queue the note for the next group.
    await telemetryService.ingest(crashBatch('aaaaaaaa-0000-4000-8000-000000000112'), null)
  await settle()
    assert.equal(jobs.length, queuedBefore, 'nothing was queued while disabled')
  } finally {
    env.ERROR_TRIAGE_ENABLED = original
  }
})

await check('§4.7: an answer that is not the JSON asked for is failed, never retried', async () => {
  reset()
  await telemetryService.ingest(crashBatch('aaaaaaaa-0000-4000-8000-000000000121'), null)
  await settle()
  const fingerprint = String(docs('app_error_groups')[0]._id)

  llmReply = () => 'I think it is probably the network, sorry!'
  assert.equal(await triageService.run(fingerprint), 'failed')
  assert.equal(llmCalls.length, 1, 'no retry')
  assert.equal(docs('app_error_groups')[0].triage.state, 'failed')
  assert.equal(docs('app_error_groups')[0].triage.likely_cause, undefined, 'a bad answer stores no words')
  assert.equal(docs('app_triage_calls').length, 1, 'the call still spent money')

  llmReply = () => JSON.stringify({ likely_cause: 'x'.repeat(301), suggested_owner: 'app-logic', confidence: 'medium' })
  assert.equal(await triageService.run(fingerprint), 'failed', 'an over-long sentence is refused')
})

await check('§4.7: the console can re-run a note, and it is queued fresh', async () => {
  reset()
  await telemetryService.ingest(crashBatch('aaaaaaaa-0000-4000-8000-000000000131'), null)
  await settle()
  const fingerprint = String(docs('app_error_groups')[0]._id)
  jobs.length = 0

  const response = await send('POST', `/admin/analytics/errors/${fingerprint}/triage`, {})
  assert.equal(response.status, 200)
  keys(response.body, ['triage_state'], 'triage response')
  assert.equal(response.body.triage_state, 'pending')
  assert.equal(jobs.length, 1)
  assert.notEqual(jobs[0].opts.jobId, fingerprint, 'a re-run is not deduplicated away')
  assert.equal(docs('app_error_groups')[0].triage.state, 'pending')

  const ignored = 'f'.repeat(40)
  store.app_error_groups.push({
    _id: ignored, class: 'handled_bug', category: 'Something broke on a screen', type: 'BadState',
    title: 'Noise', status: 'ignored', first_seen: new Date(), last_seen: new Date(), count: 1,
  })
  const refused = await send('POST', `/admin/analytics/errors/${ignored}/triage`, {})
  assert.equal(refused.body.triage_state, 'not_applicable')
  assert.equal(jobs.length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Play vitals
// ─────────────────────────────────────────────────────────────────────────────

const CRASH_ROWS = {
  rows: [
    {
      aggregationPeriod: 'DAILY',
      startTime: { year: 2026, month: 10, day: 22 },
      dimensions: [{ dimension: 'versionCode', int64Value: '14' }],
      metrics: [
        { metric: 'crashRate', decimalValue: { value: '0.006' } },
        { metric: 'userPerceivedCrashRate', decimalValue: { value: '0.004' } },
        { metric: 'distinctUsers', decimalValue: { value: '31' } },
      ],
    },
  ],
}
const ANR_ROWS = {
  rows: [
    {
      aggregationPeriod: 'DAILY',
      startTime: { year: 2026, month: 10, day: 22 },
      dimensions: [{ dimension: 'versionCode', int64Value: '14' }],
      metrics: [
        { metric: 'anrRate', decimalValue: { value: '0.002' } },
        { metric: 'userPerceivedAnrRate', decimalValue: { value: '0.001' } },
        { metric: 'distinctUsers', decimalValue: { value: '31' } },
      ],
    },
  ],
}
const ISSUES_PAYLOAD = {
  errorIssues: [
    {
      name: 'apps/com.everloreapp/issues/abc123',
      type: 'CRASH',
      cause: 'java.lang.IllegalStateException',
      location: 'com.everloreapp.MainActivity.onCreate',
      errorReportCount: '3',
      distinctUsers: '2',
      lastErrorReportTime: '2026-10-22T04:00:00Z',
      lastAppVersion: { versionCode: '14' },
      sampleErrorReports: [],
    },
  ],
}

const VITALS_KEYS = ['available', 'reason_kind', 'reason', 'last_updated', 'rates', 'issues'] as const
const RATE_KEYS = ['date', 'version_code', 'crash_rate', 'anr_rate', 'users'] as const
const ISSUE_KEYS = ['id', 'type', 'cause', 'location', 'reports', 'users', 'last_seen', 'versions'] as const

// A credential has to *exist* for the reader to reach Play at all. The token is
// injected in these checks, so this value is never parsed or signed with.
const originalCredential = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = '{"client_email":"audit@p.invalid","private_key":"offline"}'

await check('§5: an empty report says no_data rather than "no crashes"', async () => {
  const request = (async () => Response.json({ rows: [] })) as unknown as typeof fetch
  await assert.rejects(
    () => loadPlayVitals(async () => 'offline-token', new Date(), request),
    (error: Error) => (error as Doc).kind === 'no_data',
  )

  const reader = createVitalsReader(async () => emptyVitals('no_data'))
  const report = await reader()
  keys(report, VITALS_KEYS, 'vitals')
  assert.equal(report.available, false)
  assert.equal(report.reason_kind, 'no_data')
  assert.deepEqual(report.rates, [])
  assert.deepEqual(report.issues, [])
})

await check('§5: the rate sets merge by day and version, and issues are grouped', async () => {
  const urls: string[] = []
  const bodies: Doc[] = []
  const request = (async (input: string, init: RequestInit = {}) => {
    const url = String(input)
    urls.push(url)
    if (init.body) bodies.push(JSON.parse(String(init.body)))
    if (url.includes('crashRateMetricSet')) return Response.json(CRASH_ROWS)
    if (url.includes('anrRateMetricSet')) return Response.json(ANR_ROWS)
    return Response.json(ISSUES_PAYLOAD)
  }) as unknown as typeof fetch

  const report = await loadPlayVitals(async (scope: string) => {
    assert.equal(scope, 'https://www.googleapis.com/auth/playdeveloperreporting')
    return 'offline-token'
  }, new Date('2026-10-23T12:00:00Z'), request)

  keys(report, VITALS_KEYS, 'vitals')
  assert.equal(report.available, true)
  assert.equal(report.reason_kind, null)
  assert.equal(report.last_updated, '2026-10-23T12:00:00.000Z')

  assert.equal(report.rates.length, 1)
  const rate = report.rates[0]
  keys(rate, RATE_KEYS, 'vitals rate')
  assert.deepEqual(rate, { date: '2026-10-22', version_code: 14, crash_rate: 0.004, anr_rate: 0.001, users: 31 })

  assert.equal(report.issues.length, 1)
  const issue = report.issues[0]
  keys(issue, ISSUE_KEYS, 'vitals issue')
  assert.deepEqual(issue, {
    id: 'abc123',
    type: 'CRASH',
    cause: 'java.lang.IllegalStateException',
    location: 'com.everloreapp.MainActivity.onCreate',
    reports: 3,
    users: 2,
    last_seen: '2026-10-22T04:00:00Z',
    versions: [14],
  })

  // The documented request bodies.
  const crashBody = bodies[0]
  assert.deepEqual(crashBody.timelineSpec.aggregationPeriod, 'DAILY')
  assert.deepEqual(crashBody.timelineSpec.startTime, { year: 2026, month: 9, day: 26 })
  assert.deepEqual(crashBody.timelineSpec.endTime, { year: 2026, month: 10, day: 23 })
  assert.deepEqual(crashBody.dimensions, ['versionCode'])
  assert.deepEqual(crashBody.metrics, ['crashRate', 'userPerceivedCrashRate', 'distinctUsers'])
  assert.equal(crashBody.timelineSpec.timeZone, undefined, 'DAILY defaults to America/Los_Angeles')
  assert.deepEqual(bodies[1].metrics, ['anrRate', 'userPerceivedAnrRate', 'distinctUsers'])

  assert(urls[0].endsWith('/apps/com.everloreapp/crashRateMetricSet:query'))
  assert(urls[1].endsWith('/apps/com.everloreapp/anrRateMetricSet:query'))
  const issuesUrl = new URL(urls[2])
  assert(issuesUrl.pathname.endsWith('/apps/com.everloreapp/errorIssues:search'))
  assert.equal(issuesUrl.searchParams.get('interval.startTime.hours'), '0')
  assert.equal(issuesUrl.searchParams.get('interval.startTime.year'), '2026')
  assert.equal(issuesUrl.searchParams.get('orderBy'), 'errorReportCount desc')
})

await check('§5: a 403 is forbidden, and no upstream body reaches the console', async () => {
  const leaks = 'Forbidden for fake-reader@example.invalid, token fake-token-123'
  const request = (async () => new Response(leaks, { status: 403 })) as unknown as typeof fetch
  await assert.rejects(
    () => loadPlayVitals(async () => 'fake-token-123', new Date(), request),
    (error: Error) => (error as Doc).kind === 'forbidden' && !error.message.includes(leaks),
  )

  const reader = createVitalsReader(async () => emptyVitals('forbidden'))
  const report = await reader()
  assert.equal(report.available, false)
  assert.equal(report.reason_kind, 'forbidden')
  assert(!JSON.stringify(report).includes(leaks))
  assert(!JSON.stringify(report).includes('fake-token-123'))
})

await check('§5: an unconfigured server never calls Play at all', async () => {
  const original = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
  let calls = 0
  try {
    env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = ''
    await assert.rejects(
      () => loadPlayVitals(async () => { calls++; return 'token' }, new Date(), (async () => Response.json({})) as typeof fetch),
      (error: Error) => (error as Doc).kind === 'not_configured',
    )
    assert.equal(calls, 0)
  } finally {
    env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = original
  }
  await assert.rejects(
    () => loadPlayVitals(async () => { throw new HttpError(503, 'private credential details') }, new Date(),
      (async () => Response.json({})) as typeof fetch),
    (error: Error) => (error as Doc).kind === 'not_configured' && !error.message.includes('private'),
  )
})

await check('§5: successes cache six hours and failures fifteen minutes', async () => {
  let clock = 0
  let calls = 0
  const ok = createVitalsReader(async () => {
    calls++
    return {
      available: true, reason_kind: null, reason: null, last_updated: new Date(clock).toISOString(), rates: [], issues: [],
    }
  }, () => clock)
  const first = await ok()
  const second = await ok()
  assert.deepEqual(first, second)
  assert.equal(calls, 1)
  clock = 6 * 60 * 60_000 - 1
  await ok()
  assert.equal(calls, 1)
  clock++
  await ok()
  assert.equal(calls, 2)

  clock = 0
  calls = 0
  const bad = createVitalsReader(async () => {
    calls++
    throw new Error('offline')
  }, () => clock)
  const failed = await bad()
  assert.equal(failed.reason_kind, 'error')
  await bad()
  assert.equal(calls, 1)
  clock = 15 * 60_000
  await bad()
  assert.equal(calls, 2)
})

await check('§4.6a: the vitals route answers the §5 shape', async () => {
  env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = originalCredential
  const response = await get('/admin/analytics/vitals')
  assert.equal(response.status, 200)
  keys(response.body, VITALS_KEYS, 'vitals route')
  assert.equal(response.body.available, false, 'no service account in an offline run')
  assert.equal(response.body.reason_kind, 'not_configured')
})

// ─────────────────────────────────────────────────────────────────────────────
// Median helper — the arithmetic the screens table depends on
// ─────────────────────────────────────────────────────────────────────────────

await check('§4.6a: a histogram median is the middle view, and whole seconds are exact', () => {
  assert.equal(medianFromHist({}), 0)
  assert.equal(medianFromHist({ 1: 3 }), 1000)
  assert.equal(medianFromHist({ 1: 2, 2: 1 }), 1000)
  assert.equal(medianFromHist({ 1: 1, 3: 2 }), 3000)
  assert.equal(medianFromHist({ 21_600: 3 }), 21_600_000, 'the last bucket is the six-hour cap')
  assert.equal(medianFromHist({ 0: 1, 21_600: 1 }), 0, 'an even count takes the lower middle')
})

// ─────────────────────────────────────────────────────────────────────────────
// A last guard: the analytics service refuses the same windows the route does.
// ─────────────────────────────────────────────────────────────────────────────

await check('§4.6a: the service validates days and views itself, not only the route', async () => {
  reset()
  await assert.rejects(() => analyticsService.screens('6'), HttpLikeError)
  await assert.rejects(() => analyticsService.errors('nonsense'), HttpLikeError)
  await assert.rejects(() => analyticsService.errorDetail('short'), HttpLikeError)
  await assert.rejects(() => analyticsService.sessions({ user_id: 'not-an-id' }), HttpLikeError)
  assert.deepEqual(STORY_TURN_TYPES, ['narration', 'intimate', 'travel', 'calendar_tick'])
})

function HttpLikeError(error: unknown): boolean {
  return error instanceof HttpError && error.statusCode === 400
}

console.log(`\ntelemetry-admin: ${failures === 0 ? 'ALL GREEN' : `${failures} FAILED`} (${passed} passed)`)
process.exit(failures === 0 ? 0 : 1)
