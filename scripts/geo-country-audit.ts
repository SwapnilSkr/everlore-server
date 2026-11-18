/**
 * Pure audit: country capture on telemetry sessions and users, and the offline
 * lookup behind it (`everlore-docs/phases/admin-insights.md`, "Contract, part 3").
 *
 * What this proves, in the contract's terms:
 *   - known public IPv4 and IPv6 addresses resolve to their ISO code from the
 *     committed DB-IP file;
 *   - private, loopback, link-local, multicast, reserved and malformed addresses
 *     resolve to nothing, before the database is even consulted;
 *   - a batch from a forwarded public address stores `country` on the session and
 *     on the user, and stores no address anywhere — not in a document, not in a
 *     log line;
 *   - `signup_country` is set once and survives a later, different country;
 *   - a second batch on the same UTC day does not rewrite the user, and a batch
 *     the next day moves `country` without touching `signup_country`;
 *   - a missing database disables the lookup with one warning and no throw.
 *
 * No Mongo, no Redis, no network, no env: `mongoColl` is an in-memory store, the
 * optional-auth plugin is a header stand-in, Redis is a counting fake, and the
 * logger is captured so the address scan can see it. The route is mounted on a
 * fresh Elysia and driven through `.handle()`, so the status is the real one.
 *
 * Each check is shown to bite: the pure parts run against mutated copies of their
 * own source, and the route-level assertions are shown to reject a deliberately
 * broken document.
 *
 * Run with: `bun --no-env-file run scripts/geo-country-audit.ts`
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObjectId } from 'mongodb'
import { Elysia } from 'elysia'

type Doc = Record<string, any>

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const GEO_DIR = join(root, 'data', 'geo')

// ─────────────────────────────────────────────────────────────────────────────
// An in-memory Mongo with exactly the operators this feature's writes use:
// equality and `$exists`, dotted paths, upserts, and the update operators the
// session, install and user rows rely on.
// ─────────────────────────────────────────────────────────────────────────────

const COLL_NAMES = [
  'app_events',
  'app_sessions',
  'app_installs',
  'app_errors',
  'app_error_groups',
  'app_error_counters',
  'users',
] as const
type CollName = (typeof COLL_NAMES)[number]

const store = Object.fromEntries(
  COLL_NAMES.map((name) => [name, [] as Doc[]]),
) as Record<CollName, Doc[]>

let userWrites = 0

function reset(): void {
  for (const name of COLL_NAMES) store[name] = []
  userWrites = 0
  redisData.clear()
  logs.length = 0
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

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const value = getPath(doc, key)
    if (isOperator(cond) && '$exists' in cond) return (value !== undefined) === cond.$exists
    return valueEquals(value, cond)
  })
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
    for (const [key, value] of Object.entries((update.$setOnInsert ?? {}) as Doc)) setPath(next, key, clone(value))
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
  return next
}

function seedFromFilter(filter: Doc): Doc {
  const seed: Doc = {}
  for (const [key, value] of Object.entries(filter)) {
    if (!isOperator(value)) setPath(seed, key, clone(value))
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
      store[name].push(next)
      return { acknowledged: true, insertedId: next._id }
    },
    findOne: async (filter: Doc, opts: { projection?: Doc } = {}) => {
      const found = store[name].find((doc) => matches(doc, filter))
      return found ? project(clone(found), opts.projection) : null
    },
    updateOne: async (filter: Doc, update: Doc, opts: { upsert?: boolean } = {}) => {
      const index = store[name].findIndex((doc) => matches(doc, filter))
      if (index >= 0) {
        store[name][index] = applyUpdate(store[name][index], update, false)
        if (name === 'users') userWrites++
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
      }
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
      const inserted = applyUpdate(seedFromFilter(filter), update, true)
      if (inserted._id === undefined) inserted._id = new ObjectId()
      store[name].push(inserted)
      if (name === 'users') userWrites++
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
    },
    updateMany: async (filter: Doc, update: Doc) => {
      let modified = 0
      store[name] = store[name].map((doc) => {
        if (!matches(doc, filter)) return doc
        modified++
        return applyUpdate(doc, update, false)
      })
      return { matchedCount: modified, modifiedCount: modified }
    },
    deleteMany: async (filter: Doc) => {
      const kept = store[name].filter((doc) => !matches(doc, filter))
      const deleted = store[name].length - kept.length
      store[name] = kept
      return { deletedCount: deleted }
    },
  }
}

const docs = (name: CollName): Doc[] => store[name].map((doc) => clone(doc))

// ─────────────────────────────────────────────────────────────────────────────
// Fakes for everything the route touches that is not under test.
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

type LogCall = { level: string; message: string; fields: Record<string, unknown> }
const logs: LogCall[] = []
const capture = (level: string) => (message: string, fields: Record<string, unknown> = {}) => {
  logs.push({ level, message, fields })
}

const auditAuthPlugin = new Elysia({ name: 'geo-audit-auth' }).derive(
  { as: 'global' },
  ({ headers }) => ({
    user: headers['x-audit-user']
      ? { id: headers['x-audit-user'], email: '', username: '', tier: 'free' }
      : null,
  }),
)

mock.module('../src/config/env', () => ({
  env: { CHAT_RATE_MAX: 60, TEMPLATE_CREATE_RATE_MAX: 5, DISABLE_OTP_RATE_LIMIT: false },
}))
mock.module('../src/config/redis', () => ({ getRedisClient: () => fakeRedis }))
mock.module('../src/utils/logger', () => ({
  log: { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') },
}))
mock.module('../src/middleware/auth', () => ({ authPlugin: auditAuthPlugin }))
mock.module('../src/config/mongo', () => ({
  mongoColl: {
    appEvents: () => fakeColl('app_events'),
    appSessions: () => fakeColl('app_sessions'),
    appInstalls: () => fakeColl('app_installs'),
    appErrors: () => fakeColl('app_errors'),
    appErrorGroups: () => fakeColl('app_error_groups'),
    appErrorCounters: () => fakeColl('app_error_counters'),
    users: () => fakeColl('users'),
  },
}))

const { telemetryRoutes } = await import('../src/routes/telemetry.routes')
const { countryOf, isPrivateOrReserved, loadCountryLookup } = await import('../src/services/geo-country.service')

const app = new Elysia().use(telemetryRoutes)

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures and helpers
// ─────────────────────────────────────────────────────────────────────────────

const INSTALL = '11111111-1111-4111-8111-111111111111'
const USER_A = new ObjectId('64b7f0c2a1b2c3d4e5f60718')
const DEVICE = { os: 'android', os_version: '35', model: 'SM-A155F', form: 'phone', locale: 'en-IN' }
const APP = { version: '1.0.11', build: 14 }

/** Countries this DB-IP month resolves these to; the update script checks the same pair. */
const PUBLIC_IN = '49.36.1.1'
const PUBLIC_US_V4 = '8.8.8.8'
const PUBLIC_US_V6 = '2606:4700:4700::1111'

