/** Offline contract checks. All collections are replaced before any service runs. */
import assert from 'node:assert/strict'
import { ensureEverloreIndexes } from '../src/config/mongo-indexes'
import { ObjectId, type Db, type Document } from 'mongodb'
import { Elysia } from 'elysia'
import { env } from '../src/config/env'
import { mongoColl } from '../src/config/mongo'
import { mergeBillingConfig, effectiveBilling, invalidateBillingConfig, saveBillingConfig, validatePromoPatch } from '../src/services/billing-config.service'
import { billingService } from '../src/services/billing.service'
import { LAST_ACTIVE_INTERVAL_MS, lastActiveFilter, recordLastActive } from '../src/services/last-active.service'
import { utcDaySeries, metricsDays } from '../src/services/admin-metrics.service'
import { createInstallsReader, parseInstallsCsv, loadInstallReports, loadReports } from '../src/services/play-installs.service'
import { STORY_TURN_TYPES, userActivityStages } from '../src/services/admin-activity'
import { onboardingFacets, userOnboarding, usersSince } from '../src/services/admin-onboarding'
import { adminService } from '../src/services/admin.service'
import { adminRoutes } from '../src/routes/admin.routes'
import { HttpError } from '../src/utils/http-error'
import { StoryRestingError } from '../src/utils/story-resting-error'
import type { BillingConfigDoc } from '../src/models/billing.model'

