/**
 * Review accounts are flagged and left out of player numbers by default.
 *
 * What this proves, in the contract's own terms:
 *   - the rule: a phone-shaped name matches, a name with a letter never does,
 *     too few digits never does, and an unset review phone never matches;
 *   - the Mongo filter the sweep uses and the pure rule agree on every sample;
 *   - `updatePreferences` flags a phone-shaped name, not a normal one, and a
 *     later normal rename keeps the flag;
 *   - the sweep flags exactly the matching unflagged rows, twice is a no-op;
 *   - `/admin/users` hides a flagged row by default and `total` follows, `only`
 *     and `include` show it, and a bad value is a 400 sentence;
 *   - metrics and the overview summary leave a reviewer's turns out of the
 *     headline figures, and `/admin/overview` leaves them out of its counts;
 *   - the funnel leaves a reviewer guest out of `started` and their install out
 *     of first opens; sessions hide theirs by default and mark them in `only`;
 *   - the daily rollup leaves a reviewer install's events out of every count,
 *     but still counts their crash;
 *   - the backfill script's dry run prints without full phone numbers, and its
 *     `--apply` writes exactly what the sweep writes.
 *
 * No Mongo, no Redis, no network: `mongoColl` is an in-memory store that
 * evaluates the filters and the aggregation pipelines these services send.
 *
 *   bun --no-env-file run scripts/reviewer-accounts-audit.ts
 */
import assert from 'node:assert/strict'
import { ObjectId } from 'mongodb'
import { Elysia } from 'elysia'
import { env } from '../src/config/env'
import { mongoColl } from '../src/config/mongo'
import { HttpError } from '../src/utils/http-error'
import { authService } from '../src/services/auth.service'
import { adminRoutes } from '../src/routes/admin.routes'
import { adminService } from '../src/services/admin.service'
import { adminMetricsService } from '../src/services/admin-metrics.service'
import { adminOverviewSummaryService } from '../src/services/admin-overview-summary.service'
import { analyticsService } from '../src/services/telemetry/analytics.service'
import { appDailyRollupService } from '../src/services/telemetry/rollup.service'
import {
  numberNameFilter,
  resetReviewerScopeCache,
  reviewerAccounts,
  reviewerReason,
  reviewersParam,
  reviewerSweepFilter,
} from '../src/services/reviewer-accounts'
import { maskPhone, parseFlagArgs, planFlags } from './flag-reviewers'

type Doc = Record<string, any>

// ─────────────────────────────────────────────────────────────────────────────
// An in-memory Mongo: equality, the operators these queries use, dotted paths,
// `$set` updates (plain and pipeline), and the aggregation stages the admin
// services send.
// ─────────────────────────────────────────────────────────────────────────────

const store: Record<string, Doc[]> = {}

const rows = (name: string) => (store[name] ??= [])

function clone<T>(value: T): T {
  if (value instanceof ObjectId) return new ObjectId(value.toHexString()) as unknown as T
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T
  if (value instanceof RegExp) return value
  if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Doc = {}
    for (const [key, inner] of Object.entries(value)) out[key] = clone(inner)
    return out as T
  }
  return value
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

function isOperator(value: unknown): value is Doc {
  return !!value && typeof value === 'object' && !(value instanceof ObjectId) &&
    !(value instanceof Date) && !(value instanceof RegExp) && !Array.isArray(value)
}

function sameValue(left: unknown, right: unknown): boolean {
  if (right instanceof ObjectId) return left instanceof ObjectId && left.equals(right)
  if (right instanceof Date) return left instanceof Date && left.getTime() === right.getTime()
  return left === right
}

function valueMatches(docValue: unknown, cond: unknown): boolean {
  // A document array (an install's `user_ids`) matches when any element does.
  if (Array.isArray(docValue) && !Array.isArray(cond)) {
    return docValue.some((item) => sameValue(item, cond))
  }
  return sameValue(docValue, cond)
}

function compare(left: unknown, right: unknown): number {
  const a = left instanceof Date ? left.getTime() : left
  const b = right instanceof Date ? right.getTime() : right
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  const sa = String(a), sb = String(b)
  return sa === sb ? 0 : sa < sb ? -1 : 1
}