let idSeq = 0
function uuid(): string {
  idSeq += 1
  return `00000000-0000-4000-8000-${String(idSeq).padStart(12, '0')}`
}

const today = (): string => new Date().toISOString().slice(0, 10)

function envelope(session: string, overrides: Doc = {}): Doc {
  return {
    install_id: INSTALL,
    session_id: session,
    app: { ...APP },
    device: { ...DEVICE },
    sent_at: new Date().toISOString(),
    events: [{ id: uuid(), seq: 1, at: new Date(Date.now() - 60_000).toISOString(), name: 'first_open' }],
    errors: [],
    ...overrides,
  }
}

function seedUser(extra: Doc = {}): void {
  store.users.push({
    _id: new ObjectId(USER_A.toHexString()),
    username: 'player-a',
    password_hash: '',
    providers: [],
    tier: 'free',
    token_balance: 0,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  })
}

async function post(payload: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const response = await app.handle(
    new Request('http://localhost/app/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    }),
  )
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

const sessionById = (id: string): Doc | undefined => docs('app_sessions').find((row) => row._id === id)
const userDoc = (): Doc => docs('users')[0]

function assertSessionCountry(session: Doc | undefined, expected: string): void {
  assert.ok(session, 'session row was not written')
  assert.equal(session!.country, expected)
}

function assertUserCountry(user: Doc, latest: string, signup: string): void {
  assert.equal(user.country, latest)
  assert.equal(user.signup_country, signup)
}

/** Nothing that looks like a literal null may be stored (AGENTS §3). */
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

function assertNoAddress(target: unknown, address: string): void {
  assert.ok(!JSON.stringify(target).includes(address), `the address ${address} was stored`)
}

function assertNoAddressLogged(address: string): void {
  assert.ok(!JSON.stringify(logs).includes(address), `the address ${address} reached the log`)
}

function assertPrivate(fn: (address: string) => boolean): void {
  for (const address of [
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    'ff02::1',
  ]) {
    assert.equal(fn(address), true, `${address} must be private or reserved`)
  }
  assert.equal(fn('8.8.8.8'), false)
  assert.equal(fn('2606:4700:4700::1111'), false)
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let failures = 0
async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}: ${(error as Error).message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The lookup
// ─────────────────────────────────────────────────────────────────────────────

await check('lookup: the committed database loads', () => {
  assert.equal(loadCountryLookup(), true)
})

await check('lookup: known public IPv4 addresses resolve', () => {
  assert.equal(countryOf(PUBLIC_US_V4), 'US')
  assert.equal(countryOf(PUBLIC_IN), 'IN')
})

await check('lookup: a known public IPv6 address resolves', () => {
  assert.equal(countryOf(PUBLIC_US_V6), 'US')
})

await check('lookup: private, loopback, link-local, reserved and malformed resolve to nothing', () => {
  for (const address of [
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '2001:db8::1',
    '::ffff:10.0.0.1',
    '999.1.1.1',
    '1.2.3.4.5',
    'not-an-address',
    'unknown',
    '',
  ]) {
    assert.equal(countryOf(address), undefined, `${address} must not resolve`)
  }
  assert.equal(countryOf(undefined), undefined)
})

await check('lookup: the reserved-range test itself names every block', () => {
  assertPrivate(isPrivateOrReserved)
})

// ─────────────────────────────────────────────────────────────────────────────
// Ingest
// ─────────────────────────────────────────────────────────────────────────────

await check('ingest: a forwarded public address puts country on the session and the user', async () => {
  reset()
  seedUser()
  const session = uuid()
  const reply = await post(envelope(session), { 'x-forwarded-for': PUBLIC_IN, 'x-audit-user': USER_A.toHexString() })
  assert.equal(reply.status, 202)
  assert.equal(reply.body.accepted, 1)

  assertSessionCountry(sessionById(session), 'IN')
  const user = userDoc()
  assertUserCountry(user, 'IN', 'IN')
  assert.equal(user.country_day, today())
})

await check('ingest: the address is stored nowhere and logged nowhere', async () => {
  reset()
  seedUser()
  await post(envelope(uuid()), { 'x-forwarded-for': PUBLIC_IN, 'x-audit-user': USER_A.toHexString() })
  assertNoAddress(store, PUBLIC_IN)
  assertNoAddressLogged(PUBLIC_IN)
})

await check('ingest: no explicit null is written to a session or a user', async () => {
  reset()
  seedUser()
  await post(envelope(uuid()), { 'x-forwarded-for': PUBLIC_IN, 'x-audit-user': USER_A.toHexString() })
  assertNoNullish(sessionById(docs('app_sessions')[0]._id), 'app_sessions[0]')
  assertNoNullish(userDoc(), 'users[0]')
})

await check('ingest: a batch from a private address leaves country off everything', async () => {
  reset()
  seedUser()
  const session = uuid()
  await post(envelope(session), { 'x-forwarded-for': '10.0.0.7', 'x-audit-user': USER_A.toHexString() })
  const row = sessionById(session)
  assert.ok(row, 'the session was still written')
  assert.equal(Object.hasOwn(row!, 'country'), false)
  assert.equal(Object.hasOwn(userDoc(), 'country'), false)
  assert.equal(Object.hasOwn(userDoc(), 'signup_country'), false)
})

await check('ingest: an anonymous batch records the session country without a user write', async () => {
  reset()
  const session = uuid()
  await post(envelope(session), { 'x-forwarded-for': PUBLIC_IN })
  assertSessionCountry(sessionById(session), 'IN')
  assert.equal(docs('users').length, 0)
})

await check('ingest: a second batch the same day does not rewrite the user', async () => {
  reset()
  seedUser()
  await post(envelope(uuid()), { 'x-forwarded-for': PUBLIC_IN, 'x-audit-user': USER_A.toHexString() })
  const writes = userWrites
  assert.ok(writes > 0, 'the first batch must write the user')

  const session = uuid()
  await post(envelope(session), { 'x-forwarded-for': PUBLIC_US_V4, 'x-audit-user': USER_A.toHexString() })
  assert.equal(userWrites, writes, 'the same UTC day must not write the user again')
  assertUserCountry(userDoc(), 'IN', 'IN')
  // The session itself is new, so it still learns this batch's country.
  assertSessionCountry(sessionById(session), 'US')
})

await check('ingest: the next day moves country but never signup_country', async () => {
  reset()
  seedUser()
  await post(envelope(uuid()), { 'x-forwarded-for': PUBLIC_IN, 'x-audit-user': USER_A.toHexString() })
  assertUserCountry(userDoc(), 'IN', 'IN')

  // Simulate the next UTC day without moving the clock: only the day marker changes.
  store.users[0].country_day = '2000-01-01'

  await post(envelope(uuid()), { 'x-forwarded-for': PUBLIC_US_V4, 'x-audit-user': USER_A.toHexString() })
  const user = userDoc()
  assertUserCountry(user, 'US', 'IN')
  assert.equal(user.country_day, today())
})

// ─────────────────────────────────────────────────────────────────────────────
// A missing database
// ─────────────────────────────────────────────────────────────────────────────

await check('missing database: disables the lookup, warns once, and never throws', async () => {
  const warnings = logs.filter((line) => line.level === 'warn').length
  const missing = join(tmpdir(), `everlore-geo-missing-${Date.now()}`)

  assert.equal(loadCountryLookup(missing), false)
  assert.equal(countryOf(PUBLIC_US_V4), undefined)
  assert.equal(logs.filter((line) => line.level === 'warn').length, warnings + 1, 'one warning')

  assert.equal(loadCountryLookup(`${missing}-again`), false)
  assert.equal(logs.filter((line) => line.level === 'warn').length, warnings + 1, 'still one warning')

  reset()
  seedUser()
  const session = uuid()
  await post(envelope(session), { 'x-forwarded-for': PUBLIC_IN, 'x-audit-user': USER_A.toHexString() })
  const row = sessionById(session)
  assert.ok(row, 'ingest still works with the lookup disabled')
  assert.equal(Object.hasOwn(row!, 'country'), false)
  assert.equal(Object.hasOwn(userDoc(), 'country'), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// The audit bites: mutated copies of the real code, and assertions shown to
// reject a deliberately broken document.
// ─────────────────────────────────────────────────────────────────────────────

const mutants: string[] = []

function mutantFile(directory: string, label: string, sourceName: string, from: string, to: string): string {
  const original = readFileSync(join(root, directory, sourceName), 'utf8')
  assert.equal(original.split(from).length, 2, `mutation anchor for ${label} not found exactly once`)
  const file = join(root, directory, `${label}.ts`)
  writeFileSync(file, original.replace(from, to))
  mutants.push(file)
  return file
}

try {
  await check('bites: dropping a private range from the guard fails the reserved-range check', async () => {
    const file = mutantFile('src/services', 'geo-country.mutant-private', 'geo-country.service.ts', '      a === 10 ||\n', '')
    const mutant = await import(file)
    assert.throws(() => assertPrivate(mutant.isPrivateOrReserved))
  })

  await check('bites: a lookup that ignores a missing file fails the disabled check', async () => {
    const file = mutantFile(
      'src/services',
      'geo-country.mutant-missing',
      'geo-country.service.ts',
      '  attempted = true\n  reader = null\n',
      '  attempted = true\n',
    )
    const mutant = await import(file)
    assert.equal(mutant.loadCountryLookup(GEO_DIR), true)
    assert.equal(mutant.loadCountryLookup(join(tmpdir(), 'everlore-not-here')), false)
    assert.throws(() => assert.equal(mutant.countryOf(PUBLIC_US_V4), undefined))
  })

  await check('bites: a session written without its country fails the session check', async () => {
    reset()
    seedUser()
    const file = mutantFile(
      'src/services/telemetry',
      'ingest.mutant-audit',
      'ingest.service.ts',
      '  if (country) set.country = country\n',
      '',
    )
    const { telemetryService } = await import(file)
    const session = uuid()
    const batch = { install_id: INSTALL, session_id: session, app: { ...APP }, device: { ...DEVICE }, events: [], errors: [] }
    await telemetryService.ingest(batch, USER_A.toHexString(), PUBLIC_IN)
    assert.throws(() => assertSessionCountry(sessionById(session), 'IN'))
  })

  await check('bites: writing country twice in one day fails the once-a-day check', async () => {
    reset()
    seedUser({ country: 'IN', country_day: today(), signup_country: 'IN' })
    const file = mutantFile(
      'src/services/telemetry',
      'user-country.mutant-day',
      'user-country.service.ts',
      '    if (user.country_day !== day) {',
      '    if (true) {',
    )
    const { recordUserCountry } = await import(file)
    const before = userWrites
    await recordUserCountry(USER_A, 'IN', today())
    assert.throws(() => assert.equal(userWrites - before, 0))
  })

  await check('bites: overwriting signup_country fails the signup check', async () => {
    reset()
    seedUser({ country: 'IN', country_day: '2000-01-01', signup_country: 'IN' })
    const file = mutantFile(
      'src/services/telemetry',
      'user-country.mutant-signup',
      'user-country.service.ts',
      '    if (user.signup_country === undefined) update.signup_country = country',
      '    update.signup_country = country',
    )
    const { recordUserCountry } = await import(file)
    await recordUserCountry(USER_A, 'US', today())
    assert.throws(() => assertUserCountry(userDoc(), 'US', 'IN'))
  })

  await check('bites: a polluted document fails the address scan', () => {
    reset()
    const polluted = clone(store) as Record<string, Doc[]>
    polluted.app_sessions.push({ _id: uuid(), address: PUBLIC_IN })
    assert.throws(() => assertNoAddress(polluted, PUBLIC_IN))
  })
} finally {
  for (const file of mutants) rmSync(file, { force: true })
}

console.log(failures === 0 ? '\ngeo-country: ALL GREEN' : `\ngeo-country: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
