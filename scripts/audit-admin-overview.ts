/** Offline checks for the Overview and System routes. Fakes only, no network. */
import assert from 'node:assert/strict'
import type { Queue } from 'bullmq'
import { Elysia } from 'elysia'
import { env } from '../src/config/env'
import { mongoColl } from '../src/config/mongo'
import { adminOverviewRoutes } from '../src/routes/admin-overview.routes'
import {
  createAdminHealthService,
  readQueue,
  type HealthDependencies,
  type QueueHealth,
  type QueueReader,
} from '../src/services/admin-health.service'
import { adminOverviewSummaryService, utcDayStart } from '../src/services/admin-overview-summary.service'
import { STORY_TURN_TYPES } from '../src/services/admin-activity'

let count = 0
let failures = 0
async function check(label: string, run: () => unknown | Promise<unknown>) {
  try { await run(); count++; console.log(`PASS ${label}`) }
  catch (error) { failures++; console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`) }
}

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

const answer = async () => undefined
const healthy: HealthDependencies = {
  pingMongo: answer,
  pingRedis: answer,
  pingPinecone: answer,
  countGenerationWorkers: async () => 2,
}

type QueueRow = Omit<QueueHealth, 'name' | 'label'>

const queueOf = (name: string, label: string, row: QueueRow): QueueReader =>
  ({ name, label, read: async () => row })

const queues: QueueReader[] = [
  queueOf('generation', 'Story turns', { waiting: 0, active: 1, failed_24h: 0, failing_now: 0, oldest_waiting_s: null }),
  queueOf('media', 'Pictures and voices', { waiting: 3, active: 0, failed_24h: 2, failing_now: 1, oldest_waiting_s: 41 }),
]

type FinishedFixture = { name: string; finishedOn: number }

/** A BullMQ queue reduced to what readQueue reads: two newest-first scans, counts and the oldest waiting job. */
const finishedQueue = (failed: FinishedFixture[], completed: FinishedFixture[]) => {
  const scans: { failed: Array<[number, number]>; completed: Array<[number, number]> } = { failed: [], completed: [] }
  const queue = {
    getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: failed.length }),
    getFailed: async (start: number, end: number) => { scans.failed.push([start, end]); return failed.slice(start, end + 1) },
    getCompleted: async (start: number, end: number) => { scans.completed.push([start, end]); return completed.slice(start, end + 1) },
    getJobs: async () => [],
  }
  return { queue: queue as unknown as Queue, scans }
}

const byKey = (checks: Array<{ key: string }>) => Object.fromEntries(checks.map((c) => [c.key, c as Record<string, unknown>]))

const originalEnv = { ...env }
const originalCollections = { ...mongoColl }
/** Set for the whole run; only the not-configured check turns it off, and it puts this back. */
const FIXTURE_PINECONE_KEY = 'offline-fixture'
env.PINECONE_API_KEY = FIXTURE_PINECONE_KEY

try {
  await check('health payload carries the contract shape and all four checks', async () => {
    const now = new Date('2026-10-24T12:00:00.000Z')
    const body = await createAdminHealthService({ dependencies: healthy, queues }).health(now)
    assert.deepEqual(Object.keys(body), ['generated_at', 'version', 'checks', 'queues'])
    assert.equal(body.generated_at, now.toISOString())
    assert.deepEqual(Object.keys(body.version), ['commit', 'started_at'])
    assert.equal(body.version.commit, null)
    assert.equal(new Date(body.version.started_at).toISOString(), body.version.started_at)
    assert.deepEqual(body.checks.map((c) => [c.key, c.label, c.status]), [
      ['mongo', 'Database', 'ok'],
      ['redis', 'Cache and queue', 'ok'],
      ['pinecone', 'Story memory search', 'ok'],
      ['worker', 'Background worker', 'ok'],
    ])
    for (const c of body.checks.slice(0, 3)) {
      assert.deepEqual(Object.keys(c).sort(), ['detail', 'key', 'label', 'latency_ms', 'status'])
      assert.equal(typeof c.latency_ms, 'number')
      assert.equal(c.detail, `${c.latency_ms} ms`)
    }
    assert.deepEqual(Object.keys(body.checks[3]).sort(), ['detail', 'key', 'label', 'status'])
    assert.equal(body.checks[3].detail, '2 connected')
    assert.deepEqual(body.queues, [
      { name: 'generation', label: 'Story turns', waiting: 0, active: 1, failed_24h: 0, failing_now: 0, oldest_waiting_s: null },
      { name: 'media', label: 'Pictures and voices', waiting: 3, active: 0, failed_24h: 2, failing_now: 1, oldest_waiting_s: 41 },
    ])
  })

  await check('mongo down only changes its own check', async () => {
    const body = await createAdminHealthService({
      dependencies: { ...healthy, pingMongo: async () => { throw new Error('private-host:27017 refused') } },
      queues,
    }).health()
    const checks = byKey(body.checks)
    assert.equal(checks.mongo.status, 'down')
    assert.equal(checks.mongo.detail, 'Did not answer.')
    assert.equal(checks.mongo.latency_ms, undefined)
    for (const key of ['redis', 'pinecone', 'worker']) assert.equal(checks[key].status, 'ok')
    assert.equal(body.queues.length, 2)
  })

  await check('an upstream error message never reaches the body', async () => {
    const secret = 'mongodb://admin:hunter2@db.internal:27017 refused'
    const refuse = async () => { throw new Error(secret) }
    const body = await createAdminHealthService({
      dependencies: { pingMongo: refuse, pingRedis: refuse, pingPinecone: refuse, countGenerationWorkers: refuse },
      queues: [{ name: 'generation', label: 'Story turns', read: refuse }],
    }).health()
    const serialized = JSON.stringify(body)
    for (const fragment of ['hunter2', 'db.internal', '27017', 'refused', secret]) assert(!serialized.includes(fragment), fragment)
    assert.deepEqual(body.checks.map((c) => c.status), ['down', 'down', 'down', 'down'])
    assert.deepEqual(body.queues, [])
  })

  await check('a slow dependency is degraded while a fast one stays ok', async () => {
    const slow = async () => { await new Promise((resolve) => setTimeout(resolve, 520)) }
    const body = await createAdminHealthService({
      dependencies: { ...healthy, pingMongo: slow, pingPinecone: slow },
      queues: [],
    }).health()
    const checks = byKey(body.checks)
    assert.equal(checks.mongo.status, 'degraded')
    // The vector search is allowed 1500 ms, so the same 520 ms — and only the
    // second of its two pings is graded — is still healthy.
    assert.equal(checks.pinecone.status, 'ok')
    assert.equal(checks.redis.status, 'ok')
  })

  await check('a stalled check times out as down instead of holding the route', async () => {
    const service = createAdminHealthService({
      dependencies: { ...healthy, pingMongo: () => new Promise(() => {}) },
      queues: [],
      timeoutMs: 25,
    })
    const started = performance.now()
    const body = await service.health()
    assert.equal(byKey(body.checks).mongo.status, 'down')
    assert(performance.now() - started < 1000, 'the timeout must bound the route')
  })

  await check('pinecone not configured is down with a fixed sentence', async () => {
    env.PINECONE_API_KEY = ''
    let calls = 0
    try {
      const body = await createAdminHealthService({
        dependencies: { ...healthy, pingPinecone: async () => { calls++ } },
        queues: [],
      }).health()
      assert.equal(byKey(body.checks).pinecone.status, 'down')
      assert.equal(byKey(body.checks).pinecone.detail, 'Search is not configured on this server.')
      assert.equal(byKey(body.checks).pinecone.latency_ms, undefined)
      assert.equal(calls, 0, 'an unconfigured dependency must not be called')
    } finally { env.PINECONE_API_KEY = FIXTURE_PINECONE_KEY }
  })

  await check('a cold first pinecone ping does not make the check down', async () => {
    let calls = 0
    const ping = async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, calls === 1 ? 1800 : 200))
    }
    const body = await createAdminHealthService({ dependencies: { ...healthy, pingPinecone: ping }, queues: [] }).health()
    const pinecone = byKey(body.checks).pinecone as { status: string; detail: string; latency_ms: number }
    assert.equal(calls, 2, 'the connection is opened once before the graded call')
    assert.equal(pinecone.status, 'ok')
    // Timers overshoot by a millisecond or two; what matters is that the graded
    // figure is the warm call's and not the pair's.
    assert(pinecone.latency_ms >= 180 && pinecone.latency_ms <= 400, `graded latency was ${pinecone.latency_ms} ms`)
    assert.equal(pinecone.detail, `${pinecone.latency_ms} ms`)
  })

  await check('a throwing pinecone ping is down with the fixed sentence', async () => {
    for (const throwOn of [1, 2]) {
      let calls = 0
      const body = await createAdminHealthService({
        dependencies: {
          ...healthy,
          pingPinecone: async () => {
            calls++
            if (calls === throwOn) throw new Error('pinecone 503 from internal-host')
          },
        },
        queues: [],
      }).health()
      const pinecone = byKey(body.checks).pinecone
      assert.equal(pinecone.status, 'down', `throw on call ${throwOn}`)
      assert.equal(pinecone.detail, 'Did not answer.')
      assert.equal(pinecone.latency_ms, undefined)
    }
  })

  await check('a pinecone pair over its deadline is down', async () => {
    const service = createAdminHealthService({
      dependencies: { ...healthy, pingPinecone: () => new Promise<void>((resolve) => setTimeout(resolve, 40)) },
      queues: [],
      pineconeTimeoutMs: 60,
    })
    const started = performance.now()
    const body = await service.health()
    const pinecone = byKey(body.checks).pinecone
    assert.equal(pinecone.status, 'down')
    assert.equal(pinecone.detail, 'Did not answer.')
    assert(performance.now() - started < 500, 'the pair deadline must bound the route')
  })

  await check('a warm pinecone ping over 1.5 s is degraded', async () => {
    let calls = 0
    const body = await createAdminHealthService({
      dependencies: {
        ...healthy,
        pingPinecone: async () => {
          calls++
          if (calls === 2) await new Promise((resolve) => setTimeout(resolve, 1600))
        },
      },
      queues: [],
    }).health()
    const pinecone = byKey(body.checks).pinecone as { status: string; latency_ms: number }
    assert.equal(pinecone.status, 'degraded')
    assert(pinecone.latency_ms >= 1500, `graded latency was ${pinecone.latency_ms} ms`)
  })

  await check('no connected worker is down', async () => {
    const body = await createAdminHealthService({ dependencies: { ...healthy, countGenerationWorkers: async () => 0 }, queues: [] }).health()
    assert.equal(byKey(body.checks).worker.status, 'down')
    assert.equal(byKey(body.checks).worker.detail, '0 connected')
  })

  await check('an unreadable queue is dropped, not reported as empty and healthy', async () => {
    const body = await createAdminHealthService({
      dependencies: healthy,
      queues: [
        queueOf('generation', 'Story turns', { waiting: 1, active: 0, failed_24h: 0, failing_now: 0, oldest_waiting_s: 5 }),
        { name: 'media', label: 'Pictures and voices', read: async () => { throw new Error('redis down') } },
      ],
    }).health()
    assert.deepEqual(body.queues.map((q) => q.name), ['generation'])
  })

  // ── Queue failure history vs what is failing now ────────────────────────────
  await check('a job name that completed again is not failing now', async () => {
    const failedAt = Date.now() - 2 * hour
    const { queue, scans } = finishedQueue([{ name: 'decay', finishedOn: failedAt }], [{ name: 'decay', finishedOn: failedAt + hour }])
    const row = await readQueue(queue)
    assert.equal(row.failing_now, 0)
    // The failure is still the history the console shows.
    assert.equal(row.failed_24h, 1)
    // Completed jobs are read the way failed ones are: newest first, bounded.
    assert.deepEqual(scans.completed, [[0, 199]])
    assert.deepEqual(scans.failed, [[0, 199]])
  })

  await check('a job name whose newest run failed is failing now', async () => {
    const completedAt = Date.now() - 2 * hour
    const { queue } = finishedQueue([{ name: 'decay', finishedOn: completedAt + hour }], [{ name: 'decay', finishedOn: completedAt }])
    const row = await readQueue(queue)
    assert.equal(row.failing_now, 1)
    assert.equal(row.failed_24h, 1)
  })

  await check('failing now counts names, not failures', async () => {
    const base = Date.now() - 3 * hour
    const { queue } = finishedQueue(
      // Newest first, like BullMQ: media failed most recently, decay failed twice
      // and then completed.
      [{ name: 'media', finishedOn: base + 2 * hour }, { name: 'decay', finishedOn: base + hour }, { name: 'decay', finishedOn: base }],
      [{ name: 'decay', finishedOn: base + 2 * hour }],
    )
    const row = await readQueue(queue)
    assert.equal(row.failing_now, 1)
    assert.equal(row.failed_24h, 3)
  })

  // ── Overview summary ────────────────────────────────────────────────────────
  const now = new Date('2026-10-24T15:30:00.000Z')
  const todayStart = utcDayStart(now)
  const yesterdayStart = new Date(todayStart.getTime() - day)
  const yesterdaySameTime = new Date(now.getTime() - day)

  interface DateWindow { $gte?: Date; $lte?: Date }
  function inWindow(at: Date | undefined, window: DateWindow): boolean {
    if (!at) return false
    if (window.$gte && at.getTime() < window.$gte.getTime()) return false
    if (window.$lte && at.getTime() > window.$lte.getTime()) return false
    return true
  }

  const lastSeen: Array<Date | undefined> = [
    new Date(now.getTime() - 9 * minute), // in
    new Date(now.getTime() - 11 * minute), // out
    undefined, // never seen
  ]
  const eventDocs = [
    { type: 'narration', created_at: todayStart }, // in today (first instant)
    { type: 'intimate', created_at: new Date(now.getTime() - 1_000) }, // in today
    { type: 'side_chat', created_at: new Date(now.getTime() - 2_000) }, // not a story turn
    { type: 'narration', created_at: new Date(now.getTime() + 1_000) }, // after now
    { type: 'travel', created_at: yesterdayStart }, // in yesterday (first instant)
    { type: 'calendar_tick', created_at: yesterdaySameTime }, // in yesterday (same time, inclusive)
    { type: 'narration', created_at: new Date(yesterdaySameTime.getTime() + 1) }, // out
    { type: 'narration', created_at: new Date(yesterdayStart.getTime() - 1) }, // out
  ]
  const userFilters: DateWindow[] = []
  const eventFilters: Array<{ type?: { $in?: string[] }; created_at?: DateWindow }> = []

  Object.assign(mongoColl, {
    users: () => ({
      countDocuments: async (filter: { last_active_at?: DateWindow }) => {
        assert(filter.last_active_at, 'live_players must constrain last_active_at')
        userFilters.push(filter.last_active_at)
        return lastSeen.filter((seen) => inWindow(seen, filter.last_active_at as DateWindow)).length
      },
    }),
    events: () => ({
      countDocuments: async (filter: { type?: { $in?: string[] }; created_at?: DateWindow }) => {
        eventFilters.push(filter)
        return eventDocs.filter((doc) =>
          (!filter.type?.$in || filter.type.$in.includes(doc.type)) && inWindow(doc.created_at, filter.created_at ?? {}),
        ).length
      },
    }),
  })

  const spendWindows: Array<[Date, Date]> = []
  const summary = await adminOverviewSummaryService.summary(now, async (from, to) => {
    spendWindows.push([from, to])
    return { usd: 0.123456, calls: 40, unpriced: 3 }
  })

  await check('live players counts only the last ten minutes', async () => {
    assert.equal(summary.live_players, 1)
    assert.deepEqual(userFilters[0], { $gte: new Date(now.getTime() - 10 * minute) })
  })

  await check('turns today and yesterday same time count the same turn kinds', async () => {
    assert.equal(summary.turns_today, 2)
    assert.equal(summary.turns_yesterday_same_time, 2)
    assert.deepEqual(eventFilters[0], { type: { $in: STORY_TURN_TYPES }, created_at: { $gte: todayStart, $lte: now } })
    assert.deepEqual(eventFilters[1], {
      type: { $in: STORY_TURN_TYPES },
      created_at: { $gte: yesterdayStart, $lte: yesterdaySameTime },
    })
    assert.equal(yesterdaySameTime.toISOString(), '2026-10-23T15:30:00.000Z')
  })

  await check('summary shape states what is not measured yet', async () => {
    assert.deepEqual(Object.keys(summary).sort(), [
      'error_rate', 'error_rate_reason', 'generated_at', 'live_players',
      'spend_reason', 'spend_today_usd', 'turns_today', 'turns_yesterday_same_time',
    ])
    assert.equal(summary.generated_at, now.toISOString())
    assert.equal(summary.error_rate, null)
    assert.equal(summary.error_rate_reason, "Error tracking isn't built yet.")
  })

  await check('spend sums today\'s traced calls, and no calls is no figure, not $0', async () => {
    assert.deepEqual(spendWindows[0], [todayStart, now])
    assert.equal(summary.spend_today_usd, 0.1235)
    assert.equal(summary.spend_reason, '3 of 40 calls had no reported price.')
    const quiet = await adminOverviewSummaryService.summary(now, async () => ({ usd: 0, calls: 0, unpriced: 0 }))
    assert.equal(quiet.spend_today_usd, null)
    assert.equal(quiet.spend_reason, 'No model calls recorded today.')
    const priced = await adminOverviewSummaryService.summary(now, async () => ({ usd: 0.5, calls: 2, unpriced: 0 }))
    assert.equal(priced.spend_today_usd, 0.5)
    assert.equal(priced.spend_reason, null)
  })

  // ── Routes ──────────────────────────────────────────────────────────────────
  Object.assign(mongoColl, originalCollections)

  await check('both overview routes are guarded when admin credentials are unset', async () => {
    env.ADMIN_USERNAME = ''
    env.ADMIN_PASSWORD = ''
    const app = new Elysia().use(adminOverviewRoutes)
    for (const path of ['/admin/system/health', '/admin/overview/summary']) {
      const response = await app.handle(new Request(`http://localhost${path}`))
      assert.equal(response.status, 503, path)
      assert.deepEqual(await response.json(), { error: 'Admin credentials are not configured' })
    }
  })

  await check('the health route answers 200 even when every dependency is down', async () => {
    env.ADMIN_USERNAME = 'offline-admin'
    env.ADMIN_PASSWORD = 'offline-fixture'
    env.PINECONE_API_KEY = ''
    const app = new Elysia().use(adminOverviewRoutes)
    const response = await app.handle(new Request('http://localhost/admin/system/health', {
      headers: { Authorization: `Basic ${Buffer.from('offline-admin:offline-fixture').toString('base64')}` },
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(Object.keys(body), ['generated_at', 'version', 'checks', 'queues'])
    assert.equal(body.checks.length, 4)
    assert.deepEqual(body.checks.map((c: { status: string }) => c.status), ['down', 'down', 'down', 'down'])
    assert.deepEqual(body.queues, [])
  })
} finally {
  Object.assign(env, originalEnv)
  Object.assign(mongoColl, originalCollections)
}
console.log(`admin-overview audit: ${count} passed, ${failures} failed`)
if (failures) process.exit(1)