function inRange(value: unknown, cond: Doc): boolean {
  if ('$gte' in cond && compare(value, cond.$gte) < 0) return false
  if ('$lte' in cond && compare(value, cond.$lte) > 0) return false
  if ('$gt' in cond && compare(value, cond.$gt) <= 0) return false
  if ('$lt' in cond && compare(value, cond.$lt) >= 0) return false
  return true
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return (cond as Doc[]).some((inner) => matches(doc, inner))
    if (key === '$and') return (cond as Doc[]).every((inner) => matches(doc, inner))
    const value = getPath(doc, key)
    if (isOperator(cond)) {
      if ('$exists' in cond) return (value !== undefined) === cond.$exists
      if ('$ne' in cond) return !valueMatches(value, cond.$ne)
      if ('$in' in cond) return (cond.$in as unknown[]).some((candidate) => valueMatches(value, candidate))
      if ('$nin' in cond) return !(cond.$nin as unknown[]).some((candidate) => valueMatches(value, candidate))
      if ('$regex' in cond) {
        const regex = cond.$regex instanceof RegExp ? cond.$regex : new RegExp(String(cond.$regex), cond.$options ?? '')
        return Array.isArray(value)
          ? value.some((item) => typeof item === 'string' && regex.test(item))
          : typeof value === 'string' && regex.test(value)
      }
      if (Array.isArray(value) && !('$gte' in cond) && !('$lte' in cond) && !('$gt' in cond) && !('$lt' in cond)) {
        return value.some((item) => inRange(item, cond))
      }
      return inRange(value, cond)
    }
    return valueMatches(value, cond)
  })
}

/** Aggregation expressions, for the pipelines the admin readers send. */
function evaluate(expr: unknown, doc: Doc): unknown {
  if (typeof expr === 'string' && expr.startsWith('$')) return getPath(doc, expr.slice(1))
  if (Array.isArray(expr)) return expr.map((item) => evaluate(item, doc))
  if (expr instanceof RegExp) return expr
  if (!isOperator(expr)) return expr
  const keys = Object.keys(expr)
  // A document expression with no operator key is a literal: each value is
  // evaluated, which is how `{ date: …, player: … }` group keys work.
  if (!keys[0].startsWith('$')) {
    return Object.fromEntries(keys.map((key) => [key, evaluate((expr as Doc)[key], doc)]))
  }
  const [op] = keys
  const arg = (expr as Doc)[op]
  switch (op) {
    case '$ifNull': {
      const [first, second] = arg as unknown[]
      const value = evaluate(first, doc)
      return value === null || value === undefined ? evaluate(second, doc) : value
    }
    case '$cond': {
      const [test, yes, no] = arg as unknown[]
      return evaluate(test, doc) ? evaluate(yes, doc) : evaluate(no, doc)
    }
    case '$eq': { const [a, b] = arg as unknown[]; return sameValue(evaluate(a, doc), evaluate(b, doc)) }
    case '$ne': { const [a, b] = arg as unknown[]; return !sameValue(evaluate(a, doc), evaluate(b, doc)) }
    case '$gte': { const [a, b] = arg as unknown[]; return compare(evaluate(a, doc), evaluate(b, doc)) >= 0 }
    case '$gt': { const [a, b] = arg as unknown[]; return compare(evaluate(a, doc), evaluate(b, doc)) > 0 }
    case '$size': return ((evaluate(arg, doc) as unknown[]) ?? []).length
    case '$setUnion': return [...new Set((arg as unknown[]).flatMap((item) => (evaluate(item, doc) as unknown[]) ?? []))]
    case '$dateToString': {
      const spec = arg as Doc
      return utcDayOf(evaluate(spec.date, doc) as Date)
    }
    case '$first': return ((arg as unknown[]).map((item) => evaluate(item, doc))[0] ?? undefined)
    case '$regexMatch': {
      const spec = arg as Doc
      const regex = spec.regex instanceof RegExp ? spec.regex : new RegExp(String(spec.regex), spec.options ?? '')
      return regex.test(String(evaluate(spec.input, doc) ?? ''))
    }
    default: throw new Error(`unsupported expression ${op}`)
  }
}

function utcDayOf(when: Date): string {
  return new Date(when).toISOString().slice(0, 10)
}

function groupBy(docs: Doc[], spec: Doc): Doc[] {
  const keyId = (key: unknown): string => {
    if (key instanceof ObjectId) return key.toHexString()
    if (key instanceof Date) return key.toISOString()
    if (key && typeof key === 'object') {
      return `{${Object.entries(key as Doc).map(([name, value]) => `${name}:${keyId(value)}`).join(',')}}`
    }
    return JSON.stringify(key) ?? 'null'
  }
  const buckets = new Map<string, { key: unknown; rows: Doc[] }>()
  for (const doc of docs) {
    const key = spec._id === null ? null : evaluate(spec._id, doc)
    const id = spec._id === null ? 'null' : keyId(key)
    if (!buckets.has(id)) buckets.set(id, { key, rows: [] })
    buckets.get(id)!.rows.push(doc)
  }
  if (docs.length === 0 && spec._id === null) return []
  return [...buckets.values()].map(({ key, rows: bucket }) => {
    const out: Doc = { _id: key }
    for (const [field, accumulator] of Object.entries(spec)) {
      if (field === '_id') continue
      out[field] = accumulate(bucket, accumulator as Doc, field)
    }
    return out
  })
}