let count = 0
let failures = 0
async function check(label: string, run: () => unknown | Promise<unknown>) {
  try { await run(); count++; console.log(`PASS ${label}`) }
  catch (error) { failures++; console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`) }
}
const originalEnv = { ...env }
const originalCollections = { ...mongoColl }
let doc: BillingConfigDoc | null = null
const ledger: Array<{ player_id: ObjectId; delta: number; reason: string; reference?: string; idempotency_key: string; created_at: Date }> = []
const userId = new ObjectId()
let recordedFilter: unknown
Object.assign(mongoColl, {
  billingConfig: () => ({
    findOne: async () => doc,
    updateOne: async (_filter: unknown, update: { $set: Record<string, unknown> } | Array<{ $set: Record<string, unknown> }>) => {
      doc ??= { _id: 'singleton' }
      let set: Record<string, unknown>
      if (Array.isArray(update)) {
        const expression = update[0].$set.promo as { $ifNull: [string, { unlimited: boolean; daily_turn_cap: number }] }
        doc.promo ??= { ...expression.$ifNull[1] }
        set = Object.fromEntries(Object.entries(update[1].$set).map(([key, value]) => [key, (value as { $literal: unknown }).$literal]))
      } else set = update.$set
      for (const [key, value] of Object.entries(set)) {
        if (key.startsWith('promo.')) {
          doc.promo ??= { unlimited: false, daily_turn_cap: 500 }
          Object.assign(doc.promo, { [key.slice(6)]: value })
        } else Object.assign(doc, { [key]: value })
      }
    },
  }),
  users: () => ({ findOne: async () => ({ tier: 'free' }), updateOne: async (filter: unknown) => { recordedFilter = filter } }),
  billingEntitlements: () => ({ findOne: async () => null }),
  inkLedger: () => ({
    findOne: async (filter: { idempotency_key: string }) => ledger.find((row) => row.idempotency_key === filter.idempotency_key) ?? null,
    insertOne: async (row: (typeof ledger)[number]) => { ledger.push(row) },
    updateOne: async (_filter: unknown, update: { $setOnInsert: (typeof ledger)[number] }) => {
      if (!ledger.some((row) => row.idempotency_key === update.$setOnInsert.idempotency_key)) ledger.push(update.$setOnInsert)
    },
    aggregate: (pipeline: Array<Record<string, unknown>>) => ({ toArray: async () => {
      const match = pipeline[0].$match as { reason?: string; reference?: string }
      const selected = ledger.filter((row) => (!match.reason || row.reason === match.reason) && (!match.reference || row.reference === match.reference))
      return [{ balance: selected.reduce((sum, row) => sum + row.delta, 0), reserved: selected.length }]
    } }),
  }),
})
try {
  env.INK_PROMO_UNLIMITED = true
  env.INK_PROMO_DAILY_TURN_CAP = 777
  await check('config overrides env including false', () => {
    const promo = mergeBillingConfig({ _id: 'singleton', promo: { unlimited: false, daily_turn_cap: 12 }, updated_by: 'operator' }).promo
    assert.deepEqual(promo, { unlimited: false, daily_turn_cap: 12, source: 'config', updated_at: null, updated_by: 'operator' })
  })
  await check('absent promo uses env and null attribution', () => {
    assert.deepEqual(mergeBillingConfig({ _id: 'singleton' }).promo,
      { unlimited: true, daily_turn_cap: 777, source: 'env', updated_at: null, updated_by: null })
    assert.equal(mergeBillingConfig(null).promo.source, 'env')
  })
  await check('partial first save seeds missing promo values, later saves preserve keys', async () => {
    invalidateBillingConfig()
    const first = await saveBillingConfig({ promo: { unlimited: false } }, 'operator')
    assert.equal(first.promo.daily_turn_cap, 777)
    assert.equal(first.promo.unlimited, false)
    assert.equal(first.promo.source, 'config')
    assert.equal(first.promo.updated_by, 'operator')
    assert(first.promo.updated_at instanceof Date)
    env.INK_PROMO_UNLIMITED = false
    env.INK_PROMO_DAILY_TURN_CAP = 999
    const second = await saveBillingConfig({ promo: { daily_turn_cap: 2 } }, 'next')
    assert.equal(second.promo.unlimited, false)
    assert.equal(second.promo.daily_turn_cap, 2)
    assert.equal((await effectiveBilling()).promo.updated_by, 'next')
  })
  await check('promo validation rejects strings, nulls, fractions and out of range', () => {
    for (const value of [null, [], false, { unlimited: 'false' }, { unlimited: null }, { daily_turn_cap: '1' }, { daily_turn_cap: 0 }, { daily_turn_cap: 100001 }, { daily_turn_cap: 1.5 }, { daily_turn_cap: null }]) {
      assert.throws(() => validatePromoPatch(value), (error) => error instanceof HttpError && error.statusCode === 400 && /\.$/.test(error.message))
    }
    assert.deepEqual(validatePromoPatch({ unlimited: false, daily_turn_cap: 100000 }), { unlimited: false, daily_turn_cap: 100000 })
  })
  await check('reserve promo on is free, idempotent and capped with enforcement off', async () => {
    doc = { _id: 'singleton', promo: { unlimited: true, daily_turn_cap: 1 } }
    invalidateBillingConfig()
    env.BILLING_ENFORCEMENT_ENABLED = false
    assert.equal((await billingService.wallet(userId.toHexString(), 'free')).unlimited_ink, true)
    const result = await billingService.reserve(userId.toHexString(), 'story_turn', 'promo')
    assert.equal(result.cost, 0)
    assert.equal(ledger.length, 1)
    assert.equal((await billingService.reserve(userId.toHexString(), 'story_turn', 'promo')).cost, 0)
    await assert.rejects(() => billingService.reserve(userId.toHexString(), 'story_turn', 'capped'), StoryRestingError)
    assert.equal((await billingService.reserve(userId.toHexString(), 'image_preview', 'preview')).cost, 0)
    assert.equal(ledger.reduce((sum, row) => sum + row.delta, 0), 0)
  })
  await check('reserve promo off uses configured cost and tier cap', async () => {
    ledger.length = 0
    doc = { _id: 'singleton', promo: { unlimited: false, daily_turn_cap: 1 }, costs: { story_turn: 3 }, tiers: { free: { daily_story_safety_cap: 2 } } }
    invalidateBillingConfig()
    env.BILLING_ENFORCEMENT_ENABLED = true
    assert.equal((await billingService.wallet(userId.toHexString(), 'free')).unlimited_ink, false)
    assert.equal((await billingService.reserve(userId.toHexString(), 'story_turn', 'paid1')).cost, 3)
    assert.equal((await billingService.reserve(userId.toHexString(), 'story_turn', 'paid2')).cost, 3)
    await assert.rejects(() => billingService.reserve(userId.toHexString(), 'story_turn', 'paid3'), StoryRestingError)
    env.BILLING_ENFORCEMENT_ENABLED = false
    assert.equal((await billingService.reserve(userId.toHexString(), 'story_turn', 'unenforced')).reservation_id, null)
  })
  await check('last active conditional predicate throttles across workers', async () => {
    const now = new Date('2026-10-21T12:00:00Z')
    const filter = lastActiveFilter(userId, now)
    assert.deepEqual(filter, { _id: userId, $or: [
      { last_active_at: { $exists: false } },
      { last_active_at: { $lt: new Date('2026-10-21T11:55:00Z') } },
    ] })
    assert.equal(LAST_ACTIVE_INTERVAL_MS, 300000)
    recordLastActive(userId.toHexString())
    await Promise.resolve()
    assert(recordedFilter)
    Object.assign(mongoColl, { users: () => ({ updateOne: async () => { throw new Error('offline') } }) })
    assert.doesNotThrow(() => recordLastActive(userId.toHexString()))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await check('UTC day series includes empty days, month boundary and today', () => {
    const series = utcDaySeries(7, new Date('2026-03-03T23:59:59-05:00'))
    assert.equal(series.length, 7)
    assert.equal(series[0].date, '2026-02-26')
    assert.equal(series[6].date, '2026-03-04')
    assert(series.every((day) => day.signups === 0 && day.active_players === 0 && day.story_turns === 0 && day.new_saves === 0 && day.installs === null))
    assert.deepEqual(series.map((day) => day.date), ['2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'])
  })
  await check('days default, boundaries and invalid values', () => {
    assert.equal(metricsDays(), 30)
    assert.equal(metricsDays('7'), 7)
    assert.equal(metricsDays('180'), 180)
    for (const value of ['', '6', '181', '7.5', 'NaN', ' 7', '1e2']) assert.throws(() => metricsDays(value), HttpError)
  })
  await check('UTF-16LE BOM install CSV handles quotes, commas, CRLF and zero', () => {
    const sample = '\uFEFFDate,Package Name,Daily User Installs,Notes\r\n2026-10-20,com.everloreapp,12,"a,b"\r\n2026-10-21,com.everloreapp,0,"said ""hi"""\r\n'
    assert.deepEqual(parseInstallsCsv(Buffer.from(sample, 'utf16le')), { '2026-10-20': 12, '2026-10-21': 0 })
    for (const invalid of ['Date,Count\n2026-10-20,1', 'Date,Daily User Installs\n2026-02-30,3', 'Date,Daily User Installs\n2026-10-20,wat', 'Date,Daily User Installs\n2026-10-20,"4']) {
      assert.throws(() => parseInstallsCsv(Buffer.from(invalid, 'utf16le')))
    }
  })
  await check('installs failures coalesce, wait fifteen minutes, then recover', async () => {
    let clock = 0, calls = 0
    const read = createInstallsReader(async () => {
      if (++calls === 1) throw new Error('private upstream details')
      return { '2026-10-21': 4 }
    }, () => clock)
    const [one, two] = await Promise.all([read(), read()])
    assert.deepEqual(one, two)
    assert.deepEqual(one, { available: false, reason_kind: 'error', reason: "Play's install reports couldn't be read just now.", last_updated: null, daily: {} })
    assert.equal(calls, 1)
    clock = 15 * 60_000 - 1
    await read(); assert.equal(calls, 1)
    clock++
    const recovered = await read()
    assert.equal(calls, 2)
    assert.deepEqual(recovered, { available: true, reason_kind: null, reason: null, last_updated: new Date(clock).toISOString(), daily: { '2026-10-21': 4 } })
    clock += 15 * 60_000
    await read(); assert.equal(calls, 2)
  })
  await check('installs successes coalesce and stay cached for six hours', async () => {
    let clock = 0, calls = 0
    const read = createInstallsReader(async () => { calls++; return { '2026-10-21': 4 } }, () => clock)
    const [one, two] = await Promise.all([read(), read()])
    assert.deepEqual(one, two)
    assert.deepEqual(one, { available: true, reason_kind: null, reason: null, last_updated: new Date(0).toISOString(), daily: { '2026-10-21': 4 } })
    assert.equal(calls, 1)
    clock = 6 * 60 * 60_000 - 1
    await read(); assert.equal(calls, 1)
    clock++; await read(); assert.equal(calls, 2)
  })
  const installDate = new Date('2026-10-21T00:00:00Z')
  const reportListing = () => Response.json({ items: [{ name: 'stats/installs/installs_com.everloreapp_202610_overview.csv' }] })
  const readWithRequest = (request: typeof fetch) => createInstallsReader(() => loadInstallReports('offline', installDate, request))()
  env.GOOGLE_PLAY_PACKAGE_NAME = 'com.everloreapp'
  await check('installs list and object 401 or 403 classify as forbidden', async () => {
    for (const status of [401, 403]) {
      for (const object of [false, true]) {
        let calls = 0
        const result = await readWithRequest((async () => {
          if (object && ++calls === 1) return reportListing()
          return new Response('private upstream body', { status })
        }) as typeof fetch)
        assert.equal(result.available, false)
        assert.equal(result.reason_kind, 'forbidden')
        assert.equal(result.reason, "Play hasn't given the server's account access to install reports yet.")
      }
    }
  })
  await check('installs empty or nonmatching listings classify as no_reports', async () => {
    for (const items of [undefined, [], [
      { name: 'stats/installs/installs_com.everloreapp_202610_country.csv' },
      { name: 'stats/installs/installs_com.everloreapp_202001_overview.csv' },
      { name: 'stats/installs/installs_other.app_202610_overview.csv' },
    ]]) {
      const result = await readWithRequest((async () => Response.json({ items })) as typeof fetch)
      assert.equal(result.available, false)
      assert.equal(result.reason_kind, 'no_reports')
      assert.equal(result.reason, "Play hasn't published an install report for this app yet. They usually appear a day or two after launch.")
    }
  })
  await check('installs 500, network and CSV failures classify as error', async () => {
    const requests = [
      (async () => new Response('private upstream body', { status: 500 })) as typeof fetch,
      (async (input) => String(input).includes('alt=media') ? new Response('', { status: 500 }) : reportListing()) as typeof fetch,
      (async () => { throw new Error('network unavailable') }) as typeof fetch,
      (async (input) => String(input).includes('alt=media') ? new Response(Buffer.from('not CSV', 'utf16le')) : reportListing()) as typeof fetch,
    ]
    for (const request of requests) {
      const result = await readWithRequest(request)
      assert.equal(result.available, false)
      assert.equal(result.reason_kind, 'error')
      assert.equal(result.reason, "Play's install reports couldn't be read just now.")
    }
  })
  await check('installs token 503 and missing developer ID classify as not_configured', async () => {
    const originalId = env.PLAY_DEVELOPER_ACCOUNT_ID
    let tokenCalls = 0, requestCalls = 0
    const request = (async () => { requestCalls++; return Response.json({}) }) as typeof fetch
    const getToken = async (scope: string) => {
      tokenCalls++
      assert.equal(scope, 'https://www.googleapis.com/auth/devstorage.read_only')
      throw new HttpError(503, 'private credential details')
    }
    try {
      env.PLAY_DEVELOPER_ACCOUNT_ID = 'offline-developer'
      const tokenFailure = await createInstallsReader(() => loadReports(getToken, installDate, request))()
      assert.equal(tokenCalls, 1)
      env.PLAY_DEVELOPER_ACCOUNT_ID = ''
      const missingId = await createInstallsReader(() => loadReports(getToken, installDate, request))()
      assert.equal(tokenCalls, 1)
      for (const result of [tokenFailure, missingId]) {
        assert.equal(result.available, false)
        assert.equal(result.reason_kind, 'not_configured')
        assert.equal(result.reason, "The server isn't set up to read Play reports.")
      }
      assert.equal(requestCalls, 0)
    } finally { env.PLAY_DEVELOPER_ACCOUNT_ID = originalId }
  })
  await check('installs reasons never contain upstream bodies or credential details', async () => {
    const email = 'fake-reader@example.invalid', token = 'fake-access-token-123'
    const upstream = `Forbidden for ${email}, token ${token}`
    const results = [
      await readWithRequest((async () => new Response(upstream, { status: 403 })) as typeof fetch),
      await readWithRequest((async (input) => String(input).includes('alt=media') ? new Response(upstream, { status: 403 }) : reportListing()) as typeof fetch),
      await readWithRequest((async () => { throw new Error(upstream) }) as typeof fetch),
      await createInstallsReader(async () => { throw new HttpError(503, upstream) })(),
    ]
    for (const result of results) {
      assert(result.reason)
      assert(!result.reason.includes(email))
      assert(!result.reason.includes(token))
      assert(!JSON.stringify(result).includes(upstream))
    }
  })
  await check('installs fetch discovers existing months and contains network failures', async () => {
    const urls: string[] = []
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input); urls.push(url)
      if (url.includes('alt=media')) return new Response(Buffer.from('\uFEFFDate,Daily User Installs\r\n2026-10-20,12\r\n', 'utf16le'))
      return Response.json({ items: [
        { name: 'stats/installs/installs_com.everloreapp_202610_overview.csv' },
        { name: 'stats/installs/installs_com.everloreapp_202610_country.csv' },
        { name: 'stats/installs/installs_com.everloreapp_202001_overview.csv' },
      ] })
    }) as typeof fetch
    env.GOOGLE_PLAY_PACKAGE_NAME = 'com.everloreapp'
    assert.deepEqual(await loadInstallReports('offline', new Date('2026-10-21T00:00:00Z'), fakeFetch), { '2026-10-20': 12 })
    assert.equal(urls.length, 2)
    assert(urls[1].includes('stats%2Finstalls%2Finstalls_com.everloreapp_202610_overview.csv?alt=media'))
    const forbidden = (async () => new Response('', { status: 403 })) as typeof fetch
    const read = createInstallsReader(() => loadInstallReports('offline', new Date(), forbidden))
    assert.equal((await read()).available, false)
  })
  await check('story activity includes all generated turn kinds and excludes side chats', () => {
    assert.deepEqual(STORY_TURN_TYPES, ['narration', 'intimate', 'travel', 'calendar_tick'])
    assert.deepEqual(userActivityStages()[0].$lookup.pipeline[0].$match.type.$in, STORY_TURN_TYPES)
  })
  await check('activity compound indexes coexist despite different key order', async () => {
    const indexes = new Map<string, Document[]>()
    const database = { collection: (name: string) => ({
      listIndexes: () => ({ toArray: async () => indexes.get(name) ?? [] }),
      dropIndex: async (label: string) => { indexes.set(name, (indexes.get(name) ?? []).filter((idx) => idx.name !== label)) },
      createIndex: async (key: Document, options: Document) => {
        indexes.set(name, [...(indexes.get(name) ?? []), { key, ...options, name: options.name ?? JSON.stringify(key) }])
      },
    }) } as unknown as Db
    await ensureEverloreIndexes(database)
    const names = indexes.get('events')!.map((idx) => idx.name)
    assert(names.includes('idx_events_type_created_player'))
    assert(names.includes('idx_events_player_type_created'))
    assert.deepEqual(indexes.get('users')!.find((idx) => idx.name === 'idx_users_created')?.key, { created_at: -1 })
  })
  await check('onboarding mapper defaults skipped fields and completion follows name', () => {
    const skipped = { name: null, gender: null, interests: [], sign_in: [], mature_enabled: false, completed: false }
    assert.deepEqual(userOnboarding({}), skipped)
    assert.deepEqual(userOnboarding({ preferences: {} }), skipped)
    assert.deepEqual(userOnboarding({ preferences: { player_name: '' } }), skipped)
    assert.deepEqual(userOnboarding({ preferences: { gender: 'male', interests: ['noir'], nsfw_enabled: true }, providers: ['phone'] }),
      { ...skipped, gender: 'male', interests: ['noir'], sign_in: ['phone'], mature_enabled: true })
    assert.deepEqual(userOnboarding({ preferences: { player_name: 'Mira', gender: 'female', interests: ['noir'] }, providers: ['phone', 'google'] }),
      { name: 'Mira', gender: 'female', interests: ['noir'], sign_in: ['phone', 'google'], mature_enabled: false, completed: true })
  })
  await check('onboarding gender buckets include skipped and sort by descending count', () => {
    const facets = onboardingFacets()
    assert.deepEqual(facets.gender, [
      { $project: { key: { $ifNull: ['$preferences.gender', 'skipped'] } } },
      { $group: { _id: '$key', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $project: { _id: 0, key: '$_id', count: 1 } },
    ])
  })
  await check('since validates ISO dates and rejects invalid calendar dates', () => {
    assert.equal(usersSince(), undefined)
    for (const value of ['2026-10-14', '2026-10-14T12:30:00.123Z', '2026-10-14T12:30:00+05:30', '2024-02-29']) {
      assert.equal(usersSince(value)?.getTime(), new Date(value).getTime())
    }
    for (const value of ['', 'yesterday', '123', '2026-02-30', '2026-02-29T00:00:00Z', '2026-13-01', '2026-10-14T25:00:00Z', ' 2026-10-14', '2026-10-14T00:00:00']) {
      assert.throws(() => usersSince(value), (error) => error instanceof HttpError && error.statusCode === 400 && error.message === 'Since must be a valid ISO date.')
    }
  })
  await check('user routes combine since search sort and attach onboarding to list and detail', async () => {
    const row = { _id: userId, preferences: { player_name: 'Mira' }, providers: ['phone'] }
    const filters: unknown[] = []
    const pipelines: Document[][] = []
    Object.assign(mongoColl, {
      users: () => ({
        countDocuments: async (filter: unknown) => { filters.push(filter); return 1 },
        aggregate: (pipeline: Document[]) => { pipelines.push(pipeline); return { toArray: async () => [row] } },
      }),
      worldInstances: () => ({ countDocuments: async () => 0 }),
      worldTemplates: () => ({ countDocuments: async () => 0 }),
      events: () => ({ countDocuments: async () => 0 }),
      memories: () => ({ countDocuments: async () => 0 }),
    })
    env.ADMIN_USERNAME = 'offline-admin'
    env.ADMIN_PASSWORD = 'offline-fixture'
    const app = new Elysia().onError(({ error, set }) => {
      if (error instanceof HttpError) { set.status = error.statusCode; return { error: error.message } }
    }).use(adminRoutes)
    const request = (path: string) => app.handle(new Request(`http://localhost${path}`, {
      headers: { Authorization: `Basic ${Buffer.from('offline-admin:offline-fixture').toString('base64')}` },
    }))
    const since = '2026-10-14T00:00:00Z'
    for (const sort of ['created', 'last_active']) {
      const response = await request(`/admin/users?since=${since}&search=Mira&sort=${sort}`)
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.deepEqual(body.items[0].onboarding, userOnboarding(row))
      assert.deepEqual(filters.at(-1), pipelines.at(-1)![0].$match)
      assert.deepEqual((filters.at(-1) as Document).created_at, { $gte: new Date(since) })
      assert((filters.at(-1) as Document).$or.some((filter: Document) => filter['preferences.player_name']?.$regex === 'Mira'))
      assert(pipelines.at(-1)!.some((stage) => stage.$sort?.[sort === 'created' ? 'created_at' : 'last_active_at'] === -1))
      assert(pipelines.at(-1)!.some((stage) => stage.$project?.password_hash === 0))
    }
    const detail = await request(`/admin/users/${userId.toHexString()}`)
    assert.equal(detail.status, 200)
    assert.deepEqual((await detail.json()).user.onboarding, userOnboarding(row))
    const invalid = await request('/admin/users?since=not-a-date')
    assert.equal(invalid.status, 400)
    assert.deepEqual(await invalid.json(), { error: 'Since must be a valid ISO date.' })
    await assert.rejects(() => adminService.listUsers({ since: '' }), HttpError)
  })
  await check('metrics route is guarded by scoped admin auth', async () => {
    env.ADMIN_USERNAME = ''
    env.ADMIN_PASSWORD = ''
    const app = new Elysia().use(adminRoutes)
    const response = await app.handle(new Request('http://localhost/admin/metrics?days=30'))
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'Admin credentials are not configured' })
  })
} finally {
  Object.assign(env, originalEnv)
  Object.assign(mongoColl, originalCollections)
  invalidateBillingConfig()
}
console.log(`admin-ops audit: ${count} passed, ${failures} failed`)
if (failures) process.exit(1)