function accumulate(docs: Doc[], accumulator: Doc, fallbackField: string): unknown {
  const [op] = Object.keys(accumulator)
  const arg = (accumulator as Doc)[op] ?? `$${fallbackField}`
  if (op === '$sum') {
    return docs.reduce((sum, doc) => sum + Number(evaluate(arg, doc) ?? 0), 0)
  }
  if (op === '$max') {
    const values = docs.map((doc) => evaluate(arg, doc)).filter((value) => value !== undefined)
    return values.reduce((best, value) => (best === undefined || compare(value, best) > 0 ? value : best), undefined)
  }
  if (op === '$first') return docs.length > 0 ? evaluate(arg, docs[0]) : undefined
  throw new Error(`unsupported accumulator ${op}`)
}

/**
 * `$lookup`, `$set`, `$project` and `$unwind` pass documents through: what this
 * audit grades is which rows a filter keeps, not the shape a projection trims.
 */
function aggregate(input: Doc[], pipeline: Doc[]): Doc[] {
  let docs = input
  for (const stage of pipeline) {
    if ('$match' in stage) docs = docs.filter((doc) => matches(doc, stage.$match))
    else if ('$sort' in stage) {
      const entries = Object.entries(stage.$sort as Doc)
      docs = [...docs].sort((left, right) => {
        for (const [key, direction] of entries) {
          const order = compare(getPath(left, key), getPath(right, key))
          if (order !== 0) return Number(direction) < 0 ? -order : order
        }
        return 0
      })
    } else if ('$skip' in stage) docs = docs.slice(stage.$skip)
    else if ('$limit' in stage) docs = docs.slice(0, stage.$limit)
    else if ('$group' in stage) docs = groupBy(docs, stage.$group)
    else if ('$facet' in stage) {
      const out: Doc = {}
      for (const [key, sub] of Object.entries(stage.$facet as Record<string, Doc[]>)) out[key] = aggregate(docs, sub)
      docs = [out]
    }
  }
  return docs
}

function applyUpdate(doc: Doc, update: Doc | Doc[]): Doc {
  const next = clone(doc)
  const setOf = (update: Doc | Doc[]) => {
    if (Array.isArray(update)) return update[0].$set as Doc
    return (update.$set ?? {}) as Doc
  }
  const set = setOf(update)
  for (const [key, value] of Object.entries(set)) {
    setPath(next, key, Array.isArray(update) ? evaluate(value, doc) : clone(value))
  }
  if (!Array.isArray(update)) {
    for (const key of Object.keys((update.$unset ?? {}) as Doc)) {
      const parts = key.split('.')
      const parent = parts.length > 1 ? getPath(next, parts.slice(0, -1).join('.')) as Doc : next
      if (parent) delete parent[parts[parts.length - 1]]
    }
  }
  return next
}

function fakeColl(name: string) {
  const project = (doc: Doc, projection?: Doc) => {
    const copy = clone(doc)
    if (!projection) return copy
    const out: Doc = {}
    if (projection._id !== 0 && copy._id !== undefined) out._id = copy._id
    for (const key of Object.keys(projection)) {
      if (key === '_id') continue
      const value = getPath(copy, key)
      if (value !== undefined) setPath(out, key, value)
    }
    return out
  }
  const cursor = (matched: Doc[], projection?: Doc) => ({
    sort(spec: Doc) {
      const entries = Object.entries(spec)
      return cursor([...matched].sort((left, right) => {
        for (const [key, direction] of entries) {
          const order = compare(getPath(left, key), getPath(right, key))
          if (order !== 0) return Number(direction) < 0 ? -order : order
        }
        return 0
      }), projection)
    },
    limit(count: number) { return cursor(matched.slice(0, count), projection) },
    async toArray() { return matched.map((doc) => project(doc, projection)) },
  })
  return {
    find: (filter: Doc = {}, opts: { projection?: Doc } = {}) =>
      cursor(rows(name).filter((doc) => matches(doc, filter)), opts.projection),
    async findOne(filter: Doc, opts: { sort?: Doc; projection?: Doc } = {}) {
      let matched = rows(name).filter((doc) => matches(doc, filter))
      if (opts.sort) matched = aggregate(matched, [{ $sort: opts.sort }])
      return matched[0] ? project(matched[0], opts.projection) : null
    },
    async countDocuments(filter: Doc = {}) {
      return rows(name).filter((doc) => matches(doc, filter)).length
    },
    async distinct(field: string, filter: Doc = {}) {
      const values: unknown[] = []
      for (const doc of rows(name).filter((doc) => matches(doc, filter))) {
        const value = getPath(doc, field)
        if (value === undefined) continue
        for (const item of Array.isArray(value) ? value : [value]) {
          if (!values.some((seen) => sameValue(seen, item))) values.push(item)
        }
      }
      return values
    },
    aggregate(pipeline: Doc[]) {
      return { async toArray() { return clone(aggregate(rows(name), pipeline)) } }
    },
    async insertOne(doc: Doc) {
      const next = clone(doc)
      if (next._id === undefined) next._id = new ObjectId()
      rows(name).push(next)
      return { acknowledged: true, insertedId: next._id }
    },
    async updateOne(filter: Doc, update: Doc | Doc[]) {
      const index = rows(name).findIndex((doc) => matches(doc, filter))
      if (index < 0) return { matchedCount: 0, modifiedCount: 0 }
      rows(name)[index] = applyUpdate(rows(name)[index], update)
      return { matchedCount: 1, modifiedCount: 1 }
    },
    async updateMany(filter: Doc, update: Doc | Doc[]) {
      let modified = 0
      for (let index = 0; index < rows(name).length; index++) {
        if (!matches(rows(name)[index], filter)) continue
        rows(name)[index] = applyUpdate(rows(name)[index], update)
        modified++
      }
      return { matchedCount: modified, modifiedCount: modified }
    },
    async replaceOne(filter: Doc, doc: Doc) {
      const index = rows(name).findIndex((candidate) => matches(candidate, filter))
      const next = clone(doc)
      if (index >= 0) rows(name)[index] = next
      else rows(name).push(next)
      return { matchedCount: index >= 0 ? 1 : 0 }
    },
    async deleteMany(filter: Doc) {
      const before = rows(name).length
      store[name] = rows(name).filter((doc) => !matches(doc, filter))
      return { deletedCount: before - store[name].length }
    },
  }
}

const COLLECTIONS = [
  'users', 'app_installs', 'app_sessions', 'app_events', 'app_errors', 'app_error_groups',
  'app_error_counters', 'app_daily', 'guest_merges', 'events', 'world_instances', 'world_templates',
  'memories', 'characters',
]

const fakes = Object.fromEntries(COLLECTIONS.map((name) => [name, fakeColl(name)]))
Object.assign(mongoColl, {
  users: () => fakes.users,
  appInstalls: () => fakes.app_installs,
  appSessions: () => fakes.app_sessions,
  appEvents: () => fakes.app_events,
  appErrors: () => fakes.app_errors,
  appErrorGroups: () => fakes.app_error_groups,
  appErrorCounters: () => fakes.app_error_counters,
  appDaily: () => fakes.app_daily,
  guestMerges: () => fakes.guest_merges,
  events: () => fakes.events,
  worldInstances: () => fakes.world_instances,
  worldTemplates: () => fakes.world_templates,
  memories: () => fakes.memories,
  characters: () => fakes.characters,
})

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

const originalEnv = { ...env }
const REAL_PHONE = '+12025550142'

function reset(): void {
  for (const name of COLLECTIONS) store[name] = []
  resetReviewerScopeCache()
  env.REVIEW_DEMO_PHONE = ''
}

/** Seed one user; only the fields a test cares about are passed. */
function user(overrides: Doc = {}): Doc {
  const doc = {
    _id: new ObjectId(),
    username: `player_${Math.random().toString(16).slice(2, 8)}`,
    password_hash: '',
    tier: 'free',
    providers: ['google'],
    preferences: { nsfw_enabled: false, preferred_model: 'gpt-4o', theme: 'dark', narration_length: 'detailed', auto_memory_curation: true },
    token_balance: 0,
    created_at: new Date('2026-11-01T10:00:00Z'),
    updated_at: new Date('2026-11-01T10:00:00Z'),
    ...overrides,
  } as Doc
  rows('users').push(doc)
  return doc
}

const BASIC = `Basic ${Buffer.from('audit-admin:audit-password').toString('base64')}`
const app = new Elysia().onError(({ error, set }) => {
  if (error instanceof HttpError) {
    set.status = error.statusCode
    return { error: error.message }
  }
}).use(adminRoutes)

async function request(path: string) {
  const response = await app.handle(new Request(`http://localhost${path}`, { headers: { authorization: BASIC } }))
  let body: any = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

try {
  env.ADMIN_USERNAME = 'audit-admin'
  env.ADMIN_PASSWORD = 'audit-password'

  // ── The rule ────────────────────────────────────────────────────────────────
  await check('a phone-shaped name matches and a name with a letter never does', () => {
    for (const name of ['+12025550142', '+1 202-555-0142', '(202) 555 0142', '202.555.0142', ' 555 0142 ']) {
      assert.equal(reviewerReason({ player_name: name }, ''), 'number_name', name)
    }
    for (const name of ['Reviewer', 'Jaden', 'Agent 47', 'R2D2 1234567', '123', '', '   ', 'Mira (she/her)',
      'call me 5550142 x', '123456', '(202) 555', '12 34 56']) {
      assert.equal(reviewerReason({ player_name: name }, ''), null, name)
    }
  })

  await check('the review phone matches after normalisation, and only when set', () => {
    assert.equal(reviewerReason({ phone: REAL_PHONE }, REAL_PHONE), 'review_phone')
    assert.equal(reviewerReason({ phone: '+1 202-555-0142' }, REAL_PHONE), 'review_phone')
    assert.equal(reviewerReason({ phone: '+1 (202) 555-0142' }, REAL_PHONE), 'review_phone')
    assert.equal(reviewerReason({ phone: '+12025550143' }, REAL_PHONE), null)
    // An empty review phone arms nothing, even for the number Google uses.
    assert.equal(reviewerReason({ phone: REAL_PHONE }, ''), null)
    assert.equal(reviewerReason({ phone: REAL_PHONE }, undefined), null)
  })

  await check('the Mongo filter and the pure rule agree on the whole sample', () => {
    const filter = numberNameFilter()['preferences.player_name'] as { $regex: string }
    const regex = new RegExp(filter.$regex)
    const sample = [
      '+12025550142', '+1 202-555-0142', '(202) 555 0142', '202.555.0142', ' 555 0142 ',
      'Reviewer', 'Jaden', 'Agent 47', 'R2D2 1234567', '123', '', '   ', 'Mira (she/her)',
      'call me 5550142 x', '1234567', '12 34 56', '+91 98765 43210', 'Mira', 'A1B2C3D4', '123456', '(202) 555',
    ]
    for (const name of sample) {
      const pure = reviewerReason({ player_name: name }, '') === 'number_name'
      assert.equal(regex.test(name), pure, `filter and rule disagree on ${JSON.stringify(name)}`)
    }
  })

  await check('the phone filter agrees with the rule, and is absent when unset', () => {
    const filter = reviewerSweepFilter(REAL_PHONE)
    const branches = filter.$or as Doc[]
    assert.equal(branches.length, 2)
    const regex = new RegExp(branches[0].phone.$regex as string)
    for (const phone of [REAL_PHONE, '+1 202-555-0142', '+1 (202) 555-0142', '+12025550143', '+1202555014', '']) {
      const pure = reviewerReason({ phone }, REAL_PHONE) === 'review_phone'
      assert.equal(regex.test(phone), pure, `filter and rule disagree on ${phone}`)
    }
    assert.equal(reviewerSweepFilter('').$or.length, 1, 'an unset review phone leaves one rule')
  })

  await check('a reviewers value outside the three is a 400 sentence', () => {
    assert.equal(reviewersParam(undefined), 'exclude')
    assert.equal(reviewersParam(''), 'exclude')
    assert.equal(reviewersParam('include'), 'include')
    assert.equal(reviewersParam('only'), 'only')
    assert.throws(() => reviewersParam('nope'), (error) => error instanceof HttpError && error.statusCode === 400 &&
      error.message === 'Reviewers must be exclude, include or only.')
  })

  // ── Flagging on write ───────────────────────────────────────────────────────
  await check('updatePreferences flags a phone-shaped name and not a normal one', async () => {
    const reviewer = user({ preferences: { ...defaultPreferences(), player_name: '+1 202-555-0142' } })
    await authService.updatePreferences(reviewer._id.toHexString(), { player_name: 'Jaden' })
    assert.equal(rows('users')[0].reviewer, undefined, 'a normal name does not flag')

    const plain = user()
    await authService.updatePreferences(plain._id.toHexString(), { player_name: 'Jaden' })
    assert.equal(rows('users')[1].reviewer, undefined)
    assert(!('reviewer' in rows('users')[1]), 'never written as false or null')

    await authService.updatePreferences(plain._id.toHexString(), { player_name: '(202) 555 0142' })
    assert.equal(rows('users')[1].reviewer, true)
    assert.equal(rows('users')[1].reviewer_reason, 'number_name')
    assert(rows('users')[1].reviewer_at instanceof Date)
  })

  await check('a later normal rename keeps the flag and its first date', async () => {
    const flagged = user({ reviewer: true, reviewer_reason: 'number_name', reviewer_at: new Date('2026-11-02T00:00:00Z') })
    await authService.updatePreferences(flagged._id.toHexString(), { player_name: 'Mira' })
    const stored = rows('users').find((row) => row._id.equals(flagged._id))!
    assert.equal(stored.reviewer, true)
    assert.equal(stored.reviewer_reason, 'number_name')
    assert.equal((stored.reviewer_at as Date).toISOString(), '2026-11-02T00:00:00.000Z')
  })

  await check('the sweep flags exactly the matching unflagged rows once', async () => {
    env.REVIEW_DEMO_PHONE = REAL_PHONE
    resetReviewerScopeCache()
    const numberName = user({ preferences: { ...defaultPreferences(), player_name: '202 555 0142' } })
    const reviewPhone = user({ phone: '+1 202-555-0142' })
    const normal = user({ preferences: { ...defaultPreferences(), player_name: 'Mira' } })
    const already = user({ reviewer: true, reviewer_reason: 'number_name', reviewer_at: new Date('2026-10-01T00:00:00Z') })

    assert.equal(await reviewerAccounts.sweep(), 2)
    const byId = (id: ObjectId) => rows('users').find((row) => row._id.equals(id))!
    assert.equal(byId(numberName._id).reviewer_reason, 'number_name')
    assert.equal(byId(reviewPhone._id).reviewer_reason, 'review_phone')
    assert.equal(byId(normal._id).reviewer, undefined)
    assert.equal((byId(already._id).reviewer_at as Date).toISOString(), '2026-10-01T00:00:00.000Z',
      'the first date is kept')
    assert.equal(await reviewerAccounts.sweep(), 0, 'a second sweep has nothing to do')
  })

  // ── The scope ───────────────────────────────────────────────────────────────
  await check('the scope is the flagged users, their installs and their own install', async () => {
    reset()
    const flagged = user({ reviewer: true, reviewer_reason: 'number_name', install_id: 'install-own' })
    const normal = user()
    rows('app_installs').push(
      { _id: 'install-a', first_seen: new Date(), last_seen: new Date(), user_ids: [flagged._id] },
      { _id: 'install-b', first_seen: new Date(), last_seen: new Date(), user_ids: [flagged._id, normal._id] },
      { _id: 'install-c', first_seen: new Date(), last_seen: new Date(), user_ids: [normal._id] },
      { _id: 'install-d', first_seen: new Date(), last_seen: new Date() },
    )
    const scope = await reviewerAccounts.scope()
    assert.deepEqual(scope.userIds.map((id) => id.toHexString()), [flagged._id.toHexString()])
    assert.deepEqual([...scope.installIds].sort(), ['install-a', 'install-b', 'install-own'])
  })

  // ── The Players list ────────────────────────────────────────────────────────
  await check('/admin/users hides a flagged account by default, total follows, and the switch works', async () => {
    reset()
    const flagged = user({ reviewer: true, reviewer_reason: 'review_phone', username: 'reviewer_phone' })
    user({ username: 'normal_player' })

    const hidden = await request('/admin/users')
    assert.equal(hidden.status, 200)
    assert.equal(hidden.body.total, 1)
    assert.deepEqual(hidden.body.items.map((item: Doc) => item.username), ['normal_player'])

    const only = await request('/admin/users?reviewers=only')
    assert.equal(only.status, 200)
    assert.equal(only.body.total, 1)
    assert.deepEqual(only.body.items.map((item: Doc) => item.username), ['reviewer_phone'])
    assert.equal(only.body.items[0].reviewer, true, 'the row carries the flag')
    assert.equal(only.body.items[0].reviewer_reason, 'review_phone')

    const both = await request('/admin/users?reviewers=include')
    assert.equal(both.status, 200)
    assert.equal(both.body.total, 2)
    assert.equal(both.body.items.length, 2)

    const bad = await request('/admin/users?reviewers=nope')
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error, 'Reviewers must be exclude, include or only.')

    // A reviewer stays fully readable by id.
    const detail = await request(`/admin/users/${flagged._id.toHexString()}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.user.reviewer, true)
  })

  // ── Headline numbers ────────────────────────────────────────────────────────
  await check('metrics leave a reviewer\'s turns out of players_ever, story_turns and dau', async () => {
    reset()
    const reviewer = user({ reviewer: true, reviewer_reason: 'number_name' })
    const normal = user()
    const now = new Date()
    const turn = (player: ObjectId) => ({
      _id: new ObjectId(), type: 'narration', player_id: player, instance_id: new ObjectId(),
      created_at: now, sequence: 1, data: {},
    })
    rows('events').push(turn(reviewer._id), turn(reviewer._id), turn(reviewer._id), turn(normal._id))
    const metrics = await adminMetricsService.metrics('30')
    assert.equal(metrics.totals.players_ever, 1, 'only the real player')
    assert.equal(metrics.totals.story_turns, 1)
    assert.equal(metrics.totals.users, 1)
    assert.equal(metrics.active.dau, 1)
    const today = now.toISOString().slice(0, 10)
    const series = metrics.series.find((day) => day.date === today)!
    assert.equal(series.active_players, 1)
    assert.equal(series.story_turns, 1)
  })

  await check('the overview summary leaves a reviewer out of live players and turns', async () => {
    reset()
    const reviewer = user({ reviewer: true, reviewer_reason: 'number_name', last_active_at: new Date() })
    const normal = user({ last_active_at: new Date() })
    const now = new Date()
    rows('events').push(
      { _id: new ObjectId(), type: 'narration', player_id: reviewer._id, created_at: now },
      { _id: new ObjectId(), type: 'narration', player_id: normal._id, created_at: now },
    )
    const summary = await adminOverviewSummaryService.summary(now, async () => ({ usd: 0, calls: 0, unpriced: 0 }))
    assert.equal(summary.live_players, 1)
    assert.equal(summary.turns_today, 1)
  })

  await check('/admin/overview leaves review accounts out of its user, save and event counts', async () => {
    reset()
    const reviewer = user({ reviewer: true, reviewer_reason: 'number_name' })
    user()
    rows('world_instances').push(
      { _id: new ObjectId(), player_id: reviewer._id, created_at: new Date() },
      { _id: new ObjectId(), player_id: rows('users')[1]._id, created_at: new Date() },
    )
    rows('events').push(
      { _id: new ObjectId(), type: 'narration', player_id: reviewer._id, created_at: new Date() },
      { _id: new ObjectId(), type: 'narration', player_id: rows('users')[1]._id, created_at: new Date() },
    )
    const counts = await adminService.overview()
    assert.equal(counts.users, 1)
    assert.equal(counts.world_instances, 1)
    assert.equal(counts.events, 1)
  })

  // ── The funnel and sessions ─────────────────────────────────────────────────
  await check('the funnel leaves a reviewer guest out of started and their install out of first opens', async () => {
    reset()
    const now = new Date()
    const reviewer = user({ guest: true, guest_started_at: now, created_at: now, reviewer: true, reviewer_reason: 'number_name' })
    const guest = user({ guest: true, guest_started_at: now, created_at: now })
    rows('app_installs').push(
      { _id: 'install-reviewer', first_seen: now, last_seen: now, user_ids: [reviewer._id] },
      { _id: 'install-guest', first_seen: now, last_seen: now, user_ids: [guest._id] },
      { _id: 'install-anon', first_seen: now, last_seen: now },
      { _id: 'install-reviewer-anon-extra', first_seen: now, last_seen: now, user_ids: [reviewer._id] },
    )
    const funnel = await analyticsService.funnel('30')
    const step = (key: string) => funnel.steps.find((entry) => entry.key === key)!.count
    assert.equal(step('first_open'), 2, 'the two untouched installs')
    assert.equal(step('started'), 1, 'only the real guest started')

    const included = await analyticsService.funnel('30', 'include')
    assert.equal(included.steps.find((entry) => entry.key === 'started')!.count, 2)
  })

  await check('sessions hide a reviewer by default and mark them when only reviewers are asked for', async () => {
    reset()
    const now = new Date()
    const reviewer = user({ reviewer: true, reviewer_reason: 'number_name', install_id: 'install-own' })
    const normal = user()
    const session = (id: string, overrides: Doc) => ({
      _id: id, install_id: id, app_version: '1.0.8', build: 11,
      device: { os: 'android', form: 'phone' }, started_at: now, last_at: now,
      counts: { events: 1, errors: 0, actions: 0 }, screen_path: [],
      ...overrides,
    })
    rows('app_sessions').push(
      session('s-reviewer', { user_id: reviewer._id }),
      session('s-own-install', { install_id: 'install-own' }),
      session('s-normal', { user_id: normal._id }),
    )

    const hidden = await analyticsService.sessions({})
    assert.deepEqual(hidden.items.map((item) => item.id), ['s-normal'])
    assert.equal(hidden.items[0].reviewer, undefined, 'a normal session carries no mark')

    const only = await analyticsService.sessions({ reviewers: 'only' })
    assert.deepEqual(only.items.map((item) => item.id).sort(), ['s-own-install', 's-reviewer'])
    for (const item of only.items) assert.equal(item.reviewer, true)

    // `include` shows everything, and still says which rows are review sessions.
    const both = await analyticsService.sessions({ reviewers: 'include' })
    assert.equal(both.items.length, 3)
    const marked = both.items.filter((item) => item.reviewer === true).map((item) => item.id).sort()
    assert.deepEqual(marked, ['s-own-install', 's-reviewer'])

    const bad = await request('/admin/analytics/sessions?reviewers=nope')
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error, 'Reviewers must be exclude, include or only.')
  })

  // ── The daily rollup ────────────────────────────────────────────────────────
  await check('computeDay leaves a reviewer install\'s events out but still counts their crash', async () => {
    reset()
    const day = '2026-11-05'
    const at = new Date(`${day}T12:00:00Z`)
    const reviewer = user({ reviewer: true, reviewer_reason: 'number_name', install_id: 'install-reviewer' })
    rows('app_events').push(
      {
        name: 'screen_view', screen: 'play', duration_ms: 3000, props: {}, user_id: reviewer._id,
        install_id: 'install-reviewer', session_id: 's1', app_version: '1.0.8', at,
      },
      {
        name: 'screen_view', screen: 'play', duration_ms: 1000, props: {}, install_id: 'install-normal',
        session_id: 's2', app_version: '1.0.8', at,
      },
    )
    rows('app_errors').push(
      { class: 'crash', user_id: reviewer._id, install_id: 'install-reviewer', at },
      { class: 'crash', install_id: 'install-normal', at },
    )
    rows('app_error_counters').push({ day, class: 'offline', route: '/x', status: 0, count: 1 })
    rows('app_installs').push(
      { _id: 'install-reviewer', first_seen: at, last_seen: at },
      { _id: 'install-normal', first_seen: at, last_seen: at },
    )

    const row = await appDailyRollupService.computeDay(day)
    assert.equal(row.screens.play?.views, 1, 'only the normal install\'s view')
    assert.equal(row.screens.play?.players, 1)
    assert.equal(row.funnel.first_opens, 1)
    assert.equal(row.errors.samples, 2, 'a reviewer\'s crash is still a crash')
    assert.equal(row.errors.players, 1, 'but it is not a player')
  })

  // ── The backfill script ─────────────────────────────────────────────────────
  await check('the backfill dry run masks phone numbers and apply writes the sweep\'s flag', async () => {
    reset()
    env.REVIEW_DEMO_PHONE = REAL_PHONE
    const reviewer = user({ phone: REAL_PHONE, username: 'reviewer_phone', created_at: new Date('2026-10-20T00:00:00Z') })
    const numberName = user({ preferences: { ...defaultPreferences(), player_name: '(202) 555 0142' }, username: 'by_name' })
    user({ preferences: { ...defaultPreferences(), player_name: 'Mira' } })

    const printed: string[] = []
    const dry = await planFlags(
      await fakes.users.find(reviewerSweepFilter(REAL_PHONE), { projection: { username: 1, phone: 1, created_at: 1, preferences: 1 } }).toArray(),
      REAL_PHONE,
    )
    assert.equal(dry.count, 2)
    for (const line of dry.candidates) {
      printed.push(line.phone ?? '-')
      assert(!(line.phone ?? '').includes('2025550142'), 'no full phone number is printed')
    }
    assert.equal(dry.candidates.find((line) => line._id.equals(reviewer._id))!.reason, 'review_phone')
    assert.equal(dry.candidates.find((line) => line._id.equals(numberName._id))!.reason, 'number_name')
    assert.equal(maskPhone('+12025550142'), '+•••••••0142')

    assert.deepEqual(parseFlagArgs([]), { apply: false, reroll: false })
    assert.deepEqual(parseFlagArgs(['--apply', '--reroll', '--review-phone', REAL_PHONE]),
      { apply: true, reroll: true, reviewPhone: REAL_PHONE })
    assert.throws(() => parseFlagArgs(['--reroll']), /only allowed with --apply/)

    const { flagReviewers } = await import('./flag-reviewers')
    const result = await flagReviewers({
      users: fakes.users,
      appDaily: fakes.app_daily,
      rollupDay: async () => undefined,
    } as unknown as Parameters<typeof flagReviewers>[0], { apply: true, reroll: false, reviewPhone: REAL_PHONE }, () => {})
    assert.equal(result.flagged, 2)
    assert.equal(rows('users').filter((row) => row.reviewer === true).length, 2)
    assert.equal(rows('users')[2].reviewer, undefined)
  })
} finally {
  Object.assign(env, originalEnv)
  resetReviewerScopeCache()
}

console.log(`reviewer-accounts audit: ${passed} passed, ${failures} failed`)
if (failures) process.exit(1)

function defaultPreferences() {
  return {
    nsfw_enabled: false,
    preferred_model: 'gpt-4o',
    theme: 'dark',
    narration_length: 'detailed',
    auto_memory_curation: true,
  }
}
